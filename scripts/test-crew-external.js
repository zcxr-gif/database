'use strict';
// Conformance test for crewExternal.js and crewExternalRoutes.js — codeshares
// with airlines whose crew centre is somewhere else.
//
// The properties worth protecting:
//
//   * their feed is read whatever shape it arrives in — CSV with their own
//     column names, JSON with nesting, a Google Sheets link — and a leg keeps
//     the same identity between reads
//   * our server never fetches a private address, an http address, or follows
//     a redirect off https
//   * a feed that fails or comes back EMPTY removes nothing from our network
//   * their changes are followed, and our rank gates and notes survive them
//   * the feed WE publish carries only what we chose to share with that one
//     partner, is dead the moment its token is rotated, and lands in their
//     system as codeshares on us
//   * ending it removes only their copies — never a codeshare typed by hand
//
// The routes run against an in-memory airline; the network is faked.

const path = require('path');
const E = require(path.join('..', 'crewExternal.js'));
const crewCsv = require(path.join('..', 'crewCsv.js'));
const registerCrewExternal = require(path.join('..', 'crewExternalRoutes.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

(async () => {
    console.log('reading their feed');
    {
        const csv = E.parseFeed('Flight No,Dep ICAO,Arr ICAO,Equipment\nBR1,ENGM,EGLL,B738\nBR2,ENGM,KJFK,B789\nBR1,ENGM,EGLL,B738');
        T('their own column names are understood', csv.routes.map((r) => `${r.flightNumber}:${r.origin}-${r.destination}:${r.aircraft}`), ['BR1:ENGM-EGLL:B738', 'BR2:ENGM-KJFK:B789']);
        T('…a repeated row is one leg', csv.total, 2);
        T('a leg with no id is known by number and airports', csv.routes[0]._id, 'BR1|ENGM|EGLL');
        T('a leg with their id keeps it', E.parseFeed('route_id,flight,from,to\nR77,BR1,ENGM,EGLL').routes[0]._id, 'id:R77');
        const json = E.parseFeed(JSON.stringify({ data: [{ callsign: 'XY12', departure: { icao: 'LEMD' }, arrival: { icao: 'SCEL' }, aircraft: { name: 'A350' } }] }));
        T('nested JSON is understood', json.routes.map((r) => `${r.flightNumber}:${r.origin}-${r.destination}:${r.aircraft}`), ['XY12:LEMD-SCEL:A350']);
        T('JSON that is not JSON says so', !!E.parseFeed('{nope', { format: 'json' }).error, true);
        T('a Google Sheets link becomes its CSV export', E.normalizeFeedUrl('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=9'), 'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=9');
    }

    console.log('fetching it safely');
    {
        const calls = [];
        const transport = { get: async (url, opts) => { calls.push({ url, opts }); return { data: 'flight,from,to\nBR1,ENGM,EGLL', headers: { 'content-type': 'text/csv' } }; } };
        const refuse = async (url) => { try { await E.safeGet(url, { transport }); return 'fetched'; } catch (e) { return e.message; } };
        T('http is refused', /https/.test(await refuse('http://example.test/feed.csv')), true);
        T('a private address is refused', /private/.test(await refuse('https://10.0.0.5/feed.csv')), true);
        T('the cloud metadata address is refused', /private/.test(await refuse('https://169.254.169.254/latest/meta-data')), true);
        T('localhost is refused', /private/.test(await refuse('https://localhost/feed.csv')), true);
        T('…and none of those were fetched', calls.length, 0);
        await E.safeGet('https://partner.test/feed.csv', { transport });
        const o = calls[0].opts;
        T('a public https address is fetched with a size cap, a timeout and a redirect limit', [o.maxContentLength, o.timeout, o.maxRedirects], [2 * 1024 * 1024, 10000, 3]);
        T('…through an agent that checks every address it connects to', typeof o.httpsAgent.options.lookup, 'function');
        let redirectRefused = false;
        try { o.beforeRedirect({ protocol: 'http:' }); } catch { redirectRefused = true; }
        T('a redirect off https is refused', redirectRefused, true);
        const looked = await new Promise((r) => E.guardedLookup('localhost', {}, (err) => r(err && err.code)));
        T('a name that resolves to a private address is refused at connect time', looked, 'EPRIVATE');
        T('private address ranges', ['10.1.1.1', '172.20.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '8.8.8.8', '2606:4700::1'].map(E.privateAddress),
            [true, true, true, true, true, true, true, true, false, false]);
    }

    console.log('end to end: add, follow, outage, our feed, end');
    // ---- an in-memory airline ----
    const doc = { _id: 'va1', name: 'Aurora Virtual', slug: 'aurora', callsign: 'AUR', status: 'approved', logoUrl: 'https://x.test/a.png', crewExternalPartners: [] };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const live = () => { const d = clone(doc); d.markModified = () => {}; d.save = async function () { const { markModified, save, ...rest } = this; Object.assign(doc, clone(rest)); }; return d; };
    const chain = (lean) => ({ select() { return this; }, limit() { return this; }, lean: async () => clone(doc), then: (a, b) => Promise.resolve(lean ? clone(doc) : live()).then(a, b) });
    const Ads = {
        findById: () => chain(false),
        findOne: (q) => ({ select() { return this; }, lean: async () => ((doc.crewExternalPartners || []).some((p) => p.shareToken === q['crewExternalPartners.shareToken']) ? clone(doc) : null) }),
        find: () => ({ select() { return this; }, limit() { return this; }, lean: async () => [clone(doc)] }),
    };
    const routes = [
        { _id: 'r1', flightNumber: 'AU1', origin: 'EGLL', destination: 'KJFK', aircraft: 'A350', kind: 'own', active: true, partnerSlug: '', sourceRouteId: '' },
        { _id: 'r2', flightNumber: 'AU2', origin: 'EGLL', destination: 'LFPG', kind: 'own', active: true, partnerSlug: '', sourceRouteId: '' },
        { _id: 'r3', flightNumber: 'AU3', origin: 'EGLL', destination: 'EDDF', kind: 'own', active: false, partnerSlug: '', sourceRouteId: '' },
        { _id: 'r9', flightNumber: 'BR9', origin: 'ENGM', destination: 'LFPG', kind: 'codeshare', partnerName: 'Borealis Virtual', partnerSlug: '', sourceRouteId: '' },
    ];
    let n = 0;
    const store = {
        async listRoutes({ activeOnly } = {}) { return clone(routes.filter((r) => !activeOnly || r.active !== false)); },
        async createRoute(v) { const r = { _id: `new${++n}`, ...v }; routes.push(r); return r; },
        async updateRoute(id, v) { const r = routes.find((x) => x._id === id); Object.assign(r, v); return r; },
        async deleteRoute(id) { routes.splice(routes.findIndex((x) => x._id === id), 1); },
        async health() { return { codeshareLinks: true }; },
    };
    let FEED = 'Flight,From,To,Aircraft\nBR1,ENGM,EGLL,B738\nBR2,ENGM,KJFK,B789';
    let FEED_DOWN = false;
    const transport = { get: async () => { if (FEED_DOWN) { const e = new Error('down'); e.code = 'ECONNABORTED'; throw e; } return { data: FEED, headers: { 'content-type': 'text/csv' } }; } };
    const hs = [];
    const add = (m) => (p, fn) => hs.push({ m, re: new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), keys: (p.match(/:[a-zA-Z]+/g) || []).map((k) => k.slice(1)), fn });
    const app = { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'), put: add('PUT') };
    const call = async (m, url, { body = {}, as = 'staff', query = {} } = {}) => {
        const h = hs.find((x) => x.m === m && x.re.test(url.split('?')[0]));
        const mm = url.split('?')[0].match(h.re); const params = {}; h.keys.forEach((k, i) => { params[k] = mm[i + 1]; });
        let status = 200; let json = null; let sent = null;
        const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; }, set() { return res; }, send(s) { sent = s; return res; } };
        await h.fn({ params, body, query, as, protocol: 'https', get: () => 'api.test' }, res);
        return { status, json, sent };
    };
    registerCrewExternal(app, {
        mongoose: null, VirtualAirlineAd: Ads,
        resolveCrewVa: async () => ({ _id: 'va1', slug: 'aurora' }),
        resolveCrewStore: async () => ({ va: doc, store }),
        requireCap: async (req) => (req.as === 'staff' ? { p: {} } : { error: 403 }),
        crewFail: (res, err) => res.status(500).json({ error: String(err && err.stack) }),
        cleanRoute: (b) => ({ ...b, partnerSlug: b.kind === 'codeshare' ? (b.partnerSlug || '') : '', sourceRouteId: b.kind === 'codeshare' ? (b.sourceRouteId || '') : '' }),
        publicRoute: (r) => r,
        eachLimited: async (items, _n, fn) => { for (const it of [...items]) await fn(it); },
        crewCsv, crewWebhookUrlFor: async () => '', postCrewNotice: async () => true, transport, SITE_ORIGIN: 'https://inflight.test',
    });
    const copies = () => routes.filter((r) => String(r.partnerSlug || '').startsWith('ext:')).map((r) => `${r.flightNumber}:${r.origin}-${r.destination}`).sort();

    T('a pilot cannot add one', (await call('POST', '/api/crew/aurora/codeshare/external', { as: null, body: { name: 'X' } })).status, 403);
    const prev = await call('POST', '/api/crew/aurora/codeshare/external/preview', { body: { feedUrl: 'https://partner.test/routes.csv' } });
    T('a feed can be previewed before anything is saved', [prev.json.total, doc.crewExternalPartners.length], [2, 0]);
    const made = await call('POST', '/api/crew/aurora/codeshare/external', { body: {
        name: 'Borealis Virtual', platform: 'vamsys', feedUrl: 'https://partner.test/routes.csv', logo: 'https://x.test/b.png',
        take: { mode: 'all' }, share: { mode: 'selected', routeIds: ['r1', 'r3'] },
    } });
    const id = made.json.partner.id;
    T('adding one syncs it at once', [made.status, made.json.sync.created], [201, 2]);
    T('their routes are on our network as codeshares', copies(), ['BR1:ENGM-EGLL', 'BR2:ENGM-KJFK']);
    T('…under their name and logo', routes.filter((r) => r.partnerSlug === `ext:${id}`).every((r) => r.partnerName === 'Borealis Virtual' && r.partnerLogo === 'https://x.test/b.png'), true);
    T('the private token never reaches the staff screen', made.json.partner.shareToken, undefined);

    // Our pilots put their long-haul behind a rank, then they re-equip it.
    routes.find((r) => r.flightNumber === 'BR2').minRank = 'Captain';
    FEED = 'Flight,From,To,Aircraft\nBR1,ENGM,EGLL,B738\nBR2,ENGM,KJFK,A350\nBR3,ENGM,ESSA,B738';
    const s2 = await call('POST', `/api/crew/aurora/codeshare/external/${id}/sync`);
    T('their changes are followed', [s2.json.sync.created, s2.json.sync.updated], [1, 1]);
    T('…and our rank gate on their leg survives', routes.find((r) => r.flightNumber === 'BR2').minRank, 'Captain');

    FEED_DOWN = true;
    const down = await call('POST', `/api/crew/aurora/codeshare/external/${id}/sync`);
    T('a feed that is down removes nothing, and says so', [copies().length, /10 seconds/.test(down.json.sync.error)], [3, true]);
    FEED_DOWN = false;
    FEED = 'Flight,From,To\n';
    const empty = await call('POST', `/api/crew/aurora/codeshare/external/${id}/sync`);
    T('a feed that comes back empty removes nothing, and says so', [copies().length, /empty/.test(empty.json.sync.error)], [3, true]);

    FEED = 'Flight,From,To\nBR1,ENGM,EGLL';
    await call('POST', `/api/crew/aurora/codeshare/external/${id}/sync`);
    T('a leg they dropped comes off', copies(), ['BR1:ENGM-EGLL']);

    const up = await call('POST', `/api/crew/aurora/codeshare/external/${id}/sync`, { body: { csv: 'flight,from,to\nBR1,ENGM,EGLL\nBR5,ENGM,EKCH' } });
    T('an uploaded spreadsheet syncs the same way', [up.json.sync.created, copies()], [1, ['BR1:ENGM-EGLL', 'BR5:ENGM-EKCH']]);

    await call('PATCH', `/api/crew/aurora/codeshare/external/${id}`, { body: { take: { mode: 'selected', routeIds: ['BR1|ENGM|EGLL'] }, feedUrl: 'https://partner.test/routes.csv' } });
    T('flying only some of theirs takes the rest off', copies(), ['BR1:ENGM-EGLL']);

    console.log('the feed we publish for them');
    const feedUrl = (await call('GET', '/api/crew/aurora/codeshare/external')).json.partners[0].ourFeed.csv;
    const token = feedUrl.match(/codeshare\/([a-f0-9]{48})\.csv$/)[1];
    T('their feed address is ours, on our API', feedUrl.startsWith('https://api.test/api/crew-feed/codeshare/'), true);
    const out = await call('GET', `/api/crew-feed/codeshare/${token}.csv`, { as: null });
    const lines = String(out.sent).replace(/^﻿/, '').trim().split(/\r?\n/);
    T('it carries only what we share with them — never a draft', lines.slice(1).map((l) => l.split(',')[0]), ['AU1']);
    T('…as codeshares on us, operator first-class', [lines[0].split(',').includes('operator'), /Aurora Virtual/.test(lines[1]), /codeshare/.test(lines[1])], [true, true, true]);
    const js = await call('GET', `/api/crew-feed/codeshare/${token}.json`, { as: null });
    T('…and as JSON with who we are', [js.json.airline.name, js.json.routes.length], ['Aurora Virtual', 1]);
    T('a wrong token is nothing', (await call('GET', `/api/crew-feed/codeshare/${'0'.repeat(48)}.csv`, { as: null })).status, 404);
    await call('POST', `/api/crew/aurora/codeshare/external/${id}/token`);
    T('a rotated token kills the old address', (await call('GET', `/api/crew-feed/codeshare/${token}.csv`, { as: null })).status, 404);

    console.log('ending it');
    const end = await call('DELETE', `/api/crew/aurora/codeshare/external/${id}`);
    T('ending removes their copies', [end.json.removed, copies()], [1, []]);
    T('…never the codeshare typed by hand', routes.some((r) => r._id === 'r9'), true);
    T('…nor our own network', routes.filter((r) => r.kind === 'own').length, 3);
    T('…and the partner is gone', doc.crewExternalPartners.length, 0);

    console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
