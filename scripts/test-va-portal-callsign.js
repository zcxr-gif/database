// test-va-portal-callsign.js
// Callsigns from the VA Partnership Portal: an owner picking their own, and an
// owner giving one to a teammate as they add them.
//
// The callsign itself lives in the VA's crew store and is vetted by server.js
// (portalCallsigns → crewAuth.setUpStaffPilotSide, which
// test-crew-staff-pilot.js covers). What is checked HERE is the portal's half:
// the order things happen in, and that a callsign can never quietly go missing.
//
//   * a taken number stops "add a teammate" BEFORE the account exists
//   * a crew center with no database still gets its teammate, and is told the
//     callsign has to wait — rather than either losing the teammate or the
//     sentence
//   * the owner's own callsign is theirs to set; an empty one is refused
//
// Run:  node scripts/test-va-portal-callsign.js
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

/* The bridge server.js hands over, faked: BAW001 is somebody's, and a VA can
   be switched to "no database" to watch the other branch. */
let STORE_UP = true;
const SET = [];
const bridge = {
    info: async () => (STORE_UP ? { ok: true, available: true, callsign: 'BAW007', sample: 'BAW 001VA' }
        : { ok: false, code: 'store_not_connected', error: 'not connected' }),
    check: async ({ callsign }) => {
        if (!STORE_UP) return { ok: false, code: 'store_not_connected', error: 'not connected' };
        return callsign.toUpperCase() === 'BAW001'
            ? { ok: false, code: 'callsign_taken', error: 'BAW001 is already flown by Sam.', callsign: 'BAW001' }
            : { ok: true, callsign: callsign.toUpperCase() };
    },
    set: async ({ account, callsign }) => {
        if (!STORE_UP) return { ok: false, code: 'store_not_connected', error: 'Connect your database first.' };
        if (callsign.toUpperCase() === 'BAW001') return { ok: false, code: 'callsign_taken', error: 'taken' };
        SET.push({ who: String(account._id), callsign: callsign.toUpperCase() });
        return { ok: true, callsign: callsign.toUpperCase(), created: true };
    },
    forAccounts: async () => ({ o1: 'BAW007' }),
};

const routes = {};
const app = {
    get: (p, ...h) => { routes['GET ' + p] = h; },
    post: (p, ...h) => { routes['POST ' + p] = h; },
    patch: (p, ...h) => { routes['PATCH ' + p] = h; },
    delete: (p, ...h) => { routes['DELETE ' + p] = h; },
    use: () => {},
};
vaPortal.registerVaPortalRoutes(app, {
    VirtualAirlineAd: { findById: async () => null, findOne: async () => null },
    EmbedConfig: {}, VaPilot: {}, s3Client: {},
    upload: { single: () => (q, s, n) => n(), array: () => (q, s, n) => n(), fields: () => (q, s, n) => n() },
    uploadVaImage: async () => '', deleteVaImage: async () => {},
    isDiscordWebhookUrl: () => true, sendVaTestEvent: async () => {},
    renderCardPreview: async () => Buffer.alloc(0), applyEmbedAppearance: () => {},
    portalCallsigns: bridge,
});

const OWNER = { _id: 'o1', username: 'founder', displayName: 'Founder', role: 'owner', vaAdId: 'va-1', vaName: 'Test VA', active: true };
let CREATED = [];
VaPortalAccount.exists = async () => null;
VaPortalAccount.create = async (o) => { const a = { _id: `n${CREATED.length + 1}`, ...o, async save() {} }; CREATED.push(a); return a; };
VaPortalAccount.find = () => ({ sort: async () => [OWNER] });

async function run(key, { body = {}, params = {}, portal = OWNER } = {}) {
    const h = routes[key];
    let status = 200; let payload = null;
    const res = { status(s) { status = s; return this; }, json(b) { payload = b; return this; }, set() { return this; } };
    try { await h[h.length - 1]({ body, params, portal }, res); } catch (e) { status = 500; payload = { error: e.message }; }
    return { status, body: payload };
}

(async () => {
    {
        CREATED = []; SET.length = 0; STORE_UP = true;
        const r = await run('POST /api/va-portal/team', { body: { username: 'robin', password: 'password1', role: 'staff', callsign: 'BAW001' } });
        check('a taken callsign stops "add a teammate"', r.status === 409 && r.body.code === 'callsign_taken', r);
        check('…before the account exists', CREATED.length === 0, CREATED.length);
    }
    {
        CREATED = []; SET.length = 0; STORE_UP = true;
        const r = await run('POST /api/va-portal/team', { body: { username: 'robin', password: 'password1', role: 'staff', callsign: 'baw012' } });
        check('a free callsign is given with the account', r.status === 201 && r.body.account.callsign === 'BAW012', r);
        check('…to the new account, not the owner', SET.length === 1 && SET[0].who === 'n1', SET);
    }
    {
        CREATED = []; SET.length = 0; STORE_UP = false;
        const r = await run('POST /api/va-portal/team', { body: { username: 'robin', password: 'password1', role: 'staff', callsign: 'BAW012' } });
        check('no database: the teammate is still added', r.status === 201 && CREATED.length === 1, r);
        check('…and told the callsign has to wait', !!r.body.callsignWarning && r.body.account.callsign === '', r.body);
    }
    {
        CREATED = []; SET.length = 0; STORE_UP = true;
        const r = await run('POST /api/va-portal/team', { body: { username: 'robin', password: 'password1', role: 'staff' } });
        check('no callsign asked for, none set', r.status === 201 && SET.length === 0 && !r.body.callsignWarning, r);
    }
    {
        STORE_UP = true; SET.length = 0;
        const mine = await run('POST /api/va-portal/me/callsign', { body: { callsign: 'BAW 1' } });
        check('the owner sets their own', mine.status === 200 && SET[0] && SET[0].who === 'o1', mine);
        const empty = await run('POST /api/va-portal/me/callsign', { body: { callsign: '  ' } });
        check('…an empty one is refused, not read as "clear it"', empty.status === 400, empty);
        const taken = await run('POST /api/va-portal/me/callsign', { body: { callsign: 'BAW001' } });
        check('…a taken one is a 409', taken.status === 409, taken);
        const asked = await run('POST /api/va-portal/me/callsign', { body: { callsign: 'BAW001', check: true } });
        check('…and `check` only asks', asked.body && asked.body.ok === false && SET.length === 1, asked);
        const info = await run('GET /api/va-portal/me/callsign');
        check('what they fly as now is readable', info.body.callsign === 'BAW007' && info.body.sample === 'BAW 001VA', info.body);
    }
    {
        const r = await run('GET /api/va-portal/team');
        check('the team list carries callsigns', r.body.team[0].callsign === 'BAW007', r.body);
    }

    console.log(`${pass} passed, ${fails.length} failed`);
    if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
})();
