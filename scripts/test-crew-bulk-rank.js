// test-crew-bulk-rank.js
// Locking a whole airline's routes to one rank at once, and the live-flight
// list and card the crew bot's /crew live and /crew flight are built on —
// driven through the REAL server.js with Mongo, the VA's database and the
// outside world replaced by memory (the harness of test-crew-featured-routes).
//
// Run:  node scripts/test-crew-bulk-rank.js
'use strict';

process.env.JWT_SECRET = 'test-secret-bulk-rank';
process.env.PORT = String(45000 + Math.floor(Math.random() * 2000));
process.env.FEATURED_SWEEP_DISABLED = '1';
delete process.env.MONGODB_URI;
delete process.env.MONGO_URI;

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

/* ---------------------------------------------------------------- the VA */
const HOOK = 'https://discord.com/api/webhooks/123456/featured-test-token';
const VA = {
    _id: 'va1', slug: 'am', name: 'Aeroméxico Virtual', callsign: 'AEROMEXICO ###AM', status: 'approved',
    crewAccent: '#0b2340', logoUrl: 'https://cdn.example/am-logo.png',
    ranks: [{ name: 'Cadet', minHours: 0 }, { name: 'Captain', minHours: 500 }],
    crewShop: { enabled: true, currencyName: 'Miles', currencyShort: 'mi', perHour: 100 },
    crewFeatured: {}, crewWebhookUrl: HOOK, crewWebhooks: {},
    supabaseUrl: 'https://x.supabase.co', supabaseServiceKey: 'k',
};

// Apply a `$set` with dotted paths to the VA, so a save is a save.
function applySet(target, set) {
    for (const [path, value] of Object.entries(set || {})) {
        const keys = path.split('.');
        let at = target;
        for (const k of keys.slice(0, -1)) { at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {}; at = at[k]; }
        at[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
    }
}
const query = (v) => {
    const q = {
        select: () => q, lean: () => Promise.resolve(v), sort: () => q, limit: () => q,
        then: (a, b) => Promise.resolve(v).then(a, b), catch: (b) => Promise.resolve(v).catch(b),
        exec: () => Promise.resolve(v),
    };
    return q;
};
const isVa = (m) => m && m.modelName === 'VirtualAirlineAd';
const copy = () => JSON.parse(JSON.stringify(VA));
mongoose.Model.findOne = function () { return query(isVa(this) ? copy() : null); };
mongoose.Model.findById = function () { return query(isVa(this) ? copy() : null); };
mongoose.Model.find = function () { return query(isVa(this) ? [] : []); };
mongoose.Model.countDocuments = function () { return query(0); };
mongoose.Model.exists = function () { return query(null); };
mongoose.Model.updateOne = function (filter, update) {
    if (isVa(this) && update && update.$set) applySet(VA, update.$set);
    return query({ modifiedCount: 1 });
};
mongoose.Model.findOneAndUpdate = function () { return query(null); };
mongoose.Model.findByIdAndUpdate = function () { return query(null); };
mongoose.Model.create = async function (d) { return d; };
mongoose.connect = async () => {};

/* ---------------------------------------------------- the VA's own database */
let SEQ = 0;
const id = () => `00000000-0000-4000-8000-${String(++SEQ).padStart(12, '0')}`;
const route = (n, extra) => ({
    _id: id(), flightNumber: `AM${n}`, origin: 'MMMX', destination: 'KJFK', aircraft: 'Boeing 737-800', distanceNm: 2000,
    notes: '', active: true, kind: 'own', partnerName: '', partnerLogo: '', minRank: '', ...(extra || {}),
});
const DB = {
    routes: [
        route(1), route(2), route(3, { minRank: 'Captain' }),
        route(4, { kind: 'codeshare', partnerName: 'Borealis Virtual' }),
        route(5, { kind: 'codeshare', partnerName: 'Borealis Virtual' }),
        route(6, { kind: 'codeshare', partnerName: 'Iberia Virtual' }),
    ],
    members: [{ _id: id(), name: 'Rae Okafor', callsign: 'AM101', hours: 3, ifUserId: 'if-user-1' }],
    accounts: [],
};
const writes = [];
const store = {
    drift: () => [],
    health: async () => ({ ok: true, provisioned: true, version: 26 }),
    listRoutes: async () => DB.routes.map((r) => ({ ...r })),
    getRoute: async (i) => DB.routes.find((r) => r._id === i) || null,
    setRoutesRank: async (ids, minRank) => {
        writes.push({ ids: ids.slice(), minRank });
        let n = 0;
        for (const r of DB.routes) if (ids.includes(r._id)) { r.minRank = minRank; n++; }
        return n;
    },
    getMember: async (i) => DB.members.find((m) => m._id === i) || null,
    listMembers: async () => DB.members.slice(),
    getAccount: async () => null,
    listAccounts: async () => [],
};
const crewStore = require('../crewStore');
crewStore.forVa = async () => store;
crewStore.forVaOrNull = async () => store;

// Nothing leaves the building. Discord posts are recorded; logo hosts 404.
const axios = require('axios');
const posts = [];
axios.post = async (url, body) => {
    if (String(url).startsWith('https://discord.com/api/webhooks/')) {
        const isForm = body && typeof body.append === 'function';
        let payload = body;
        let files = [];
        if (isForm) {
            payload = JSON.parse(body.get('payload_json'));
            files = [...body.keys()].filter((k) => k.startsWith('files['));
        }
        posts.push({ url, payload, files });
        return { status: 204, data: {} };
    }
    return { status: 204, data: {} };
};
const asked = [];
axios.get = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.endsWith('/api/va/roster')) {
        return { data: { flights: [
            { flightId: 'fl-1', userId: 'if-user-1', username: 'rae_if', callsign: 'Aeromexico 101AM', server: 'Expert',
                altitude: 36000, speed: 470, heading: 45, verticalSpeed: 0, latitude: 25, longitude: -95 },
            { flightId: 'fl-2', userId: 'if-user-9', username: 'stranger', callsign: 'Aeromexico 202AM', server: 'Expert',
                altitude: 0, speed: 0, heading: 0, latitude: 19.43, longitude: -99.07 },
        ] } };
    }
    if (u.includes('/api/flights/fl-1/history')) {
        return { data: { ok: true, path: [{ lat: 19.436, lon: -99.072 }, { lat: 22, lon: -97 }, { lat: 25, lon: -95 }] } };
    }
    if (u.includes('/api/flights/fl-1/plan')) {
        return { data: { waypoints: [{ name: 'MMMX', lat: 19.436, lon: -99.072 }, { name: 'KJFK', lat: 40.64, lon: -73.78 }] } };
    }
    const e = new Error('offline'); e.response = { status: 404 }; throw e;
};

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw).slice(0, 500)})`));
};

require('../server.js');
const vaBot = require('../vaBot');

const base = `http://127.0.0.1:${process.env.PORT}`;
const owner = jwt.sign({ typ: 'crew', sub: 'aaaaaaaaaaaaaaaaaaaaaaa1', kind: 'va', role: 'owner', view: 'owner', slug: 'am', vaId: 'va1', name: 'Founder' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, body, token, extra) => {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra || {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
};
const settle = () => new Promise((r) => setTimeout(r, 400));
const ranks = () => DB.routes.map((r) => r.minRank);

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/crew/am/invite-banner.png?kind=footer'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
}

(async () => {
    await waitForServer();

    /* ---- bulk rank lock ---------------------------------------------- */
    const anon = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'own', minRank: 'Captain' });
    check('a stranger cannot lock routes', anon.status === 401, anon);

    const bad = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'own', minRank: 'Admiral' }, owner);
    check('a rank that is not on the ladder is refused, not written', bad.status === 400 && !writes.length, bad.body);

    const dry = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'own', minRank: 'captain', dryRun: true }, owner);
    check('a dry run counts own metal not yet at Captain', dry.status === 200 && dry.body.dryRun && dry.body.matched === 2, dry.body);
    check('…spells the rank the ladder’s way', dry.body.minRank === 'Captain', dry.body);
    check('…and changes nothing', !writes.length);

    const own = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'own', minRank: 'Captain' }, owner);
    await settle();
    check('own metal is locked to Captain in one write', own.status === 200 && own.body.updated === 2 && writes.length === 1, own.body);
    check('…only own metal', JSON.stringify(ranks()) === JSON.stringify(['Captain', 'Captain', 'Captain', '', '', '']), ranks());
    const notice = posts[posts.length - 1];
    check('…with one notice to the routes feed', notice && /locked to Captain/.test(notice.payload.embeds[0].title), notice && notice.payload);

    const partner = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'borealis virtual', minRank: 'Cadet' }, owner);
    check('one partner’s codeshares, by name, case aside', partner.body.updated === 2
        && JSON.stringify(ranks()) === JSON.stringify(['Captain', 'Captain', 'Captain', 'Cadet', 'Cadet', '']), ranks());

    const keep = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'all', minRank: 'Cadet', onlyOpen: true }, owner);
    check('“leave gated routes alone” touches only the open one', keep.body.updated === 1 && ranks()[5] === 'Cadet', ranks());

    const picked = await call('POST', '/api/crew/am/routes/bulk-rank', { ids: [DB.routes[0]._id, DB.routes[5]._id], minRank: '' }, owner);
    check('ticked routes can be opened back up', picked.body.updated === 2 && ranks()[0] === '' && ranks()[5] === '' && ranks()[1] === 'Captain', ranks());

    const again = await call('POST', '/api/crew/am/routes/bulk-rank', { airline: 'own', minRank: 'Captain', dryRun: true }, owner);
    check('routes already at the rank are not counted as a change', again.body.matched === 1, again.body);

    /* ---- who is flying now ------------------------------------------- */
    const live = await call('GET', '/api/crew/am/live');
    const fl = (live.body && live.body.flights) || [];
    check('the live list is public', live.status === 200 && fl.length === 2, live.body);
    check('…airborne first', fl[0] && fl[0].flightId === 'fl-1' && fl[1].onGround === true, fl);
    check('…with the roster name joined on the IF user id', fl[0] && fl[0].pilot && fl[0].pilot.name === 'Rae Okafor' && fl[1].pilot === null, fl);
    check('…and the route off the filed plan', fl[0] && fl[0].origin === 'MMMX' && fl[0].destination === 'KJFK', fl[0]);

    const pub = await call('GET', '/api/crew/am/live/fl-1/card');
    check('the drawn card is not public', pub.status === 403, pub);
    const botHeaders = vaBot.callerHeaders('am', 'Tester');
    const card = await call('GET', '/api/crew/am/live/fl-1/card', null, null, botHeaders);
    check('the bot gets the satellite map', card.status === 200 && card.body.map.length > 1000 && card.body.card === undefined,
        card.body && { ...card.body, map: (card.body.map || '').length });
    check('…drawn with the flown track asked for', asked.some((u) => u.includes('/api/flights/fl-1/history')), asked);
    const elsewhere = await call('GET', '/api/crew/am/live/not-ours/card', null, null, botHeaders);
    check('a flight not flying for the airline is not drawn', elsewhere.status === 404, elsewhere.body);
    const otherVa = await call('GET', '/api/crew/am/live/fl-1/card', null, null, vaBot.callerHeaders('zz', 'Tester'));
    check('the bot acting for another airline cannot draw this one’s', otherVa.status === 403, otherVa);

    console.log(`${pass} passed, ${fails.length} failed`);
    if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
