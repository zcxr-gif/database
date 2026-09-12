'use strict';

/*
 * crewAwards.js
 * What a pilot has to show for it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Hours are a fine measure and a terrible reward: nobody screenshots 214.
 *
 * Every badge here is computed from flights the VA has ALREADY approved, which
 * is the whole design and not an implementation detail:
 *
 *   · Nothing new is asked of staff, so no badge is ever forgotten.
 *   · Nothing can be gamed that the flight log does not already permit. If a
 *     flight was good enough to approve, it is good enough to count.
 *   · A VA that never opens the panel still has them accruing, so the day they
 *     do it is full rather than empty.
 *
 * There is therefore NO awards table anywhere. An earned badge is a fact about
 * a flight log, recomputed on read, and the date on it is the date of the
 * flight that crossed the line — not the date somebody first looked.
 *
 * WHAT LIVES HERE
 * ---------------
 * The catalogue and the arithmetic, and nothing that talks to a database. The
 * caller hands over one pilot's approved reports; this hands back what they
 * have earned and how far along they are on everything else.
 *
 * HOW A THRESHOLD IS DATED
 * ------------------------
 * The reports are replayed oldest first and a small tally is carried forward.
 * The moment a tally reaches a badge's figure, that flight's date is the date
 * the badge was earned. Replaying rather than summing is the only way to answer
 * "when?", and it costs one pass over a list the caller already had in hand.
 */

/**
 * One tally per thing worth counting, carried forward through the log.
 *
 * `destinations` is a Set while the replay runs and a number afterwards, which
 * is why the tally is built rather than spread — everything else is a plain
 * addition and this one is not.
 */
const freshTally = () => ({
    flights: 0,
    hours: 0,
    landings: 0,
    fleetFlights: 0,
    eventFlights: 0,
    scheduleFlights: 0,
    cleanFlights: 0,
    longestHours: 0,
    _airports: new Set(),
    destinations: 0,
});

function advance(t, p) {
    t.flights += 1;
    const hours = Math.max(0, Number(p.durationMin) || 0) / 60;
    t.hours += hours;
    t.landings += Math.max(0, Number(p.landings) || 0);
    if (p.inFleet) t.fleetFlights += 1;
    if (p.eventId) t.eventFlights += 1;
    if (p.scheduleId) t.scheduleFlights += 1;
    // A clean flight is one with no violations on it. Counted as a total rather
    // than as a streak: a streak badge that a single bad landing takes away is
    // a badge people stop looking at, and this one is meant to be kept.
    if (!(Number(p.violations) || 0)) t.cleanFlights += 1;
    if (hours > t.longestHours) t.longestHours = hours;
    // Both ends. A pilot who has flown into thirty airports has seen thirty
    // places whichever direction they were pointing.
    for (const icao of [p.origin, p.destination]) {
        const code = String(icao || '').trim().toUpperCase();
        if (code) t._airports.add(code);
    }
    t.destinations = t._airports.size;
    return t;
}

/**
 * The catalogue.
 *
 * Tiers are a visual grouping and not a score — they exist so a wall of badges
 * has a shape and the rare ones read as rare. `need` is compared against the
 * tally named by `metric`, which is the whole of what a badge is: there is no
 * per-badge code to go wrong, and adding one is a line in this array.
 *
 * The figures are deliberately reachable. A ladder whose first rung is fifty
 * flights is a ladder nobody starts climbing.
 */
const CATALOG = [
    // The first one. Earned by every pilot who has ever filed anything, which
    // is the point: the panel a new pilot opens should not be empty.
    { id: 'first-flight', name: 'First flight', desc: 'Filed and approved.', icon: 'plane-takeoff', tier: 'bronze', metric: 'flights', need: 1 },
    { id: 'flights-10', name: '10 flights', desc: 'Ten in the log.', icon: 'plane', tier: 'bronze', metric: 'flights', need: 10 },
    { id: 'flights-50', name: '50 flights', desc: 'Fifty in the log.', icon: 'plane', tier: 'silver', metric: 'flights', need: 50 },
    { id: 'flights-100', name: '100 flights', desc: 'A hundred in the log.', icon: 'plane', tier: 'gold', metric: 'flights', need: 100 },
    { id: 'flights-500', name: '500 flights', desc: 'Five hundred in the log.', icon: 'plane', tier: 'platinum', metric: 'flights', need: 500 },

    { id: 'hours-10', name: '10 hours', desc: 'Ten hours flown.', icon: 'clock', tier: 'bronze', metric: 'hours', need: 10 },
    { id: 'hours-50', name: '50 hours', desc: 'Fifty hours flown.', icon: 'clock', tier: 'silver', metric: 'hours', need: 50 },
    { id: 'hours-100', name: '100 hours', desc: 'A hundred hours flown.', icon: 'clock', tier: 'gold', metric: 'hours', need: 100 },
    { id: 'hours-1000', name: '1,000 hours', desc: 'A thousand hours flown.', icon: 'clock', tier: 'platinum', metric: 'hours', need: 1000 },

    { id: 'ports-10', name: '10 airports', desc: 'Ten airports visited.', icon: 'map-pin', tier: 'bronze', metric: 'destinations', need: 10 },
    { id: 'ports-25', name: '25 airports', desc: 'Twenty-five airports visited.', icon: 'map', tier: 'silver', metric: 'destinations', need: 25 },
    { id: 'ports-50', name: '50 airports', desc: 'Fifty airports visited.', icon: 'globe', tier: 'gold', metric: 'destinations', need: 50 },

    { id: 'landings-50', name: '50 landings', desc: 'Fifty of them.', icon: 'plane-landing', tier: 'silver', metric: 'landings', need: 50 },
    { id: 'landings-250', name: '250 landings', desc: 'Two hundred and fifty.', icon: 'plane-landing', tier: 'gold', metric: 'landings', need: 250 },

    // Long haul is a property of one flight rather than of a total, which is why
    // the tally carries the longest rather than the sum.
    { id: 'long-haul', name: 'Long haul', desc: 'A single flight over eight hours.', icon: 'moon', tier: 'gold', metric: 'longestHours', need: 8 },

    { id: 'fleet-25', name: 'Airline colours', desc: '25 flights in your airline’s own aircraft.', icon: 'shield-check', tier: 'silver', metric: 'fleetFlights', need: 25 },
    { id: 'clean-25', name: 'Clean sheet', desc: '25 flights with no violations.', icon: 'sparkles', tier: 'silver', metric: 'cleanFlights', need: 25 },
    { id: 'events-5', name: 'Regular', desc: 'Five group flights flown.', icon: 'users', tier: 'silver', metric: 'eventFlights', need: 5 },
    { id: 'schedule-10', name: 'On the roster', desc: 'Ten scheduled departures flown.', icon: 'calendar-check', tier: 'silver', metric: 'scheduleFlights', need: 10 },
];

/** The catalogue as the panel draws it — no `metric`, which is ours. */
const catalog = () => CATALOG.map(({ id, name, desc, icon, tier, need }) => ({ id, name, desc, icon, tier, need }));

/**
 * Only this pilot's approved flights, oldest first.
 *
 * `flownAt` where there is one and the filing date otherwise: a report captured
 * from a logbook knows when the flight happened, and one typed in by hand may
 * not. Reports with neither sort last, which is where an undated thing belongs.
 */
function ownApproved(pireps, member) {
    const id = String((member && member._id) || '');
    const ifId = String((member && member.ifUserId) || '');
    const when = (p) => {
        const d = new Date(p.flownAt || p.createdAt || 0).getTime();
        return Number.isFinite(d) ? d : 0;
    };
    return (pireps || [])
        .filter((p) => p && p.status === 'approved'
            && (String(p.memberId || '') === id
                // The IF id is the fallback, not the primary — reports captured
                // automatically can land before the roster row is linked to an
                // account, and those flights were still flown by this person.
                || (ifId && String(p.ifUserId || '') === ifId)))
        .sort((a, b) => when(a) - when(b));
}

/**
 * What one pilot has earned, and how far along they are on the rest.
 *
 * Returns the two things the panel renders and nothing else:
 *   earned   [{ id, at, name, tier, icon }]  — `at` is the crossing flight's date
 *   progress { [id]: { have, need } }        — for the ones not earned yet
 *
 * A pilot with no roster row (a login that has never been linked) earns
 * nothing and is still given the catalogue, because a shelf of things to come
 * is a better answer to "what are awards?" than an empty panel.
 */
function forMember({ member = null, pireps = [] } = {}) {
    const log = ownApproved(pireps, member);
    const tally = freshTally();
    const earnedAt = new Map();

    for (const p of log) {
        advance(tally, p);
        const at = p.flownAt || p.createdAt || null;
        for (const a of CATALOG) {
            if (earnedAt.has(a.id)) continue;
            if ((Number(tally[a.metric]) || 0) >= a.need) earnedAt.set(a.id, at);
        }
    }

    const earned = [];
    const progress = {};
    for (const a of CATALOG) {
        if (earnedAt.has(a.id)) {
            earned.push({ id: a.id, at: earnedAt.get(a.id), name: a.name, tier: a.tier, icon: a.icon });
        } else {
            // Rounded down: "9 of 10 hours" with 9.97 in the tally reads as
            // nearly there, which is true, and 10 of 10 on an unearned badge
            // reads as broken.
            progress[a.id] = { have: Math.floor(Number(tally[a.metric]) || 0), need: a.need };
        }
    }
    return { earned, progress };
}

module.exports = { CATALOG, catalog, forMember, ownApproved };
