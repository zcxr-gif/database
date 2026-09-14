'use strict';

/*
 * build-route-library.js — bakes the real-world route reference shipped as
 * data/route-library.json.
 *
 * WHY BAKED AND NOT FETCHED AT REQUEST TIME
 * -----------------------------------------
 * The bulk source (OpenFlights) is a FROZEN snapshot — it stopped being updated
 * in 2014 and has not moved since. Fetching a file that never changes on every
 * request buys nothing and costs an outbound dependency on a path a VA is
 * sitting in front of. So it is resolved, filtered and compacted once, here,
 * and committed. routeLibrary.js reads the result and never calls out.
 *
 * WHAT THIS DOES TO THE RAW DATA, AND WHY
 * ---------------------------------------
 *  1. IATA → ICAO on both endpoints. crew_routes.origin/destination are ICAO
 *     (see cleanRoute in server.js); OpenFlights is IATA throughout. A route we
 *     cannot resolve to two ICAOs cannot be imported, so it is dropped here
 *     rather than imported broken.
 *  2. Drops anything whose endpoints are not in data/airport-coords.json. That
 *     file is what the route map and the event card draw from — a leg to an
 *     airport it does not know is a route that imports fine and then renders as
 *     a gap in the VA's network map. 94% of the source survives this.
 *  3. Precomputes distance in nm. Same haversine the event card uses, so an
 *     imported route's distance matches what the rest of the platform would
 *     have computed for it.
 *  4. Maps IATA equipment codes onto Infinite Flight type names. This is the
 *     step that makes the fleet append possible, and it is also a FILTER: a leg
 *     flown only on an ATR 72 is not flyable in Infinite Flight, and offering
 *     it to an IF virtual airline is offering them a route they cannot fly.
 *  5. Groups by airline and stores each airline once, so serving one airline's
 *     network does not mean scanning 67k rows.
 *
 * Run: node scripts/build-route-library.js
 * Needs network. Re-run only if the upstream snapshot ever moves.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OF = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data';
const OUT = path.join(__dirname, '..', 'data', 'route-library.json');
const COORDS = require(path.join(__dirname, '..', 'data', 'airport-coords.json'));

// ---------------------------------------------------------------------------
// IATA equipment code → Infinite Flight aircraft name.
//
// The names on the right are the canonical strings the live API reports, which
// is what makes an imported route attributable to a VA's fleet. They must match
// /api/crew/aircraft-metadata exactly; a near-miss ("Boeing 737-800 " or "B738")
// produces a fleet row that never matches a flight.
//
// Substitutions are deliberate and conservative. A variant IF does not model is
// mapped to the nearest one it does ONLY where a VA would plausibly fly it as
// that: a 737-300/-400/-500 becomes the 737-700, an A340-300 the -600. Where
// there is no honest stand-in — ATR, Saab, most MD-80s, Beech, Jetstream — the
// code is absent, and a route flown only on those is dropped rather than
// silently re-equipped with something the airline never operated.
// ---------------------------------------------------------------------------
const IF_TYPES = {
    // Airbus narrowbody
    '318': 'Airbus A318-100',
    '319': 'Airbus A319-100', '31X': 'Airbus A319-100',
    '320': 'Airbus A320-200', '32A': 'Airbus A320-200', '32S': 'Airbus A320-200', '32X': 'Airbus A320-200',
    '321': 'Airbus A321-200', '32B': 'Airbus A321-200',
    'CS1': 'Airbus A220-300', 'CS3': 'Airbus A220-300', '221': 'Airbus A220-300', '223': 'Airbus A220-300',
    // Airbus widebody
    '332': 'Airbus A330-200F', '333': 'Airbus A330-300', '330': 'Airbus A330-300', '33X': 'Airbus A330-300',
    '339': 'Airbus A330-900neo',
    '340': 'Airbus A340-600', '343': 'Airbus A340-600', '345': 'Airbus A340-600', '346': 'Airbus A340-600',
    '350': 'Airbus A350-900', '351': 'Airbus A350-900', '359': 'Airbus A350-900', '35X': 'Airbus A350-900',
    '380': 'Airbus A380-800', '388': 'Airbus A380-800',
    // Boeing narrowbody
    '717': 'Boeing 717-200',
    '733': 'Boeing 737-700', '734': 'Boeing 737-700', '735': 'Boeing 737-700', '736': 'Boeing 737-700',
    '737': 'Boeing 737-700', '73C': 'Boeing 737-700', '73G': 'Boeing 737-700', '73W': 'Boeing 737-700',
    '738': 'Boeing 737-800', '73H': 'Boeing 737-800',
    '739': 'Boeing 737-900', '73J': 'Boeing 737-900',
    '7M8': 'Boeing 737-8 MAX', '38M': 'Boeing 737-8 MAX',
    '752': 'Boeing 757-200', '757': 'Boeing 757-200', '75W': 'Boeing 757-200',
    // Boeing widebody
    '741': 'Boeing 747-200', '742': 'Boeing 747-200', '743': 'Boeing 747-200',
    '744': 'Boeing 747-400', '747': 'Boeing 747-400', '74E': 'Boeing 747-400', '74M': 'Boeing 747-400',
    '748': 'Boeing 747-8', '74H': 'Boeing 747-8',
    '762': 'Boeing 767-300', '763': 'Boeing 767-300', '764': 'Boeing 767-300', '767': 'Boeing 767-300',
    '76W': 'Boeing 767-300',
    '772': 'Boeing 777-200ER', '777': 'Boeing 777-200ER', '77L': 'Boeing 777-200LR',
    '773': 'Boeing 777-300ER', '77W': 'Boeing 777-300ER', '77F': 'Boeing 777F',
    '787': 'Boeing 787-8 Dreamliner', '788': 'Boeing 787-8 Dreamliner',
    '789': 'Boeing 787-9 Dreamliner', '78X': 'Boeing 787-10 Dreamliner', '781': 'Boeing 787-10 Dreamliner',
    // Regional jets
    'CR2': 'Bombardier CRJ-200', 'CRJ': 'Bombardier CRJ-200',
    'CR7': 'Bombardier CRJ-700', 'CR9': 'Bombardier CRJ-900', 'CRK': 'Bombardier CRJ-1000',
    'E70': 'Embraer E175', 'E75': 'Embraer E175', 'ER4': 'Embraer E175', 'ERJ': 'Embraer E175',
    'E90': 'Embraer E190', 'E95': 'Embraer E190',
    // Turboprop
    'DH4': 'Bombardier Dash 8-Q400', 'DH8': 'Bombardier Dash 8-Q400',
    'CN1': 'Cessna 208 Caravan', '208': 'Cessna 208 Caravan',
    // Trijets / classics still worth offering
    'D10': 'McDonnell Douglas DC-10', 'M11': 'McDonnell Douglas MD-11', 'D11': 'McDonnell Douglas MD-11',
};

const get = (url) => new Promise((resolve, reject) => {
    https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} → HTTP ${res.statusCode}`)); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
    }).on('error', reject);
});

// OpenFlights .dat files are CSV with quoted fields and a literal \N for null.
const splitCsv = (line) => {
    const out = []; let cur = ''; let quoted = false;
    for (const ch of line) {
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((f) => { const t = f.trim(); return t === '\\N' ? '' : t; });
};

// Same constant and shape as haversineNm in vaEventCardImage.js, so an imported
// route's distance agrees with the one the event card draws.
const haversineNm = (a, b) => {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return Math.round(3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(h))));
};

async function main() {
    console.log('fetching OpenFlights snapshot…');
    const [airportsDat, airlinesDat, routesDat] = await Promise.all([
        get(`${OF}/airports.dat`), get(`${OF}/airlines.dat`), get(`${OF}/routes.dat`),
    ]);

    // IATA → ICAO, restricted to airports the platform can actually place.
    const icaoOf = new Map();
    for (const line of airportsDat.split('\n')) {
        if (!line.trim()) continue;
        const f = splitCsv(line);
        const iata = (f[4] || '').toUpperCase();
        const icao = (f[5] || '').toUpperCase();
        if (!iata || !/^[A-Z0-9]{4}$/.test(icao)) continue;
        if (!COORDS[icao]) continue;       // not drawable → not importable
        icaoOf.set(iata, icao);
    }
    console.log(`  airports: ${icaoOf.size} IATA→ICAO pairs the map can place`);

    // Airline IATA/ICAO → display identity. Keyed by the OpenFlights row id,
    // because routes.dat points at that and not at the code.
    const airlineById = new Map();
    for (const line of airlinesDat.split('\n')) {
        if (!line.trim()) continue;
        const f = splitCsv(line);
        const [id, name, , iata, icao, callsign, country, active] = f;
        if (!id || !name) continue;
        airlineById.set(id, {
            name, iata: (iata || '').toUpperCase(), icao: (icao || '').toUpperCase(),
            callsign: callsign || '', country: country || '', active: active === 'Y',
        });
    }

    const byAirline = new Map();
    let total = 0; let dropped = 0; let noIcao = 0; let noType = 0;

    for (const line of routesDat.split('\n')) {
        if (!line.trim()) continue;
        const f = line.trim().split(',').map((s) => s.trim());
        if (f.length < 9) continue;
        total++;
        const [, airlineId, srcIata, , dstIata, , codeshare, stops, equipment] = f;
        // Direct legs only. A multi-stop entry is one marketed flight number
        // over two sectors, and a VA's network is built from sectors.
        if (stops && stops !== '0') { dropped++; continue; }

        const origin = icaoOf.get(srcIata.toUpperCase());
        const destination = icaoOf.get(dstIata.toUpperCase());
        if (!origin || !destination || origin === destination) { dropped++; noIcao++; continue; }

        const types = [...new Set(
            (equipment || '').split(/\s+/).filter(Boolean)
                .map((code) => IF_TYPES[code.toUpperCase()]).filter(Boolean),
        )];
        if (!types.length) { dropped++; noType++; continue; }

        const air = airlineById.get(airlineId);
        if (!air) { dropped++; continue; }
        // An airline with no code at all cannot be looked up or labelled.
        const key = air.icao || air.iata;
        if (!key) { dropped++; continue; }

        if (!byAirline.has(key)) {
            byAirline.set(key, {
                key, name: air.name, iata: air.iata, icao: air.icao,
                callsign: air.callsign, country: air.country, active: air.active, routes: [],
            });
        }
        byAirline.get(key).routes.push({
            o: origin,
            d: destination,
            nm: haversineNm(COORDS[origin], COORDS[destination]),
            // Every IF type the real airline is recorded as flying the leg on.
            // Plural on purpose: the import offers the VA a choice rather than
            // picking one for them.
            ac: types,
            // OpenFlights' codeshare flag lands directly on crew_routes.kind,
            // which already splits a network into own metal and sold-under-
            // partner legs. Free fidelity.
            cs: codeshare === 'Y' ? 1 : 0,
        });
    }

    // De-duplicate: the source lists a city pair once per marketing arrangement,
    // so a hub pair can appear four times with the same equipment. A VA wants
    // the leg once.
    let kept = 0;
    const airlines = [...byAirline.values()].map((a) => {
        const seen = new Map();
        for (const r of a.routes) {
            const k = `${r.o}-${r.d}`;
            const prev = seen.get(k);
            if (!prev) { seen.set(k, r); continue; }
            // Keep the union of equipment, and prefer own metal over codeshare:
            // if the airline flies the pair itself at all, it is not a codeshare.
            prev.ac = [...new Set([...prev.ac, ...r.ac])];
            prev.cs = prev.cs && r.cs;
        }
        const routes = [...seen.values()].sort((x, y) => x.o.localeCompare(y.o) || x.d.localeCompare(y.d));
        kept += routes.length;
        return { ...a, routes };
    }).filter((a) => a.routes.length)
        .sort((a, b) => b.routes.length - a.routes.length);

    const out = {
        _comment: 'Real-world route reference for the crew-centre route importer. '
            + 'Built by scripts/build-route-library.js from the OpenFlights snapshot '
            + '(https://openflights.org/data.html, ODbL). The snapshot is FROZEN AT 2014 — '
            + 'it is a starting point a VA reviews, never an authority. Endpoints are ICAO and '
            + 'are all present in airport-coords.json; distance is nm; `ac` lists Infinite Flight '
            + 'type names only; `cs` marks a codeshare.',
        source: 'OpenFlights (ODbL)', sourceUrl: 'https://openflights.org/data.html',
        snapshotYear: 2014,
        builtAt: new Date().toISOString().slice(0, 10),
        airlines,
    };
    fs.writeFileSync(OUT, JSON.stringify(out));

    console.log(`  source rows      : ${total}`);
    console.log(`  dropped          : ${dropped} (${noIcao} unplaceable airport, ${noType} no IF-flyable type)`);
    console.log(`  kept (deduped)   : ${kept} legs across ${airlines.length} airlines`);
    console.log(`  written          : ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
