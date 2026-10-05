// test-crew-featured-routes.js
// The Route of the Week / of the Day, driven through the REAL server.js — its
// routes, its auth, its pay — with only Mongo, the VA's own database and the
// outside world (Discord, logo hosts) replaced by memory.
//
// WHAT THIS FILE IS DEFENDING
//
//   * The week is seven legs and the day is one, and every one of them is open
//     to every pilot whatever their rank — on the featured tiles and in the
//     route list alike.
//   * Staff can draft a week, and pilots do not see a draft. Released, it is
//     the week, and it goes to Discord as a card (an image, with the legs as
//     text around it) — and only to the featured feed.
//   * A plan for a week that is over, or naming a leg that is not on the
//     network, is refused where staff are looking rather than lapsing quietly.
//   * A pilot can file a flight AS the Route of the Week — the leg fills in the
//     airports — and a flight that is not a featured leg cannot claim to be.
//   * A codeshare route announces itself with the partner's logo.
//
// Run:  node scripts/test-crew-featured-routes.js
'use strict';

process.env.JWT_SECRET = 'test-secret-featured';
process.env.PORT = String(43000 + Math.floor(Math.random() * 2000));
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
const route = (n, origin, destination, extra) => ({
    _id: id(), flightNumber: `AM${n}`, origin, destination, aircraft: 'Boeing 737-800', distanceNm: 400 + n * 10,
    active: true, kind: 'own', partnerName: '', partnerLogo: '', minRank: '', ...(extra || {}),
});
const DB = {
    routes: [
        route(1, 'MMMX', 'KJFK', { minRank: 'Captain' }),
        route(2, 'MMMX', 'LEMD', { minRank: 'Captain' }),
        route(3, 'MMGL', 'KLAX', { minRank: 'Captain' }),
        route(4, 'MMUN', 'MMMX', { minRank: 'Captain' }),
        route(5, 'MMMX', 'SCEL', { minRank: 'Captain' }),
        route(6, 'MMMX', 'RJAA', { minRank: 'Captain' }),
        route(7, 'MMMY', 'KDFW', { minRank: 'Captain' }),
        route(8, 'MMMX', 'MPTO', { minRank: 'Captain' }),
        route(9, 'CYYZ', 'MMMX', { minRank: 'Captain', kind: 'codeshare', partnerName: 'Borealis Virtual', partnerLogo: 'https://cdn.example/borealis.png' }),
        route(10, 'MMMX', 'MMTJ', { active: false }),
    ],
    members: [], accounts: [], pireps: [],
};
const pilot = { _id: id(), name: 'Rae Okafor', callsign: 'AM101', hours: 3 };
DB.members.push(pilot);
const account = { _id: id(), memberId: pilot._id, username: 'rae', active: true };
DB.accounts.push(account);

const store = {
    drift: () => [],
    health: async () => ({ ok: true, provisioned: true, version: 26 }),
    listRoutes: async ({ activeOnly } = {}) => DB.routes.filter((r) => !activeOnly || r.active !== false).map((r) => ({ ...r })),
    getRoute: async (i) => DB.routes.find((r) => r._id === i) || null,
    createRoute: async (d) => { const r = { _id: id(), active: true, kind: 'own', ...d }; DB.routes.push(r); return r; },
    getMember: async (i) => DB.members.find((m) => m._id === i) || null,
    listMembers: async () => DB.members.slice(),
    getAccount: async (i) => DB.accounts.find((a) => a._id === i) || null,
    listAccounts: async () => DB.accounts.slice(),
    createPirep: async (d) => { const p = { _id: id(), createdAt: new Date(), ...d }; DB.pireps.push(p); return p; },
    seenFlightIds: async () => new Set(),
    listPirepsForMember: async () => [],
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
axios.get = async () => { const e = new Error('offline'); e.response = { status: 404 }; throw e; };

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw).slice(0, 500)})`));
};

require('../server.js');

const base = `http://127.0.0.1:${process.env.PORT}`;
const owner = jwt.sign({ typ: 'crew', sub: 'aaaaaaaaaaaaaaaaaaaaaaa1', kind: 'va', role: 'owner', view: 'owner', slug: 'am', vaId: 'va1', name: 'Founder' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
const pilotToken = jwt.sign({ typ: 'crew', sub: account._id, kind: 'crew', role: 'pilot', slug: 'am', vaId: 'va1', name: 'Rae Okafor' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
};
const settle = () => new Promise((r) => setTimeout(r, 400));

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/crew/am/invite-banner.png?kind=footer'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
}

(async () => {
    await waitForServer();

    /* ---- what everybody sees ------------------------------------------- */
    const pub = await call('GET', '/api/crew/am/featured-routes', null, pilotToken);
    const week = pub.body && pub.body.week;
    const day = pub.body && pub.body.day;
    check('the week is seven legs', pub.status === 200 && week && week.legs.length === 7, pub.body);
    check('the day is one', day && day.legs.length === 1, day);
    check('…and not one of the week’s', day && !week.legs.some((l) => l.route.id === day.legs[0].route.id));
    check('every featured leg is open to a 3-hour pilot, though all are Captain-gated',
        [...week.legs, ...day.legs].every((l) => l.route.locked === false && l.route.minRank === 'Captain'
            || l.route.kind === 'codeshare'), week.legs.map((l) => [l.route.minRank, l.route.locked]));
    check('the week pays a bonus somewhere', week.legs.some((l) => l.bonus > 1), week.legs.map((l) => l.bonus));
    check('…in the airline’s own currency', pub.body.currency && pub.body.currency.short === 'mi', pub.body.currency);
    check('a draft leg is never featured', ![...week.legs, ...day.legs].some((l) => l.route.flightNumber === 'AM10'));
    check('a pilot is not handed the planner', pub.body.canManage === false && pub.body.plans === undefined);

    const list = await call('GET', '/api/crew/am/routes', null, pilotToken);
    const featuredIds = new Set([...week.legs, ...day.legs].map((l) => l.route.id));
    const listed = (list.body.routes || []).filter((r) => featuredIds.has(r.id));
    check('the route list agrees: featured legs are open', listed.length === 8 && listed.every((r) => !r.locked && r.featured), listed.map((r) => [r.flightNumber, r.locked, r.featured]));
    check('…and everything else is still gated', (list.body.routes || []).some((r) => !featuredIds.has(r.id) && r.locked));

    /* ---- the planner ----------------------------------------------------- */
    const staff = await call('GET', '/api/crew/am/featured-routes', null, owner);
    check('staff get the planner', staff.body.canManage === true && Array.isArray(staff.body.routes) && staff.body.upcoming.week.length === 9, staff.body && Object.keys(staff.body));
    check('…with codeshare legs to pick, logo and all',
        staff.body.routes.some((r) => r.kind === 'codeshare' && r.logo === 'https://cdn.example/borealis.png'));
    check('…and the airline’s own logo on its own legs', staff.body.routes.some((r) => r.kind === 'own' && r.logo === VA.logoUrl));

    const codeshare = DB.routes.find((r) => r.kind === 'codeshare');
    const picks = [DB.routes[0], DB.routes[1], codeshare];
    const before = posts.length;
    const draft = await call('POST', '/api/crew/am/featured-routes/plans', {
        period: 'week', title: 'Ruta de la semana', note: 'Fly them all for a badge.',
        legs: picks.map((r, i) => ({ routeId: r._id, bonus: i === 2 ? 2 : 1 })),
    }, owner);
    check('staff draft a week', draft.status === 201 && draft.body.plans.length === 1 && draft.body.plans[0].status === 'draft', draft.body);
    check('…which is not posted', posts.length === before);
    const stillAuto = await call('GET', '/api/crew/am/featured-routes', null, pilotToken);
    check('…nor seen by pilots', stillAuto.body.week.planned === false);

    const refusedPast = await call('POST', '/api/crew/am/featured-routes/plans', { period: 'week', periodKey: '2020-W01', legs: [{ routeId: DB.routes[0]._id }] }, owner);
    check('a plan for a week that is over is refused', refusedPast.status === 400, refusedPast);
    const refusedLeg = await call('POST', '/api/crew/am/featured-routes/plans', { period: 'day', legs: [{ routeId: DB.routes[9]._id }] }, owner);
    check('a plan naming a draft leg is refused', refusedLeg.status === 409, refusedLeg);
    const pilotTry = await call('POST', '/api/crew/am/featured-routes/plans', { period: 'week', legs: [{ routeId: DB.routes[0]._id }] }, pilotToken);
    check('a pilot cannot plan', pilotTry.status === 403 || pilotTry.status === 401, pilotTry);

    const planId = draft.body.planId;
    const released = await call('PATCH', `/api/crew/am/featured-routes/plans/${planId}`, { action: 'release' }, owner);
    await settle();
    check('released', released.status === 200 && released.body.plans[0].status === 'released', released.body);
    const live = await call('GET', '/api/crew/am/featured-routes', null, pilotToken);
    check('the released plan is the week', live.body.week.planned === true
        && live.body.week.legs.map((l) => l.route.id).join() === picks.map((r) => r._id).join(), live.body.week);
    check('…carrying the bonus staff set', live.body.week.legs[2].bonus === 2);
    const card = posts[posts.length - 1];
    check('release posts the week to Discord', posts.length === before + 1 && card.url === HOOK, posts.length - before);
    check('…as a card image', card && card.files.length >= 1 && card.payload.embeds[0].image.url === 'attachment://card.png', card && card.payload);
    const desc = card ? card.payload.embeds[0].description : '';
    check('…with every leg, its aircraft and block time as text',
        /MMMX → KJFK/.test(desc) && /Boeing 737-800/.test(desc) && /\dh \d\dm|\d+m/.test(desc), desc);
    check('…the codeshare partner named', /Borealis Virtual/.test(desc), desc);
    check('…the bonus, in the airline’s currency', /2× pay/.test(desc) && /Miles bonus/.test(desc), desc);
    check('…and the plan’s own words', /Ruta de la semana/.test(desc) && /badge/.test(desc), desc);

    const rolled = await call('PATCH', `/api/crew/am/featured-routes/plans/${planId}`, { action: 'roll' }, owner);
    check('bonuses can be re-rolled', rolled.status === 200 && rolled.body.plans[0].legs.some((l) => l.bonus > 1), rolled.body.plans && rolled.body.plans[0].legs);

    const dayPlan = await call('POST', '/api/crew/am/featured-routes/plans', {
        period: 'day', release: true, legs: [{ routeId: codeshare._id, bonus: 1.5 }],
    }, owner);
    await settle();
    const dayCard = posts[posts.length - 1];
    check('a day can be built and released in one go', dayPlan.status === 201 && dayPlan.body.day.planned === true, dayPlan.body && dayPlan.body.day);
    check('…and is posted with its map', dayCard && /Route of the Day/.test(dayCard.payload.embeds[0].title), dayCard && dayCard.payload.embeds[0].title);

    // Its own channel, when it has one.
    VA.crewWebhooks = { featured: 'https://discord.com/api/webhooks/999/featured-only' };
    const manual = await call('POST', '/api/crew/am/featured-routes/post', { period: 'week' }, owner);
    check('“post now” goes to the featured channel', manual.status === 200 && posts[posts.length - 1].url.includes('/999/'), manual);
    VA.crewWebhooks = {};

    const off = await call('POST', '/api/crew/am/featured-routes/settings', { autoPost: false }, owner);
    check('auto-posting can be switched off', off.status === 200 && off.body.autoPost === false && VA.crewFeatured.autoPost === false, off.body && off.body.autoPost);

    /* ---- filing a flight as the Route of the Week ------------------------- */
    const filed = await call('POST', '/api/crew/am/pireps', {
        featured: 'week', routeId: DB.routes[1]._id, hours: 10, minutes: 50, landings: 1,
    }, pilotToken);
    check('a pilot files AS the Route of the Week, the leg filling the airports',
        filed.status === 201 && filed.body.pirep.featured === 'week'
        && filed.body.pirep.origin === 'MMMX' && filed.body.pirep.destination === 'LEMD'
        && filed.body.pirep.routeId === DB.routes[1]._id, filed.body);
    const wrong = await call('POST', '/api/crew/am/pireps', {
        featured: 'week', origin: 'MMMX', destination: 'MMTJ', hours: 2,
    }, pilotToken);
    check('a flight that is not a featured leg cannot claim to be', wrong.status === 409 && wrong.body.code === 'not_featured', wrong.body);
    const mismatch = await call('POST', '/api/crew/am/pireps', {
        featured: 'day', routeId: codeshare._id, origin: 'MMMX', destination: 'KJFK', hours: 2,
    }, pilotToken);
    check('…nor file a different flight against a featured leg', mismatch.status === 409, mismatch.body);
    const filedNotice = posts.find((p) => p.payload && p.payload.embeds && (p.payload.embeds[0].fields || []).some((f) => f.name === 'Flown as'));
    check('the flight report notice says how it was flown', !!filedNotice);

    /* ---- a codeshare route announces itself with its logo ----------------- */
    const csAdd = await call('POST', '/api/crew/am/routes', {
        flightNumber: 'BV9', origin: 'CYUL', destination: 'MMMX', aircraft: 'A220-300', kind: 'codeshare',
        partnerName: 'Borealis Virtual', partnerLogo: 'https://cdn.example/borealis.png',
    }, owner);
    await settle();
    const csNotice = posts[posts.length - 1];
    check('a codeshare route is added', csAdd.status === 201, csAdd.body);
    check('…and posted with the partner’s logo', csNotice && csNotice.payload.embeds[0].thumbnail
        && csNotice.payload.embeds[0].thumbnail.url === 'https://cdn.example/borealis.png'
        && /Codeshare/.test(csNotice.payload.embeds[0].title), csNotice && csNotice.payload.embeds[0]);

    const gone = await call('DELETE', `/api/crew/am/featured-routes/plans/${planId}`, null, owner);
    check('a plan can be removed', gone.status === 200 && !gone.body.plans.some((p) => p.id === planId));

    console.log(`${pass} passed, ${fails.length} failed`);
    if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
