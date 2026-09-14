'use strict';
// Conformance test for the real-world route importer — routeLibrary.js and the
// shared planner it leans on.
//
// The properties worth protecting are the ones that would quietly put wrong
// data into a VA's public network rather than throw:
//
//   * every leg offered is importable: two ICAOs the platform can place, never
//     a circular route, always at least one aircraft Infinite Flight actually has
//   * the aircraft names are the canonical live-API strings, because a fleet row
//     that is one character off never matches a flight
//   * a codeshare never invents its operator
//   * importing the same airline twice is a no-op, not a duplicated network
//   * a re-import leaves alone the fields the library knows nothing about — a
//     rank gate the VA set by hand must survive
//   * the planner refuses a row with a missing or circular airport
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const routeLibrary = require(path.join('..', 'routeLibrary.js'));
const crewCsv = require(path.join('..', 'crewCsv.js'));
const COORDS = require(path.join('..', 'data', 'airport-coords.json'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// The 60 type names Infinite Flight actually has, as the community aircraft
// library records them. A name the fleet editor cannot offer is a name that
// will never match a live flight.
const IF_NAMES = new Set(
    require(path.join('..', 'aircraft.json')).map((a) => `${a.manufacturer} ${a.model}`.trim()),
);

console.log('\n the library itself');
{
    const all = routeLibrary.airlines('', 5000);
    T('the snapshot is labelled with its source', all.source, 'OpenFlights (ODbL)');
    T('…and with how old it is', all.snapshotYear, 2014);
    T('airlines are offered', all.airlines.length > 100, true);

    // Walk every leg of every airline once. This is the check that matters:
    // anything that survives the builder is something a VA can be shown.
    let legs = 0; let badAirport = 0; let circular = 0; let badType = 0; let noType = 0;
    for (const a of routeLibrary.airlines('', 5000).airlines) {
        const full = routeLibrary.airline(a.key);
        for (const r of full.routes) {
            legs++;
            if (!COORDS[r.origin] || !COORDS[r.destination]) badAirport++;
            if (r.origin === r.destination) circular++;
            if (!r.aircraftOptions.length) noType++;
            for (const t of r.aircraftOptions) if (!IF_NAMES.has(t)) badType++;
        }
    }
    T('every leg has both airports on the map', badAirport, 0);
    T('no leg starts and ends in the same place', circular, 0);
    T('every leg has at least one flyable aircraft', noType, 0);
    T('every aircraft name is one Infinite Flight has', badType, 0);
    T('the network is a real size', legs > 20000, true);
}

console.log('\n what it refuses to guess');
{
    const ba = routeLibrary.airline('BAW');
    T('an airline resolves by ICAO', ba.airline.name, 'British Airways');
    T('…and by IATA', routeLibrary.airline('BA').airline.name, 'British Airways');
    T('…and an unknown code is null, not an empty network', routeLibrary.airline('ZZZZ'), null);

    // A REAL-WORLD CODESHARE IS NOT THIS PLATFORM'S CODESHARE.
    // `kind: 'codeshare'` here means a named partner VA flies the leg for us.
    // The source means "a real airline sold a seat on someone else's aeroplane
    // in 2014" and does not say whose. Importing one as the other invents a
    // partnership, and — the operator being unknown — lands every leg with an
    // empty partnerName, which is precisely what the routes screen refuses when
    // it is typed by hand and what codesharePartners folds into one tile reading
    // "Partner airline".
    const cs = ba.routes.filter((r) => r.realCodeshare);
    T('legs the airline sold but did not fly are flagged', cs.length > 0, true);
    T('…but nothing is imported as a codeshare on its own',
        ba.routes.every((r) => r.kind === 'own'), true);
    T('…and no partner name is ever invented',
        ba.routes.every((r) => r.partnerName === ''), true);
    // Iberia is the case that made this obvious: 79% of its listed network.
    {
        const ibe = routeLibrary.airline('IBE');
        const n = ibe.routes.filter((r) => r.realCodeshare).length;
        T('the worst case is flagged rather than imported blind', n > 500, true);
        T('…with none of it landing as an unnamed codeshare',
            ibe.routes.every((r) => !(r.kind === 'codeshare' && !r.partnerName)), true);
    }

    // A flight number is not in the source. Inventing "BA001" would be putting
    // a confident fabrication in the field pilots read first.
    T('no leg arrives with an invented flight number',
        ba.routes.every((r) => r.flightNumber === ''), true);
}

console.log('\n fleet annotation');
{
    const fleet = [{ type: 'Boeing 777-200ER' }, { type: 'Boeing 747-400' }];
    const ba = routeLibrary.airline('BAW', { fleet });
    const flown = ba.routes.filter((r) => r.inFleet);
    T('legs the VA can already fly are marked', flown.length > 0, true);
    T('…and they name nothing to add',
        flown.every((r) => r.aircraftOptions.some((t) => fleet.some((f) => f.type === t))), true);
    const adds = ba.routes.filter((r) => !r.inFleet);
    T('…while the rest name exactly what they would add',
        adds.every((r) => r.newTypes.length > 0
            && r.newTypes.every((t) => !fleet.some((f) => f.type === t))), true);
    T('an empty fleet means nothing is in it',
        routeLibrary.airline('BAW').routes.some((r) => r.inFleet), false);
}

console.log('\n importing it');
{
    // What the endpoint does: library rows → cleaned values → the shared planner.
    const rowsFor = (routes, startAt = 1) => routes.map((r, i) => ({
        line: startAt + i,
        id: '',
        values: {
            flightNumber: '', origin: r.origin, destination: r.destination,
            aircraft: r.aircraft, distanceNm: r.distanceNm, notes: '',
            active: false, kind: r.kind, partnerName: r.partnerName,
        },
        error: null,
    }));
    const PRESENT = new Set(['flightNumber', 'origin', 'destination', 'aircraft',
        'distanceNm', 'notes', 'active', 'kind', 'partnerName']);
    const plan = (routes, existing) =>
        crewCsv.planRows(crewCsv.ROUTES_SPEC, rowsFor(routes), existing, { present: PRESENT });

    const picked = routeLibrary.airline('BAW').routes.slice(0, 10);
    const first = plan(picked, []);
    T('a fresh import creates every leg', first.create.length, 10);
    T('…and updates nothing', first.update.length, 0);
    T('…with no bad rows', first.errors.length, 0);
    T('…as drafts, so nothing goes public unreviewed',
        first.create.every((r) => r.values.active === false), true);

    // What is now in the VA's database, as crewStore would hand it back.
    const stored = first.create.map((r, i) => ({ id: `r${i}`, ...r.values }));

    const again = plan(picked, stored);
    T('importing the same airline twice adds nothing', again.create.length, 0);
    T('…and changes nothing', again.update.length, 0);
    T('…it is all simply already there', again.unchanged, 10);

    // The VA has since gated a leg and published it. The library has no opinion
    // about either field, so a re-import must not have one.
    const edited = stored.map((r, i) => (i === 0 ? { ...r, minRank: 'Senior First Officer', active: true } : r));
    const third = plan(picked, edited);
    const touched = third.update.find((u) => u.id === 'r0');
    T('a re-import does not clear a rank gate the VA set',
        touched ? Object.prototype.hasOwnProperty.call(touched.values, 'minRank') : false, false);

    // The endpoint drops `active` from every UPDATE before it writes (see
    // /routes/library-import). Without that, a VA who published their network
    // in March and re-imports in June to pick up two new legs has the whole
    // live network silently returned to draft.
    const applyPublishedGuard = (p) => {
        let unchanged = p.unchanged;
        const updates = [];
        for (const row of p.update) {
            const { active, ...rest } = row.values;
            if (!Object.keys(rest).length) { unchanged++; continue; }
            updates.push({ ...row, values: rest });
        }
        return { ...p, update: updates, unchanged };
    };
    const guarded = applyPublishedGuard(third);
    T('…and a published leg is not quietly re-drafted',
        guarded.update.some((u) => u.id === 'r0'), false);
    T('…it counts as unchanged instead', guarded.unchanged, 10);

    // The guard must not swallow a real edit that arrives alongside `active`.
    const reEquipped = picked.map((r, i) => (i === 0 ? { ...r, aircraft: 'Boeing 787-9 Dreamliner' } : r));
    const fourth = applyPublishedGuard(plan(reEquipped, edited));
    const still = fourth.update.find((u) => u.id === 'r0');
    T('a genuine change still updates', still ? still.values.aircraft : null, 'Boeing 787-9 Dreamliner');
    T('…without carrying the published state with it',
        still ? Object.prototype.hasOwnProperty.call(still.values, 'active') : true, false);
}

console.log('\n the codeshare rule');
{
    // The guard the endpoint applies before planning: the same rule the routes
    // screen enforces on a hand-typed leg.
    const guard = (v) => (v.kind === 'codeshare' && !v.partnerName)
        ? 'a codeshare needs the partner airline named — or import it as your own metal' : null;
    T('a codeshare with no partner is refused',
        guard({ kind: 'codeshare', partnerName: '' }),
        'a codeshare needs the partner airline named — or import it as your own metal');
    T('…and one with a partner is fine', guard({ kind: 'codeshare', partnerName: 'Iberia Virtual' }), null);
    T('…while own metal never needs one', guard({ kind: 'own', partnerName: '' }), null);
}

console.log('\n rows it will not accept');
{
    const bad = [
        { line: 1, id: '', values: { origin: '', destination: 'EGLL' }, error: 'this route is missing an airport' },
        { line: 2, id: '', values: { origin: 'EGLL', destination: 'EGLL' }, error: 'this route starts and ends at the same airport' },
        { line: 3, id: '', values: { origin: 'EGLL', destination: 'KJFK', aircraft: 'Boeing 777-200ER', active: false }, error: null },
    ];
    const p = crewCsv.planRows(crewCsv.ROUTES_SPEC, bad, [], {
        present: new Set(['origin', 'destination', 'aircraft', 'active']),
    });
    T('a leg with no airport is reported', p.errors[0].message, 'this route is missing an airport');
    T('a circular leg is reported', p.errors[1].message, 'this route starts and ends at the same airport');
    T('…by line number', p.errors.map((e) => e.line), [1, 2]);
    T('…and the good row is still planned', p.create.length, 1);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
