'use strict';
// Conformance test for crewCodeshare.js and the codeshare half of
// crewNetworkRoutes.js — two crew centres agreeing to fly each other's routes.
//
// The properties worth protecting are the ones that would put a flight on sale
// that nobody agreed to, or take away a VA's own work:
//
//   * only a partner's OWN, PUBLISHED legs are ever shared — never a draft, and
//     never a codeshare of a codeshare (a third airline's route)
//   * each side can only narrow what the other allows; nothing widens by edit
//   * a sync writes only what the partner owns (number, airports, aircraft,
//     distance) — the flying airline's rank gate, notes and gates survive it
//   * a pre-v23 project never has rows deleted on a guess
//   * ending an agreement removes the copies from both networks, and only the
//     copies — a codeshare somebody typed by hand stays
//   * a partner's edit is followed: renumbered, it is an edit, not a new leg
//   * a combined sheet (an `operator` column) sorts itself on import
//
// The end-to-end half drives the real Express handlers against two in-memory
// airlines — no network, no Postgres, no mongoose.

const path = require('path');
const C = require(path.join('..', 'crewCodeshare.js'));
const crewCsv = require(path.join('..', 'crewCsv.js'));
const registerCrewNetwork = require(path.join('..', 'crewNetworkRoutes.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const route = (id, fn, o, d, extra) => ({
    _id: id, flightNumber: fn, origin: o, destination: d, aircraft: 'A320', distanceNm: 500,
    notes: '', active: true, kind: 'own', partnerName: '', partnerLogo: '', minRank: '',
    departureGate: '', arrivalGate: '', partnerSlug: '', sourceRouteId: '', ...(extra || {}),
});

console.log('selections');
{
    T('an empty "selected" is "none", said honestly', C.cleanSelection({ mode: 'selected', routeIds: [] }), { mode: 'none', routeIds: [] });
    T('ids are de-duplicated', C.cleanSelection({ mode: 'selected', routeIds: ['a', 'a', 'b'] }).routeIds, ['a', 'b']);
    T('an unknown mode falls back', C.cleanSelection({ mode: 'everything' }).mode, 'none');
    T('narrow: all inside all is all', C.narrowSelection({ mode: 'all' }, { mode: 'all' }).mode, 'all');
    T('narrow: all inside a few is those few', C.narrowSelection({ mode: 'all' }, { mode: 'selected', routeIds: ['x', 'y'] }), { mode: 'selected', routeIds: ['x', 'y'] });
    T('narrow: never wider than the ceiling', C.narrowSelection({ mode: 'selected', routeIds: ['x', 'z'] }, { mode: 'selected', routeIds: ['x', 'y'] }).routeIds, ['x']);
    T('narrow: nothing allowed is nothing', C.narrowSelection({ mode: 'all' }, { mode: 'none' }).mode, 'none');
}

console.log('what may be shared');
{
    const net = [
        route('1', 'BR1', 'ENGM', 'EGLL'),
        route('2', 'BR2', 'ENGM', 'LEMD', { active: false }),
        route('3', 'IB9', 'LEMD', 'SCEL', { kind: 'codeshare', partnerName: 'Iberia' }),
        route('4', 'BR4', 'ENGM', ''),
    ];
    T('all = own, published, complete legs only', C.selectRoutes(net, { mode: 'all' }).map((r) => r._id), ['1']);
    T('a selection cannot reach a draft or a codeshare', C.selectRoutes(net, { mode: 'selected', routeIds: ['1', '2', '3'] }).map((r) => r._id), ['1']);
}

console.log('asking');
{
    const take = { mode: 'all' }; const none = { mode: 'none' };
    T('asking yourself', C.requestProblem({ fromSlug: 'a', toSlug: 'A', take, offer: none }), 'That is your own airline.');
    T('asking for nothing either way', /at least one route/.test(C.requestProblem({ fromSlug: 'a', toSlug: 'b', take: none, offer: none })), true);
    T('asking an airline that switched requests off', /not taking/.test(C.requestProblem({ fromSlug: 'a', toSlug: 'b', take, offer: none, partnerOpen: false })), true);
    T('asking twice', /already a request/.test(C.requestProblem({ fromSlug: 'a', toSlug: 'b', take, offer: none, existing: [{ fromSlug: 'b', toSlug: 'a', status: 'pending' }] })), true);
    T('asking a partner you already have', /already codeshare/.test(C.requestProblem({ fromSlug: 'a', toSlug: 'b', take, offer: none, existing: [{ fromSlug: 'a', toSlug: 'b', status: 'active' }] })), true);
    T('a declined request does not block a new one', C.requestProblem({ fromSlug: 'a', toSlug: 'b', take, offer: none, existing: [{ fromSlug: 'a', toSlug: 'b', status: 'declined' }] }), '');
    const spam = Array.from({ length: C.MAX_PENDING_OUT }, (_, i) => ({ fromSlug: 'a', toSlug: `x${i}`, status: 'pending' }));
    T('asking the whole directory at once', /requests waiting/.test(C.requestProblem({ fromSlug: 'a', toSlug: 'b', take, offer: none, existing: spam })), true);
}

console.log('the sync plan');
{
    const partner = { slug: 'borealis', name: 'Borealis Virtual', logo: 'https://x.test/b.png' };
    const src = [route('s1', 'BR1', 'ENGM', 'EGLL'), route('s2', 'BR2', 'ENGM', 'KJFK', { aircraft: 'B787' })];
    const fresh = C.planSync({ source: src, existing: [], partner });
    T('first sync adds every leg', fresh.create.length, 2);
    T('…as a codeshare under the partner', [fresh.create[0].kind, fresh.create[0].partnerName, fresh.create[0].partnerSlug, fresh.create[0].sourceRouteId], ['codeshare', 'Borealis Virtual', 'borealis', 's1']);
    T('…with a note saying who flies it', fresh.create[0].notes, 'Operated by Borealis Virtual.');

    const held = [
        route('m1', 'BR1', 'ENGM', 'EGLL', { kind: 'codeshare', partnerName: 'Borealis Virtual', partnerLogo: 'https://x.test/b.png', partnerSlug: 'borealis', sourceRouteId: 's1', minRank: 'Captain', notes: 'Our words' }),
        route('m2', 'BR2', 'ENGM', 'KJFK', { kind: 'codeshare', partnerName: 'Borealis Virtual', partnerLogo: 'https://x.test/b.png', partnerSlug: 'borealis', sourceRouteId: 's2', aircraft: 'B787' }),
        // Typed by hand, same airline's name, never linked: not ours to touch.
        route('m3', 'BR9', 'ENGM', 'LFPG', { kind: 'codeshare', partnerName: 'Borealis Virtual' }),
        route('m4', 'AU1', 'EGLL', 'KJFK'),
    ];
    T('nothing changed is nothing to do', (() => { const p = C.planSync({ source: src, existing: held, partner }); return [p.create.length, p.update.length, p.remove.length, p.keep]; })(), [0, 0, 0, 2]);

    // The partner renumbers BR1 and re-equips it.
    const edited = [route('s1', 'BR101', 'ENGM', 'EGLL', { aircraft: 'A321' }), src[1]];
    const p = C.planSync({ source: edited, existing: held, partner });
    T('a renumbered leg is an edit, not a new leg', [p.create.length, p.update.length], [0, 1]);
    T('…writing only what the partner owns', Object.keys(p.update[0].values).sort(), ['aircraft', 'flightNumber']);
    T('…so the flying airline’s rank gate and notes survive', [p.update[0].before.minRank, p.update[0].before.notes], ['Captain', 'Our words']);

    const dropped = C.planSync({ source: [src[1]], existing: held, partner });
    T('a leg the partner withdrew is removed', dropped.remove, ['m1']);
    T('…and the hand-typed one is never touched', dropped.remove.includes('m3'), false);

    const ended = C.planSync({ source: [], existing: held, partner });
    T('ending removes every copy, and only copies', ended.remove.sort(), ['m1', 'm2']);

    // A pre-v23 project: no link columns, so a copy cannot be told from a
    // hand-typed codeshare under the same name. Nothing is deleted on a guess.
    const legacy = held.map((r) => ({ ...r, partnerSlug: '', sourceRouteId: '' }));
    const lp = C.planSync({ source: [src[1]], existing: legacy, partner, schemaLinks: false });
    T('an old project is never deleted from', lp.remove, []);
    T('…and says how much is stranded', lp.stranded, 2);
    T('…but still matches what it holds by leg', lp.create.length, 0);

    const twins = [route('t1', 'BR5', 'ENGM', 'ESSA'), route('t2', 'BR5', 'ENGM', 'ESSA')];
    T('two partner legs with one number are two copies', C.planSync({ source: twins, existing: [], partner }).create.length, 2);
}

console.log('one side of the table');
{
    const doc = {
        _id: 'd1', status: 'pending', fromSlug: 'aurora', fromName: 'Aurora', toSlug: 'borealis', toName: 'Borealis',
        fromTakes: { mode: 'all' }, fromLimit: { mode: 'selected', routeIds: ['b1', 'b2'] },
        toTakes: { mode: 'selected', routeIds: ['a1'] }, toLimit: { mode: 'all' },
    };
    const mine = C.view(doc, 'aurora');
    const theirs = C.view(doc, 'BOREALIS');
    T('the asker sees an outgoing request it can withdraw', [mine.direction, mine.canWithdraw, mine.canAccept], ['outgoing', true, false]);
    T('the asked sees an incoming one it can accept', [theirs.direction, theirs.canAccept, theirs.canWithdraw], ['incoming', true, false]);
    T('"what I fly" is my wish inside their allowance', [mine.iTake, theirs.iTake], [{ mode: 'selected', routeIds: ['b1', 'b2'] }, { mode: 'selected', routeIds: ['a1'] }]);
    T('…and the wish is kept as it was made', mine.iWant.mode, 'all');
    T('a stranger sees nothing', C.view(doc, 'somebody'), null);
}

console.log('a combined sheet sorts itself');
{
    const me = { name: 'Aurora Virtual', slug: 'aurora', callsign: 'AUR' };
    const sheet = [
        'operator,flightNumber,origin,destination',
        'Aurora Virtual,AU1,EGLL,KJFK',
        'Borealis Virtual,BR1,ENGM,EGLL',
        'aur,AU2,EGLL,LFPG',
    ].join('\n');
    const plan = crewCsv.planImport(crewCsv.ROUTES_SPEC, sheet, [], {
        prepare: C.operatorPrepare(me, new Map([['borealis virtual', 'https://x.test/b.png']])),
    });
    const rows = plan.create.map((r) => [r.values.flightNumber, r.values.kind, r.values.partnerName, r.values.partnerLogo || '']);
    T('our rows are our own network; theirs are codeshares with their logo', rows, [
        ['AU1', 'own', '', ''],
        ['BR1', 'codeshare', 'Borealis Virtual', 'https://x.test/b.png'],
        ['AU2', 'own', '', ''],
    ]);
    const typed = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'kind,operated by,origin,destination\nown,Borealis Virtual,ENGM,EGLL', [], { prepare: C.operatorPrepare(me) });
    T('an explicit kind column is respected', typed.create[0].values.kind, 'own');
}

/* ===========================================================================
 * End to end: two airlines, the real handlers.
 * ======================================================================== */

// ---- a very small mongoose ----
function fakeMongoose() {
    const collections = new Map();
    let seq = 0;
    const match = (doc, q) => Object.entries(q || {}).every(([k, v]) => {
        if (k === '$or') return v.some((sub) => match(doc, sub));
        const have = doc[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if ('$ne' in v) return have !== v.$ne;
            if ('$nin' in v) return !v.$nin.includes(have == null ? null : have);
        }
        return String(have) === String(v);
    });
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const setPath = (o, p, v) => { const ks = p.split('.'); let t = o; while (ks.length > 1) { const k = ks.shift(); t[k] = t[k] || {}; t = t[k]; } t[ks[0]] = v; };
    const chain = (get) => {
        const q = { sort: () => q, limit: () => q, select: () => q, lean: () => Promise.resolve(get(true)), then: (a, b) => Promise.resolve(get(false)).then(a, b) };
        return q;
    };
    function model(name) {
        if (!collections.has(name)) collections.set(name, []);
        const rows = collections.get(name);
        const live = (row) => {
            const d = clone(row);
            d.save = async () => { const i = rows.findIndex((r) => r._id === d._id); const plain = clone({ ...d }); delete plain.save; delete plain.toObject; delete plain.markModified; plain.updatedAt = new Date().toISOString(); rows[i] = plain; return d; };
            d.toObject = () => { const o = clone(d); return o; };
            d.markModified = () => {};
            return d;
        };
        return {
            async create(obj) { const row = { _id: `id${++seq}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...clone(obj) }; rows.push(row); return live(row); },
            find(q) { return chain(() => rows.filter((r) => match(r, q)).map(clone)); },
            findById(id) { return chain((lean) => { const r = rows.find((x) => String(x._id) === String(id)); return r ? (lean ? clone(r) : live(r)) : null; }); },
            findOne(q) { return chain((lean) => { const r = rows.find((x) => match(x, q)); return r ? (lean ? clone(r) : live(r)) : null; }); },
            async updateOne(q, u) { const r = rows.find((x) => match(x, q)); if (r) for (const [k, v] of Object.entries(u.$set || {})) setPath(r, k, clone(v)); return {}; },
            _rows: rows,
        };
    }
    function Schema() {}
    Schema.Types = { ObjectId: String, Mixed: Object };
    return { Schema, models: {}, model, collections };
}

// ---- an in-memory crew store ----
function fakeStore(slug, { links = true } = {}) {
    const routes = [];
    let n = 0;
    return {
        slug, routes,
        async listRoutes({ activeOnly = false } = {}) { return routes.filter((r) => !activeOnly || r.active).map((r) => ({ ...r })); },
        async getRoute(id) { return routes.find((r) => r._id === id) || null; },
        async createRoute(v) { const r = { _id: `${slug}-r${++n}`, ...v }; if (!links) { r.partnerSlug = ''; r.sourceRouteId = ''; } routes.push(r); return r; },
        async updateRoute(id, v) { const r = routes.find((x) => x._id === id); if (!r) return null; Object.assign(r, v); if (!links) { r.partnerSlug = ''; r.sourceRouteId = ''; } return r; },
        async deleteRoute(id) { const i = routes.findIndex((x) => x._id === id); if (i >= 0) routes.splice(i, 1); return true; },
        async health() { return { codeshareLinks: links }; },
        async listPireps() { return []; },
    };
}

// ---- an Express that only records ----
function fakeApp() {
    const handlers = [];
    const add = (method) => (p, fn) => handlers.push({ method, re: new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)').replace(/\./g, '\\.')}$`), keys: (p.match(/:[a-zA-Z]+/g) || []).map((k) => k.slice(1)), fn });
    const app = { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
    app.call = async (method, url, { body = {}, as = null, query = {} } = {}) => {
        const h = handlers.find((x) => x.method === method && x.re.test(url));
        if (!h) throw new Error(`no handler for ${method} ${url}`);
        const m = url.match(h.re);
        const params = {}; h.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        let status = 200; let json = null; let sent = null;
        const res = {
            status(s) { status = s; return res; }, json(j) { json = j; return res; }, set() { return res; }, send(s) { sent = s; return res; },
        };
        await h.fn({ params, body, query, as }, res);
        return { status, json, sent };
    };
    return app;
}

(async () => {
    console.log('end to end: request, accept, follow, end');
    const mg = fakeMongoose();
    const Ads = mg.model('VirtualAirlineAd');
    const aurora = await Ads.create({ name: 'Aurora Virtual', slug: 'aurora', callsign: 'AUR', status: 'approved', supabaseUrl: 'https://a.supabase.co', logoUrl: 'https://x.test/a.png' });
    const borealis = await Ads.create({ name: 'Borealis Virtual', slug: 'borealis', callsign: 'BRL', status: 'approved', supabaseUrl: 'https://b.supabase.co', logoUrl: 'https://x.test/b.png' });
    await Ads.create({ name: 'Closed Air', slug: 'closed', status: 'approved', supabaseUrl: 'https://c.supabase.co', crewCodeshareOpen: false });
    const stores = { aurora: fakeStore('aurora'), borealis: fakeStore('borealis') };
    stores.aurora.routes.push(route('a1', 'AU1', 'EGLL', 'KJFK'), route('a2', 'AU2', 'EGLL', 'LFPG'), route('a3', 'AU3', 'EGLL', 'EDDF', { active: false }));
    stores.borealis.routes.push(route('b1', 'BR1', 'ENGM', 'EGLL'), route('b2', 'BR2', 'ENGM', 'KJFK'),
        route('b3', 'IB1', 'LEMD', 'SCEL', { kind: 'codeshare', partnerName: 'Iberia' }));
    // A codeshare Aurora typed by hand long ago, same partner's name.
    stores.aurora.routes.push(route('a9', 'BR9', 'ENGM', 'LFPG', { kind: 'codeshare', partnerName: 'Borealis Virtual' }));

    const Store = { CrewStoreError: class extends Error {} };
    const vaFor = async (slug) => (await Ads.findOne({ slug: String(slug).toLowerCase() }).lean());
    const app = fakeApp();
    const net = registerCrewNetwork(app, {
        mongoose: mg, VirtualAirlineAd: Ads, crewStore: Store, crewCsv, crewRanks: { meetsRank: () => true },
        resolveCrewVa: vaFor,
        resolveCrewStore: async (slug) => ({ va: await vaFor(slug), store: stores[String(slug).toLowerCase()] }),
        // `as` names the airline whose staff is calling.
        requireCap: async (req, slug) => (req.as === String(slug).toLowerCase() ? { p: { name: `${req.as} staff` } } : { error: 403 }),
        crewFail: (res, err) => res.status(500).json({ error: String(err && err.stack) }),
        withDrift: (s, p) => p,
        crewViewer: async () => null,
        cleanRoute: (b) => ({ ...b, partnerSlug: b.kind === 'codeshare' ? (b.partnerSlug || '') : '', sourceRouteId: b.kind === 'codeshare' ? (b.sourceRouteId || '') : '' }),
        publicRoute: (r) => ({ id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination, kind: r.kind }),
        eachLimited: async (items, _n, fn) => { for (const [i, it] of items.entries()) await fn(it, i); },
        crewWebhookUrlFor: async () => '',
        postCrewNotice: async () => true,
        SITE_ORIGIN: 'https://inflight.test',
    });

    app.get('/api/crew/:slug/routes.csv', (req, res) => net.sendExport(req, res, req.query));
    const dir = await app.call('GET', '/api/crew/aurora/codeshare/directory', { as: 'aurora' });
    T('the directory lists other open airlines only', dir.json.airlines.map((a) => a.slug), ['borealis']);
    T('another airline’s staff cannot manage mine', (await app.call('GET', '/api/crew/aurora/codeshare', { as: 'borealis' })).status, 403);

    const netB = await app.call('GET', '/api/crew/aurora/codeshare/network/borealis', { as: 'aurora' });
    T('a partner’s network offers only its own published legs', netB.json.routes.map((r) => r.id), ['b1', 'b2']);

    const sent = await app.call('POST', '/api/crew/aurora/codeshare', {
        as: 'aurora', body: { partner: 'borealis', take: { mode: 'all' }, offer: { mode: 'selected', routeIds: ['a1', 'a2'] }, message: 'Fancy it?' },
    });
    T('a request is sent', [sent.status, sent.json.agreement.status, sent.json.agreement.direction], [201, 'pending', 'outgoing']);
    const id = sent.json.agreement.id;
    T('asking again is refused', (await app.call('POST', '/api/crew/aurora/codeshare', { as: 'aurora', body: { partner: 'borealis', take: { mode: 'all' } } })).status, 409);
    T('the asker cannot accept its own request', (await app.call('POST', `/api/crew/aurora/codeshare/${id}/accept`, { as: 'aurora' })).status, 409);

    const inbox = await app.call('GET', '/api/crew/borealis/codeshare', { as: 'borealis' });
    T('the partner sees it waiting', [inbox.json.incoming, inbox.json.agreements[0].message], [1, 'Fancy it?']);

    // Borealis lets Aurora fly only BR1, and takes only AU1 of the two offered.
    const acc = await app.call('POST', `/api/crew/borealis/codeshare/${id}/accept`, {
        as: 'borealis', body: { offer: { mode: 'selected', routeIds: ['b1'] }, take: { mode: 'selected', routeIds: ['a1', 'a3'] }, reply: 'Deal.' },
    });
    T('accepted', acc.json.agreement.status, 'active');
    const codeshares = (s) => stores[s].routes.filter((r) => r.kind === 'codeshare' && r.partnerSlug).map((r) => `${r.flightNumber}:${r.partnerName}`).sort();
    T('Aurora now flies exactly what Borealis allowed', codeshares('aurora'), ['BR1:Borealis Virtual']);
    T('Borealis flies what it took of what was offered (a draft cannot sneak in)', codeshares('borealis'), ['AU1:Aurora Virtual']);

    // Aurora puts the codeshare behind a rank; Borealis then renumbers the leg.
    const copy = stores.aurora.routes.find((r) => r.partnerSlug === 'borealis');
    copy.minRank = 'Captain';
    stores.borealis.routes.find((r) => r._id === 'b1').flightNumber = 'BR100';
    await app.call('POST', `/api/crew/aurora/codeshare/${id}/sync`, { as: 'aurora' });
    const after = stores.aurora.routes.filter((r) => r.partnerSlug === 'borealis');
    T('the renumbered leg is followed, not duplicated', after.map((r) => r.flightNumber), ['BR100']);
    T('…and Aurora’s rank gate on it survives', after[0].minRank, 'Captain');

    // Borealis widens what it allows, and Aurora — which asked for "all" — follows.
    await app.call('PATCH', `/api/crew/borealis/codeshare/${id}`, { as: 'borealis', body: { offer: { mode: 'all' } } });
    T('an airline that took "all" follows a widened offer', codeshares('aurora'), ['BR100:Borealis Virtual', 'BR2:Borealis Virtual']);

    // Aurora narrows its own half.
    await app.call('PATCH', `/api/crew/aurora/codeshare/${id}`, { as: 'aurora', body: { take: { mode: 'selected', routeIds: ['b2', 'b3'] } } });
    T('narrowing what I fly takes the rest away — and cannot reach their codeshare', codeshares('aurora'), ['BR2:Borealis Virtual']);

    const done = await app.call('POST', `/api/crew/borealis/codeshare/${id}/end`, { as: 'borealis' });
    T('ended', done.json.agreement.status, 'ended');
    T('every copy is gone from both networks', [codeshares('aurora'), codeshares('borealis')], [[], []]);
    T('the codeshare Aurora typed by hand is still there', stores.aurora.routes.some((r) => r._id === 'a9'), true);
    T('Aurora’s own network is untouched', stores.aurora.routes.filter((r) => r.kind === 'own').length, 3);

    console.log('exports');
    stores.aurora.routes.push(route('a10', 'IB7', 'EGLL', 'LEMD', { kind: 'codeshare', partnerName: 'Iberia' }));
    const csv = (r) => String(r.sent || '').replace(/^﻿/, '').trim().split(/\r?\n/);
    const cs = await app.call('GET', '/api/crew/aurora/routes.csv', { as: 'aurora', query: { scope: 'codeshare', id: '0' } });
    T('codeshares only', csv(cs).slice(1).map((l) => l.split(',')[1]), ['BR9', 'IB7']);
    const one = await app.call('POST', '/api/crew/aurora/routes/export', { as: 'aurora', body: { partner: 'iberia', id: false } });
    T('one partner only', csv(one).length, 2);
    const picked = await app.call('POST', '/api/crew/aurora/routes/export', { as: 'aurora', body: { ids: ['a2', 'a10'], id: false } });
    T('exactly the ticked rows', csv(picked).slice(1).map((l) => l.split(',')[1]), ['AU2', 'IB7']);
    const both = await app.call('POST', '/api/crew/aurora/routes/export', { as: 'aurora', body: { combined: true } });
    const lines = csv(both);
    T('a combined sheet leads with operator', lines[0].split(',')[0], 'operator');
    T('…naming us on our legs and the partner on theirs', lines.slice(1).map((l) => l.split(',')[0]).sort(), ['Aurora Virtual', 'Aurora Virtual', 'Aurora Virtual', 'Borealis Virtual', 'Iberia']);
    T('…and carries no ids, because it travels', /(^|,)id(,|$)/.test(lines[0]), false);
    const empty = await app.call('POST', '/api/crew/aurora/routes/export', { as: 'aurora', body: { partner: 'nobody' } });
    T('a slice that matches nothing says so', empty.status, 404);
    const prep = await net.importPrepare({ _id: aurora._id, slug: 'aurora', name: 'Aurora Virtual' });
    T('the import sorts the combined sheet it exported', crewCsv.planImport(crewCsv.ROUTES_SPEC, lines.join('\n'), [], { prepare: prep }).create
        .map((r) => r.values.kind).sort(), ['codeshare', 'codeshare', 'own', 'own', 'own']);

    console.log('hubs');
    const bad = await app.call('PUT', '/api/crew/aurora/hubs', { as: 'aurora', body: { hubs: [{ icao: 'egll', name: 'London' }, { icao: 'EGLL' }, { icao: 'x' }, { icao: 'KJFK', kind: 'focus' }] } });
    T('hubs are cleaned: upper-cased, de-duplicated, junk dropped', bad.json.hubs, [{ icao: 'EGLL', name: 'London', kind: 'hub' }, { icao: 'KJFK', name: '', kind: 'focus' }]);
    T('…and read back publicly', (await app.call('GET', '/api/crew/aurora/hubs')).json.hubs.length, 2);
    void borealis;

    console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
