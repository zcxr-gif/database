// test-crew-staff-pilot.js
// A staff member's own pilot side, the pilot terms, and the starter handbook —
// driven through the real Express routes with a fake VA and a fake data store.
//
// WHAT THIS FILE IS DEFENDING
//
// A VA's owner and staff sign in with one of OUR central accounts, which has no
// row in the VA's project. That made them people who could run an airline and
// be nobody in it: no login of their own on the roster, nothing to address a
// message to, and nothing to hang a Discord link on. The fix is one bound row —
// and a bound row is exactly the sort of thing that quietly becomes a way to
// grant yourself something, so most of what is checked here is what it CANNOT
// do:
//
//   * the row is always role 'pilot', whatever the staff member's own role is
//   * a staff session's capabilities still come from the CENTRAL account, never
//     from the row — including on the Discord door
//   * signing in with Discord as staff re-reads that central account, and a
//     staff account that has been switched off gets no session at all
//   * nothing here can point a staff member at somebody else's pilot account
//   * one central account gets one row, however many times the button is pressed
//   * agreeing to the terms records a version and nothing else, and never the
//     wrong version
//
// Run:  node scripts/test-crew-staff-pilot.js
process.env.JWT_SECRET = 'test-secret-for-crew-staff-pilot';
process.env.DISCORD_CLIENT_ID = '1234567890';
process.env.DISCORD_CLIENT_SECRET = 'shh';
process.env.PUBLIC_BASE_URL = 'https://inflight.example';
process.env.CREW_PUBLIC_BASE_URL = 'https://crew.example';

const express = require('express');
const mongoose = require('mongoose');

const VA = {
    _id: 'va1', name: 'British Airways Virtual', slug: 'ba', callsign: 'BAW',
    status: 'approved', staffRoles: [], staffAssignments: [],
};

/* ---------------------------------------------------------------------------
 * The VA's project, in memory.
 * ------------------------------------------------------------------------ */
let ACCOUNTS = [];
let MEMBERS = [];
let SEQ = 0;
const freshStore = () => {
    ACCOUNTS = [
        { _id: 'a1', username: 'rae', displayName: 'Rae', role: 'pilot', active: true,
          memberId: 'm1', mustChangePassword: false, portalAccountId: '',
          termsVersion: '', discordId: '', discordUsername: '', discordAvatar: '' },
    ];
    MEMBERS = [{ _id: 'm1', name: 'Rae', callsign: 'BAW101', hours: 12 }];
    SEQ = 0;
};

const store = {
    getAccount: async (id) => ACCOUNTS.find((a) => String(a._id) === String(id)) || null,
    getAccountByUsername: async (u) => ACCOUNTS.find((a) => a.username === String(u || '').toLowerCase()) || null,
    getAccountByDiscord: async (did) => (/^[0-9]{5,32}$/.test(String(did || ''))
        ? ACCOUNTS.find((a) => a.discordId === String(did)) || null : null),
    getAccountByPortal: async (pid) => (/^[a-f0-9]{24}$/i.test(String(pid || ''))
        ? ACCOUNTS.find((a) => a.portalAccountId === String(pid)) || null : null),
    createAccount: async (data) => {
        const row = { _id: `n${++SEQ}`, active: true, termsVersion: '', discordId: '', ...data };
        ACCOUNTS.push(row);
        return row;
    },
    updateAccount: async (id, patch) => {
        const a = ACCOUNTS.find((x) => String(x._id) === String(id));
        if (a) Object.assign(a, patch);
        return a || null;
    },
    getMember: async (id) => MEMBERS.find((m) => String(m._id) === String(id)) || null,
    listMembers: async () => MEMBERS.slice(),
    getAccountByMember: async (mid) => ACCOUNTS.find((a) => String(a.memberId || '') === String(mid)) || null,
    createMember: async (data) => {
        const m = { _id: `mm${++SEQ}`, hours: 0, callsign: '', ...data };
        MEMBERS.push(m);
        return m;
    },
    listApplications: async () => { throw new Error('no applications table in this fake'); },
};

const crewStore = require('../crewStore');
crewStore.forVa = async () => store;

/* ---------------------------------------------------------------------------
 * Our central accounts.
 * ------------------------------------------------------------------------ */
const PORTAL = {
    // A 24-hex id, because that is what a Mongo ObjectId looks like and the
    // binding column refuses anything else.
    _id: 'aaaaaaaaaaaaaaaaaaaaaaa1',
    username: 'chris', displayName: 'Chris', role: 'owner', active: true,
    vaAdId: 'va1', crewMemberId: null, mustChangePassword: false,
};
let PORTAL_ACTIVE = true;

mongoose.model = (name) => {
    if (name === 'VirtualAirlineAd') {
        return {
            findOne: (q) => ({ select: () => ({ lean: async () => (
                (q && (q.slug === 'ba' || q.callsign === 'BA')) ? VA : null) }) }),
            findById: () => ({ select: () => ({ lean: async () => VA }) }),
        };
    }
    if (name === 'VaPortalAccount') {
        const row = () => ({ ...PORTAL, active: PORTAL_ACTIVE });
        return {
            findById: (id) => ({ select: () => ({ lean: async () => (
                String(id) === PORTAL._id ? row() : null) }) }),
            findByIdAndUpdate: async (id, patch) => {
                if (String(id) === PORTAL._id) Object.assign(PORTAL, patch);
                return null;
            },
            findOne: async () => null,
        };
    }
    return { findOne: async () => null };
};

const crewDiscord = require('../crewDiscord');
let WHO = { id: '80351110224678912', username: 'chris', globalName: 'Chris', avatar: 'abc' };
crewDiscord.exchangeCode = async () => 'access-token';
crewDiscord.fetchProfile = async () => WHO;

const crewAuth = require('../crewAuth');
const crewAccounts = require('../crewAccounts');
const crewHandbook = require('../crewHandbook');
const { CREW_TERMS_VERSION } = require('../crewTerms');

const app = express();
app.use(express.json());
crewAuth.registerCrewAuthRoutes(app);

let pass = 0;
const fails = [];
const check = (what, ok, extra) => {
    if (ok) pass++;
    else fails.push(what + (extra === undefined ? '' : ` — ${JSON.stringify(extra).slice(0, 300)}`));
};

const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const jwt = require('jsonwebtoken');
    const get = (p, headers) => fetch(base + p, { redirect: 'manual', headers: headers || {} });
    const send = (method) => (p, body, headers) => fetch(base + p, {
        method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(body || {}),
    });
    const post = send('POST');
    const del = send('DELETE');

    const staffSession = jwt.sign({
        typ: 'crew', sub: PORTAL._id, kind: 'va', role: 'owner', view: 'owner',
        slug: 'ba', vaId: 'va1', uname: 'chris',
    }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const pilotSession = jwt.sign({
        typ: 'crew', sub: 'a1', kind: 'crew', role: 'pilot', view: 'pilot',
        slug: 'ba', vaId: 'va1', uname: 'rae',
    }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const inflightSession = jwt.sign({
        typ: 'crew', sub: 'staff1', kind: 'inflight', role: 'inflight', view: 'owner',
        slug: 'ba', vaId: 'va1', uname: 'admin',
    }, process.env.JWT_SECRET, { expiresIn: '7d' });

    const auth = (t) => ({ Authorization: 'Bearer ' + t });
    const reasonOf = (loc) => new URL(loc, 'https://x').searchParams.get('discord');
    const stateOf = (loc) => new URL(loc).searchParams.get('state');

    try {
        freshStore();
        PORTAL_ACTIVE = true;
        PORTAL.crewMemberId = null;

        /* ---- who may ask for a pilot side ---------------------------------- */
        {
            const anon = await post('/api/crew/ba/me/pilot-side');
            check('a pilot side cannot be asked for without a session', anon.status === 401);

            const asPilot = await post('/api/crew/ba/me/pilot-side', {}, auth(pilotSession));
            const b = await asPilot.json();
            check('a pilot is told they already are one', asPilot.status === 400 && b.code === 'already_a_pilot', b);

            /* Inflight oversight is not a pilot at anybody's airline. If this
               ever passes, our own staff can put themselves on a VA's roster. */
            const asInflight = await post('/api/crew/ba/me/pilot-side', {}, auth(inflightSession));
            const c = await asInflight.json();
            check('Inflight oversight cannot put itself on a VA roster',
                asInflight.status === 403 && c.code === 'not_a_va_account', c);

            const wrongVa = await post('/api/crew/other/me/pilot-side', {}, auth(staffSession));
            check('…nor can a session for another crew center', wrongVa.status === 403);
        }

        /* ---- setting one up ------------------------------------------------- */
        {
            const res = await post('/api/crew/ba/me/pilot-side', {}, auth(staffSession));
            const b = await res.json();
            check('a staff member can set up their own pilot side', res.status === 201 && b.created === true, b);
            check('…and is put on the roster under their own name', !!(b.pilot && b.pilot.name === 'Chris'), b.pilot);

            const row = ACCOUNTS.find((a) => a.portalAccountId === PORTAL._id);
            check('…as a row bound to their central account', !!row, ACCOUNTS.map((a) => a.username));
            /* THE PROPERTY THIS WHOLE DESIGN RESTS ON. The row lives in a
               project the VA's own people can write to; a role in it would be a
               way to grant capabilities by editing a database. */
            check('…whose role is pilot, not the role they hold as staff', row && row.role === 'pilot', row && row.role);
            check('…linked to the roster row that was created for them',
                !!(row && row.memberId && MEMBERS.some((m) => String(m._id) === String(row.memberId))));
            check('…and the central account now points at the same roster row',
                String(PORTAL.crewMemberId) === String(row.memberId), PORTAL.crewMemberId);

            /* No password is minted for them: they already have one, and a
               second credential would only be a second thing to lose. The hash
               that IS stored must open nothing. */
            const bcrypt = require('bcryptjs');
            check('…with a password hash that no password opens',
                !!row.passwordHash && !(await bcrypt.compare('', row.passwordHash)));
            check('…and no nag to change a password they do not have', row.mustChangePassword === false);
            /* The reply carries no credential — not a password, and not the
               hash either. `mustChangePassword` is a flag and is allowed. */
            check('…and no credential of any kind leaves in the reply',
                b.password === undefined && !JSON.stringify(b).includes(row.passwordHash), Object.keys(b.account || {}));
        }

        /* ---- and never onto somebody else's record ---------------------------- */
        {
            // 'a1' is Rae's login, and 'm1' is Rae. A staff member naming her
            // roster row would be two identities on one pilot.
            const res = await post('/api/crew/ba/me/pilot-side', { memberId: 'm1' }, auth(staffSession));
            const b = await res.json();
            check('a staff member cannot bind their pilot side to a pilot who has a login',
                res.status === 409 && b.code === 'pilot_has_login', b);
            check('…and Rae\'s row is untouched', ACCOUNTS.find((a) => a._id === 'a1').memberId === 'm1');
        }

        /* ---- pressing the button twice --------------------------------------- */
        {
            const before = ACCOUNTS.length;
            const res = await post('/api/crew/ba/me/pilot-side', {}, auth(staffSession));
            const b = await res.json();
            check('a second press returns the row they already have',
                res.status === 200 && b.created === false && ACCOUNTS.length === before, { status: res.status, before, now: ACCOUNTS.length });
        }

        /* ---- linking Discord as staff ---------------------------------------- */
        {
            const res = await post('/api/crew/ba/auth/discord/link', {}, auth(staffSession));
            const b = await res.json();
            check('a staff member with a pilot side can start a link', res.status === 200 && !!b.url, b);

            const st = crewDiscord.readState(stateOf(b.url));
            const own = ACCOUNTS.find((a) => a.portalAccountId === PORTAL._id);
            /* The state names the crew_accounts row, never the central account.
               One shape for the callback to handle, and no way to make it write
               a Discord id onto something that is not a pilot row. */
            check('…and the state names their pilot row, not their staff account',
                st && st.sub === String(own._id) && st.intent === 'link', st);
            check('…and remembers they started from the dashboard', st && st.back === 'dashboard', st);

            const cb = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(stateOf(b.url))}`);
            const loc = cb.headers.get('location') || '';
            check('…and the link lands on the dashboard they started from',
                reasonOf(loc) === 'linked' && loc.startsWith('https://crew.example/crew-dashboard.html?va=ba'), loc);
            check('…written onto their own row', ACCOUNTS.find((a) => a.portalAccountId === PORTAL._id).discordId === WHO.id);
        }

        /* ---- and signing in with it ------------------------------------------ */
        {
            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const cb = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            const loc = cb.headers.get('location') || '';
            check('signing in with Discord as staff finds the bound row', reasonOf(loc) === 'ok', loc);
            check('…and lands on the crew center front door to spend its handoff',
                loc.startsWith('https://crew.example/crew/ba?'), loc);

            const handoff = decodeURIComponent(new URL(loc).hash.replace(/^#discord=/, ''));
            const ex = await post('/api/crew/ba/auth/discord/exchange', { code: handoff });
            const s = await ex.json();
            /* THE POINT OF THE WHOLE FEATURE. The Discord door and the password
               door must produce the SAME session — so a staff member who signs
               in with Discord is still staff, with everything they manage. */
            // The session's kind lives in the token it hands out, which is the
            // thing every later request is judged by — so that is what is read.
            const claims = JSON.parse(Buffer.from(String(s.token || '..').split('.')[1] || '', 'base64url').toString('utf8') || '{}');
            check('…and the session it hands out is the STAFF one',
                ex.status === 200 && claims.kind === 'va' && claims.role === 'owner' && claims.sub === PORTAL._id,
                { status: ex.status, kind: claims.kind, role: claims.role });
            check('…with an owner\'s capabilities, resolved from the central account',
                Array.isArray(s.caps) && s.caps.length === crewAuth.CREW_CAP_IDS.length, (s.caps || []).length);
            check('…and the management view, not the pilot home', s.view === 'owner', s.view);
        }

        /* ---- a staff account switched off between callback and exchange ------- */
        {
            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const cb = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            const handoff = decodeURIComponent(new URL(cb.headers.get('location')).hash.replace(/^#discord=/, ''));
            PORTAL_ACTIVE = false;
            const ex = await post('/api/crew/ba/auth/discord/exchange', { code: handoff });
            check('a handoff is worth nothing once the staff account is switched off', ex.status === 401, ex.status);
            /* Refused rather than quietly downgraded to a pilot session:
               somebody whose staff access has been taken away should be told,
               not handed a lesser session and left to work out what changed. */
            PORTAL_ACTIVE = true;
        }

        /* ---- unlinking -------------------------------------------------------- */
        {
            const res = await del('/api/crew/ba/account/discord', {}, auth(staffSession));
            const b = await res.json();
            check('a staff member can unlink their own Discord', res.status === 200 && b.discord.linked === false, b);
            check('…and it comes off their bound row', !ACCOUNTS.find((a) => a.portalAccountId === PORTAL._id).discordId);
        }

        /* ---- a staff member with no pilot side yet ---------------------------- */
        {
            const row = ACCOUNTS.find((a) => a.portalAccountId === PORTAL._id);
            row.portalAccountId = '';                     // as if they never set one up
            const res = await post('/api/crew/ba/auth/discord/link', {}, auth(staffSession));
            const b = await res.json();
            check('linking without a pilot side says which order to do it in',
                res.status === 409 && b.code === 'no_pilot_side', b);
            row.portalAccountId = PORTAL._id;
        }

        /* ---- the pilot terms --------------------------------------------------- */
        {
            const me = await get('/api/crew/ba/me', auth(pilotSession));
            const d = await me.json();
            check('a pilot is told which version of the notice is current',
                d.terms && d.terms.version === CREW_TERMS_VERSION && d.terms.applies === true, d.terms);
            check('…and that they have not agreed to it yet', d.terms.accepted === false, d.terms);
            check('…and where to read it', typeof d.terms.url === 'string' && d.terms.url.length > 1, d.terms);

            const stale = await post('/api/crew/ba/account/terms', { version: 'v0' }, auth(pilotSession));
            const sb = await stale.json();
            /* A page open since before a change would otherwise record an
               agreement to a document nobody had in front of them. */
            check('agreeing to an older version is refused', stale.status === 409 && sb.code === 'version_moved', sb);

            const ok = await post('/api/crew/ba/account/terms', { version: CREW_TERMS_VERSION }, auth(pilotSession));
            const ob = await ok.json();
            check('agreeing records the current version', ok.status === 200 && ob.terms.accepted === true, ob);
            const row = ACCOUNTS.find((a) => a._id === 'a1');
            check('…against their own account row', row.termsVersion === CREW_TERMS_VERSION && !!row.termsAcceptedAt, row.termsVersion);

            const after = await (await get('/api/crew/ba/me', auth(pilotSession))).json();
            check('…and they are not asked again', after.terms.accepted === true, after.terms);
        }

        /* ---- the terms for staff ------------------------------------------------ */
        {
            const me = await (await get('/api/crew/ba/me', auth(staffSession))).json();
            check('a staff member with a pilot side is asked too', me.terms.applies === true, me.terms);
            check('…and their pilot side is reported as ready', me.pilotSide && me.pilotSide.ready === true, me.pilotSide);

            const oversight = await (await get('/api/crew/ba/me', auth(inflightSession))).json();
            /* Nothing to record an answer on, so nobody is shown a prompt with
               no button behind it. */
            check('Inflight oversight is never asked', oversight.terms.applies === false && oversight.terms.accepted === true, oversight.terms);
        }

        done();
    } catch (err) {
        fails.push('threw — ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
        done();
    }
});

/* ---------------------------------------------------------------------------
 * The parts with no routes in them.
 * ------------------------------------------------------------------------ */
function offline() {
    // provisionStaffAccount, directly.
    const bcrypt = require('bcryptjs');
    return (async () => {
        freshStore();
        const mem = { getAccountByPortal: store.getAccountByPortal, getAccountByUsername: store.getAccountByUsername,
            createAccount: store.createAccount, updateAccount: store.updateAccount };
        let threw = '';
        try { await crewAccounts.provisionStaffAccount(mem, { portalAccountId: 'not-an-id', displayName: 'X' }); }
        catch (e) { threw = e.message; }
        check('a binding that is not a central account id is refused outright', !!threw, threw);

        const a = await crewAccounts.provisionStaffAccount(mem, {
            portalAccountId: PORTAL._id, displayName: 'Chris', username: 'chris',
        });
        check('provisionStaffAccount creates a bound pilot row',
            a.created === true && a.account.role === 'pilot' && a.account.portalAccountId === PORTAL._id, a.account);
        const again = await crewAccounts.provisionStaffAccount(mem, { portalAccountId: PORTAL._id, displayName: 'Chris' });
        check('…and is idempotent', again.created === false && again.account._id === a.account._id);
        check('…with a hash that the empty password does not open',
            !(await bcrypt.compare('', a.account.passwordHash)));

        /* Re-pointing the pilot side.
         *
         * The bug this is here to stop coming back: once a bound row exists it
         * is what decides which pilot a staff member is, so the endpoint that
         * says "I fly as this one" / "I don't fly here" has to move the ROW and
         * not only the pointer on our central account. Writing one of the two
         * leaves the control looking like it worked and changing nothing. */
        {
            const bound = await store.getAccountByPortal(PORTAL._id);
            const moved = await crewAccounts.repointStaffPilotSide(store, PORTAL._id, 'm1');
            check('re-pointing moves the bound row to the roster row named', moved === true
                && (await store.getAccountByPortal(PORTAL._id)).memberId === 'm1');

            const cleared = await crewAccounts.repointStaffPilotSide(store, PORTAL._id, null);
            check('…and clearing it really clears it', cleared === true
                && (await store.getAccountByPortal(PORTAL._id)).memberId === null);

            const again = await crewAccounts.repointStaffPilotSide(store, PORTAL._id, null);
            check('…and a no-op write is not made at all', again === false);

            const nobody = await crewAccounts.repointStaffPilotSide(store, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'm1');
            check('…and a central account with no pilot side is left alone', nobody === false);

            const legacy = await crewAccounts.repointStaffPilotSide({}, PORTAL._id, 'm1');
            check('…and a store that cannot hold one answers rather than throwing', legacy === false);

            // Put it back so later checks read the state they expect.
            await store.updateAccount(bound._id, { memberId: bound.memberId });
        }

        // The handbook.
        const h = crewHandbook.starterHandbook({ vaName: 'British Airways Virtual' });
        check('the starter handbook is a draft', h.status === 'draft');
        check('…filed as a handbook', h.kind === 'handbook' && h.source === 'text');
        check('…named after the airline it was made for', h.body.includes('British Airways Virtual'));
        /* The library renders a text document verbatim. Markdown syntax would
           be read out loud as hashes and asterisks. */
        check('…and carries no markdown to be rendered as literal text',
            !/^#{1,6}\s/m.test(h.body) && !/\*\*/.test(h.body), h.body.slice(0, 80));
        check('…and leaves the airline\'s own rules to the airline', h.body.includes('[Staff:'));

        // The notice.
        const terms = require('../crewTermsContent');
        check('the pilot notice has a version and clauses',
            terms.VERSION === CREW_TERMS_VERSION && terms.CLAUSES.length > 0);
        const words = JSON.stringify(terms.CLAUSES).toLowerCase();
        /* The claims that must stay true of the code, and would be a lie the
           day they stop being: the scope we ask Discord for, and where a
           pilot's account actually lives. */
        check('…and says which Discord permission is asked for', words.includes('identify'));
        check('…and that the data is the VA\'s, not ours', words.includes('own database'));

        /* Adopting a roster row instead of duplicating a person.
         *
         * The hazard: a VA's owner is usually already on their own roster with
         * hours on it, long before they press the button. A second, empty row
         * would leave two of them on the roster — and the hours visibly on the
         * wrong one, which is worse than losing them. */
        {
            freshStore();
            MEMBERS.push({ _id: 'm2', name: 'Chris', callsign: 'BAW001', hours: 240 });
            const adopted = await crewAccounts.findUnclaimedNamesake(store, 'chris', PORTAL._id);
            check('a staff member already on the roster is adopted, not duplicated',
                adopted && adopted._id === 'm2' && adopted.hours === 240, adopted);

            // The same row, but it belongs to a pilot who signs in as themselves.
            ACCOUNTS.push({ _id: 'p9', username: 'chris.p', displayName: 'Chris', role: 'pilot',
                active: true, memberId: 'm2', portalAccountId: '' });
            const taken = await crewAccounts.findUnclaimedNamesake(store, 'Chris', PORTAL._id);
            check('…but never one that already has a pilot\'s own login on it', taken === null, taken);

            // Two people of that name: no way to tell which is meant.
            ACCOUNTS.pop();
            MEMBERS.push({ _id: 'm3', name: 'chris', callsign: 'BAW002', hours: 5 });
            const ambiguous = await crewAccounts.findUnclaimedNamesake(store, 'Chris', PORTAL._id);
            check('…and two of that name are left for a human to choose between', ambiguous === null, ambiguous);

            freshStore();
        }

    })();
}

function done() {
    offline().then(() => {
        if (fails.length) {
            console.log(`${pass} passed, ${fails.length} failed`);
            fails.forEach((f) => console.log('  FAIL  ' + f));
            process.exit(1);
        }
        console.log(`${pass} passed, 0 failed`);
        process.exit(0);
    });
}
