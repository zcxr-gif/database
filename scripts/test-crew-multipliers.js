'use strict';
// Temporary multipliers on events and routes — crewMultipliers.js, and how the
// shop pays one (crewShop.payFor). Pure: no network, no database.
//
//   * always temporary: no end, or an end before the start, is refused
//   * bounded 1.1×–5×
//   * judged by when the flight was FLOWN, inside [start, end)
//   * route ones match routeId, event ones match eventId, nothing else
//   * two matching do not stack — the biggest wins
//   * long-finished ones are tidied away; recent ones are kept for the record
//   * points: everything the flight earned × the factor, milestone left out
const path = require('path');
const M = require(path.join('..', 'crewMultipliers.js'));
const Shop = require(path.join('..', 'crewShop.js'));

let failures = 0;
const T = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(ok ? '  ✓' : '  ✗', label, ok ? '' : `\n      got: ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    if (!ok) failures++;
};
const D = (s) => new Date(s);
const xmas = { kind: 'event', targetId: 'ev1', factor: 2, label: 'Christmas double', startsAt: '2026-12-20T00:00:00Z', endsAt: '2026-12-27T00:00:00Z' };
const hub = { kind: 'route', targetId: 'r1', factor: 1.5, startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' };

console.log('\n what can be saved');
T('no end is refused — it would not be temporary', M.sanitize({ ...xmas, endsAt: null }), null);
T('an end before the start is refused', M.sanitize({ ...xmas, endsAt: '2026-12-01T00:00:00Z' }), null);
T('no event or route is refused', M.sanitize({ ...xmas, targetId: '' }), null);
T('a factor below 1.1 is raised to it', M.sanitize({ ...xmas, factor: 1 }).factor, 1.1);
T('…and above 5 lowered to it', M.sanitize({ ...xmas, factor: 50 }).factor, 5);
T('an id is kept across saves', M.sanitize({ ...xmas, id: 'mx1' }, { id: 'mx1' }).id, 'mx1');

console.log('\n which flights it counts for');
const list = [xmas, hub];
T('an event flight inside the window', M.forFlight(list, { eventId: 'ev1', at: D('2026-12-24T18:00:00Z') }).factor, 2);
T('…before it starts, nothing', M.forFlight(list, { eventId: 'ev1', at: D('2026-12-19T23:59:00Z') }), null);
T('…at the end moment, nothing', M.forFlight(list, { eventId: 'ev1', at: D('2026-12-27T00:00:00Z') }), null);
T('a route flight', M.forFlight(list, { routeId: 'r1', at: D('2026-12-05T00:00:00Z') }).factor, 1.5);
T('a different route, nothing', M.forFlight(list, { routeId: 'r2', at: D('2026-12-05T00:00:00Z') }), null);
T('an event id never matches a route multiplier', M.forFlight(list, { eventId: 'r1', at: D('2026-12-05T00:00:00Z') }), null);
T('an event on a boosted route: the bigger wins, no stacking', M.forFlight(list, { routeId: 'r1', eventId: 'ev1', at: D('2026-12-24T00:00:00Z') }).factor, 2);

console.log('\n keeping the list tidy');
const old = { ...hub, id: 'old', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-01-02T00:00:00Z' };
const recent = { ...hub, id: 'recent', startsAt: '2026-11-20T00:00:00Z', endsAt: '2026-11-25T00:00:00Z' };
T('long-finished ones go', M.sanitizeList([old, recent], D('2026-12-01T00:00:00Z')).map((m) => m.id), ['recent']);
T('pilots are shown only live and upcoming ones', M.upcoming([recent, { ...xmas, id: 'x' }], D('2026-12-01T00:00:00Z')).map((m) => m.id), ['x']);

console.log('\n what it pays');
const rates = { perHour: 100 };
const pirep = { durationMin: 60 };
const plain = Shop.payFor(pirep, rates, {});
const doubled = Shop.payFor(pirep, rates, { boostMultiplier: 2, boostLabel: 'Christmas double' });
T('a 2× flight pays twice what the plain one does', doubled.total, plain.total * 2);
T('…shown as its own line', doubled.lines.some((l) => l.key === 'boostMultiplier' && l.label === 'Christmas double 2×'), true);
const withMilestone = Shop.payFor(pirep, rates, { boostMultiplier: 2, milestone: { weeks: 4, bonus: 50 } });
T('a streak milestone is added, not multiplied', withMilestone.total, plain.total * 2 + 50);
T('1× changes nothing', Shop.payFor(pirep, rates, { boostMultiplier: 1 }).total, plain.total);

console.log(failures ? `\n${failures} failed\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
