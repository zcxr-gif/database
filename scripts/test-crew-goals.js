'use strict';
// Conformance test for crewGoals.js — tours and challenges — and the routes in
// crewNetworkRoutes.js that save and read them.
//
// The properties worth protecting:
//
//   * progress is only ever APPROVED flights — a pending or rejected report
//     never moves a pilot along a tour
//   * "in order" means in order: a leg flown early does not count until the
//     leg before it is done
//   * a window is a window: a flight outside it counts for nothing
//   * a challenge's filters narrow, and a crew challenge is one bar for all
//   * the date on a finished tour is the flight that finished it
//   * finished tours and personal challenges land on the awards shelf; crew
//     challenges do not (they belong to nobody in particular)
//   * a draft is invisible to pilots, and only events staff may save
//
// Pure module test plus the handlers against an in-memory airline.

const path = require('path');
const G = require(path.join('..', 'crewGoals.js'));
const crewCsv = require(path.join('..', 'crewCsv.js'));
const registerCrewNetwork = require(path.join('..', 'crewNetworkRoutes.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

let n = 0;
const flight = (o, d, day, extra) => ({
    _id: `p${++n}`, status: 'approved', origin: o, destination: d,
    flownAt: `2026-03-${String(day).padStart(2, '0')}T12:00:00Z`, durationMin: 120, distanceNm: 800, landings: 1,
    memberId: 'm1', pilotName: 'Ann', aircraftName: 'Airbus A320', ...(extra || {}),
});

console.log('saving');
{
    T('a tour needs legs', G.sanitizeTour({ title: 'Empty', legs: [] }), null);
    T('a tour needs a title', G.sanitizeTour({ legs: [{ origin: 'EGLL', destination: 'LFPG' }] }), null);
    const t = G.sanitizeTour({ title: 'Grand tour', legs: [{ origin: 'egll', destination: 'lfpg!' }, { origin: 'LFPG' }], image: 'http://nope.test/x.png' });
    T('legs are cleaned and half-legs dropped', t.legs.map((l) => `${l.origin}-${l.destination}`), ['EGLL-LFPG']);
    T('a non-https picture is dropped', t.image, '');
    T('in order by default', t.ordered, true);
    T('the award defaults to the tour’s own name', t.award.name, 'Grand tour');
    T('an end before the start is dropped, not stored', G.sanitizeTour({ title: 'x', legs: [{ origin: 'EGLL', destination: 'LFPG' }], startsAt: '2026-04-01', endsAt: '2026-03-01' }).endsAt, null);
    T('a challenge needs a target', G.sanitizeChallenge({ title: 'Nothing', target: 0 }), null);
    const c = G.sanitizeChallenge({ title: 'Hub', target: 5, metric: 'bogus', scope: 'everyone', filter: { airport: 'egll' } });
    T('an unknown metric and scope fall back', [c.metric, c.scope], ['flights', 'pilot']);
    T('an id survives an edit', G.sanitizeTour({ ...t, title: 'Renamed' }, t).id, t.id);
}

console.log('tours');
{
    const tour = G.sanitizeTour({ title: 'Europe', legs: [
        { origin: 'EGLL', destination: 'LFPG' }, { origin: 'LFPG', destination: 'EDDF' }, { origin: 'EDDF', destination: 'LIRF', aircraft: 'A321' },
    ] });
    const log = [
        flight('LFPG', 'EDDF', 1),                       // leg 2, too early
        flight('EGLL', 'LFPG', 2),                       // leg 1
        flight('LFPG', 'EDDF', 3, { status: 'pending' }), // not approved
        flight('LFPG', 'EDDF', 4),                       // leg 2
        flight('EDDF', 'LIRF', 5),                       // wrong aircraft
    ];
    const p = G.tourProgress(tour, log);
    T('in order: an early leg waits, a pending one never counts', [p.done, p.nextLeg], [2, 2]);
    T('an aircraft-bound leg needs that aircraft', p.complete, false);
    const done = G.tourProgress(tour, [...log, flight('EDDF', 'LIRF', 9, { aircraftName: 'Airbus A321' })]);
    T('finished, dated by the flight that finished it', [done.complete, done.completedAt], [true, '2026-03-09T12:00:00Z']);
    T('any order counts the early leg', G.tourProgress({ ...tour, ordered: false }, log).done, 2);
    const windowed = { ...tour, startsAt: '2026-03-03T00:00:00Z' };
    T('a flight before the window counts for nothing', G.tourProgress(windowed, log).done, 0);
}

console.log('challenges');
{
    const log = [flight('EGLL', 'LFPG', 1), flight('LFPG', 'EGLL', 2), flight('LFPG', 'EDDF', 3), flight('EGLL', 'KJFK', 4, { memberId: 'm2', pilotName: 'Bo', durationMin: 480 })];
    const hub = G.sanitizeChallenge({ title: 'Heathrow', metric: 'flights', target: 2, filter: { airport: 'EGLL' } });
    const me = G.challengeProgress(hub, log.filter((f) => f.memberId === 'm1'));
    T('an airport filter takes either end', [me.have, me.complete, me.completedAt], [2, true, '2026-03-02T12:00:00Z']);
    const hours = G.challengeProgress(G.sanitizeChallenge({ title: 'Hours', metric: 'hours', target: 20 }), log);
    T('hours add up across the log', [hours.have, hours.pct], [14, 70]);
    const ports = G.challengeProgress(G.sanitizeChallenge({ title: 'See places', metric: 'airports', target: 4 }), log);
    T('airports count each place once', ports.have, 4);
    const board = G.challengeBoard(hub, log);
    T('the board ranks pilots by how far along', board.top.map((r) => [r.name, r.have]), [['Ann', 2], ['Bo', 1]]);
    const cs = G.sanitizeChallenge({ title: 'Partners', metric: 'flights', target: 1, filter: { routeKind: 'codeshare' } });
    T('a codeshare-only challenge ignores own legs', G.challengeProgress(cs, [flight('EGLL', 'LFPG', 1, { routeKind: 'own' })]).have, 0);
}

console.log('on the awards shelf');
{
    const tour = G.sanitizeTour({ title: 'Short hop', legs: [{ origin: 'EGLL', destination: 'LFPG' }], award: { name: 'Channel crosser', tier: 'silver' } });
    const mine = G.sanitizeChallenge({ title: 'One flight', target: 1 });
    const ours = G.sanitizeChallenge({ title: 'Together', target: 1, scope: 'crew' });
    const draft = G.sanitizeTour({ title: 'Secret', legs: [{ origin: 'EGLL', destination: 'LFPG' }], active: false });
    const out = G.goalAwards({ tours: [tour, draft], challenges: [mine, ours], pireps: [flight('EGLL', 'LFPG', 1)] });
    T('finished tours and personal challenges are awards', out.earned.map((e) => e.name), ['Channel crosser', 'One flight']);
    T('a crew challenge and a draft are not on one pilot’s shelf', out.catalog.length, 2);
}

// ---- handlers ----
function fakeAd(doc) {
    const live = () => ({ ...doc, save: async function save() { Object.assign(doc, this); delete doc.save; delete doc.markModified; }, markModified() {} });
    const chain = (lean) => ({ select() { return this; }, lean: async () => ({ ...doc }), then: (a, b) => Promise.resolve(lean ? { ...doc } : live()).then(a, b) });
    return {
        findById: () => chain(false),
        findOne: () => chain(true),
        find: () => ({ select() { return this; }, limit() { return this; }, sort() { return this; }, lean: async () => [] }),
        updateOne: async () => ({}),
    };
}
function fakeApp() {
    const hs = [];
    const add = (m) => (p, fn) => hs.push({ m, re: new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)').replace(/\./g, '\\.')}$`), keys: (p.match(/:[a-zA-Z]+/g) || []).map((k) => k.slice(1)), fn });
    const app = { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
    app.call = async (m, url, { body = {}, as = null, viewer = null } = {}) => {
        const h = hs.find((x) => x.m === m && x.re.test(url));
        const mm = url.match(h.re); const params = {}; h.keys.forEach((k, i) => { params[k] = mm[i + 1]; });
        let status = 200; let json = null;
        const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; }, set() { return res; }, send() { return res; } };
        await h.fn({ params, body, query: {}, as, viewer }, res);
        return { status, json };
    };
    return app;
}

(async () => {
    console.log('the routes');
    const doc = { _id: 'va1', name: 'Aurora', slug: 'aurora', crewTours: [], crewChallenges: [], ranks: [] };
    const store = {
        listPireps: async () => [flight('EGLL', 'LFPG', 1, { routeId: 'r1' }), flight('EGLL', 'LFPG', 2, { memberId: 'm2', pilotName: 'Bo', status: 'rejected' })],
        listRoutes: async () => [{ _id: 'r1', kind: 'own' }],
    };
    const app = fakeApp();
    function Schema() {}
    Schema.Types = { ObjectId: String, Mixed: Object };
    registerCrewNetwork(app, {
        mongoose: { Schema, models: {}, model: () => ({ find: () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [] }) }) },
        VirtualAirlineAd: fakeAd(doc), crewStore: { CrewStoreError: Error }, crewCsv, crewRanks: { meetsRank: () => true },
        resolveCrewVa: async () => ({ _id: 'va1', slug: 'aurora' }),
        resolveCrewStore: async () => ({ va: doc, store }),
        requireCap: async (req) => (req.as === 'staff' ? { p: { name: 'Staff' } } : { error: 403 }),
        crewFail: (res, err) => res.status(500).json({ error: String(err && err.stack) }),
        withDrift: (s, p) => p,
        crewViewer: async (req) => req.viewer,
        cleanRoute: (b) => b, publicRoute: (r) => r, eachLimited: async () => {},
        crewWebhookUrlFor: async () => '', postCrewNotice: async () => true, SITE_ORIGIN: 'https://x.test',
    });

    T('a pilot cannot save a tour', (await app.call('POST', '/api/crew/aurora/tours', { body: { title: 'x', legs: [{ origin: 'EGLL', destination: 'LFPG' }] } })).status, 403);
    T('a bad tour is refused with a reason', (await app.call('POST', '/api/crew/aurora/tours', { as: 'staff', body: { title: 'x' } })).status, 400);
    const made = await app.call('POST', '/api/crew/aurora/tours', { as: 'staff', body: { title: 'Hop', legs: [{ origin: 'EGLL', destination: 'LFPG' }, { origin: 'LFPG', destination: 'EGLL' }] } });
    T('staff can', made.status, 201);
    await app.call('POST', '/api/crew/aurora/challenges', { as: 'staff', body: { title: 'Secret', target: 3, active: false } });
    await app.call('POST', '/api/crew/aurora/challenges', { as: 'staff', body: { title: 'All of us', target: 3, scope: 'crew' } });

    const pilot = await app.call('GET', '/api/crew/aurora/goals', { viewer: { memberId: 'm1', hours: 10 } });
    T('a pilot sees their progress', pilot.json.tours[0].me.done, 1);
    T('a pilot does not see a draft', pilot.json.challenges.map((c) => c.title), ['All of us']);
    T('a crew challenge is one bar for everybody, approved flights only', pilot.json.challenges[0].crew.have, 1);
    const staff = await app.call('GET', '/api/crew/aurora/goals', { as: 'staff' });
    T('staff see drafts', staff.json.challenges.length, 2);

    const id = made.json.tour.id;
    const edited = await app.call('PATCH', `/api/crew/aurora/tours/${id}`, { as: 'staff', body: { title: 'Hop and back' } });
    T('an edit keeps the id and the legs', [edited.json.tour.id, edited.json.tour.legs.length], [id, 2]);
    const one = await app.call('GET', `/api/crew/aurora/goals/${id}`, { viewer: { memberId: 'm1', hours: 10 } });
    T('one tour, with the board', [one.json.goal.title, one.json.goal.board.flying], ['Hop and back', 1]);
    T('removed', (await app.call('DELETE', `/api/crew/aurora/tours/${id}`, { as: 'staff' })).json.ok, true);
    T('…and gone', (await app.call('GET', `/api/crew/aurora/goals/${id}`)).status, 404);

    console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
