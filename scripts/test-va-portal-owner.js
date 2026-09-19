// test-va-portal-owner.js
// Handing a partner VA over, and the rules that stop it stranding one.
//
// WHY THIS EXISTS
//
// The VA Partnership Portal had no way to change who owns a VA. `POST /team`
// refuses to mint a second owner ("Never another owner"), `PATCH /team/:id` had
// no role field at all AND refuses to touch the owner row, and the Discord
// provisioner returns the existing owner rather than making another. So once a
// VA's owner account existed, that person was the owner for good — a VA whose
// founder left had to ask Inflight staff to edit the database. Teammates, for
// the same reason, were stuck as whatever they were created as.
//
// Ownership is a SWAP, not a field: exactly one account per VA holds it, so a
// handover is two writes that have to be thought of as one. The order is the
// whole safety property, and it is what this file is mostly about:
//
//   the new owner is promoted FIRST, the old owner demoted SECOND.
//
// Fail the second write that way round and the VA briefly has two owners —
// visible, and fixable from either account or by Inflight. The other way round
// leaves a VA with NO owner, and nobody left on the VA's side holds the
// endpoint that would fix it. Two owners beats none, every time.
//
// The routes are registered against a fake `app` and called with a fake
// request; none of this is a question about Mongo.
//
// Two "write failed" errors and some "[discord] bot not ready" lines on stderr
// are expected: the first are the deliberate half-failed handovers below being
// reported by the code under test, which is the behaviour being asserted, and
// the second is the activity log with nowhere to post.
//
// Run:  node scripts/test-va-portal-owner.js
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const vaPortal = require('../vaPortal');
const { VaPortalAccount } = vaPortal;

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

/* ---------------------------------------------------------------- harness */

const routes = {};
const app = {
    get: (p, ...h) => { routes['GET ' + p] = h; },
    post: (p, ...h) => { routes['POST ' + p] = h; },
    patch: (p, ...h) => { routes['PATCH ' + p] = h; },
    delete: (p, ...h) => { routes['DELETE ' + p] = h; },
    use: () => {},
};
// The registrar wants a bag of collaborators; none of them is reached on the
// paths driven here, so they are present rather than working.
vaPortal.registerVaPortalRoutes(app, {
    VirtualAirlineAd: { findById: async () => null, findOne: async () => null },
    EmbedConfig: {}, VaPilot: {}, s3Client: {},
    upload: { single: () => (req, res, next) => next(), array: () => (req, res, next) => next(),
        fields: () => (req, res, next) => next() },
    uploadVaImage: async () => '', deleteVaImage: async () => {},
    isDiscordWebhookUrl: () => true, sendVaTestEvent: async () => {},
    renderCardPreview: async () => Buffer.alloc(0), applyEmbedAppearance: () => {},
});

const VA = 'va-1';

/**
 * A portal account, as a document just real enough for the handlers.
 *
 * `stored` is what a real database would be holding: a handler assigns to
 * `role` and the value only reaches `stored` when save() succeeds. Without that
 * separation a failed write would still look like it landed — the object was
 * mutated in memory — and the ordering assertions below would pass on a code
 * path that had actually stranded the VA.
 */
const doc = (o) => ({
    _id: o.id, username: o.username, displayName: o.displayName || o.username,
    role: o.role, vaAdId: o.vaAdId || VA, vaName: 'Test VA',
    active: o.active !== false, passwordHash: 'x', createdVia: 'owner',
    stored: { role: o.role, active: o.active !== false },
    saves: 0,
    async save() { this.saves += 1; this.stored = { role: this.role, active: this.active }; },
});

/**
 * Stand a team under the model and run one request.
 *
 * `failSaveFor` makes one account's write throw, which is how the ordering
 * property is actually observed rather than asserted about in a comment.
 */
async function run(key, { team, actor, params = {}, body = {}, failSaveFor = null }) {
    const rows = team.map(doc);
    for (const r of rows) {
        if (r._id === failSaveFor) r.save = async () => { throw new Error('write failed'); };
    }
    VaPortalAccount.findById = async (id) => rows.find((r) => String(r._id) === String(id)) || null;
    VaPortalAccount.findOne = async (q) => rows.find((r) => {
        if (q.vaAdId && String(r.vaAdId) !== String(q.vaAdId)) return false;
        if (q.role && r.role !== q.role) return false;
        if (q._id && q._id.$ne && String(r._id) === String(q._id.$ne)) return false;
        return true;
    }) || null;
    VaPortalAccount.exists = async () => null;

    const handlers = routes[key];
    const handler = handlers[handlers.length - 1];
    let status = 200; let payload = null;
    const res = { status(s) { status = s; return this; }, json(b) { payload = b; return this; } };
    const req = {
        params, body,
        portal: rows.find((r) => String(r._id) === String(actor)),
        // The oversight routes read this for their log line.
        staff: { displayName: 'Inflight Staff', username: 'inflight', role: 'admin' },
    };
    try { await handler(req, res); } catch (e) { status = 500; payload = { error: e.message }; }
    const by = (id) => rows.find((r) => r._id === id);
    return {
        status, body: payload, rows, by,
        // What the database would be holding afterwards, which is the only
        // thing that survives the request.
        roleOf: (id) => (by(id) || {}).stored.role,
        owners: () => rows.filter((r) => r.stored.role === 'owner').length,
    };
}

const OWNER = { id: 'o1', username: 'founder', role: 'owner' };
const MATE = { id: 's1', username: 'mate', displayName: 'Robin', role: 'staff' };
const PILOT = { id: 'p1', username: 'flyer', role: 'pilot' };

const TRANSFER = 'POST /api/va-portal/team/:id/transfer-owner';
const TEAM_PATCH = 'PATCH /api/va-portal/team/:id';
const ADMIN_PATCH = 'PATCH /api/va-portal/admin/accounts/:id';

(async () => {
    /* ------------------------------------------------------ the gate */
    {
        check('handing the VA over is owner-only',
            routes[TRANSFER][0] === vaPortal.requirePortalOwner);
        check('…as is editing a teammate',
            routes[TEAM_PATCH][0] === vaPortal.requirePortalOwner);
    }

    /* ---------------------------------------------------- the handover */
    {
        const r = await run(TRANSFER, { team: [OWNER, MATE], actor: 'o1', params: { id: 's1' } });
        check('a staff teammate can be made the owner', r.status === 200, r.body);
        check('…they hold it', r.roleOf('s1') === 'owner', r.roleOf('s1'));
        check('…and the outgoing owner becomes staff', r.roleOf('o1') === 'staff', r.roleOf('o1'));
        check('…so the VA still has exactly one owner', r.owners() === 1, r.owners());
        check('…the outgoing owner keeps a working account, not a locked one',
            r.by('o1').active === true);
        check('…and is told they stepped down, so the screen can reload',
            r.body.steppedDown === true && r.body.you && r.body.you.role === 'staff', r.body.you);
    }

    /* ------------------------------- the order, observed rather than asserted */
    {
        // The second write fails. What is left has to be the recoverable state.
        const r = await run(TRANSFER, {
            team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, failSaveFor: 'o1',
        });
        check('when the demote fails, the VA is left with two owners',
            r.owners() === 2, r.owners());
        check('…and never with none, which is the state nobody on the VA could undo',
            r.owners() >= 1, r.owners());
    }
    {
        // And the promote failing leaves everything exactly as it was.
        const r = await run(TRANSFER, {
            team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, failSaveFor: 's1',
        });
        check('when the promote fails, nothing moved at all',
            r.roleOf('o1') === 'owner' && r.roleOf('s1') === 'staff',
            [r.roleOf('o1'), r.roleOf('s1')]);
        check('…and it is reported as a failure', r.status === 500, r.status);
    }

    /* ------------------------------------------------- who may receive it */
    {
        const r = await run(TRANSFER, { team: [OWNER, PILOT], actor: 'o1', params: { id: 'p1' } });
        check('a pilot cannot be handed the VA — they have never opened this portal',
            r.status === 400 && /staff/i.test(r.body.error), r.body);
        check('…and nothing moved', r.roleOf('o1') === 'owner' && r.roleOf('p1') === 'pilot');
    }
    {
        const r = await run(TRANSFER, {
            team: [OWNER, { ...MATE, active: false }], actor: 'o1', params: { id: 's1' },
        });
        check('a disabled account cannot be handed the VA either',
            r.status === 400 && /enable/i.test(r.body.error), r.body);
    }
    {
        const r = await run(TRANSFER, { team: [OWNER, MATE], actor: 'o1', params: { id: 'o1' } });
        check('handing it to yourself is refused rather than half-done',
            r.status === 400, r.body);
        check('…and you are still the owner', r.roleOf('o1') === 'owner');
    }
    {
        const r = await run(TRANSFER, {
            team: [OWNER, { ...MATE, vaAdId: 'va-2' }], actor: 'o1', params: { id: 's1' },
        });
        check('somebody else’s teammate is not found, let alone promoted',
            r.status === 404, r.body);
    }

    /* --------------------------------------------- moving between the roles */
    {
        const r = await run(TEAM_PATCH, { team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { role: 'pilot' } });
        check('a staff teammate can be put back on the line as a pilot',
            r.status === 200 && r.roleOf('s1') === 'pilot', r.body);
    }
    {
        const r = await run(TEAM_PATCH, { team: [OWNER, PILOT], actor: 'o1', params: { id: 'p1' }, body: { role: 'staff' } });
        check('…and a pilot who joins the office becomes staff',
            r.status === 200 && r.roleOf('p1') === 'staff', r.body);
    }
    {
        // The route that would otherwise leave two owners, or none.
        const r = await run(TEAM_PATCH, { team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { role: 'owner' } });
        check('owner is NOT a role you can PATCH somebody into',
            r.status === 400 && r.body.code === 'use_transfer', r.body);
        check('…and it points at the transfer instead', /make owner/i.test(r.body.error), r.body.error);
        check('…and nobody moved', r.roleOf('s1') === 'staff');
    }
    {
        const r = await run(TEAM_PATCH, { team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { role: 'wizard' } });
        check('a role that does not exist is refused', r.status === 400, r.body);
        check('…rather than silently ignored', r.roleOf('s1') === 'staff');
    }
    {
        const r = await run(TEAM_PATCH, { team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { displayName: 'Robin R' } });
        check('a patch with no role still works and leaves the role alone',
            r.status === 200 && r.roleOf('s1') === 'staff' && r.by('s1').displayName === 'Robin R', r.body);
    }
    {
        const r = await run(TEAM_PATCH, { team: [OWNER, MATE], actor: 'o1', params: { id: 'o1' }, body: { role: 'staff' } });
        check('the owner row is still not editable here', r.status === 400, r.body);
    }

    /* ------------------------------------ the same rule on the Inflight side */
    {
        // Creating a second owner is guarded on POST /admin/accounts; promoting
        // one here was not, so an oversight edit could leave a VA with two.
        const r = await run(ADMIN_PATCH, {
            team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { role: 'owner' },
        });
        check('Inflight promoting a teammate makes them the owner',
            r.roleOf('s1') === 'owner', r.roleOf('s1'));
        check('…and demotes the sitting owner in the same breath',
            r.roleOf('o1') === 'staff', r.roleOf('o1'));
        check('…leaving exactly one', r.owners() === 1, r.owners());
        check('…and saying whose place was taken',
            r.body && r.body.demoted && r.body.demoted.username === 'founder', r.body && r.body.demoted);
    }
    {
        const r = await run(ADMIN_PATCH, {
            team: [OWNER, MATE], actor: 'o1', params: { id: 's1' }, body: { role: 'pilot' },
        });
        check('an ordinary oversight role change still just sets the role',
            r.roleOf('s1') === 'pilot' && r.roleOf('o1') === 'owner',
            [r.roleOf('s1'), r.roleOf('o1')]);
        check('…and reports nobody demoted', !r.body.demoted, r.body && r.body.demoted);
    }

    console.log(`${pass} passed, ${fails.length} failed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
