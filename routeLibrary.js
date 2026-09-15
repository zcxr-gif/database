'use strict';

/*
 * routeLibrary.js — where a virtual airline gets a real airline's network from.
 *
 * A VA signs up with an empty Routes screen and a real airline's name. Typing
 * four hundred legs in by hand is the reason most of them never get past twenty,
 * and a network of twenty legs is the reason their pilots drift off. This module
 * is the shortcut: pick the airline you are modelled on, see what it flies, tick
 * what you want.
 *
 * TWO SOURCES, DELIBERATELY DIFFERENT IN KIND
 * -------------------------------------------
 *   BULK (`airlines`, `airline`)  — data/route-library.json, built offline by
 *   scripts/build-route-library.js from the OpenFlights snapshot. Complete per
 *   airline, instant, no network, and FROZEN AT 2014. It answers "roughly what
 *   does this airline's network look like", which is the right question when
 *   you are filling an empty screen.
 *
 *   LIVE (`lookupCallsign`)       — api.adsbdb.com, one flight number at a time.
 *   Current, and therefore the right thing when a VA wants to check one leg or
 *   add today's flight number. It knows where a callsign flies; it does NOT know
 *   what aircraft flies it, so a live result arrives with no type and the VA
 *   picks one. Saying so is better than guessing on their behalf.
 *
 * NEITHER IS AN AUTHORITY, AND THE UI SAYS SO
 * -------------------------------------------
 * Everything here is a SUGGESTION. The import flow exists to be reviewed: rows
 * are previewed before anything is written, and land as drafts (`active: false`)
 * so a VA's public network never gains a leg nobody looked at. A 2014 snapshot
 * will offer routes that died a decade ago and miss every route opened since,
 * and the aeroplane a real airline flies a leg on today is frequently not the
 * one recorded here. That is expected, and it is why a human confirms.
 *
 * LICENSING. OpenFlights is ODbL; the attribution travels with the data, is
 * returned on every response as `source`, and is shown in the dashboard.
 */

const path = require('path');
const axios = require('axios');

// ---------------------------------------------------------------------------
// The baked snapshot. ~4 MB on disk, ~24 MB parsed, and read exactly once on
// the first request that needs it rather than at boot: most processes never
// serve a route import at all, and a VA who is importing is already waiting on
// a click. `require` caches, so this is a load-once by construction.
// ---------------------------------------------------------------------------
let _lib = null;
function lib() {
    if (!_lib) _lib = require(path.join(__dirname, 'data', 'route-library.json'));
    return _lib;
}

const attribution = () => {
    const l = lib();
    return { source: l.source, sourceUrl: l.sourceUrl, snapshotYear: l.snapshotYear, builtAt: l.builtAt };
};

const fold = (s) => String(s || '').trim().toLowerCase();

/**
 * Airline search for the picker. Index only — never the legs, which are two
 * orders of magnitude bigger and are not needed to choose.
 *
 * Ranked so that typing "BA" puts British Airways above Air Botswana: an exact
 * code match first, then a name that starts with the query, then a name that
 * merely contains it. An airline the source marks defunct sorts last but is not
 * hidden — plenty of VAs deliberately model a dead airline.
 */
function airlines(query = '', limit = 40) {
    const q = fold(query);
    const rows = lib().airlines.map((a) => {
        const name = fold(a.name);
        let rank = -1;
        if (!q) rank = 0;
        else if (fold(a.icao) === q || fold(a.iata) === q) rank = 3;
        else if (name.startsWith(q)) rank = 2;
        else if (name.includes(q) || fold(a.callsign).includes(q)) rank = 1;
        return { a, rank };
    }).filter((r) => r.rank >= 0);

    rows.sort((x, y) => (y.rank - x.rank)
        || ((y.a.active ? 1 : 0) - (x.a.active ? 1 : 0))
        || (y.a.routes.length - x.a.routes.length));

    return {
        ...attribution(),
        airlines: rows.slice(0, limit).map(({ a }) => ({
            key: a.key, name: a.name, iata: a.iata, icao: a.icao,
            callsign: a.callsign, country: a.country, active: a.active,
            routes: a.routes.length,
            // Distinct Infinite Flight types across the whole network, so the
            // picker can say "12 aircraft types" before anything is loaded.
            types: new Set(a.routes.flatMap((r) => r.ac)).size,
        })),
        total: rows.length,
    };
}

/**
 * One airline's network, expanded into the shape the routes editor speaks
 * (the same field names cleanRoute and ROUTES_SPEC use), so the confirm table,
 * the import planner and the CSV path all read one vocabulary.
 *
 * `aircraft` is ONE type, not the list: a crew_routes row holds a single
 * aircraft. The first is chosen because the builder keeps them in the order the
 * source listed them, which puts the type the airline actually flies the leg on
 * most first often enough to be a sane default — and `aircraftOptions` carries
 * the rest so the VA can change it per row without leaving the screen.
 *
 * No flight number. OpenFlights does not carry one, and inventing "BA001" for a
 * leg would be fabricating the single field a VA is most likely to trust
 * blindly. Left empty; the editor and the CSV both accept it being blank, and
 * the city pair is what the importer matches on.
 */
function airline(key, { fleet = [] } = {}) {
    const k = fold(key);
    const a = lib().airlines.find((x) => fold(x.key) === k || fold(x.icao) === k || fold(x.iata) === k);
    if (!a) return null;

    // What the VA already operates, so a row can be marked as flyable on their
    // own metal today rather than needing the fleet to grow.
    const have = new Set((fleet || []).map((f) => fold(typeof f === 'string' ? f : f && f.type)));

    /* WHICH AIRCRAFT THIS AIRLINE ACTUALLY FLIES — AND WHICH BELONG TO WHOEVER
     * FLIES FOR IT.
     *
     * An aeroplane on a leg the airline SOLD BUT DID NOT FLY is not the
     * airline's aeroplane. It belongs to whichever partner or regional operated
     * the leg, and the source does not record who that is.
     *
     * AeroMéxico is the case that makes this concrete. Its listed network has 11
     * CRJ-900 legs and it has never flown a CRJ-900 in its life — Aeroméxico
     * Connect does. Seven of its sixteen listed types are like this (A319, A320,
     * 717, 737-900, 757-200, CRJ-700, CRJ-900): every single appearance is on a
     * leg somebody else operated. Taking the aircraft off those legs at face
     * value put seven aeroplanes the airline does not own into the VA's fleet,
     * and then offered to paint them in AeroMéxico's own livery — a combination
     * Infinite Flight may not even have.
     *
     * So a type counts as this airline's only if it appears on at least one leg
     * the airline flew ITSELF. That is a fact the data does support, unlike the
     * identity of the operator, which it does not: matching a codeshare leg
     * against who flies the same pair on the same type yields one candidate 48%
     * of the time and nothing at all 37% — and for those AeroMéxico CRJ-900 legs
     * specifically, nothing. We do not guess. We just decline to hand the VA
     * somebody else's aeroplane. */
    const operates = new Set();
    for (const r of a.routes) if (!r.cs) for (const t of r.ac) operates.add(fold(t));
    const isTheirs = (t) => operates.has(fold(t));

    return {
        ...attribution(),
        airline: {
            key: a.key, name: a.name, iata: a.iata, icao: a.icao,
            callsign: a.callsign, country: a.country, active: a.active,
        },
        // Every type this airline is recorded flying on its own metal. The fleet
        // step adds from HERE and nowhere else.
        operatedTypes: [...new Set(a.routes.filter((r) => !r.cs).flatMap((r) => r.ac))].sort(),
        routes: a.routes.map((r) => {
            // Prefer an aeroplane the airline actually flies. On a leg it flew
            // itself that is every option; on one it only sold, it may be none —
            // and then the route arrives with no aircraft rather than with the
            // partner's, so the VA picks from their own fleet.
            const mine = r.ac.filter(isTheirs);
            return {
            origin: r.o,
            destination: r.d,
            distanceNm: r.nm,
            aircraft: mine[0] || '',
            aircraftOptions: r.ac,
            // The subset of aircraftOptions this airline flies itself. The
            // picker offers the rest too — a VA may well decide to fly the leg
            // on the partner's type — but only these are ever added to a fleet.
            ownAircraftOptions: mine,
            // True when the only aeroplanes listed for this leg belong to
            // somebody else. The tick list says so, and the route arrives with
            // the aircraft left for the VA to choose.
            partnerAircraftOnly: r.ac.length > 0 && mine.length === 0,
            /* ALWAYS 'own'. A REAL-WORLD CODESHARE IS NOT THIS PLATFORM'S.
             *
             * `crew_routes.kind = 'codeshare'` means "another VIRTUAL airline on
             * this platform flies this leg for us" — a relationship the VA has
             * actually agreed with somebody, whose name goes on a partner tile
             * and a public website. The source's codeshare flag means something
             * else entirely: a real airline sold a seat on another real airline's
             * aeroplane, in 2014, and the source does not record which one.
             *
             * Importing one as the other invents a partnership with an airline
             * that is not on the platform at all, and — because the operator is
             * unknown — every such leg lands with an empty partnerName. The
             * routes screen refuses that combination when it is typed by hand
             * ("Name the partner airline for a codeshare"), and codesharePartners
             * in server.js folds every unnamed one into a single tile reading
             * "Partner airline". Importing Iberia this way produced 632 legs in
             * one meaningless tile.
             *
             * We do not guess, either: asking which other airline flies the pair
             * on its own metal yields exactly one candidate 36% of the time, and
             * a 64%-wrong airline name on a public partner tile is worse than no
             * tile at all.
             *
             * So every imported leg is the VA's own metal, and `realCodeshare`
             * below is CONTEXT rather than a decision — the confirm step tells
             * the VA which legs the real airline did not fly itself and lets
             * them name a partner, take them as their own, or leave them out. */
            kind: 'own',
            partnerName: '',
            // Informational only, never persisted: "the real airline sold this
            // leg but did not operate it".
            realCodeshare: !!r.cs,
            flightNumber: '',
            notes: '',
            // Not persisted — the confirm table reads them.
            inFleet: mine.some((t) => have.has(fold(t))),
            // The types this leg would ADD to the fleet if taken as-is. Only
            // ever the airline's own: a partner's aeroplane is never added.
            newTypes: mine.filter((t) => !have.has(fold(t))),
        }; }),
    };
}

// ---------------------------------------------------------------------------
// The live half.
//
// UNVERIFIED IN CI. api.adsbdb.com is not reachable from the build sandbox this
// was written in, so the parsing below is written against the documented shape
// and is deliberately paranoid: anything unexpected degrades to "no route
// found", never to a throw and never to a half-filled row. If the upstream
// shape has moved, the failure a VA sees is "we couldn't find that flight
// number", which is the correct thing to show them either way.
// ---------------------------------------------------------------------------
const ADSBDB = 'https://api.adsbdb.com/v0/callsign';

// A short cache. The same VA checks the same handful of numbers repeatedly
// while building a network, and the upstream is a free service being asked
// nicely.
const _live = new Map();
const LIVE_TTL = 30 * 60 * 1000;
const LIVE_MAX = 500;

const icao4 = (v) => {
    const s = String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z0-9]{4}$/.test(s) ? s : '';
};

/**
 * Where does this flight number actually go, today?
 *
 * @returns {Promise<null|{callsign, airline, origin, destination, distanceNm,
 *                        aircraft: '', live: true}>}
 *          null when the upstream does not know it, or is not answering.
 */
async function lookupCallsign(raw, { coords = null } = {}) {
    const callsign = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (callsign.length < 3) return null;

    const hit = _live.get(callsign);
    if (hit && (Date.now() - hit.at) < LIVE_TTL) return hit.data;

    let data = null;
    try {
        const res = await axios.get(`${ADSBDB}/${encodeURIComponent(callsign)}`, {
            timeout: 6000,
            // A 404 is the ordinary answer for a number nobody files, not a fault.
            validateStatus: (s) => s === 200 || s === 404,
        });
        const fr = res.status === 200 && res.data && res.data.response && res.data.response.flightroute;
        const origin = icao4(fr && fr.origin && fr.origin.icao_code);
        const destination = icao4(fr && fr.destination && fr.destination.icao_code);
        if (origin && destination && origin !== destination) {
            data = {
                callsign,
                flightNumber: String((fr.callsign_iata || fr.callsign || callsign)).slice(0, 12),
                airlineName: String((fr.airline && fr.airline.name) || '').slice(0, 60),
                origin,
                destination,
                originName: String((fr.origin && fr.origin.name) || '').slice(0, 80),
                destinationName: String((fr.destination && fr.destination.name) || '').slice(0, 80),
                // Computed from OUR airport table when it knows both ends, so a
                // live row's distance is the same number a bulk row would carry.
                // Zero rather than a guess when it does not — the editor treats
                // 0 as "not set" and the route still saves.
                distanceNm: (coords && coords[origin] && coords[destination])
                    ? haversineNm(coords[origin], coords[destination]) : 0,
                // adsbdb answers "where does this callsign go", not "on what".
                // Left empty and flagged, so the UI asks rather than invents.
                aircraft: '',
                aircraftUnknown: true,
                live: true,
                source: 'adsbdb.com',
            };
        }
    } catch {
        // Upstream down, blocked, or slow. A route importer whose bulk half
        // works must not fail because its optional live half did.
        return null;
    }

    if (_live.size >= LIVE_MAX) _live.delete(_live.keys().next().value);
    _live.set(callsign, { at: Date.now(), data });
    return data;
}

const haversineNm = (a, b) => {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return Math.round(3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(h))));
};

module.exports = { airlines, airline, lookupCallsign, attribution };
