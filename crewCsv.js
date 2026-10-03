'use strict';

/*
 * crewCsv.js
 * Getting a roster or a route network out of a crew center, and back in.
 *
 * WHY
 * ---
 * "Your data is yours" is only true if you can pick it up and carry it. The
 * crew center already keeps a VA's roster and routes in the VA's own Postgres,
 * which settles the ownership question, but a Postgres table is not a form a
 * volunteer airline manager can actually use — they want the roster in a
 * spreadsheet, and they arrive with one. Most VAs on the platform were running
 * on a spreadsheet the day before they signed up.
 *
 * So: export the exact columns import accepts, and accept the exact columns
 * export produces. A file that goes out and comes back unedited must be a no-op.
 * That symmetry is the whole design, and it is why the id column is exported —
 * a row that carries its id updates precisely, with no guessing.
 *
 * MATCHING, WHEN THERE IS NO ID
 * -----------------------------
 * A file typed from scratch has no ids, so each spec below names the fields
 * that identify a row instead, tried in order. The first one that hits wins.
 * Nothing matches on a field a VA is likely to edit in bulk (a rename, a mass
 * re-assignment of ranks), because a match that breaks when someone fixes a
 * typo silently duplicates their whole roster.
 *
 * IMPORT NEVER DELETES
 * --------------------
 * A row present in the crew center and absent from the file is left alone. This
 * is not a sync: a VA importing a partial file — the twelve pilots they just
 * recruited, an updated set of hours for one wing — must not lose the rest,
 * and there is no way for us to tell that file apart from a complete one.
 * Removing a pilot is its own deliberate action on the roster screen.
 */

const Papa = require('papaparse');

// Excel on Windows reads a UTF-8 file as its own legacy code page unless the
// byte-order mark is there. Without this, every non-ASCII pilot name in an
// exported roster opens as mojibake — and these are airlines with pilots called
// Müller and Peña.
const BOM = '﻿';

// Cap the work a single import can ask for. A roster is hundreds of rows; a
// file with a hundred thousand is a mistake or an attack, and either way the
// answer is to refuse it rather than to spend ten minutes finding out.
const MAX_ROWS = 5000;

// A workbook is a handful of tabs, not hundreds. Tabs past this are reported
// and left unread rather than refused, so one enormous workbook still imports
// the part of it that is a route network.
const MAX_SHEETS = 40;

// How far down a sheet we look for the row that names the columns. A sheet laid
// out for people often has a title, a date or a blank line above the table.
const HEADER_SCAN_ROWS = 15;

// How many cells of a column we test before trusting what its header claims.
const SAMPLE_CELLS = 40;

// What a column in someone else's file can be pointed at, besides one of ours:
// nothing, or appended to the notes so it is not lost.
const IGNORE = '';
const TO_NOTES = '+notes';
// …or, for routes, read as both airports at once: "OMAA-KJFK".
const TO_PAIR = '+pair';

// How many rows of each tab the preview shows as they will be read, plus
// every row with something wrong, up to the second cap.
const PREVIEW_ROWS = 30;
const PREVIEW_MAX = 150;

const trim = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Header matching is forgiving on purpose. The file that comes back may have
// been through Excel, Numbers and a hand edit, and "Flight Number",
// "flight_number" and "flightNumber" are all obviously the same column to
// everyone except a strict parser.
const normalizeHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "depICAO", "Departure Airport", "Origin Code" are "dep", "departure" and
// "origin" with a word on the end saying what kind of value the cell holds.
// Tried only after an exact match fails, so a real header ending in one of
// these is never shortened into somebody else's.
const HEADER_SUFFIX = /(icao|iata|code|airport|apt)$/;

const TRUEISH = new Set(['1', 'true', 'yes', 'y', 't', 'active', 'on']);
const FALSEISH = new Set(['0', 'false', 'no', 'n', 'f', 'draft', 'inactive', 'off']);

// ---------------------------------------------------------------------------
// Column specs
//
// `key`      the field name on our own objects
// `header`   what it is called in the file
// `aliases`  other spellings accepted on the way in
// `type`     text | number | list | bool | enum
// ---------------------------------------------------------------------------

const ROSTER_SPEC = {
    name: 'roster',
    // The id goes first so it is the leftmost column in a spreadsheet, where it
    // is least likely to be in the way of the columns people actually edit.
    columns: [
        { key: 'id', header: 'id', type: 'text', readOnly: true },
        { key: 'name', header: 'name', aliases: ['pilot', 'pilotname', 'fullname', 'displayname'], type: 'text', max: 60, required: true },
        { key: 'callsign', header: 'callsign', aliases: ['cs', 'pilotcallsign', 'pilotid'], type: 'text', max: 20 },
        // `duration`: VA spreadsheets keep hours as "123:45" as often as 123.75.
        { key: 'hours', header: 'hours', aliases: ['flighthours', 'totalhours', 'hrs', 'flighttime', 'totaltime'], type: 'number', min: 0, max: 1e6, duration: true },
        { key: 'role', header: 'role', aliases: ['position', 'staffrole', 'title'], type: 'text', max: 40 },
        // Semicolons, not commas — a comma inside a CSV cell means quoting, and
        // quoting is exactly what gets mangled by the round trip through a
        // spreadsheet and a hand edit.
        { key: 'aircraft', header: 'aircraft', aliases: ['fleet', 'typeratings', 'ratings', 'aircrafttypes'], type: 'list', max: 40, maxItems: 40 },
        { key: 'status', header: 'status', aliases: ['state'], type: 'enum', values: ['active', 'loa', 'inactive'], default: 'active' },
        // "IF username" is what the bots and sheets VAs arrive from call it.
        { key: 'ifcName', header: 'ifcName', aliases: ['ifc', 'ifcusername', 'communityname', 'ifusername', 'ifname', 'infiniteflightusername', 'infiniteflightname'], type: 'text', max: 60 },
        { key: 'ifUserId', header: 'ifUserId', aliases: ['ifuserid', 'ifid'], type: 'text', max: 40 },
        // v22. The three columns every roster a VA brings with them has, and
        // which used to be dropped on the way in without a word.
        //
        // `rank` is never stored — rank is derived from hours (crewRanks.js).
        // Export writes the rank the ladder gives; import reads it as the old
        // system's record that the pilot HOLDS it, which is only news to us
        // where a rung needs a check-ride: those get signed off. The server's
        // `prepare` decides that, because only it knows the ladder.
        { key: 'rank', header: 'rank', aliases: ['grade', 'pilotrank', 'currentrank'], type: 'text', max: 40 },
        // `joined` is the roster row's created_at. It matters more than it
        // looks: the retention sweep runs a new pilot's first-flight clock from
        // it, so a roster imported without it puts every pilot on day one.
        { key: 'joined', header: 'joined', aliases: ['joinedat', 'joindate', 'datejoined', 'membersince', 'since', 'hired', 'hiredate', 'startdate', 'enrolled', 'joinedon'], type: 'date' },
        // Out only: the crew center login this pilot signs in with, so a VA can
        // see in the sheet who has set theirs up. Ignored on the way back in —
        // a username is not something a spreadsheet gets to change.
        { key: 'login', header: 'login', aliases: ['loginusername', 'crewlogin'], type: 'text', exportOnly: true },
    ],
    // Callsign before name: an airline reassigns a callsign far less often than
    // it corrects the spelling of somebody's name.
    matchOn: ['callsign', 'name'],
    // Two pilots can share a name; they cannot share a callsign. A name match
    // against somebody holding a different callsign is somebody else.
    matchGuard: { name: ['callsign'] },
};

const ROUTES_SPEC = {
    name: 'routes',
    columns: [
        { key: 'id', header: 'id', type: 'text', readOnly: true },
        { key: 'flightNumber', header: 'flightNumber', aliases: ['flightno', 'flight', 'number', 'flightnum', 'fltno', 'routenumber', 'routeno', 'routenum', 'callsign'], type: 'text', max: 12 },
        { key: 'origin', header: 'origin', aliases: ['from', 'dep', 'departure', 'depart', 'departs', 'departing', 'originicao'], type: 'icao', required: true },
        { key: 'destination', header: 'destination', aliases: ['to', 'arr', 'arrival', 'dest', 'arrive', 'arrives', 'arriving', 'destinationicao'], type: 'icao', required: true },
        { key: 'aircraft', header: 'aircraft', aliases: ['equipment', 'equip', 'aircrafttype', 'actype', 'plane', 'fleet'], type: 'text', max: 60 },
        { key: 'distanceNm', header: 'distanceNm', aliases: ['distance', 'nm', 'distancenm', 'dist', 'distnm', 'nmi'], type: 'number', min: 0, max: 20000, units: 'distance' },
        { key: 'notes', header: 'notes', aliases: ['note', 'remarks', 'remark', 'comments', 'comment', 'description'], type: 'text', max: 500 },
        { key: 'active', header: 'active', aliases: ['published', 'live', 'enabled', 'status', 'visible'], type: 'bool', default: true },
        // v5. A VA building a network in a spreadsheet is exactly the VA who
        // wants to mark half of it as codeshare and gate the long-haul on a
        // rank, so these belong in the file rather than being twenty clicks
        // afterwards.
        { key: 'kind', header: 'kind', aliases: ['type'], type: 'enum', values: ['own', 'codeshare'], default: 'own' },
        { key: 'partnerName', header: 'partnerName', aliases: ['partner', 'operator', 'operatedby', 'operatingairline', 'operatingcarrier', 'carrier', 'airline', 'partnerairline'], type: 'text', max: 60 },
        { key: 'partnerLogo', header: 'partnerLogo', aliases: ['partnerlogourl', 'logo'], type: 'text', max: 600 },
        // Named, not numeric: the VA's own rank names are what they think in,
        // and the hours behind them are set once on the ladder.
        { key: 'minRank', header: 'minRank', aliases: ['rank', 'opensat', 'requiredrank', 'minimumrank', 'rankrequired'], type: 'text', max: 40 },
        // v21. The stands. A VA laying a network out in a spreadsheet is exactly
        // the VA who has the gate numbers in a column already, and typing two
        // hundred of them into the form one leg at a time is the reason they
        // would not bother. The aliases cover what a real airline's own
        // schedule export calls them.
        { key: 'departureGate', header: 'departureGate', aliases: ['depgate', 'gate', 'originGate', 'depStand', 'stand'], type: 'text', max: 12 },
        { key: 'arrivalGate', header: 'arrivalGate', aliases: ['arrGate', 'destinationGate', 'arrStand'], type: 'text', max: 12 },
    ],
    // A flight number is the airline's own identifier for a leg, so it wins.
    // Falling back to the city pair is right for the many VAs that do not
    // number their routes at all, and wrong only for one that flies the same
    // pair under two numbers — which is why the number is tried first.
    matchOn: ['flightNumber', 'origin+destination'],
    // Real schedules reuse a number for the return leg, and plenty of airlines
    // fly one city pair under several numbers. So a number only names a route
    // flown between the same airports, and a city pair only names a route that
    // does not carry a different number — otherwise it is a different leg, and
    // merging the two would silently lose one of them.
    matchGuard: {
        flightNumber: ['origin', 'destination'],
        'origin+destination': ['flightNumber'],
    },
};

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

const cellFor = (col, value) => {
    if (col.type === 'list') return (Array.isArray(value) ? value : []).join('; ');
    if (col.type === 'bool') return value ? 'true' : 'false';
    if (col.type === 'number') return value == null || value === '' ? '' : String(value);
    return value == null ? '' : String(value);
};

/**
 * Which columns an export writes, and what it calls them.
 *
 * With no layout it is every column under our own names — the file import was
 * built around. A layout is a VA's own spreadsheet shape, [{ header, key }],
 * usually the one their last import was read with, so the network goes back
 * out under "routeNumber / depICAO / arrICAO" to the sheet it came from.
 * Unknown keys and repeats are dropped; an empty result falls back to ours.
 */
function resolveLayout(spec, layout, { includeId = true } = {}) {
    const byKey = new Map(spec.columns.map((c) => [c.key, c]));
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(layout) ? layout.slice(0, 60) : []) {
        const key = String((item && item.key) || '');
        // A sheet that keeps a leg in one "OMAA-KJFK" column gets it back
        // that way.
        if (key === TO_PAIR && byKey.has('origin') && byKey.has('destination') && !seen.has('origin') && !seen.has('destination')) {
            seen.add('origin'); seen.add('destination');
            out.push({ header: trim(item.header, 60) || 'route', pair: true });
            continue;
        }
        const col = byKey.get(key);
        if (!col || seen.has(col.key)) continue;
        seen.add(col.key);
        out.push({ header: trim(item.header, 60) || col.header, col });
    }
    if (!out.length) return spec.columns.map((col) => ({ header: col.header, col }));
    // A custom layout carries the id at the end, where it is out of the way of
    // the VA's own columns but still makes the file re-import exactly.
    if (includeId && !seen.has('id') && byKey.has('id')) out.push({ header: 'id', col: byKey.get('id') });
    return out;
}

/**
 * Rows → a CSV file. Always writes every column of the layout, including empty
 * ones, so the file that comes back has somewhere to put a value that was blank
 * when it left.
 */
function toCsv(spec, rows, layout, opts) {
    const cols = resolveLayout(spec, layout, opts);
    // Arrays rather than objects, so a VA whose sheet names two columns the
    // same still gets both.
    const data = (rows || []).map((row) => cols.map(({ col, pair }) => (pair
        ? [row.origin, row.destination].filter(Boolean).join('-')
        : cellFor(col, row[col.key]))));
    return BOM + Papa.unparse({ fields: cols.map((c) => c.header), data }, { newline: '\r\n' });
}

// ---------------------------------------------------------------------------
// In
// ---------------------------------------------------------------------------

function headerIndex(spec) {
    const byNorm = new Map();
    for (const col of spec.columns) {
        byNorm.set(normalizeHeader(col.header), col);
        for (const a of col.aliases || []) byNorm.set(normalizeHeader(a), col);
    }
    return byNorm;
}

function guessColumn(byNorm, header) {
    const n = normalizeHeader(header);
    if (!n) return null;
    if (byNorm.has(n)) return byNorm.get(n);
    const bare = n.replace(HEADER_SUFFIX, '');
    return bare && bare !== n && byNorm.has(bare) ? byNorm.get(bare) : null;
}

/** Map the file's headers onto our columns, tolerating spelling and case. */
function mapHeaders(spec, fields) {
    const byNorm = headerIndex(spec);
    const found = new Map();   // column key -> the header as written in the file
    for (const f of fields || []) {
        const col = guessColumn(byNorm, f);
        if (col && !found.has(col.key)) found.set(col.key, f);
    }
    return found;
}

// "12:30" or "12:30:00" as hours. A roster kept in a spreadsheet writes flight
// time the way a logbook does.
const DURATION = /^(\d+):([0-5]?\d)(?::[0-5]?\d)?$/;

// A distance with its unit, as a person types it: "5,500 nm", "10186 km",
// "6300 mi". Converted to nautical miles; a bare number already is.
const DISTANCE = /^([\d.]+)\s*(nm|nmi|km|kms|mi|mile|miles)?$/i;
const TO_NM = { nm: 1, nmi: 1, km: 1 / 1.852, kms: 1 / 1.852, mi: 0.868976, mile: 0.868976, miles: 0.868976 };

// A cell that is an airport code: the whole cell, a name with the code in
// brackets ("Abu Dhabi (OMAA)"), or a code and then the name after a dash,
// slash or comma ("EGLL - London Heathrow"). A code followed by a bare space
// is not accepted, because "ABU DHABI" would be read as ABU.
const icaoOf = (text) => {
    const t = text.toUpperCase().trim();
    const m = t.match(/^([A-Z0-9]{3,4})$/)
        || t.match(/\(([A-Z0-9]{3,4})\)/)
        || t.match(/^([A-Z0-9]{3,4})\s*[-–—/,|:]/);
    return m ? m[1] : '';
};

// Two airports in one cell, the way a schedule often writes a leg:
// "OMAA-KJFK", "OMAA → KJFK", "AUH/JFK", "OMAA to KJFK".
const PAIR = /^\s*([A-Za-z0-9]{3,4})\s*(?:-+>?|–|—|>|→|✈|\/|\bto\b|\s)\s*([A-Za-z0-9]{3,4})\s*$/i;

// Headers that name a leg as a whole rather than one end of it.
const PAIR_HEADERS = new Set(['route', 'routing', 'citypair', 'pair', 'sector', 'leg', 'fromto', 'deparr', 'origindestination', 'od', 'airports']);

// What the airport list knows. Loaded on first use and kept; a missing file
// leaves the lists empty, which only switches the "is this real?" checks off.
let AIRPORTS = null;
function airports() {
    if (AIRPORTS) return AIRPORTS;
    AIRPORTS = { iata: new Map(), icao: new Set() };
    try {
        for (const k of Object.keys(require('./data/airport-coords.json'))) if (k !== '_comment') AIRPORTS.icao.add(k);
    } catch { /* optional */ }
    try {
        for (const [k, v] of Object.entries(require('./data/airport-iata.json'))) {
            if (k === '_comment') continue;
            AIRPORTS.iata.set(k, v);
            AIRPORTS.icao.add(v);
        }
    } catch { /* optional */ }
    return AIRPORTS;
}

// A code as the crew center stores it. Three letters are IATA and become the
// ICAO code; a code nobody has heard of still goes in — small fields and
// fictional airports are real to some VA — but is flagged so a typo ("OMMA")
// is seen before it becomes a route.
function airportCode(code) {
    const a = airports();
    if (code.length === 3) {
        const icao = a.iata.get(code);
        if (icao) return { value: icao };
        return { value: code, warn: `${code} isn’t an airport code we know — the four-letter ICAO code is safest` };
    }
    if (a.icao.size && !a.icao.has(code)) return { value: code, warn: `${code} isn’t in our airport list — check it’s right` };
    return { value: code };
}

const looksLikeAirport = (v) => {
    const t = String(v || '').trim();
    const a = airports();
    if (/^[A-Z]{4}$/.test(t)) return !a.icao.size || a.icao.has(t);
    return /^[A-Z]{3}$/.test(t) && a.iata.has(t);
};

function coercePair(raw, label) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { value: { origin: '', destination: '' } };
    const m = text.match(PAIR);
    if (!m) return { error: `${label} “${text.slice(0, 40)}” isn’t two airports, like OMAA-KJFK` };
    const o = airportCode(m[1].toUpperCase());
    const d = airportCode(m[2].toUpperCase());
    return { value: { origin: o.value, destination: d.value }, warn: o.warn || d.warn };
}

// `label` is what the VA's file calls the column, so a message about their
// "arrICAO" says arrICAO rather than our name for it.
function coerce(col, raw, label = col.header) {
    const text = String(raw == null ? '' : raw).trim();
    switch (col.type) {
        case 'number': {
            if (text === '') return { value: 0 };
            let n = NaN;
            const clock = col.duration && text.match(DURATION);
            const dist = col.units === 'distance' && text.replace(/,/g, '').match(DISTANCE);
            if (clock) n = Math.round((Number(clock[1]) + Number(clock[2]) / 60) * 100) / 100;
            else if (dist) n = Math.round(Number(dist[1]) * TO_NM[(dist[2] || 'nm').toLowerCase()]);
            else n = Number(text.replace(/,/g, ''));
            if (!Number.isFinite(n)) return { error: `${label} must be a number` };
            return { value: Math.max(col.min ?? -Infinity, Math.min(col.max ?? Infinity, n)) };
        }
        case 'bool': {
            if (text === '') return { value: col.default };
            const t = text.toLowerCase();
            if (TRUEISH.has(t)) return { value: true };
            if (FALSEISH.has(t)) return { value: false };
            return { error: `${label} should be yes or no` };
        }
        case 'list':
            // Commas as well as semicolons on the way in: a hand-typed sheet
            // lists a fleet as "B787-9, A380", and no aircraft name has a comma.
            return {
                value: text.split(/[;|,]/).map((s) => s.trim().slice(0, col.max || 40))
                    .filter(Boolean).slice(0, col.maxItems || 40),
            };
        case 'enum': {
            if (text === '') return { value: col.default };
            const t = text.toLowerCase();
            if (!col.values.includes(t)) {
                return { error: `${label} must be one of ${col.values.join(', ')}` };
            }
            return { value: t };
        }
        case 'icao': {
            if (!text) return { value: '' };
            // Stricter than it was: "Passenger" used to become "PASS".
            const code = icaoOf(text);
            if (!code) return { error: `${label} “${text.slice(0, 40)}” is not an airport code` };
            return airportCode(code);
        }
        case 'date': {
            if (!text) return { value: '' };
            const d = dateOf(text);
            if (!d) return { error: `${label} “${text.slice(0, 40)}” is not a date` };
            if (d > new Date(Date.now() + DAY_MS).toISOString().slice(0, 10)) return { error: `${label} ${d} is in the future` };
            if (d < '2000-01-01') return { error: `${label} ${d} is too long ago` };
            return { value: d };
        }
        default:
            return { value: text.slice(0, col.max || 200) };
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    // Rejects 2026-02-31 rather than rolling it into March.
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
        ? `${y}-${pad2(m)}-${pad2(d)}` : '';
};

/**
 * A date cell, as a calendar day ("2026-08-02"), or '' when it is not one.
 *
 * ISO first, because it is unambiguous and what we export. Then slashes and
 * dots, which are not: 03/04/2026 is March in the US and April everywhere else.
 * A day over 12 settles it; when nothing does, it is read month-first, because
 * that is what Excel and Google Sheets write when a workbook is turned into CSV
 * (SheetJS's sheet_to_csv included), and those are where these files come from.
 * Then anything Date can read with a month name in it ("2 Aug 2026").
 */
function dateOf(text) {
    let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (m) {
        let [a, b, y] = [+m[1], +m[2], +m[3]];
        if (y < 100) y += 2000;
        return a > 12 ? ymd(y, b, a) : ymd(y, a, b);
    }
    if (/[a-z]{3}/i.test(text)) {
        const t = new Date(`${text} UTC`);
        if (!Number.isNaN(t.getTime())) return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    return '';
}

// How a value we read is shown back in the preview.
const shownAs = (col, v) => {
    if (col.type === 'list') return (v || []).join('; ');
    if (col.type === 'bool') return v ? 'yes' : 'no';
    return v == null ? '' : String(v);
};

const cellText = (v) => String(v == null ? '' : v).trim();

// "A", "B", … "AA": what a spreadsheet calls a column, for a file that does
// not name its own.
const columnLetter = (j) => {
    let s = '';
    for (let n = j + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
};

// A flight number as airlines write them: EY101, 3L452, BAW123, EY5A.
const FLIGHT_NO = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/i;
// …which an aircraft type also matches ("A380" could be airline A3, flight
// 80). Types are told apart by their shape, and by repeating: a fleet column
// says A380 twenty times, a flight-number column rarely says anything twice.
const AIRCRAFT_TYPE = /^(A3\d\d|A2\d\d|B7\d\d|B7\dM?|E1[4-9]\d|E2\d\d|E[79]\d|CRJ\d*|DH8\w?|AT[47]\d|MD\d\d|C\d{3}|BCS\d)$/i;
const distinctShare = (vals) => (vals.length ? new Set(vals.map((v) => v.toUpperCase())).size / vals.length : 0);

/**
 * Decide what each column of one sheet is, then read its rows.
 *
 * A header the VA mapped by hand is taken at their word. Anything else is
 * guessed from its name — and then checked against what is actually in the
 * column, because a header is a claim, not a fact: a "type" column full of
 * "Passenger" is not our own/codeshare `kind`, and trusting it would fail every
 * row in the file over a column the VA never meant for us.
 *
 * Columns nobody named usefully are then read by what is in them: codes that
 * are airports, "OMAA-KJFK" pairs, flight numbers. And a sheet with no header
 * row at all — the table starts on row 1 — gets "Column A", "Column B"… so
 * its first row is kept as data and the VA can still say what each column is.
 */
function readSheet(spec, byNorm, sheet, userMap) {
    const name = trim(sheet.name, 80) || 'Sheet';
    const text = String(sheet.csv || '').replace(/^﻿/, '');
    // Empty lines are kept (and skipped below) so a row number is the row
    // number the VA sees in their spreadsheet.
    const grid = text.trim() ? (Papa.parse(text, { skipEmptyLines: false }).data || []) : [];
    const byKey = new Map(spec.columns.map((c) => [c.key, c]));
    const hasNotes = byKey.has('notes');
    const hasPair = byKey.has('origin') && byKey.has('destination');
    const userTarget = (h) => {
        if (!userMap || !Object.prototype.hasOwnProperty.call(userMap, h)) return undefined;
        const t = String(userMap[h] ?? '');
        if (t === IGNORE) return IGNORE;
        if (t === TO_NOTES) return hasNotes ? TO_NOTES : IGNORE;
        if (t === TO_PAIR) return hasPair ? TO_PAIR : IGNORE;
        return byKey.has(t) ? t : undefined;
    };
    const keysOf = (t) => (t === TO_PAIR ? ['origin', 'destination'] : t && t !== TO_NOTES ? [t] : []);

    // The header row is the one, near the top, that names the most of our
    // columns. Ties go to the earliest.
    let headerAt = -1; let best = 0;
    for (let r = 0; r < Math.min(grid.length, HEADER_SCAN_ROWS); r++) {
        const keys = new Set();
        for (const cell of grid[r] || []) {
            const h = cellText(cell);
            const u = userTarget(h);
            if (u !== undefined) { keysOf(u).forEach((k) => keys.add(k)); continue; }
            const col = guessColumn(byNorm, h);
            if (col) keys.add(col.key);
            else if (hasPair && PAIR_HEADERS.has(normalizeHeader(h))) keys.add(TO_PAIR);
        }
        if (keys.size > best) { best = keys.size; headerAt = r; }
    }
    const report = { name, headerRow: headerAt + 1, rows: 0, columns: [] };
    const filled = (row) => (row || []).filter((c) => cellText(c)).length;
    // Nothing we recognise: take the first row that looks like a table (two
    // or more cells) as its headings anyway, so the VA can map them — unless
    // that row is plainly data already, in which case there are no headings.
    let headerless = false;
    if (headerAt < 0) {
        const r = grid.slice(0, HEADER_SCAN_ROWS).findIndex((row) => filled(row) >= 2);
        if (r < 0) {
            report.skipped = grid.some((row) => filled(row)) ? 'it isn’t laid out as a table' : 'it is empty';
            return { report, rows: [], preview: null };
        }
        headerAt = r;
        headerless = (grid[r] || []).some((c) => looksLikeAirport(cellText(c)) || PAIR.test(cellText(c)));
        report.headerRow = headerless ? 0 : r + 1;
    }

    const width = grid.reduce((w, row) => Math.max(w, (row || []).length), 0);
    const headers = headerless
        ? Array.from({ length: width }, (_, j) => `Column ${columnLetter(j)}`)
        : Array.from({ length: width }, (_, j) => cellText((grid[headerAt] || [])[j]));
    const body = grid.slice(headerless ? headerAt : headerAt + 1);
    const firstLine = headerless ? headerAt + 1 : headerAt + 2;
    const sample = (j) => {
        const out = [];
        for (const row of body) {
            const v = cellText((row || [])[j]);
            if (v) out.push(v);
            if (out.length >= SAMPLE_CELLS) break;
        }
        return out;
    };
    const share = (vals, test) => (vals.length ? vals.filter(test).length / vals.length : 0);
    const fits = (col, values) => !values.length
        || values.filter((v) => coerce(col, v).error).length * 2 <= values.length;

    const targets = headers.map(() => IGNORE);
    const taken = new Set();
    const entries = [];
    const claim = (j, t, source) => {
        targets[j] = t;
        keysOf(t).forEach((k) => taken.add(k));
        if (entries[j]) { entries[j].key = t; entries[j].source = source; delete entries[j].reason; }
    };
    headers.forEach((h, j) => {
        const vals = sample(j);
        if (!h && !vals.length) return;
        const entry = { header: h, key: IGNORE, source: 'unknown', example: [...new Set(vals)].slice(0, 2).join(', ').slice(0, 60) };
        entries[j] = entry;
        report.columns.push(entry);
        if (!h) return;
        const u = userTarget(h);
        if (u !== undefined) {
            entry.source = 'you';
            if (keysOf(u).some((k) => taken.has(k))) { entry.reason = 'another column already fills this'; return; }
            claim(j, u, 'you');
            return;
        }
        const col = guessColumn(byNorm, h);
        if (!col) return;
        if (taken.has(col.key)) { entry.reason = `another column is already ${col.header}`; return; }
        // A column under our own exact name is ours, and a bad cell in it is
        // an error the VA should see. Only a guess gets second-guessed.
        const ours = normalizeHeader(h) === normalizeHeader(col.header);
        if (!ours && !fits(col, vals)) { entry.reason = `its values don’t look like ${col.header}`; return; }
        claim(j, col.key, 'auto');
    });

    // Read the rest by what is in them. Only columns the VA has not ruled on,
    // and only where the answer is unambiguous: exactly the right number of
    // candidates, or none of it is guessed.
    const open = (j) => headers[j] && targets[j] === IGNORE && userTarget(headers[j]) === undefined;
    const openCols = headers.map((_, j) => j).filter(open);
    const needed = ['origin', 'destination'].filter((k) => byKey.has(k) && !taken.has(k));
    if (needed.length) {
        const codes = openCols.filter((j) => share(sample(j), looksLikeAirport) >= 0.8);
        if (codes.length === needed.length) codes.forEach((j, n) => claim(j, needed[n], 'contents'));
    }
    if (hasPair && !taken.has('origin') && !taken.has('destination')) {
        const pairs = openCols.filter((j) => targets[j] === IGNORE
            && share(sample(j), (v) => PAIR.test(v)) >= (PAIR_HEADERS.has(normalizeHeader(headers[j])) ? 0.5 : 0.8));
        if (pairs.length === 1) claim(pairs[0], TO_PAIR, 'contents');
    }
    if (byKey.has('flightNumber') && !taken.has('flightNumber')) {
        const nums = openCols.filter((j) => targets[j] === IGNORE
            && share(sample(j), (v) => FLIGHT_NO.test(v) && !AIRCRAFT_TYPE.test(v) && !looksLikeAirport(v)) >= 0.8)
            .map((j) => ({ j, unique: distinctShare(sample(j)) }))
            .filter((c) => c.unique >= 0.6)
            .sort((a, b) => b.unique - a.unique);
        // One clear winner, or nothing.
        if (nums.length === 1 || (nums.length > 1 && nums[0].unique > nums[1].unique)) claim(nums[0].j, 'flightNumber', 'contents');
    }

    if (![...taken].some((k) => k !== 'id')) {
        report.skipped = 'none of its columns look like ours — pick what they are below';
        return { report, rows: [], preview: { headers, targets, rows: previewRaw(body, firstLine) } };
    }

    const rows = [];
    const preview = [];
    body.forEach((cells, i) => {
        cells = cells || [];
        const line = firstLine + i;
        const used = targets.map((t, j) => (t === IGNORE ? '' : cellText(cells[j])));
        const info = headers.map((_, j) => { const v = cellText(cells[j]).slice(0, 80); return v ? { v } : {}; });
        // Blank as far as we are concerned — including a row that only has
        // something in a column nobody mapped, like a running total.
        if (used.every((v) => !v)) return;
        // The header again, from a sheet assembled by pasting tables together.
        if (!headerless && used.every((v, j) => !v || normalizeHeader(v) === normalizeHeader(headers[j]))) {
            preview.push({ line, cells: info, status: 'skipped', message: 'the column headings again' });
            return;
        }

        const values = {};
        const extra = [];
        let id = '';
        let error = null;
        let warn = null;
        targets.forEach((t, j) => {
            if (t === IGNORE) return;
            const raw = cells[j];
            if (t === TO_NOTES) {
                const v = cellText(raw);
                if (v) extra.push(`${headers[j]}: ${v}`);
                return;
            }
            if (t === 'id') { id = trim(raw, 64); return; }
            if (byKey.get(t) && byKey.get(t).exportOnly) return;
            const got = t === TO_PAIR ? coercePair(raw, headers[j]) : coerce(byKey.get(t), raw, headers[j]);
            if (got.error) { info[j].e = got.error; error = error || got.error; return; }
            if (got.warn) { info[j].w = got.warn; warn = warn || got.warn; }
            let shown;
            if (t === TO_PAIR) {
                values.origin = got.value.origin;
                values.destination = got.value.destination;
                shown = got.value.origin ? `${got.value.origin} → ${got.value.destination}` : '';
            } else {
                values[t] = got.value;
                shown = shownAs(byKey.get(t), got.value);
            }
            if (cellText(raw) && shown !== cellText(raw)) info[j].r = shown.slice(0, 80);
        });
        if (extra.length) {
            const lead = taken.has('notes') ? String(values.notes || '').trim() : '';
            values.notes = [lead, ...extra].filter(Boolean).join(' · ').slice(0, byKey.get('notes').max || 500);
        }
        const row = { line, sheet: name, id, values, error, warn };
        rows.push(row);
        preview.push({ line, cells: info, row });
    });
    report.rows = rows.length;
    report.keys = [...taken];
    report.layout = headers
        .map((h, j) => ({ header: h, key: targets[j] }))
        .filter((c) => c.header && c.key && c.key !== TO_NOTES);
    return { report, rows, preview: { headers, targets, rows: preview } };
}

// The first rows of a sheet as they are, for a sheet we could not read yet —
// seeing it is how the VA works out what to tell us.
function previewRaw(body, firstLine) {
    const out = [];
    body.forEach((cells, i) => {
        if (out.length >= PREVIEW_ROWS || !(cells || []).some((c) => cellText(c))) return;
        out.push({ line: firstLine + i, cells: (cells || []).map((c) => { const v = cellText(c).slice(0, 80); return v ? { v } : {}; }), status: 'skipped' });
    });
    return out;
}

/**
 * Work out what an uploaded file would do, without doing any of it.
 *
 * The dashboard runs this first and shows the result — "12 new, 3 updated, 40
 * unchanged, 2 rows we couldn't read" — because an import that silently
 * rewrites a live roster is not something anyone should trigger blind. The
 * commit step then replays exactly this plan.
 *
 * `input` is one CSV, or a workbook: [{ name, csv }], one entry per tab or per
 * file. Each tab is read on its own terms — its own header row, its own
 * columns — and the rows are then planned together, so a network split into a
 * tab per region imports as one network. A tab that is not a table of ours (a
 * cover page, a rank list) is skipped and said so, not failed.
 *
 * `mapping` is { "their header": ourKey | '' | '+notes' }: the VA's own
 * answer to "what is this column", which always beats our guess.
 *
 * @returns {{create: Object[], update: Object[], unchanged: number,
 *            errors: {line: number, sheet: string, message: string}[],
 *            matchedOn: string, columns: string[], missing: string[],
 *            sheets: Object[], layout: {header: string, key: string}[]}}
 */
function planImport(spec, input, existing, { mapping, prepare } = {}) {
    const sheets = (Array.isArray(input) ? input : [{ name: 'CSV', csv: input }])
        .filter((s) => s && typeof s === 'object');
    if (!sheets.some((s) => String(s.csv || '').replace(/^\uFEFF/, '').trim())) return { error: 'That file is empty.' };

    const byNorm = headerIndex(spec);
    const exportOnly = new Set(spec.columns.filter((c) => c.exportOnly).map((c) => c.key));
    const userMap = mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? mapping : null;
    const reports = [];
    const previews = [];
    const rows = [];
    const present = new Set();
    let layout = null;
    for (const [n, sheet] of sheets.entries()) {
        if (n >= MAX_SHEETS) {
            reports.push({ name: trim(sheet.name, 80) || 'Sheet', rows: 0, columns: [], skipped: `only the first ${MAX_SHEETS} tabs are read` });
            continue;
        }
        const got = readSheet(spec, byNorm, sheet, userMap);
        reports.push(got.report);
        previews.push([got.report, got.preview]);
        if (!got.rows.length && got.report.skipped) continue;
        for (const k of got.report.keys || []) if (k !== 'id' && !exportOnly.has(k)) present.add(k);
        if (!layout && got.report.layout && got.report.layout.length) layout = got.report.layout;
        rows.push(...got.rows);
        if (rows.length > MAX_ROWS) {
            return { error: `That is more than ${MAX_ROWS} rows. Split it and import in parts.` };
        }
    }
    const finishPreviews = () => {
        for (const [report, preview] of previews) {
            if (!preview) continue;
            // The first rows as they come, then every row with a problem: the
            // preview is for spotting what is wrong, so what is wrong is never
            // the part that got cut off.
            const flagged = (r) => r.status === 'error' || r.warn;
            const keep = preview.rows.filter((r, i) => i < PREVIEW_ROWS || flagged(r)).slice(0, PREVIEW_MAX);
            report.preview = {
                headers: preview.headers,
                targets: preview.targets,
                more: preview.rows.length - keep.length,
                rows: keep.map(({ row, ...r }) => r),
            };
        }
    };
    if (!present.size) {
        finishPreviews();
        return {
            error: `We couldn't find any recognisable columns. Name them in the first row — for example ${spec.columns.filter((c) => !c.readOnly).slice(0, 4).map((c) => c.header).join(', ')} — or pick what each column is below.`,
            sheets: reports,
        };
    }
    // `prepare` gets the row too, so it can flag one for a second look
    // (`row.warn`) — a rank that is not on the ladder, say. It never fails one.
    if (prepare) for (const row of rows) if (!row.error) row.values = prepare(row.values, row);

    // Each row's outcome lands on its preview line.
    const outcome = new Map();
    const plan = planRows(spec, rows, existing, {
        present,
        columns: [...present],
        onRow: (row, what) => outcome.set(row, what),
    });
    if (plan.error) return plan;
    for (const [, preview] of previews) {
        for (const r of (preview && preview.rows) || []) {
            if (!r.row) continue;
            const what = outcome.get(r.row) || {};
            r.status = what.status || 'unchanged';
            if (what.message) r.message = what.message;
            if (what.changes) r.changes = what.changes;
            if (r.row.warn) r.warn = r.row.warn;
        }
    }
    finishPreviews();
    const warningCount = rows.filter((r) => r.warn && !r.error).length;
    return { ...plan, warningCount, sheets: reports, layout: layout || [] };
}

const matchKey = (rule, obj) => {
    if (!obj) return '';
    const parts = rule.split('+').map((f) => String(obj[f] == null ? '' : obj[f]).trim().toLowerCase());
    return parts.every((p) => p) ? parts.join(' ') : '';
};

// Does matching `a` to `b` on `rule` contradict a field that identifies them
// too? Only when both sides actually have a value: a file with no airport
// columns says nothing about airports.
const guarded = (spec, rule, a, b) => ((spec.matchGuard && spec.matchGuard[rule]) || []).some((f) => {
    const x = String((a && a[f]) ?? '').trim().toLowerCase();
    const y = String((b && b[f]) ?? '').trim().toLowerCase();
    return x && y && x !== y;
});

// rule -> key -> [rows], so a key several rows share can still find the one
// that does not contradict it.
const pushIndex = (index, rule, key, row) => {
    const m = index.get(rule);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(row);
};

/**
 * The half of an import that does not care where the rows came from.
 *
 * Takes rows that have ALREADY been coerced into our field names and decides,
 * against what the VA currently has, which are new, which change something, and
 * which change nothing — the same answer for a spreadsheet upload and for a
 * selection ticked out of the real-world route library.
 *
 * @param rows    [{ line, sheet?, id, values, error }]
 * @param present the set of field keys these rows carry an opinion about. A key
 *                that is absent is not "blank", it is "unmentioned", and the
 *                distinction is what stops a six-column file blanking the other
 *                three (see the required-field rule below).
 */
function planRows(spec, rows, existing, { present, columns, onRow } = {}) {
    // What happened to each row, for the preview. Optional: the library
    // import and the tests have no use for it.
    const told = onRow || (() => {});
    const headers = present || new Set(
        rows.flatMap((r) => Object.keys(r.values || {})),
    );
    if (rows.length > MAX_ROWS) {
        return { error: `That is more than ${MAX_ROWS} rows. Split it and import in parts.` };
    }

    // Index what is already there, by id and by each fallback rule.
    const byId = new Map();
    const byRule = new Map(spec.matchOn.map((r) => [r, new Map()]));
    for (const row of existing || []) {
        if (row.id) byId.set(String(row.id), row);
        for (const rule of spec.matchOn) {
            const k = matchKey(rule, row);
            // Every holder of the key, in order. A lookup takes the first one
            // the row does not contradict (see matchGuard), so where two share
            // a key the earliest still wins, as it always has.
            if (k) pushIndex(byRule, rule, k, row);
        }
    }

    const create = [];
    const update = [];
    const errors = [];
    let unchanged = 0;
    let matchedOn = 'id';
    // Rows created earlier in this same batch, so a batch that lists the same
    // pilot twice updates them rather than inserting a second copy.
    const staged = new Map(spec.matchOn.map((r) => [r, new Map()]));

    rows.forEach((row) => {
        const { line, values } = row;
        const sheet = row.sheet;
        if (row.error) { errors.push({ line, sheet, message: row.error }); told(row, { status: 'error', message: row.error }); return; }

        // Find it: by id if the row carried one, else by each rule in turn.
        const id = String(row.id || '');
        let target = id ? byId.get(id) : null;
        if (id && !target) {
            const message = `No pilot or route here with id ${id}. Clear the id column to add it as new.`;
            errors.push({ line, sheet, message });
            told(row, { status: 'error', message });
            return;
        }
        // A row this same batch already asked us to create. It has no id yet —
        // it does not exist — so it cannot be an update; fold the later line's
        // values into the pending create instead. Emitting an update against an
        // empty id was the old behaviour, and it failed at commit time and
        // reported the VA's own file back to them as a broken row.
        if (!target) {
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (!k) continue;
                const pending = (staged.get(rule).get(k) || []).find((p) => !guarded(spec, rule, values, p.values));
                if (!pending) continue;
                Object.assign(pending.values, values);
                told(row, { status: 'merged', message: `same ${spec.name === 'roster' ? 'pilot' : 'route'} as ${pending.sheet && pending.sheet !== sheet ? `${pending.sheet} ` : ''}row ${pending.line} — combined with it` });
                for (const r2 of spec.matchOn) {
                    const k2 = matchKey(r2, pending.values);
                    if (k2 && !(staged.get(r2).get(k2) || []).includes(pending)) pushIndex(staged, r2, k2, pending);
                }
                return;
            }
        }

        if (!target) {
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (!k) continue;
                const hit = (byRule.get(rule).get(k) || []).find((c) => !guarded(spec, rule, values, c));
                if (hit) { target = hit; matchedOn = rule; break; }
            }
        }

        if (target) {
            // Only mention what actually differs, so "3 updated" means three
            // rows really changed rather than three rows were re-saved.
            const diff = {};
            for (const [key, v] of Object.entries(values)) {
                const before = target[key];
                const same = Array.isArray(v)
                    ? Array.isArray(before) && v.length === before.length && v.every((x, n) => x === before[n])
                    : String(before == null ? '' : before) === String(v == null ? '' : v);
                if (!same) diff[key] = v;
            }
            if (!Object.keys(diff).length) { unchanged++; told(row, { status: 'unchanged' }); return; }
            update.push({ id: String(target.id), line, sheet, values: diff, before: target });
            told(row, { status: 'update', changes: Object.keys(diff) });
        } else {
            // `required` is a rule about creating something, not about the file:
            // a VA correcting hours for existing pilots sends two columns and
            // should not be told their file needs a name column. It only has to
            // be there when there is no existing row to fall back on.
            const missingRequired = spec.columns.find(
                (c) => c.required && !String(values[c.key] || '').trim());
            if (missingRequired) {
                const message = headers.has(missingRequired.key)
                    ? `${missingRequired.header} is required to add a new ${spec.name === 'roster' ? 'pilot' : 'route'}`
                    : `this row is new, so it needs a ${missingRequired.header} column`;
                errors.push({ line, sheet, message });
                told(row, { status: 'error', message });
                return;
            }
            told(row, { status: 'create' });
            const created = { line, sheet, values };
            create.push(created);
            // Register the create row ITSELF, not a copy of its values, so a
            // later duplicate line merges into the thing that will actually be
            // written rather than into a snapshot nobody reads again.
            for (const rule of spec.matchOn) {
                const k = matchKey(rule, values);
                if (k) pushIndex(staged, rule, k, created);
            }
        }
    });

    return {
        create, update, unchanged, errors, matchedOn,
        columns: columns || [...headers],
        missing: spec.columns.filter((c) => !c.readOnly && !c.exportOnly && !headers.has(c.key)).map((c) => c.header),
    };
}

module.exports = {
    planRows,
    resolveLayout,
    mapHeaders,
    IGNORE,
    TO_NOTES,
    TO_PAIR,
    MAX_SHEETS,
    ROSTER_SPEC,
    ROUTES_SPEC,
    toCsv,
    planImport,
    normalizeHeader,
    MAX_ROWS,
    BOM,
};
