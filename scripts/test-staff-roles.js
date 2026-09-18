// test-staff-roles.js
// Who can be made an admin, who can step down, and who must never be demoted.
//
// WHY THIS EXISTS
//
// The staff portal's account table had one shield button that moved a person to
// the NEXT role along, and it was hidden on your own row. So making somebody an
// admin meant pressing it three times and reading a tooltip to know where you
// were in the loop — and handing the workspace over, which is promote them then
// step down, was impossible from the screen entirely. The table is a picker
// now, and these are the server-side rules it is a picker over.
//
// Every one of them is a lockout. Get the last-admin guard wrong in one
// direction and a workspace ends up with nobody who can manage accounts, which
// no amount of clicking fixes; get it wrong in the other and an admin can never
// hand over. So they are asserted here rather than only in a browser.
//
// The routes are registered against a fake `app` and the handler is called
// directly with a fake request, because none of this is a question about Mongo.
//
// Run:  node scripts/test-staff-roles.js
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const staffAuth = require('../staffAuth');
const { StaffUser, registerAuthRoutes, requireAdmin } = staffAuth;

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

/* ---------------------------------------------------------------- harness */

// Collect the routes instead of serving them. Only the ones this file drives
// are kept; everything else registers and is ignored.
const routes = {};
const app = {
    get: (p, ...h) => { routes['GET ' + p] = h; },
    post: (p, ...h) => { routes['POST ' + p] = h; },
    patch: (p, ...h) => { routes['PATCH ' + p] = h; },
    delete: (p, ...h) => { routes['DELETE ' + p] = h; },
    use: () => {},
};
registerAuthRoutes(app);

/** A staff account, as a document just real enough for the handler. */
const doc = (o) => ({
    _id: o.id, username: o.username, displayName: o.displayName || o.username,
    role: o.role, active: o.active !== false, passwordHash: 'x',
    lastLoginAt: null, createdAt: new Date(),
    saved: false,
    async save() { this.saved = true; },
});

/**
 * Stand a table of accounts under the model, and run one PATCH against it.
 *
 * `countDocuments` is answered from the same table the handler is editing, so
 * the last-admin guard is counting what it would really be counting.
 */
async function patch({ table, actor, targetId, body }) {
    const rows = table.map(doc);
    StaffUser.findById = async (id) => rows.find((r) => String(r._id) === String(id)) || null;
    StaffUser.countDocuments = async (q) => rows.filter((r) => {
        if (q.role && r.role !== q.role) return false;
        if (q.active !== undefined && r.active !== q.active) return false;
        if (q._id && q._id.$ne && String(r._id) === String(q._id.$ne)) return false;
        return true;
    }).length;

    const handlers = routes['PATCH /api/auth/users/:id'];
    // The gate is asserted separately below; here the handler is called with
    // the actor already resolved, which is what requireAdmin would have done.
    const handler = handlers[handlers.length - 1];

    let status = 200; let payload = null;
    const res = {
        status(s) { status = s; return this; },
        json(b) { payload = b; return this; },
    };
    await handler({ params: { id: targetId }, body, staff: rows.find((r) => String(r._id) === String(actor)) }, res);
    return { status, body: payload, rows };
}

const OWNER = { id: 'a1', username: 'owner', role: 'admin' };
const SECOND = { id: 'a2', username: 'second', role: 'admin' };
const HELPER = { id: 's1', username: 'helper', role: 'staff' };
const REP = { id: 'r1', username: 'rep', role: 'va_rep' };

(async () => {
    /* ------------------------------------------------ the gate on the route */
    {
        const handlers = routes['PATCH /api/auth/users/:id'];
        check('changing a role is admin-only', handlers[0] === requireAdmin);
        check('so is creating an account', routes['POST /api/auth/users'][0] === requireAdmin);
        check('…and deleting one', routes['DELETE /api/auth/users/:id'][0] === requireAdmin);
        check('…and even listing them', routes['GET /api/auth/users'][0] === requireAdmin);
    }

    /* ------------------------------------------------------------ promoting */
    {
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 's1', body: { role: 'admin' } });
        check('a staff account can be made an admin', r.status === 200 && r.body.user.role === 'admin',
            r.body && r.body.user && r.body.user.role);
        check('…and the change is saved, not just answered',
            r.rows.find((x) => x._id === 's1').saved);
        check('…and reported as a change', r.body.roleChanged === true);
        check('…and not as something the caller did to themselves', r.body.self === false);
    }
    {
        const r = await patch({ table: [OWNER, REP], actor: 'a1', targetId: 'r1', body: { role: 'graphic_designer' } });
        check('any of the scoped roles can be moved to any other',
            r.status === 200 && r.body.user.role === 'graphic_designer', r.body && r.body.user && r.body.user.role);
    }
    {
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 's1', body: { role: 'staff' } });
        check('setting the role somebody already has is not a change',
            r.status === 200 && r.body.roleChanged === false, r.body && r.body.roleChanged);
    }

    /* ------------------------------------------------- handing the place over */
    {
        // The whole point: promote somebody, then step down. The first half is
        // above; this is the second, and it is what the old screen could not do
        // because it hid the control on your own row.
        const r = await patch({ table: [OWNER, SECOND], actor: 'a1', targetId: 'a1', body: { role: 'staff' } });
        check('an admin can step down while another admin is holding the door',
            r.status === 200 && r.body.user.role === 'staff', r.body && (r.body.error || r.body.user.role));
        check('…and is told it was their own account', r.body.self === true);
        check('…and that the role is what moved, so the page can reload itself',
            r.body.roleChanged === true);
    }

    /* ------------------------------------------------------------- lockouts */
    {
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 'a1', body: { role: 'staff' } });
        check('the last active admin cannot step down',
            r.status === 400 && /last active admin/i.test(r.body.error), r.body);
        check('…and nothing was written', !r.rows.find((x) => x._id === 'a1').saved);
    }
    {
        const r = await patch({ table: [OWNER, SECOND], actor: 'a1', targetId: 'a2', body: { role: 'staff' } });
        check('one of two admins can be demoted by the other',
            r.status === 200 && r.body.user.role === 'staff', r.body && r.body.error);
    }
    {
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 'a1', body: { active: false } });
        check('the last active admin cannot disable themselves either',
            r.status === 400 && /last active admin/i.test(r.body.error), r.body);
    }
    {
        // Two admins on paper, one of them switched off: demoting the one who
        // is actually holding the workspace still empties it.
        const r = await patch({
            table: [OWNER, { ...SECOND, active: false }], actor: 'a1', targetId: 'a1', body: { role: 'staff' },
        });
        check('a DISABLED second admin does not count as cover',
            r.status === 400 && /last active admin/i.test(r.body.error), r.body);
    }

    /* --------------------------------------------------- a role we do not have */
    {
        // The regression this guards: an unrecognised role used to be dropped
        // in silence and answered 200, so the table showed a role the account
        // had not got until the next reload put it back.
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 's1', body: { role: 'owner' } });
        check('a role that does not exist is refused, not ignored', r.status === 400, r.body);
        check('…and the refusal names the roles that do exist',
            /admin/.test(r.body.error) && /graphic_designer/.test(r.body.error), r.body && r.body.error);
        check('…and the account is untouched', !r.rows.find((x) => x._id === 's1').saved);
    }
    {
        const r = await patch({ table: [OWNER, HELPER], actor: 'a1', targetId: 's1', body: { displayName: 'Helper H' } });
        check('a patch that mentions no role at all still works',
            r.status === 200 && r.body.user.displayName === 'Helper H', r.body);
        check('…and leaves the role where it was', r.body.user.role === 'staff', r.body.user.role);
        check('…and says nothing changed about it', r.body.roleChanged === false);
    }

    /* -------------------------------------------------------- the role list */
    {
        // The picker in staff.html offers exactly these four. A role added to
        // the server and not to the table is a role nobody can assign.
        const inPage = require('fs').readFileSync(require('path').join(__dirname, '..', 'staff.html'), 'utf8');
        const m = inPage.match(/\['admin', 'staff', 'va_rep', 'graphic_designer'\]\.map/);
        check('the account table offers every role the server accepts', !!m);
    }

    console.log(`${pass} passed, ${fails.length} failed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
