'use strict';

/*
 * crewMultipliers.js
 * Temporary multipliers on internal events and routes.
 *
 * WHAT ONE IS
 * -----------
 * "Fly the Christmas event and it counts double" or "BA117 is 1.5× this week".
 * A multiplier names ONE event or ONE route, a factor, and a window; a flight
 * that matches and was flown inside the window is credited at that factor —
 * BOTH its hours (so ranks come faster) and its shop points. The logbook keeps
 * the real flight time; only what the flight is CREDITED moves.
 *
 * WHERE IT LIVES
 * --------------
 * On the VA's record (crewMultipliers), beside the shop and the featured
 * routes. It is a rule about how the airline is run, read before a store
 * connection, and it must not need a schema migration in every VA's project.
 *
 * THE RULES THIS FILE KEEPS
 * -------------------------
 *   · Always temporary. A multiplier without an end is not one; a permanent
 *     change of pay is the shop's rates.
 *   · Judged by WHEN THE FLIGHT WAS FLOWN, not when it was approved — the same
 *     rule the featured routes follow. Slow staff must not cost a pilot their
 *     bonus.
 *   · Several matching (an event on a boosted route): the biggest wins. They do
 *     not stack; two promotions on one flight is a bookkeeping accident, not an
 *     offer anybody made.
 *   · Bounded: 1.1× to 5×. Below is noise; above turns a rank ladder into a
 *     formality in one evening.
 *
 * Pure: no database, no clock unless handed one.
 */

const KINDS = ['event', 'route'];
const MIN_FACTOR = 1.1;
const MAX_FACTOR = 5;
const MAX_MULTIPLIERS = 60;
// How long a finished one is kept for the record before it is tidied away.
const KEEP_ENDED_MS = 30 * 24 * 3600 * 1000;

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const when = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const newId = () => `mx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One multiplier as stored, or null when it cannot be honoured. */
function sanitize(m, prev = null) {
    const src = m && typeof m === 'object' ? m : {};
    const kind = KINDS.includes(src.kind) ? src.kind : '';
    const targetId = str(src.targetId, 80);
    const factor = Math.round(Number(src.factor) * 10) / 10;
    const startsAt = when(src.startsAt) || (prev && when(prev.startsAt)) || new Date();
    const endsAt = when(src.endsAt);
    if (!kind || !targetId || !Number.isFinite(factor) || !endsAt || endsAt <= startsAt) return null;
    return {
        id: (prev && prev.id) || str(src.id, 40) || newId(),
        kind,
        targetId,
        // What the pilot reads: "Christmas double", "Hub week". Optional.
        label: str(src.label, 60),
        factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor)),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
    };
}

/** The whole list, bounded, with long-finished ones tidied away. */
function sanitizeList(list, now = Date.now()) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const out = [];
    const seen = new Set();
    for (const m of (Array.isArray(list) ? list : [])) {
        const clean = sanitize(m, m);
        if (!clean || seen.has(clean.id)) continue;
        if (new Date(clean.endsAt).getTime() < t - KEEP_ENDED_MS) continue;
        seen.add(clean.id);
        out.push(clean);
        if (out.length >= MAX_MULTIPLIERS) break;
    }
    return out;
}

const isLive = (m, at) => {
    const t = at instanceof Date ? at.getTime() : Number(at);
    return new Date(m.startsAt).getTime() <= t && t < new Date(m.endsAt).getTime();
};

/**
 * What this flight is multiplied by: { factor, label, id } or null. A flight
 * matches an event multiplier by its eventId and a route multiplier by its
 * routeId; the biggest live one wins.
 */
function forFlight(list, { routeId = '', eventId = '', at = Date.now() } = {}) {
    let best = null;
    for (const m of sanitizeList(list, at)) {
        const hit = (m.kind === 'route' && routeId && m.targetId === String(routeId))
            || (m.kind === 'event' && eventId && m.targetId === String(eventId));
        if (!hit || !isLive(m, at)) continue;
        if (!best || m.factor > best.factor) best = { factor: m.factor, label: m.label, id: m.id, kind: m.kind };
    }
    return best;
}

/** Live now or starting later — what pilots are shown. */
const upcoming = (list, now = Date.now()) => {
    const t = now instanceof Date ? now.getTime() : Number(now);
    return sanitizeList(list, now).filter((m) => new Date(m.endsAt).getTime() > t)
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
};

module.exports = { KINDS, MIN_FACTOR, MAX_FACTOR, MAX_MULTIPLIERS, sanitize, sanitizeList, forFlight, upcoming, isLive };
