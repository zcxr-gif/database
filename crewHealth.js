'use strict';

/*
 * crewHealth.js
 * Who is slipping away, while there is still time to ask.
 *
 * WHY THIS EXISTS
 * ---------------
 * crewRetention.js already answers "who should come off the roster?". It is the
 * right question and it is asked too late: by the time the sweep removes
 * somebody, the airline lost them weeks ago. The useful moment was the fortnight
 * a pilot who flew twice a week flew nothing, and nothing on the dashboard was
 * shaped like that.
 *
 * This is that shape. Four groups, each of which is a DIFFERENT CONVERSATION —
 * which is the reason it is four lists and not one sorted by risk:
 *
 *   quiet   flew regularly, has not lately. The one worth a message.
 *   never   joined, never filed. A recruitment problem, not a retention one:
 *           usually nobody told them how.
 *   edge    inside the sweep's window. Last chance to ask.
 *   away    on leave, with a date. Here so nobody chases them.
 *
 * Every pilot appears in at most one group, and the order above is the priority:
 * somebody on leave is on leave whatever their flight count says, and a pilot
 * about to be swept is "nearly out" rather than "going quiet" because that is
 * the more urgent sentence about the same person.
 *
 * WHAT LIVES HERE
 * ---------------
 * Decisions. It reads a roster, a flight log and the VA's sweep settings and
 * returns four lists; it does not talk to a database or know what time it is
 * unless told. The same split crewRetention.js and crewSchedules.js follow, and
 * for the same reason: the rules that are explained live beside the rules that
 * are enforced, so the two cannot disagree.
 */

const crewRetention = require('./crewRetention');

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** How many weeks of flying the spark on each row shows. */
const SPARK_WEEKS = 8;

/**
 * A pilot has to have flown enough for "has not lately" to mean anything.
 *
 * Two flights is not a habit, and telling a staff member that somebody who
 * filed one report in March has "gone quiet" is how a board like this loses
 * their attention.
 */
const REGULAR_FLIGHTS = 3;

/** The silence that counts as going quiet, for a pilot who was flying. */
const QUIET_DAYS = 21;

/**
 * A new joiner gets a few days before "never started" is a fair thing to say
 * about them. Somebody who joined this morning has not failed at anything.
 */
const GRACE_DAYS = 3;

/** How close to the sweep's deadline counts as "nearly out". */
const EDGE_DAYS = 14;

const time = (v) => {
    if (!v) return 0;
    const d = v instanceof Date ? v : new Date(v);
    const n = d.getTime();
    return Number.isFinite(n) ? n : 0;
};

/**
 * Every approved flight, keyed by the pilot who flew it.
 *
 * Built once rather than filtered per pilot, for the reason crewRetention
 * builds its own index: a VA with 300 pilots and 20,000 reports is six million
 * comparisons the other way round. Only approved reports count — a pending one
 * is a claim nobody has looked at, and a pilot cannot hold their place on the
 * roster by filing something that is never reviewed.
 */
function flightsByMember(pireps) {
    const byId = new Map();
    const byIf = new Map();
    for (const p of pireps || []) {
        if (!p || p.status !== 'approved') continue;
        const at = time(p.flownAt || p.createdAt);
        if (!at) continue;
        const push = (map, key) => {
            if (!key) return;
            const list = map.get(key);
            if (list) list.push(at); else map.set(key, [at]);
        };
        push(byId, p.memberId && String(p.memberId));
        push(byIf, p.ifUserId && String(p.ifUserId));
    }
    return { byId, byIf };
}

/** When this pilot flew, every time, as timestamps. */
function timesFor(member, index) {
    const own = index.byId.get(String(member._id)) || [];
    // The IF id is the fallback, not the primary — see crewRetention's note on
    // the same lookup. A flight captured before the roster row was linked was
    // still flown by this person.
    const viaIf = member.ifUserId ? (index.byIf.get(String(member.ifUserId)) || []) : [];
    if (!viaIf.length) return own;
    if (!own.length) return viaIf;
    return [...new Set([...own, ...viaIf])];
}

/**
 * Eight weeks of flying, oldest bar first.
 *
 * Not a chart — a shape, and the shape is the reason the row is on a list
 * called "going quiet". A row of bars that stops halfway says more in 2cm than
 * a date does in a sentence.
 */
function spark(times, now) {
    const weeks = new Array(SPARK_WEEKS).fill(0);
    const start = now - (SPARK_WEEKS * WEEK_MS);
    for (const t of times) {
        if (t < start || t > now) continue;
        const idx = Math.min(SPARK_WEEKS - 1, Math.floor((t - start) / WEEK_MS));
        weeks[idx] += 1;
    }
    return weeks;
}

/**
 * The row, as the board draws it.
 *
 * Deliberately small: a name, a callsign, one date and the shape. A board whose
 * rows carry everything about a pilot is a board nobody scans, and the button
 * next to each row is the point of the screen.
 */
function row(member, times, now, extra) {
    const last = times.length ? Math.max(...times) : 0;
    return {
        id: member._id,
        name: member.name || '',
        callsign: member.callsign || '',
        joinedAt: member.createdAt || null,
        lastFlightAt: last ? new Date(last).toISOString() : null,
        flights: times.length,
        weeks: spark(times, now),
        ...(extra || {}),
    };
}

/**
 * When the sweep would reach this pilot, in days, or null if it would not.
 *
 * Read off the VA's own settings rather than guessed, so a VA running a 90-day
 * window is not told somebody is nearly out at day 30. Both rules are asked
 * because they apply to different people: probation to somebody who has never
 * flown, inactivity to somebody who has stopped.
 */
function daysUntilSwept(member, times, rules, now) {
    if (!rules.enabled) return null;
    // Staff and pilots already marked inactive are never swept — the same four
    // exemptions crewRetention applies, asked of the same settings.
    if (rules.exemptStaff && String(member.role || '').trim()) return null;
    if (member.status === 'inactive') return null;

    if (!times.length) {
        if (!rules.firstFlight) return null;
        const joined = time(member.createdAt);
        if (!joined) return null;
        return Math.ceil((joined + (rules.firstFlightDays * DAY_MS) - now) / DAY_MS);
    }
    if (!rules.inactivity) return null;
    const last = Math.max(...times);
    return Math.ceil((last + (rules.inactivityDays * DAY_MS) - now) / DAY_MS);
}

/**
 * The four groups.
 *
 * `now` is injected rather than read, which is what lets the test assert the
 * boundaries instead of waiting three weeks for one.
 */
function groups({ members = [], pireps = [], rules = {}, now = Date.now() } = {}) {
    const r = crewRetention.publicRules(rules);
    const index = flightsByMember(pireps);
    const out = { quiet: [], never: [], edge: [], away: [] };

    for (const m of members) {
        if (!m || m.status === 'inactive') continue;
        const times = timesFor(m, index);

        // 1. Away. Whatever else is true of them.
        if (m.status === 'loa') {
            const until = time(m.loaUntil);
            // Leave that has run out is no longer leave: the pilot is an
            // ordinary member of the roster again and belongs in whichever group
            // their flying puts them in, which is the same moment the sweep
            // starts counting them again.
            if (!until || until > now) {
                out.away.push(row(m, times, now, {
                    until: m.loaUntil || null,
                    reason: m.loaReason || '',
                }));
                continue;
            }
        }

        const days = daysUntilSwept(m, times, r, now);

        // 2. Never started. Joined, never filed, and past the grace period.
        if (!times.length) {
            const joined = time(m.createdAt);
            if (joined && (now - joined) >= (GRACE_DAYS * DAY_MS)) {
                out.never.push(row(m, times, now, {
                    removedInDays: days != null ? Math.max(0, days) : null,
                }));
            }
            continue;
        }

        // 3. Nearly out. Inside the sweep's last fortnight — which only exists
        //    for a VA that runs the sweep at all.
        if (days != null && days <= EDGE_DAYS) {
            out.edge.push(row(m, times, now, { removedInDays: Math.max(0, days) }));
            continue;
        }

        // 4. Going quiet. Flew regularly, has not lately.
        const last = Math.max(...times);
        if (times.length >= REGULAR_FLIGHTS && (now - last) >= (QUIET_DAYS * DAY_MS)) {
            out.quiet.push(row(m, times, now));
        }
    }

    // Longest silence first in the three lists that are about silence, and
    // soonest-back first in the one that is not: both are the order a staff
    // member would work down.
    const bySilence = (a, b) => time(a.lastFlightAt || a.joinedAt) - time(b.lastFlightAt || b.joinedAt);
    out.quiet.sort(bySilence);
    out.never.sort(bySilence);
    out.edge.sort((a, b) => (a.removedInDays ?? 9e9) - (b.removedInDays ?? 9e9));
    out.away.sort((a, b) => time(a.until) - time(b.until));
    return out;
}

module.exports = {
    groups,
    spark,
    SPARK_WEEKS,
    QUIET_DAYS,
    EDGE_DAYS,
    GRACE_DAYS,
    REGULAR_FLIGHTS,
};
