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

    return {
        ...attribution(),
        airline: {
            key: a.key, name: a.name, iata: a.iata, icao: a.icao,
            callsign: a.callsign, country: a.country, active: a.active,
        },
        routes: a.routes.map((r) => ({
            origin: r.o,
            destination: r.d,
            distanceNm: r.nm,
            aircraft: r.ac[0] || '',
            aircraftOptions: r.ac,
            kind: r.cs ? 'codeshare' : 'own',
            // Left EMPTY on a codeshare, on purpose. The source records THAT a
            // leg is a codeshare but not who operates it, and `partnerName` means
            // the operating partner — filling it with the marketing airline's own
            // name would put a confident wrong answer in the one field the whole
            // codeshare split exists to carry. The confirm table flags these so
            // the VA names the partner, or flips the row to own metal.
            partnerName: '',
            flightNumber: '',
            notes: '',
            // Not persisted — the confirm table reads them.
            inFleet: r.ac.some((t) => have.has(fold(t))),
            // The types this leg would ADD to the fleet if taken as-is.
            newTypes: r.ac.filter((t) => !have.has(fold(t))),
        })),
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
