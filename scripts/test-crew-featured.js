'use strict';
// Conformance test for crewFeatured.js — the Route of the Week / of the Day
// pick, the pilot's flying profile, and the suggestion scoring.
//
// The properties worth protecting are the ones that would make the feature
// quietly wrong rather than throw:
//
//   * the pick is STABLE inside a period and DIFFERENT between periods — a
//     route of the week that changes on every page load is not a route of the
//     week, and one that never changes is not a rotation
//   * two airlines with the same network do not feature the same leg
//   * the day never lands on the week's leg
//   * a staff pin wins for the period it was set in, and lapses after it
//   * a profile does not lean on two flights
//   * every reason a suggestion prints is a reason that actually scored
//   * a suggestion never offers a leg the pilot's rank has locked
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const F = require(path.join('..', 'crewFeatured.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const route = (id, origin, destination, extra) => ({
    id, origin, destination, aircraft: 'Boeing 737-800', distanceNm: 400,
    active: true, locked: false, flightNumber: `XX${id}`, ...(extra || {}),
});
const NETWORK = [
    route('a', 'EGLL', 'KJFK', { distanceNm: 3000 }),
    route('b', 'EGLL', 'LFPG', { distanceNm: 190 }),
    route('c', 'EGKK', 'LEMG', { distanceNm: 900 }),
    route('d', 'EGLL', 'OMDB', { distanceNm: 2900 }),
    route('e', 'EGCC', 'EIDW', { distanceNm: 140 }),
    route('f', 'EGLL', 'VHHH', { distanceNm: 5100 }),
];

console.log('\n the period keys');
{
    T('an ISO week, in Z', F.weekKey(new Date('2026-09-16T12:00:00Z')), '2026-W38');
    T('…turning over on Monday, not Sunday',
        F.weekKey(new Date('2026-09-13T23:59:00Z')) === F.weekKey(new Date('2026-09-14T00:01:00Z')), false);
    T('…and Monday starts the new one',
        F.weekKey(new Date('2026-09-14T00:01:00Z')), '2026-W38');
    // The ISO rule everybody gets wrong: the last days of a December belong to
    // week 1 of the year after when the Thursday does.
    T('the year rolls on the Thursday, as ISO says', F.weekKey(new Date('2025-12-31T00:00:00Z')), '2026-W01');
    T('a day is a UTC calendar day', F.dayKey(new Date('2026-09-16T23:59:00Z')), '2026-09-16');
}

console.log('\n picking the week');
{
    const mon = new Date('2026-09-14T09:00:00Z');
    const fri = new Date('2026-09-18T22:00:00Z');
    const nextWeek = new Date('2026-09-22T09:00:00Z');

    const a = F.pickFeatured(NETWORK, { period: 'week', now: mon, slug: 'ba' });
    const b = F.pickFeatured(NETWORK, { period: 'week', now: fri, slug: 'ba' });
    T('the same leg all week', a.route.id, b.route.id);
    T('…and it says which week it is for', a.periodKey, '2026-W38');

    const later = F.pickFeatured(NETWORK, { period: 'week', now: nextWeek, slug: 'ba' });
    T('a new week is a new pick', later.periodKey, '2026-W39');

    // Over a year of weeks, a six-leg network should visit more than one leg.
    // Not "every leg exactly evenly" — that is not what a hash promises, and a
    // test that asserts it is a test that fails on a network of seven.
    const seen = new Set();
    for (let w = 0; w < 52; w++) {
        const when = new Date(mon.getTime() + w * 7 * 86400000);
        seen.add(F.pickFeatured(NETWORK, { period: 'week', now: when, slug: 'ba' }).route.id);
    }
    T('it rotates across the network', seen.size >= 4, true);

    // Two airlines, identical networks, same week.
    const one = F.pickFeatured(NETWORK, { period: 'week', now: mon, slug: 'ba' });
    const two = F.pickFeatured(NETWORK, { period: 'week', now: mon, slug: 'klm' });
    const three = F.pickFeatured(NETWORK, { period: 'week', now: mon, slug: 'af' });
    T('different airlines are not handed the same leg',
        new Set([one.route.id, two.route.id, three.route.id]).size > 1, true);
}

console.log('\n picking the day');
{
    const now = new Date('2026-09-16T09:00:00Z');
    const week = F.pickFeatured(NETWORK, { period: 'week', now, slug: 'ba' });
    // Across a fortnight the day must never be the week's leg — one feature
    // drawn twice is a wasted slot on the page.
    let collisions = 0;
    for (let d = 0; d < 14; d++) {
        const when = new Date(now.getTime() + d * 86400000);
        const day = F.pickFeatured(NETWORK, { period: 'day', now: when, slug: 'ba' });
        const wk = F.pickFeatured(NETWORK, { period: 'week', now: when, slug: 'ba' });
        if (day.route.id === wk.route.id) collisions++;
    }
    T('the day is never the week’s leg', collisions, 0);
    T('the day is stable within the day',
        F.pickFeatured(NETWORK, { period: 'day', now: new Date('2026-09-16T01:00:00Z'), slug: 'ba' }).route.id,
        F.pickFeatured(NETWORK, { period: 'day', now: new Date('2026-09-16T23:00:00Z'), slug: 'ba' }).route.id);

    let moved = 0;
    for (let d = 1; d < 8; d++) {
        const when = new Date(now.getTime() + d * 86400000);
        if (F.pickFeatured(NETWORK, { period: 'day', now: when, slug: 'ba' }).route.id
            !== F.pickFeatured(NETWORK, { period: 'day', now, slug: 'ba' }).route.id) moved++;
    }
    T('…and moves across a week', moved >= 3, true);
    T('a one-leg network still has a route of the day',
        F.pickFeatured([NETWORK[0]], { period: 'day', now, slug: 'ba' }).route.id, 'a');
    T('an empty network has none', F.pickFeatured([], { period: 'week', now, slug: 'ba' }), null);
    T('a circular leg is never featured',
        F.eligible([{ id: 'x', origin: 'EGLL', destination: 'EGLL', active: true }]).length, 0);
    T('nor is a draft', F.eligible([{ id: 'x', origin: 'EGLL', destination: 'KJFK', active: false }]).length, 0);
}

console.log('\n a staff pin');
{
    const now = new Date('2026-09-16T09:00:00Z');
    const pinned = F.pickFeatured(NETWORK, {
        period: 'week', now, slug: 'ba', pin: { routeId: 'f', periodKey: '2026-W38' },
    });
    T('a pin set this week wins', pinned.route.id, 'f');
    T('…and says so', pinned.pinned, true);

    const stale = F.pickFeatured(NETWORK, {
        period: 'week', now, slug: 'ba', pin: { routeId: 'f', periodKey: '2026-W20' },
    });
    T('a pin from a period that has rolled over lapses', stale.pinned, false);

    const gone = F.pickFeatured(NETWORK, {
        period: 'week', now, slug: 'ba', pin: { routeId: 'deleted', periodKey: '2026-W38' },
    });
    T('a pin on a route that no longer exists falls back to the rotation', gone.pinned, false);

    const rec = F.toPinRecord({ week: 'f' }, {}, now);
    T('the pin is stamped with the period it was set in', rec.weekPeriod, '2026-W38');
    T('…and carries the route', rec.weekRouteId, 'f');
    const cleared = F.toPinRecord({ week: '' }, rec, now);
    T('an empty id hands the slot back', [cleared.weekRouteId, cleared.weekPeriod], ['', '']);
    const untouched = F.toPinRecord({ day: 'a' }, rec, now);
    T('…and pinning the day leaves the week alone', untouched.weekRouteId, 'f');
}

console.log('\n what a pilot flies');
{
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
    const leg = (min, ac, o, d, status) => ({
        durationMin: min, aircraftName: ac, origin: o, destination: d,
        status: status || 'approved', flownAt: iso(5),
    });

    const thin = F.flyingProfile([leg(90, 'Airbus A320', 'EGLL', 'LFPG'), leg(95, 'Airbus A320', 'LFPG', 'EGLL')]);
    T('two flights is not a habit', thin.confident, false);
    T('…but they are still counted', thin.flights, 2);

    const shortHaul = F.flyingProfile([
        leg(70, 'Airbus A320', 'EGLL', 'LFPG'), leg(85, 'Airbus A320', 'LFPG', 'EGLL'),
        leg(95, 'Airbus A320', 'EGLL', 'EHAM'), leg(60, 'Airbus A320', 'EHAM', 'EGLL'),
        leg(110, 'Boeing 737-800', 'EGLL', 'EIDW'), leg(80, 'Airbus A320', 'EIDW', 'EGLL'),
    ]);
    T('six flights is', shortHaul.confident, true);
    T('…and they lean short', shortHaul.lean, 'short');
    T('…on the type they actually fly', shortHaul.aircraft[0].value, 'Airbus A320');
    T('…out of the field they actually use', shortHaul.airports[0].value, 'EGLL');

    const longHaul = F.flyingProfile([
        leg(480, 'Boeing 777-300ER', 'EGLL', 'KJFK'), leg(500, 'Boeing 777-300ER', 'KJFK', 'EGLL'),
        leg(700, 'Boeing 777-300ER', 'EGLL', 'VHHH'), leg(690, 'Boeing 777-300ER', 'VHHH', 'EGLL'),
        leg(420, 'Boeing 787-9', 'EGLL', 'OMDB'), leg(60, 'Airbus A320', 'EGLL', 'LFPG'),
    ]);
    T('a long-haul pilot leans long', longHaul.lean, 'long');
    // One short hop among five long ones must not drag the lean over: that is
    // the whole reason this is a median.
    T('…and one hop does not move it', longHaul.typicalMin >= F.LONG_HAUL_MIN, true);

    const pending = F.flyingProfile([
        leg(90, 'Airbus A320', 'EGLL', 'LFPG', 'pending'),
        leg(90, 'Airbus A320', 'EGLL', 'LFPG', 'rejected'),
    ]);
    T('a report waiting on staff is not yet flying', pending.flights, 0);
}

console.log('\n suggesting a leg');
{
    const iso = new Date().toISOString();
    const pilot = F.flyingProfile([
        { durationMin: 70, aircraftName: 'Boeing 737-800', origin: 'EGLL', destination: 'LFPG', status: 'approved', flownAt: iso },
        { durationMin: 85, aircraftName: 'Boeing 737-800', origin: 'LFPG', destination: 'EGLL', status: 'approved', flownAt: iso },
        { durationMin: 95, aircraftName: 'Boeing 737-800', origin: 'EGLL', destination: 'EHAM', status: 'approved', flownAt: iso },
        { durationMin: 60, aircraftName: 'Boeing 737-800', origin: 'EHAM', destination: 'EGLL', status: 'approved', flownAt: iso },
        { durationMin: 110, aircraftName: 'Boeing 737-800', origin: 'EGLL', destination: 'EIDW', status: 'approved', flownAt: iso },
        { durationMin: 80, aircraftName: 'Boeing 737-800', origin: 'EIDW', destination: 'EGLL', status: 'approved', flownAt: iso },
    ]);

    const out = F.suggest(NETWORK, pilot, {
        busy: { atc: [{ icao: 'EGKK' }, { icao: 'LEMG' }], inbound: { LEMG: 7 } },
        limit: 6,
    });
    T('every leg comes back scored', out.length, 6);
    T('ATC at both ends wins the top slot', out[0].route.id, 'c');
    T('…and says why', out[0].why[0].text, 'ATC open at both ends — EGKK and LEMG');
    T('…tagged as an ATC reason, so a tile can badge it', out[0].why[0].tone, 'atc');

    // Every printed reason must have scored. A reason generated separately
    // from the score is a reason that drifts from it.
    const bare = F.suggest(NETWORK, pilot, { limit: 6 });
    T('no ATC data, no ATC claims',
        bare.some((s) => s.why.some((w) => w.tone === 'atc')), false);
    T('…and the habits still rank it', bare[0].score > 0, true);
    T('a leg with no reason scores nothing',
        F.suggest([route('z', 'PANC', 'PAFA', { aircraft: 'Cessna 172', distanceNm: 250 })],
            F.flyingProfile([]), {})[0].score, 0);

    const locked = F.suggest(
        NETWORK.map((r) => (r.id === 'c' ? { ...r, locked: true } : r)),
        pilot, { busy: { atc: [{ icao: 'EGKK' }, { icao: 'LEMG' }] }, limit: 6 },
    );
    T('a leg this pilot’s rank has locked is never suggested',
        locked.some((s) => s.route.id === 'c'), false);

    // A brand-new pilot: no habits to lean on, so nothing may claim one.
    const fresh = F.suggest(NETWORK, F.flyingProfile([]), { limit: 3 });
    T('a pilot who has flown nothing gets no habit claims',
        fresh.some((s) => s.why.some((w) => w.tone === 'habit')), false);
    T('…but still gets suggestions', fresh.length, 3);

    T('an empty network suggests nothing', F.suggest([], pilot, {}).length, 0);
    T('a leg is estimated in minutes, taxi included', F.legMinutes({ distanceNm: 440 }), 90);
    T('…and a leg with no distance is not guessed at', F.legMinutes({ distanceNm: 0 }), 0);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
