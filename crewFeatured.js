'use strict';

/*
 * crewFeatured.js
 * Which leg to fly next, and why that one.
 *
 * WHAT LIVES HERE
 * ---------------
 * Three rules, and nothing that talks to a database:
 *
 *   ROUTE OF THE WEEK / OF THE DAY   one leg out of the VA's own network,
 *   chosen for a period and the same for everybody in the airline for the
 *   length of it.
 *
 *   A PILOT'S HABITS                 what somebody actually flies, read off
 *   their own approved reports: long or short, how long a leg they sit
 *   through, which aeroplane, which fields.
 *
 *   SUGGESTIONS                      the network scored against those habits
 *   (and against wherever ATC is open right now), with the reason attached to
 *   each one.
 *
 * WHY THE PICK IS DERIVED AND NOT STORED
 * --------------------------------------
 * The obvious build is a `featured` column on crew_routes and a cron that
 * rotates it. That is a schema migration in three hundred VA projects, a job
 * that has to run, and a VA whose route of the week is whatever it was when the
 * job last succeeded.
 *
 * So the pick is a pure function of (the network, the period). Hash the period
 * key, walk it over the eligible routes, done — every reader of every surface
 * computes the same leg without asking anyone, it changes on the hour it is
 * supposed to, and a VA that has never heard of this feature has a Route of the
 * Week the first time a pilot opens the page. A network that gains or loses a
 * leg re-rolls the pick, which is correct: the answer is "one of the legs we
 * fly", and that set changed.
 *
 * STAFF STILL GET THE LAST WORD. A VA can pin a leg for the period (see
 * `pins`), and a pin beats the derived pick until the period it was set in
 * rolls over. That is the half the shop's "Name a route" item has been
 * promising since it shipped — it says the leg a pilot buys "is flown as that
 * week's featured route", and until now there was nothing to write it onto.
 * The pin lives on the VA record next to the rank ladder and the shop rates,
 * for the reason those do: it is a decision about how the airline is run, and
 * it must not cost a round trip to somebody else's database to read.
 *
 * NOTHING HERE IS A GATE. A suggestion is a suggestion. Everything below
 * decides what to OFFER a pilot; what they may actually fly is `publicRoute`'s
 * business and is unchanged by any of it.
 */

const PERIODS = ['week', 'day'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const icao = (v) => str(v, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ===========================================================================
 * THE PERIOD
 *
 * Both keys are UTC. A VA is not in one timezone — its pilots are in thirty —
 * and a "route of the day" that is Tuesday's leg for half the roster and
 * Wednesday's for the other half is not one route of one day. Z is the one
 * clock everybody in aviation already shares, and it is the clock the schedule,
 * the events calendar and every flight plan in the product are written in.
 * ======================================================================== */

/** Midnight-to-midnight Z. `2026-09-16`. */
function dayKey(now) {
    const d = now instanceof Date ? now : new Date(now || Date.now());
    if (Number.isNaN(d.getTime())) return dayKey(new Date());
    return d.toISOString().slice(0, 10);
}

/**
 * The ISO-8601 week. `2026-W38`.
 *
 * ISO rather than "seven days since the epoch" because a week that turns over
 * on a Thursday afternoon is not a week anybody plans around. This turns over
 * Monday 00:00Z, which is what a VA means by "this week" when they post a
 * schedule.
 */
function weekKey(now) {
    const src = now instanceof Date ? now : new Date(now || Date.now());
    const d = new Date(Date.UTC(
        src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate(),
    ));
    if (Number.isNaN(d.getTime())) return weekKey(new Date());
    // Thursday of this ISO week decides which year the week belongs to: that is
    // the whole of the ISO rule, and it is why the last days of December are
    // frequently week 1 of the year after.
    const dayNum = (d.getUTCDay() + 6) % 7;          // Mon = 0
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const year = d.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(year, 0, 4));
    const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
    const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
    return `${year}-W${String(week).padStart(2, '0')}`;
}

const periodKey = (period, now) => (period === 'day' ? dayKey(now) : weekKey(now));

/** FNV-1a. Small, stable across processes, and not trying to be a hash. */
function hash(s) {
    let h = 2166136261;
    const text = String(s || '');
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/* ===========================================================================
 * THE PICK
 * ======================================================================== */

/** The legs a featured route may be drawn from. */
function eligible(routes) {
    return (routes || []).filter((r) => r
        && r.active !== false
        && icao(r.origin) && icao(r.destination)
        // A leg nobody on the roster can fly is not this week's route. The rank
        // gate is per-pilot and this pick is per-airline, so what is excluded
        // here is only the leg gated above the top of the ladder — see
        // `pickFeatured`'s caller, which passes routes already filtered to what
        // the whole airline can see.
        && icao(r.origin) !== icao(r.destination));
}

/**
 * One leg, for one period, for one airline.
 *
 * `slug` is mixed into the seed so two VAs with identical networks do not
 * feature the same leg in the same week — they are different airlines and it
 * would look like the platform picked it, which is exactly what it must not
 * look like.
 *
 * The day pick is seeded off the week's choice as well, so the day never
 * lands on the week's leg: two features pointing at one route is one feature
 * and a wasted slot on the page.
 */
function pickFeatured(routes, { period = 'week', now, slug = '', pin = null } = {}) {
    const pool = eligible(routes);
    if (!pool.length) return null;
    const key = periodKey(period, now);

    // A pin set inside the current period wins. One set in a period that has
    // rolled over does not: a VA that pinned a leg in March did not mean it to
    // be September's route of the week, and a pin that never lapses is a
    // feature that silently stops rotating.
    if (pin && pin.routeId && pin.periodKey === key) {
        const at = pool.find((r) => String(r.id || r._id) === String(pin.routeId));
        if (at) return { route: at, period, periodKey: key, pinned: true };
    }

    // What the week landed on, so the day can avoid it and be seeded off it.
    // Computed once: the week's pick over the same pool is one more hash, but
    // doing it twice invites the two copies to be given different arguments.
    const weekId = period === 'day' && pool.length > 1
        ? (() => {
            const week = pickFeatured(pool, { period: 'week', now, slug });
            return week ? String(week.route.id || week.route._id || '') : '';
        })()
        : '';

    const seedParts = [String(slug || '').toLowerCase(), period, key];
    if (weekId) seedParts.push(weekId);
    const seed = hash(seedParts.join('|'));

    let ordered = pool;
    if (weekId) {
        const without = pool.filter((r) => String(r.id || r._id) !== weekId);
        if (without.length) ordered = without;
    }
    // Sorted before indexing. `listRoutes` orders by created_at, which is
    // stable, but "stable today" is not the same as "the same on the replica",
    // and a featured route that differs between two readers of the same
    // airline is the one failure this must not have.
    const sorted = ordered.slice().sort((a, b) => String(a.id || a._id).localeCompare(String(b.id || b._id)));
    return { route: sorted[seed % sorted.length], period, periodKey: key, pinned: false };
}

/* ===========================================================================
 * THE PINS, ON THE VA RECORD
 *
 * Flat on the record for the reason the shop's six fields are: the crew center
 * reads them before it has a store connection, and a nested document buys
 * nothing at four fields.
 * ======================================================================== */

const normalizePins = (rec) => {
    const r = rec || {};
    return {
        week: { routeId: str(r.weekRouteId, 64), periodKey: str(r.weekPeriod, 12) },
        day: { routeId: str(r.dayRouteId, 64), periodKey: str(r.dayPeriod, 12) },
    };
};

/**
 * A pin, from staff, flattened back onto the record.
 *
 * The period is stamped HERE rather than taken from the caller: a pin is
 * always for the period it is set in, and letting a request name its own
 * period would let one pin a leg for a week in 2031.
 *
 * An empty `routeId` clears that pin, which is how staff hand the slot back to
 * the rotation.
 */
function toPinRecord(patch, current, now) {
    const p = patch || {};
    const out = { ...(current || {}) };
    for (const period of PERIODS) {
        if (!(period in p)) continue;
        const id = str(p[period], 64);
        const Key = period === 'week' ? 'week' : 'day';
        out[`${Key}RouteId`] = id;
        out[`${Key}Period`] = id ? periodKey(period, now) : '';
    }
    return out;
}

/* ===========================================================================
 * WHAT A PILOT ACTUALLY FLIES
 *
 * Read off their own approved reports and nothing else. Not the roster's hours
 * column (it says how much, never what), not the fleet (it says what the
 * airline owns), not what they clicked on (we do not record that and should
 * not start).
 *
 * APPROVED ONLY, and newest first. A report waiting on staff is not yet a
 * flight this pilot flew, and a suggestion built on one that gets rejected is
 * a suggestion built on a claim.
 *
 * A PROFILE IS NOT A VERDICT. Everything below is expressed as a lean, and
 * `confident` says whether there is enough flying behind it to lean at all —
 * six legs, which is the point at which "you mostly fly short-haul" stops
 * being a sentence about two Tuesdays. Under that the suggestions fall back to
 * the network's own shape, which is the honest answer to "what should I fly"
 * from somebody who has not flown yet.
 * ======================================================================== */

/** A leg of this many minutes is a long haul. Six hours: the usual line. */
const LONG_HAUL_MIN = 360;
/** …and under this it is a short hop rather than a medium sector. */
const SHORT_HAUL_MIN = 120;
/** How many approved legs before the profile is worth leaning on. */
const CONFIDENT_AT = 6;
/** How far back a habit is read from. A year of flying is who somebody is. */
const WINDOW_DAYS = 365;

const median = (nums) => {
    const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

/** The n most common values, with their counts. Ties break alphabetically. */
function top(counts, n) {
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .slice(0, n)
        .map(([value, count]) => ({ value, count }));
}

function flyingProfile(pireps, { now = Date.now() } = {}) {
    const since = now - WINDOW_DAYS * 86400000;
    const flown = (pireps || []).filter((p) => {
        if (!p || p.status !== 'approved') return false;
        const t = new Date(p.flownAt || p.createdAt).getTime();
        return !Number.isFinite(t) || t >= since;
    });

    const minutes = [];
    const aircraft = new Map();
    const airports = new Map();
    const pairs = new Set();
    let long = 0;
    let short = 0;
    let totalMin = 0;

    for (const p of flown) {
        const min = Math.max(0, Number(p.durationMin) || 0);
        totalMin += min;
        if (min) {
            minutes.push(min);
            if (min >= LONG_HAUL_MIN) long += 1;
            else if (min <= SHORT_HAUL_MIN) short += 1;
        }
        const ac = str(p.aircraftName, 60);
        if (ac) aircraft.set(ac, (aircraft.get(ac) || 0) + 1);
        for (const field of [icao(p.origin), icao(p.destination)]) {
            if (field) airports.set(field, (airports.get(field) || 0) + 1);
        }
        const o = icao(p.origin);
        const d = icao(p.destination);
        if (o && d) pairs.add(`${o}-${d}`);
    }

    const flights = flown.length;
    const typical = median(minutes);
    return {
        flights,
        confident: flights >= CONFIDENT_AT,
        hours: Math.round(totalMin / 60),
        // The leg length this pilot actually sits through, as a median rather
        // than a mean: one transatlantic in a month of circuits should not move
        // it, and with a mean it moves it a long way.
        typicalMin: typical,
        // Which end of the network they live at. Named rather than numeric
        // because the whole point is to put it in a sentence on a tile.
        lean: typical >= LONG_HAUL_MIN ? 'long'
            : typical && typical <= SHORT_HAUL_MIN ? 'short'
                : typical ? 'medium' : '',
        longHauls: long,
        shortHauls: short,
        aircraft: top(aircraft, 3),
        airports: top(airports, 6),
        // Every pair they have already flown, so a suggestion can say "you have
        // not flown this one" and mean it.
        flown: pairs,
    };
}

/* ===========================================================================
 * SCORING A LEG FOR ONE PILOT
 *
 * Every signal is worth points and every signal that scores writes its own
 * sentence. That pairing is deliberate and it is the whole design: a
 * suggestion a pilot cannot see the reason for is a suggestion they do not
 * trust, and a reason generated separately from the score is a reason that
 * drifts from it. If it did not score, it does not get to claim credit.
 *
 * THE WEIGHTS ARE SMALL AND THE SPREAD IS DELIBERATE. The largest single
 * signal (ATC open at both ends) is worth about as much as two habit matches,
 * because "somebody is controlling" is the thing that changes an evening's
 * flying and the habits are only saying "and you will enjoy it".
 * ======================================================================== */

const WEIGHTS = {
    atcBothEnds: 34,
    atcArrival: 24,
    atcDeparture: 16,
    busyArrival: 14,          // traffic inbound, ATC or not — somebody to follow
    aircraftMatch: 18,
    lengthMatch: 16,
    familiarField: 10,
    freshPair: 12,            // a leg on the network they have never flown
    inFleet: 6,
    featured: 40,
};

/**
 * How close a leg is to the length this pilot flies, 0..1.
 *
 * Tolerant on purpose: half again as long, or two thirds as long, still counts
 * as "about your usual". A pilot whose median is 95 minutes is not looking for
 * exactly 95 minutes, they are looking for an evening rather than a night.
 */
function lengthFit(routeMin, typicalMin) {
    if (!routeMin || !typicalMin) return 0;
    const ratio = routeMin / typicalMin;
    if (ratio >= 0.6 && ratio <= 1.6) return 1;
    if (ratio >= 0.4 && ratio <= 2.2) return 0.5;
    return 0;
}

/**
 * Minutes a leg is expected to take.
 *
 * From the distance at a flat 440 kt, which is wrong for a Dash 8 and wrong
 * for a 777 and close enough for "is this an evening or a night". A route that
 * carries no distance gets nothing rather than a guess — the length signal
 * then simply does not fire for it, which is the correct way for a missing
 * fact to behave.
 */
const CRUISE_KT = 440;
const legMinutes = (route) => {
    const nm = Math.max(0, Number(route && route.distanceNm) || 0);
    if (!nm) return 0;
    // Half an hour of taxi, climb and approach that is not spent at cruise.
    return Math.round((nm / CRUISE_KT) * 60) + 30;
};

/**
 * The whole network, scored, with the reasons.
 *
 * `busy` is what the browser knows and the server does not: which fields have
 * ATC open right now, and how much traffic is pointed at them. It arrives from
 * the caller because the live network is the CLIENT's to see — the crew center
 * page is already on a tracker that holds it, and having this server poll
 * Infinite Flight on behalf of every VA would be a second copy of a feed that
 * is already open in the tab.
 *
 * Absent, everything still works: the habit signals carry it, and no tile
 * claims an ATC reason it cannot support.
 */
function suggest(routes, profile, { busy = null, limit = 6, featured = [], fleet = [] } = {}) {
    const pool = eligible(routes).filter((r) => !r.locked);
    if (!pool.length) return [];

    const atc = new Map();      // ICAO -> [{ type, label }]
    const inbound = new Map();  // ICAO -> aircraft pointed at it
    for (const f of (busy && busy.atc) || []) {
        const code = icao(f && (f.icao || f.airportName));
        if (!code) continue;
        atc.set(code, (atc.get(code) || 0) + 1);
    }
    for (const [code, n] of Object.entries((busy && busy.inbound) || {})) {
        const field = icao(code);
        if (field) inbound.set(field, Math.max(0, Number(n) || 0));
    }

    const p = profile || flyingProfile([]);
    const lean = p.confident;
    const favouriteAircraft = new Set(p.aircraft.map((a) => a.value.toLowerCase()));
    const familiar = new Set(p.airports.map((a) => a.value));
    const fleetNames = new Set((fleet || []).map((f) => str(f && (f.name || f), 60).toLowerCase()).filter(Boolean));
    const featuredIds = new Set((featured || []).map((id) => String(id)).filter(Boolean));

    const rows = pool.map((route) => {
        const o = icao(route.origin);
        const d = icao(route.destination);
        const why = [];
        let score = 0;
        const add = (points, text, tone) => { score += points; if (text) why.push({ text, tone: tone || 'habit' }); };

        // --- The live network -------------------------------------------
        const atcO = atc.get(o) || 0;
        const atcD = atc.get(d) || 0;
        if (atcO && atcD) {
            add(WEIGHTS.atcBothEnds, `ATC open at both ends — ${o} and ${d}`, 'atc');
        } else if (atcD) {
            add(WEIGHTS.atcArrival, `${d} is being controlled right now`, 'atc');
        } else if (atcO) {
            add(WEIGHTS.atcDeparture, `${o} is being controlled right now`, 'atc');
        }
        const in_ = inbound.get(d) || 0;
        if (in_ >= 3 && !atcD) {
            // Traffic without a controller is still the reason to go: it is
            // where the aeroplanes are, and it is where ATC opens next.
            add(WEIGHTS.busyArrival, `${in_} aircraft already inbound to ${d}`, 'traffic');
        } else if (in_ >= 3) {
            add(Math.round(WEIGHTS.busyArrival / 2), `${in_} aircraft inbound with you`, 'traffic');
        }

        // --- What this pilot flies --------------------------------------
        const ac = str(route.aircraft, 60);
        if (lean && ac && favouriteAircraft.has(ac.toLowerCase())) {
            add(WEIGHTS.aircraftMatch, `Flown on the ${ac} — your most-flown type`, 'habit');
        }
        const min = legMinutes(route);
        if (lean && min) {
            const fit = lengthFit(min, p.typicalMin);
            if (fit === 1) {
                add(WEIGHTS.lengthMatch, p.lean === 'long'
                    ? 'A long haul, the way you usually fly'
                    : p.lean === 'short' ? 'A short hop, about your usual leg'
                        : 'About the length of leg you normally file', 'habit');
            } else if (fit) {
                score += Math.round(WEIGHTS.lengthMatch / 2);
            }
        }
        if (lean && (familiar.has(o) || familiar.has(d))) {
            const field = familiar.has(d) ? d : o;
            add(WEIGHTS.familiarField, `You know ${field}`, 'habit');
        }
        if (lean && o && d && !p.flown.has(`${o}-${d}`)) {
            add(WEIGHTS.freshPair, 'One you have not flown yet', 'new');
        }
        if (ac && fleetNames.has(ac.toLowerCase())) score += WEIGHTS.inFleet;
        if (featuredIds.has(String(route.id || route._id))) score += WEIGHTS.featured;

        return {
            route,
            score,
            estimatedMin: min,
            why: why.slice(0, 3),
            atc: { origin: atcO, destination: atcD },
            inbound: in_,
        };
    });

    return rows
        // A leg with nothing to say for itself is not a suggestion, it is the
        // route list. Shown only when there would otherwise be nothing at all —
        // which the caller decides, because an empty panel is worse.
        .sort((a, b) => b.score - a.score
            || String(a.route.flightNumber || '').localeCompare(String(b.route.flightNumber || ''))
            || String(a.route.id || a.route._id).localeCompare(String(b.route.id || b.route._id)))
        .slice(0, Math.max(1, Math.min(24, limit)));
}

/**
 * The profile, as a browser may read it.
 *
 * `flown` is dropped: it is a Set (which JSON turns into `{}`, silently) and it
 * is every pair this pilot has ever flown, which is a bigger thing than a
 * sentence on a tile needs. What the page actually wants from it — "one you
 * have not flown yet" — is already a reason on the suggestion that used it.
 */
const publicProfile = (p) => ({
    flights: p.flights,
    hours: p.hours,
    confident: p.confident,
    typicalMin: p.typicalMin,
    lean: p.lean,
    longHauls: p.longHauls,
    shortHauls: p.shortHauls,
    aircraft: p.aircraft,
    airports: p.airports,
});

/** A suggestion, as a browser may read it. */
const publicSuggestion = (s) => ({
    route: s.route,
    score: s.score,
    estimatedMin: s.estimatedMin,
    why: s.why,
    atc: s.atc,
    inbound: s.inbound,
});

module.exports = {
    PERIODS,
    LONG_HAUL_MIN,
    SHORT_HAUL_MIN,
    CONFIDENT_AT,
    WEIGHTS,
    dayKey,
    weekKey,
    periodKey,
    hash,
    eligible,
    pickFeatured,
    normalizePins,
    toPinRecord,
    flyingProfile,
    legMinutes,
    lengthFit,
    suggest,
    publicProfile,
    publicSuggestion,
};
