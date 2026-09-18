// test-crew-staff-apps.js
// Openings, staff applications, and the promotion that accepting one runs —
// the decision modules directly, and the promote/stand-down pair against a fake
// VA and a fake data store.
//
// WHAT THIS FILE IS DEFENDING
//
// Accepting a staff application mints a staff LOGIN and hands over permissions,
// which is the one escalation the whole capability system is built to be
// careful about. A hiring queue is therefore a new door onto the most dangerous
// thing in the crew centre, and most of what is checked here is what it CANNOT
// do:
//
//   * an opening cannot advertise a role that does not exist
//   * a pilot cannot apply twice, cannot apply under the hours bar, and cannot
//     apply to something that is closed, and staff cannot apply at all
//   * a form cannot put its own words in the airline's mouth
//   * nobody can be promoted onto the permissive unassigned-staff default: a
//     role, or at least one tick, or the promotion is refused
//   * promoting the same pilot twice is refused rather than minting a second
//     login nobody can reach
//
// Plus the two things the feature exists for: accepting runs the same promotion
// an owner would have run by hand — taking over the pilot's own login rather
// than sitting behind it, and writing the assignment in the same breath — and
// standing somebody down gives that login back rather than taking it away for
// having helped.
//
// NOT covered here: the no-escalation checks on the hiring routes themselves,
// which live in server.js and cannot be required without a live app. They are
// the same rule teamSaveFailure enforces, applied at two more points.
//
// Run:  node scripts/test-crew-staff-apps.js
process.env.JWT_SECRET = 'test-secret-for-crew-staff-apps';
process.env.PUBLIC_BASE_URL = 'https://inflight.example';

const assert = require('assert');
const crewStaffApps = require('../crewStaffApps');

let passed = 0;
function ok(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const ROLES = [
    { id: 'pirep-manager', name: 'PIREP manager', color: '#0EA5E9', permissions: ['flights.review'] },
    { id: 'chief', name: 'Chief of staff', color: '#B45309', permissions: ['team.manage', 'roster.manage'] },
];

console.log('\nOpenings — what the airline may advertise');

ok('an opening whose role does not exist is dropped', () => {
    const out = crewStaffApps.sanitizeOpenings([
        { roleId: 'pirep-manager', title: 'PIREP reviewer' },
        { roleId: 'ghost', title: 'Something that was deleted' },
    ], ROLES);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].roleId, 'pirep-manager');
});

ok('ids survive a save, because applications point at them', () => {
    const first = crewStaffApps.sanitizeOpenings([{ roleId: 'chief', title: 'Chief of staff' }], ROLES);
    const again = crewStaffApps.sanitizeOpenings(first, ROLES);
    assert.strictEqual(again[0].id, first[0].id);
});

ok('two openings for the same role get distinct ids', () => {
    const out = crewStaffApps.sanitizeOpenings([
        { roleId: 'chief', title: 'Chief of staff' },
        { roleId: 'chief', title: 'Chief of staff' },
    ], ROLES);
    assert.strictEqual(out.length, 2);
    assert.notStrictEqual(out[0].id, out[1].id);
});

ok('questions and the hours bar are bounded', () => {
    const out = crewStaffApps.sanitizeOpenings([{
        roleId: 'chief', title: 'Chief',
        questions: new Array(50).fill('why?'),
        minHours: -20,
    }], ROLES);
    assert.strictEqual(out[0].questions.length, crewStaffApps.MAX_QUESTIONS);
    assert.strictEqual(out[0].minHours, 0);
});

ok('a non-list is refused rather than coerced', () => {
    assert.strictEqual(crewStaffApps.sanitizeOpenings('openings', ROLES), null);
    assert.strictEqual(crewStaffApps.sanitizeOpenings(undefined, ROLES), null);
});

ok('an opening says what the job actually lets you do', () => {
    const [o] = crewStaffApps.sanitizeOpenings([{ roleId: 'chief', title: 'Chief of staff' }], ROLES);
    const view = crewStaffApps.publicOpening(o, {
        role: ROLES[1],
        labels: ['Create staff roles & assign the team', 'Add, edit & remove pilots'],
    });
    assert.strictEqual(view.roleName, 'Chief of staff');
    assert.deepStrictEqual(view.can, ['Create staff roles & assign the team', 'Add, edit & remove pilots']);
    // Never the ids. A pilot deciding whether to put their name forward is
    // owed the airline's words, not ours.
    assert.ok(!JSON.stringify(view).includes('team.manage'));
});

console.log('\nApplying — who may, and who may not');

const OPEN = crewStaffApps.sanitizeOpenings(
    [{ roleId: 'pirep-manager', title: 'PIREP reviewer', minHours: 25 }], ROLES)[0];
const SHUT = crewStaffApps.sanitizeOpenings(
    [{ roleId: 'chief', title: 'Chief of staff', open: false }], ROLES)[0];

ok('a pilot over the bar may apply', () => {
    assert.strictEqual(crewStaffApps.applyFailure(OPEN, { hours: 40 }), '');
});

ok('a pilot under the bar is told the number, and their own', () => {
    const why = crewStaffApps.applyFailure(OPEN, { hours: 12.7 });
    assert.ok(why.includes('25'), why);
    assert.ok(why.includes('12'), why);
});

ok('a closed opening is refused', () => {
    assert.ok(crewStaffApps.applyFailure(SHUT, { hours: 900 }));
});

ok('an opening that has been withdrawn is refused', () => {
    assert.ok(crewStaffApps.applyFailure(null, { hours: 900 }));
});

ok('applying twice is refused', () => {
    assert.ok(crewStaffApps.applyFailure(OPEN, { hours: 40, alreadyApplied: true }));
});

ok('staff are refused — they are already on the team', () => {
    assert.ok(crewStaffApps.applyFailure(OPEN, { hours: 40, isStaff: true }));
});

console.log('\nAnswers — the questions are the airline’s');

ok('answers are paired against the airline’s own questions', () => {
    const out = crewStaffApps.pairAnswers(['Why?', 'When are you about?'], ['Because', 'Evenings']);
    assert.deepStrictEqual(out, [
        { q: 'Why?', a: 'Because' },
        { q: 'When are you about?', a: 'Evenings' },
    ]);
});

ok('a form cannot put words in the airline’s mouth', () => {
    // The client sends four answers and its own idea of the questions; only the
    // airline's two questions survive, and the extra answers are dropped with
    // them. A row staff read as "what we asked" must be what we asked.
    const out = crewStaffApps.pairAnswers(['Why?'], ['Because', 'and also this']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].q, 'Why?');
});

ok('a missing answer is empty, not undefined', () => {
    const out = crewStaffApps.pairAnswers(['Why?', 'When?'], ['Because']);
    assert.strictEqual(out[1].a, '');
});

console.log('\nViews — what each side is shown');

const ROW = {
    _id: 'app1', openingId: 'pirep-reviewer', roleId: 'pirep-manager',
    position: 'PIREP reviewer', memberId: 'm1', pilotName: 'Sam', callsign: 'BAW123',
    answers: [{ q: 'Why?', a: 'Because' }], status: 'declined',
    staffMessage: 'Not this time.', decidedBy: 'dave', decidedAt: new Date(), createdAt: new Date(),
};

ok('the reviewer sees who decided it', () => {
    assert.strictEqual(crewStaffApps.staffApplicationView(ROW).decidedBy, 'dave');
});

ok('the applicant does not', () => {
    const mine = crewStaffApps.myApplicationView(ROW);
    assert.ok(!('decidedBy' in mine));
    // They DO see what was said. A decision with no reason is the thing this
    // feature was meant to replace.
    assert.strictEqual(mine.staffMessage, 'Not this time.');
});

/* ===========================================================================
 * Promotion, and its inverse — against a fake VA and a fake project.
 *
 * These two are what "accept" actually does, and what the team screen's new
 * stand-down button actually does. Both are in crewAuth, which reaches for
 * mongoose models and the VA's store, so both are faked below.
 * ======================================================================== */
const mongoose = require('mongoose');

let ACCOUNTS = [];
let MEMBERS = [];
let PORTAL = [];
let SEQ = 0;

function freshWorld() {
    // Rae has a pilot login of her own. Kim is on the roster and has never
    // signed in. The difference is the whole of what promotion has to get right.
    ACCOUNTS = [
        { _id: 'a1', username: 'rae', passwordHash: '$2a$12$raehash', role: 'pilot', active: true, memberId: 'm1' },
    ];
    MEMBERS = [
        { _id: 'm1', name: 'Rae', callsign: 'BAW101', hours: 120 },
        { _id: 'm2', name: 'Kim', callsign: 'BAW102', hours: 40 },
    ];
    PORTAL = [];
    SEQ = 0;
}

const store = {
    getMember: async (id) => MEMBERS.find(m => String(m._id) === String(id)) || null,
    getAccountByMember: async (mid) => ACCOUNTS.find(a => String(a.memberId || '') === String(mid)) || null,
    updateAccount: async (id, patch) => {
        const a = ACCOUNTS.find(x => String(x._id) === String(id));
        if (a) Object.assign(a, patch);
        return a || null;
    },
};
const crewStore = require('../crewStore');
crewStore.forVa = async () => store;

mongoose.model = (name) => {
    if (name !== 'VaPortalAccount') return { findOne: async () => null };
    const q = (row) => ({ select: () => ({ lean: async () => row }) });
    return {
        exists: async ({ username }) => PORTAL.some(a => a.username === username),
        findOne: (where) => {
            const hit = PORTAL.find(a => (!where.username || a.username === where.username)
                && (!where.crewMemberId || String(a.crewMemberId) === String(where.crewMemberId))) || null;
            // The promote path calls .select().lean(); the stand-down path
            // wants a live document with .deleteOne(). Both shapes, one stub.
            const doc = hit && { ...hit, deleteOne: async () => { PORTAL = PORTAL.filter(a => a !== hit); } };
            return Object.assign(Promise.resolve(doc), q(hit));
        },
        create: async (data) => { const row = { _id: `p${++SEQ}`, ...data }; PORTAL.push(row); return row; },
    };
};

const crewAuth = require('../crewAuth');

const VA = { _id: 'va1', name: 'British Airways Virtual', slug: 'ba' };
const freshAd = () => ({
    _id: 'va1',
    staffRoles: [{ id: 'pirep-manager', name: 'PIREP manager', permissions: ['flights.review'] }],
    staffAssignments: [],
    save: async function () { this.saved = (this.saved || 0) + 1; },
});

async function asyncOk(name, fn) {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

(async () => {
    console.log('\nPromotion — what accepting actually does');

    await asyncOk('a pilot with a login keeps it, and no password is issued', async () => {
        freshWorld();
        const ad = freshAd();
        const out = await crewAuth.provisionStaffFromMember({
            va: VA, ad, memberId: 'm1', roleId: 'pirep-manager', byName: 'chris', store,
        });
        assert.strictEqual(out.keptTheirLogin, true);
        assert.strictEqual(out.password, null);
        assert.strictEqual(out.account.username, 'rae');
        // The hash came across, which is what makes the password she knows the
        // password that works.
        assert.strictEqual(PORTAL[0].passwordHash, '$2a$12$raehash');
        // And her pilot row is stood down, so the login cascade reaches the
        // staff account rather than stopping at the pilot one in front of it.
        assert.strictEqual(ACCOUNTS[0].active, false);
    });

    await asyncOk('a pilot with no login gets one, with a password shown once', async () => {
        freshWorld();
        const ad = freshAd();
        const out = await crewAuth.provisionStaffFromMember({
            va: VA, ad, memberId: 'm2', roleId: 'pirep-manager', byName: 'chris', store,
        });
        assert.strictEqual(out.keptTheirLogin, false);
        assert.ok(out.password && out.password.length >= 8, 'a password should have been issued');
        assert.strictEqual(out.account.username, 'kim');
        assert.strictEqual(PORTAL[0].mustChangePassword, true);
    });

    await asyncOk('the assignment is written in the same breath as the account', async () => {
        freshWorld();
        const ad = freshAd();
        await crewAuth.provisionStaffFromMember({
            va: VA, ad, memberId: 'm2', roleId: 'pirep-manager', store,
        });
        assert.deepStrictEqual(ad.staffAssignments, [
            { username: 'kim', roleId: 'pirep-manager', permissions: [] },
        ]);
    });

    await asyncOk('no role and no ticks is refused — that is the permissive default', async () => {
        freshWorld();
        const ad = freshAd();
        await assert.rejects(
            () => crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm2', store }),
            (err) => err.code === 'role_required');
        assert.strictEqual(PORTAL.length, 0, 'nothing should have been created');
    });

    await asyncOk('a role that has been deleted is refused', async () => {
        freshWorld();
        const ad = freshAd();
        await assert.rejects(
            () => crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm2', roleId: 'ghost', store }),
            (err) => err.code === 'role_gone');
    });

    await asyncOk('promoting the same pilot twice is refused', async () => {
        freshWorld();
        const ad = freshAd();
        await crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm2', roleId: 'pirep-manager', store });
        await assert.rejects(
            () => crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm2', roleId: 'pirep-manager', store }),
            (err) => err.code === 'already_staff');
        assert.strictEqual(PORTAL.length, 1);
    });

    await asyncOk('a pilot who has left the roster cannot be promoted', async () => {
        freshWorld();
        const ad = freshAd();
        await assert.rejects(
            () => crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'gone', roleId: 'pirep-manager', store }),
            (err) => err.code === 'not_on_roster');
    });

    console.log('\nStanding down — giving the login back');

    await asyncOk('their pilot login comes back, with the password they have been using', async () => {
        freshWorld();
        const ad = freshAd();
        await crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm1', roleId: 'pirep-manager', store });
        assert.strictEqual(ACCOUNTS[0].active, false);

        const out = await crewAuth.standDownStaff({ va: VA, ad, username: 'rae', store });
        assert.strictEqual(out.pilotRestored, true);
        assert.strictEqual(ACCOUNTS[0].active, true);
        assert.strictEqual(ACCOUNTS[0].passwordHash, '$2a$12$raehash');
        assert.strictEqual(PORTAL.length, 0, 'the staff account should be gone');
    });

    await asyncOk('the assignment goes with them', async () => {
        freshWorld();
        const ad = freshAd();
        await crewAuth.provisionStaffFromMember({ va: VA, ad, memberId: 'm1', roleId: 'pirep-manager', store });
        assert.strictEqual(ad.staffAssignments.length, 1);
        await crewAuth.standDownStaff({ va: VA, ad, username: 'rae', store });
        // Usernames are globally unique and the delete frees this one, so an
        // assignment left behind would hand the next holder their permissions.
        assert.strictEqual(ad.staffAssignments.length, 0);
    });

    await asyncOk('the owner cannot be stood down', async () => {
        freshWorld();
        const ad = freshAd();
        PORTAL.push({ _id: 'p0', username: 'chris', role: 'owner', vaAdId: 'va1' });
        await assert.rejects(
            () => crewAuth.standDownStaff({ va: VA, ad, username: 'chris', store }),
            (err) => err.code === 'is_owner');
        assert.strictEqual(PORTAL.length, 1);
    });

    await asyncOk('somebody who is not on this crew centre is refused', async () => {
        freshWorld();
        const ad = freshAd();
        await assert.rejects(
            () => crewAuth.standDownStaff({ va: VA, ad, username: 'nobody', store }),
            (err) => err.code === 'not_found');
    });

    /* =====================================================================
     * THE BOARD — hiring on it, and not growing forever.
     *
     * Against a fake PostgREST rather than a real one: what is being defended
     * is which rows this module sends and what it does when the project refuses
     * one, and both are decided here rather than in Postgres.
     * ================================================================== */
    console.log('\nThe noticeboard — a kind an old project has never heard of');

    const { SupabaseStore } = crewStore;
    function fakeStore({ refuseKind = false, pruned = null } = {}) {
        const st = new SupabaseStore({ slug: 'ba', supabaseUrl: 'https://x.test', supabaseServiceKey: 'k' });
        const sent = [];
        st.db = {
            dropped: new Set(),
            insert: async (table, row) => {
                sent.push(row);
                if (refuseKind && row.kind !== 'notice') {
                    throw new crewStore.CrewStoreError('write failed', {
                        status: 502, code: 'store_error',
                        detail: 'new row for relation "crew_announcements" violates check constraint "crew_announcements_kind_check"',
                    });
                }
                return [{ id: 'n1', va_slug: 'ba', ...row, created_at: new Date().toISOString() }];
            },
            rpc: async (fn, args) => {
                if (pruned === null) throw new crewStore.CrewStoreError('no such function', { code: 'store_schema_missing' });
                st.lastPrune = { fn, args };
                return pruned;
            },
        };
        st.sent = sent;
        return st;
    }

    await asyncOk('a project that knows “staff” gets a staff row', async () => {
        const st = fakeStore();
        const out = await st.createAnnouncement({ kind: 'staff', title: 'Rae has joined the staff team', source: 'auto' });
        assert.strictEqual(out.kind, 'staff');
        assert.strictEqual(st.sent.length, 1);
        assert.strictEqual(st.db.dropped.size, 0);
    });

    await asyncOk('a project that refuses it still gets the notice, as a plain one', async () => {
        // The failure this closes: the kind is an inline CHECK constraint, so a
        // VA who has not re-run the SQL used to lose the whole row — silently,
        // because postAnnouncement is fire-and-forget.
        const st = fakeStore({ refuseKind: true });
        const out = await st.createAnnouncement({ kind: 'staff', title: 'Rae has joined the staff team', source: 'auto' });
        assert.strictEqual(out.kind, 'notice');
        assert.strictEqual(out.title, 'Rae has joined the staff team');
        assert.strictEqual(st.sent.length, 2, 'should have retried exactly once');
        assert.ok(st.db.dropped.has('crew_announcements.kind'));
        assert.deepStrictEqual(st.drift(), ['the icon on a generated notice']);
    });

    await asyncOk('any other write failure still throws', async () => {
        const st = fakeStore();
        st.db.insert = async () => { throw new crewStore.CrewStoreError('nope', { detail: 'permission denied' }); };
        await assert.rejects(() => st.createAnnouncement({ kind: 'staff', title: 'x' }));
    });

    await asyncOk('a plain notice is never retried — there is nothing to fall back to', async () => {
        const st = fakeStore({ refuseKind: true });
        // refuseKind only refuses a non-notice kind, so this succeeds first
        // time; the point is that the retry path is not entered for 'notice'.
        const out = await st.createAnnouncement({ kind: 'notice', title: 'Read the new rules' });
        assert.strictEqual(st.sent.length, 1);
        assert.strictEqual(out.kind, 'notice');
    });

    console.log('\nPruning — the board is not a log');

    await asyncOk('the prune says how many went', async () => {
        const st = fakeStore({ pruned: 137 });
        assert.strictEqual(await st.pruneAnnouncements(), 137);
        assert.strictEqual(st.lastPrune.fn, 'crew_announcements_prune');
        assert.strictEqual(st.lastPrune.args.p_va_slug, 'ba');
        assert.strictEqual(st.lastPrune.args.p_keep, 200);
    });

    await asyncOk('a pre-v20 project with no such function answers 0, not an error', async () => {
        // Housekeeping runs AFTER a notice has been written. A throw here would
        // mean a promotion reported as broken because the tidy-up failed.
        const st = fakeStore();   // rpc throws
        assert.strictEqual(await st.pruneAnnouncements(), 0);
    });

    await asyncOk('a legacy store has no board to prune and says so quietly', async () => {
        const legacy = new crewStore.LegacyStore({ _id: 'va1', slug: 'ba' });
        assert.strictEqual(await legacy.pruneAnnouncements(), 0);
        // Everything else about the noticeboard still refuses there.
        await assert.rejects(() => legacy.createAnnouncement({ title: 'x' }));
    });

    console.log('\nWhat somebody can do, in the airline’s own words');

    await asyncOk('capabilities come back as labels, never as ids', async () => {
        const out = crewAuth.capabilitySummary(['flights.review', 'team.manage', 'nonsense']);
        assert.strictEqual(out.length, 2);
        assert.ok(out.every(l => !l.includes('.')), out.join(' | '));
    });

    await asyncOk('an owner’s summary is the whole catalogue', async () => {
        const all = crewAuth.capabilitySummary(crewAuth.CREW_CAP_IDS);
        assert.strictEqual(all.length, crewAuth.CREW_CAPABILITIES.length);
    });

    console.log(`\n${passed} checks passed.\n`);
})();
