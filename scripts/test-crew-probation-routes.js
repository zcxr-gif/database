'use strict';
// Probation on set routes — crewRetention's "fly these N routes in your first
// week" rule. Pure module test: no network, no database.
//
//   * off (0 routes) is the old rule, untouched
//   * random mode hands routes only to pilots who have NOT flown — switching it
//     on never puts an established pilot back on probation
//   * the clock starts when routes are handed out, not at the join date
//   * a route counts when a report names it OR flew the same airports
//   * only approved reports count
//   * a deleted route stops counting rather than making probation impossible
//   * staff mode never removes a pilot whose routes nobody has chosen
//   * assignments of pilots who left are forgotten

const path = require('path');
const R = require(path.join('..', 'crewRetention.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const DAY = R.DAY_MS;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ROUTES = [
    { _id: 'r1', origin: 'EGLL', destination: 'KJFK', kind: 'own', active: true },
    { _id: 'r2', origin: 'KJFK', destination: 'EGLL', kind: 'own', active: true },
    { _id: 'r3', origin: 'EGLL', destination: 'LFPG', kind: 'own', active: true },
    { _id: 'cs', origin: 'LEMD', destination: 'EGLL', kind: 'codeshare', active: true },
    { _id: 'dr', origin: 'EGLL', destination: 'EDDF', kind: 'own', active: false },
];
const rules = (x = {}) => ({ enabled: true, firstFlight: true, firstFlightDays: 7, firstFlightWarnDays: 2, firstFlightRoutes: 2, firstFlightRoutePick: 'random', ...x });
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

console.log('\n settings');
T('routes default to 0 — the old rule', R.normalizeRules({}).firstFlightRoutes, 0);
T('bounded at 10', R.normalizeRules({ firstFlightRoutes: 99 }).firstFlightRoutes, 10);
T('pick defaults to random', R.normalizeRules({ firstFlightRoutePick: 'nope' }).firstFlightRoutePick, 'random');

console.log('\n picking');
const picked = R.pickRoutes(ROUTES, 5, seq(0.1, 0.5, 0.9));
T('only our own published legs are handed out', picked.slice().sort(), ['r1', 'r2', 'r3']);
T('never more than asked', R.pickRoutes(ROUTES, 2).length, 2);

console.log('\n handing them out');
const members = [
    { _id: 'new', name: 'New', createdAt: ago(1) },
    { _id: 'vet', name: 'Vet', createdAt: ago(200) },
    { _id: 'loa', name: 'Away', createdAt: ago(1), status: 'loa' },
];
const pireps = [{ memberId: 'vet', status: 'approved', flownAt: ago(10), origin: 'EGLL', destination: 'KJFK' }];
const got = R.assignMissing({ members, pireps, rules: rules(), assignments: { gone: { routeIds: ['r1'], by: 'random', at: ago(3) } }, routes: ROUTES, now: NOW });
T('only the pilot who has never flown gets routes', got.added, ['new']);
T('…two of them', got.assignments.new.routeIds.length, 2);
T('…stamped now, which is when the clock starts', got.assignments.new.at, new Date(NOW).toISOString());
T('a pilot who left is forgotten', 'gone' in got.assignments, false);
T('staff mode hands nothing out', R.assignMissing({ members, pireps, rules: rules({ firstFlightRoutePick: 'staff' }), routes: ROUTES, now: NOW }).added, []);
T('0 routes hands nothing out', R.assignMissing({ members, pireps, rules: rules({ firstFlightRoutes: 0 }), routes: ROUTES, now: NOW }).added, []);
T('no network, nothing handed out', R.assignMissing({ members, pireps, rules: rules(), routes: [], now: NOW }).added, []);

console.log('\n progress');
const byId = new Map(ROUTES.map((r) => [r._id, r]));
const A = { routeIds: ['r1', 'r3'], by: 'staff', at: ago(2) };
const m = { _id: 'p', createdAt: ago(20) };
T('a report naming the route counts', R.probationProgress(m, A, [{ memberId: 'p', status: 'approved', routeId: 'r1' }], byId).done, ['r1']);
T('…and so does one over the same airports', R.probationProgress(m, A, [{ memberId: 'p', status: 'approved', origin: 'egll', destination: 'LFPG' }], byId).done, ['r3']);
T('a pending report does not', R.probationProgress(m, A, [{ memberId: 'p', status: 'pending', routeId: 'r1' }], byId).done, []);
T('the reverse direction is a different route', R.probationProgress(m, A, [{ memberId: 'p', status: 'approved', origin: 'KJFK', destination: 'EGLL' }], byId).done, []);
T('a deleted route stops counting', R.probationProgress(m, { ...A, routeIds: ['r1', 'deleted'] }, [], byId).required, 1);

console.log('\n deadlines');
const run = (mem, assigned, reports, x) => R.assess({ members: [mem], pireps: reports, rules: rules(x), now: NOW, assignments: assigned, routes: ROUTES });
let out = run({ _id: 'p', createdAt: ago(30) }, { p: { routeIds: ['r1', 'r3'], by: 'staff', at: ago(2) } }, [], {});
T('the window runs from the assignment, not the old join date', [out.probationDue.length, out.probationWarn.length], [0, 0]);
out = run({ _id: 'p', createdAt: ago(30) }, { p: { routeIds: ['r1', 'r3'], by: 'staff', at: ago(6) } }, [], {});
T('…warned near the end', out.probationWarn.length, 1);
T('…with how far they have got', out.probationWarn[0] && out.probationWarn[0].routes.left, ['r1', 'r3']);
out = run({ _id: 'p', createdAt: ago(30) }, { p: { routeIds: ['r1', 'r3'], by: 'staff', at: ago(8) } }, [{ memberId: 'p', status: 'approved', routeId: 'r1', flownAt: ago(7) }], {});
T('one of two flown at the deadline is due', out.probationDue.length, 1);
out = run({ _id: 'p', createdAt: ago(30) }, { p: { routeIds: ['r1', 'r3'], by: 'staff', at: ago(8) } }, [
    { memberId: 'p', status: 'approved', routeId: 'r1', flownAt: ago(7) },
    { memberId: 'p', status: 'approved', routeId: 'r3', flownAt: ago(6) },
], {});
T('both flown is through', [out.probationDue.length, out.probationWarn.length], [0, 0]);
out = run({ _id: 'p', createdAt: ago(30) }, {}, [], { firstFlightRoutePick: 'staff' });
T('staff mode with nothing chosen waits, and removes nobody', [out.awaitingRoutes.length, out.probationDue.length], [1, 0]);
out = run({ _id: 'p', createdAt: ago(30) }, {}, [], { firstFlightRoutes: 0 });
T('0 routes is the old rule — never flown in 30 days is due', out.probationDue.length, 1);
out = run({ _id: 'p', createdAt: ago(30) }, { p: { routeIds: ['deleted'], by: 'random', at: ago(1) } }, [], {});
T('every assigned route deleted falls back to the old rule', out.probationDue.length, 1);

console.log(failures ? `\n${failures} failed\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
