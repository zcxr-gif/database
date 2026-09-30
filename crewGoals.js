'use strict';

/*
 * crewGoals.js
 * Tours and challenges — things a VA sets its pilots to fly.
 *
 * WHY THIS EXISTS
 * ---------------
 * Awards (crewAwards.js) are the airline noticing what a pilot did anyway.
 * These are the other half: the airline saying what it would LIKE flown.
 *
 *   TOUR       an ordered list of legs — "the Silk Road: seven sectors from
 *              London to Beijing". Fly them all and the tour is complete.
 *   CHALLENGE  a figure to reach in a window — "fifty hours out of the Heathrow
 *              hub in March", "every pilot together: a thousand landings this
 *              month". For one pilot, or for the whole crew at once.
 *
 * NOTHING IS STORED ABOUT PROGRESS
 * --------------------------------
 * Exactly the rule crewAwards follows, and for the same reasons. A leg of a
 * tour is done when there is an APPROVED flight report for it; a challenge
 * stands where the approved reports put it. So:
 *
 *   · nothing new is asked of staff — no "mark leg 3 complete" button to be
 *     forgotten, and no second record to disagree with the flight log;
 *   · nothing can be gamed that the log does not already permit;
 *   · a tour a VA publishes today is already partly flown by anybody who
 *     happens to have flown its legs inside its window, which is right.
 *
 * The DEFINITIONS are config and live on the VA's record beside the rank
 * ladder and the quizzes (crewTours / crewChallenges). No database update is
 * needed to use them, which matters: a feature that asks a VA to go and press
 * a button in Supabase first is a feature half of them never see.
 *
 * NOTHING HERE TALKS TO A DATABASE. Sanitising and arithmetic only.
 */

const MAX_TOURS = 60;
const MAX_CHALLENGES = 60;
const MAX_LEGS = 40;

const METRICS = ['flights', 'hours', 'distance', 'landings', 'airports'];
const METRIC_LABELS = {
    flights: 'flights', hours: 'hours', distance: 'nm', landings: 'landings', airports: 'airports',
};
const SCOPES = ['pilot', 'crew'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const fold = (v) => String(v || '').trim().toLowerCase();
const icao = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const iconName = (v, dflt) => (/^[a-z0-9-]{1,40}$/.test(String(v || '')) ? String(v) : dflt);
const httpsOnly = (v) => (/^https:\/\//i.test(String(v || '').trim()) ? str(v, 600) : '');
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function dateOrNull(v) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanAward(a, fallbackName, fallbackIcon = 'flag') {
    const src = a && typeof a === 'object' ? a : {};
    return {
        name: str(src.name, 60) || str(fallbackName, 60),
        tier: TIERS.includes(src.tier) ? src.tier : 'gold',
        icon: iconName(src.icon, fallbackIcon),
    };
}

/* ---------------------------------------------------------------------------
 * Tours
 * ------------------------------------------------------------------------- */

function cleanLeg(l) {
    const src = l && typeof l === 'object' ? l : {};
    return {
        origin: icao(src.origin),
        destination: icao(src.destination),
        // Optional: "in the 787" narrows the leg to one type. Matched loosely
        // against the flight report's aircraft, because IF's names are long
        // ("Boeing 787-9 Dreamliner") and a VA types "787-9".
        aircraft: str(src.aircraft, 60),
        note: str(src.note, 200),
    };
}

/** One tour as it may be stored. Returns null for one with nothing to fly. */
function sanitizeTour(t, prev = null) {
    const src = t && typeof t === 'object' ? t : {};
    const legs = (Array.isArray(src.legs) ? src.legs : []).slice(0, MAX_LEGS).map(cleanLeg)
        .filter((l) => l.origin && l.destination);
    const title = str(src.title, 80);
    if (!title || !legs.length) return null;
    const startsAt = dateOrNull(src.startsAt);
    let endsAt = dateOrNull(src.endsAt);
    if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) endsAt = null;
    return {
        id: str((prev && prev.id) || src.id, 40) || newId('tour'),
        title,
        blurb: str(src.blurb, 1200),
        image: httpsOnly(src.image),
        legs,
        // In order is the default and the point of a tour — a journey, not a
        // checklist. Off makes it a set: fly them in any order.
        ordered: src.ordered !== false,
        startsAt,
        endsAt,
        minRank: str(src.minRank, 40),
        active: src.active !== false,
        award: cleanAward(src.award, title),
        createdAt: (prev && prev.createdAt) || dateOrNull(src.createdAt) || new Date().toISOString(),
        // Kept as stored when a list is only being re-read; stamped on a save.
        updatedAt: (prev === src && src.updatedAt) || new Date().toISOString(),
    };
}

/* ---------------------------------------------------------------------------
 * Challenges
 * ------------------------------------------------------------------------- */

function sanitizeChallenge(c, prev = null) {
    const src = c && typeof c === 'object' ? c : {};
    const title = str(src.title, 80);
    const metric = METRICS.includes(src.metric) ? src.metric : 'flights';
    const target = Math.max(1, Math.min(1e7, Math.round(Number(src.target) || 0)));
    if (!title || !(Number(src.target) > 0)) return null;
    const f = src.filter && typeof src.filter === 'object' ? src.filter : {};
    const startsAt = dateOrNull(src.startsAt);
    let endsAt = dateOrNull(src.endsAt);
    if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) endsAt = null;
    return {
        id: str((prev && prev.id) || src.id, 40) || newId('chal'),
        title,
        blurb: str(src.blurb, 1200),
        image: httpsOnly(src.image),
        metric,
        target,
        scope: SCOPES.includes(src.scope) ? src.scope : 'pilot',
        // Which flights count. Every part optional; all of them together narrow.
        filter: {
            // Either end — "out of or into the hub".
            airport: icao(f.airport),
            origin: icao(f.origin),
            destination: icao(f.destination),
            aircraft: str(f.aircraft, 60),
            // Only legs the airline flies itself, only codeshares, or both.
            routeKind: ['own', 'codeshare'].includes(f.routeKind) ? f.routeKind : '',
        },
        startsAt,
        endsAt,
        active: src.active !== false,
        award: cleanAward(src.award, title, 'trophy'),
        createdAt: (prev && prev.createdAt) || dateOrNull(src.createdAt) || new Date().toISOString(),
        // Kept as stored when a list is only being re-read; stamped on a save.
        updatedAt: (prev === src && src.updatedAt) || new Date().toISOString(),
    };
}

/** A whole list from the VA record, dropping anything that no longer cleans. */
const cleanList = (arr, fn, max) => (Array.isArray(arr) ? arr : []).slice(0, max)
    .map((x) => fn(x, x)).filter(Boolean);
const sanitizeTours = (arr) => cleanList(arr, sanitizeTour, MAX_TOURS);
const sanitizeChallenges = (arr) => cleanList(arr, sanitizeChallenge, MAX_CHALLENGES);

/* ---------------------------------------------------------------------------
 * Progress
 * ------------------------------------------------------------------------- */

const whenOf = (p) => {
    const d = new Date((p && (p.flownAt || p.createdAt)) || 0).getTime();
    return Number.isFinite(d) ? d : 0;
};

/** Approved, dated, oldest first — the order everything below replays in. */
const approvedLog = (pireps) => (pireps || [])
    .filter((p) => p && p.status === 'approved')
    .sort((a, b) => whenOf(a) - whenOf(b));

function inWindow(p, g) {
    const t = whenOf(p);
    if (g.startsAt && t < new Date(g.startsAt).getTime()) return false;
    if (g.endsAt && t > new Date(g.endsAt).getTime()) return false;
    return true;
}

/** "787-9" matches "Boeing 787-9 Dreamliner"; empty matches anything. */
function aircraftMatches(want, p) {
    const w = fold(want).replace(/\s+/g, '');
    if (!w) return true;
    const have = fold(p && (p.aircraftName || p.aircraft)).replace(/\s+/g, '');
    return !!have && have.includes(w);
}

const legMatches = (leg, p) => icao(p.origin) === leg.origin && icao(p.destination) === leg.destination
    && aircraftMatches(leg.aircraft, p);

/**
 * How far one pilot is through one tour.
 *
 * Ordered: the log is replayed oldest first with a pointer at the next leg; a
 * flight only counts if it is the leg the pilot is ON. Flying leg 3 before leg
 * 2 does not count leg 3 — it has to be flown again once 2 is done, which is
 * what "in order" means.
 *
 * Unordered: each leg is done by the first flight that matches it.
 */
function tourProgress(tour, pireps) {
    const log = approvedLog(pireps).filter((p) => inWindow(p, tour));
    const legs = tour.legs.map(() => null);
    if (tour.ordered) {
        let next = 0;
        for (const p of log) {
            if (next >= legs.length) break;
            if (legMatches(tour.legs[next], p)) {
                legs[next] = { at: p.flownAt || p.createdAt || null, pirepId: String(p._id || '') };
                next += 1;
            }
        }
    } else {
        for (const p of log) {
            const i = tour.legs.findIndex((l, n) => !legs[n] && legMatches(l, p));
            if (i >= 0) legs[i] = { at: p.flownAt || p.createdAt || null, pirepId: String(p._id || '') };
        }
    }
    const done = legs.filter(Boolean).length;
    const complete = done === legs.length;
    const completedAt = complete
        ? legs.map((l) => l.at).filter(Boolean).sort().pop() || null
        : null;
    const nextLeg = tour.ordered ? legs.findIndex((l) => !l) : -1;
    return { done, total: legs.length, complete, completedAt, legs, nextLeg };
}

function flightCounts(ch, p) {
    const f = ch.filter || {};
    const o = icao(p.origin);
    const d = icao(p.destination);
    if (f.airport && o !== f.airport && d !== f.airport) return false;
    if (f.origin && o !== f.origin) return false;
    if (f.destination && d !== f.destination) return false;
    if (!aircraftMatches(f.aircraft, p)) return false;
    if (f.routeKind && p.routeKind && p.routeKind !== f.routeKind) return false;
    return inWindow(p, ch);
}

/**
 * Where a set of approved flights stands against a challenge. Replayed oldest
 * first so the flight that crossed the line dates the completion, as with
 * awards.
 */
function challengeProgress(ch, pireps) {
    let have = 0;
    const ports = new Set();
    let completedAt = null;
    for (const p of approvedLog(pireps)) {
        if (!flightCounts(ch, p)) continue;
        switch (ch.metric) {
            case 'hours': have += Math.max(0, Number(p.durationMin) || 0) / 60; break;
            case 'distance': have += Math.max(0, Number(p.distanceNm) || 0); break;
            case 'landings': have += Math.max(0, Number(p.landings) || 0); break;
            case 'airports':
                for (const a of [p.origin, p.destination]) if (icao(a)) ports.add(icao(a));
                have = ports.size;
                break;
            default: have += 1;
        }
        if (!completedAt && have >= ch.target) completedAt = p.flownAt || p.createdAt || null;
    }
    const shown = ch.metric === 'hours' ? Math.floor(have * 10) / 10 : Math.floor(have);
    return {
        have: shown,
        need: ch.target,
        unit: METRIC_LABELS[ch.metric] || '',
        complete: have >= ch.target,
        completedAt,
        pct: Math.min(100, Math.round((have / ch.target) * 100)),
    };
}

/** Split an airline-wide log into one log per pilot. */
function byPilot(pireps) {
    const out = new Map();
    for (const p of pireps || []) {
        const key = String(p.memberId || (p.ifUserId ? `if:${p.ifUserId}` : ''));
        if (!key) continue;
        if (!out.has(key)) out.set(key, { memberId: p.memberId || null, name: p.pilotName || p.callsign || 'Pilot', callsign: p.callsign || '', log: [] });
        out.get(key).log.push(p);
    }
    return out;
}

/**
 * Who is furthest along. Finished first (earliest first — being first round
 * the tour is the achievement), then by how far.
 */
function tourBoard(tour, pireps, { limit = 20 } = {}) {
    const rows = [];
    for (const who of byPilot(approvedLog(pireps)).values()) {
        const pr = tourProgress(tour, who.log);
        if (!pr.done) continue;
        rows.push({ memberId: who.memberId, name: who.name, callsign: who.callsign, done: pr.done, total: pr.total, completedAt: pr.completedAt });
    }
    rows.sort((a, b) => (b.completedAt ? 1 : 0) - (a.completedAt ? 1 : 0)
        || (a.completedAt && b.completedAt ? new Date(a.completedAt) - new Date(b.completedAt) : 0)
        || b.done - a.done || a.name.localeCompare(b.name));
    return { finishers: rows.filter((r) => r.completedAt).length, flying: rows.length, top: rows.slice(0, limit) };
}

function challengeBoard(ch, pireps, { limit = 20 } = {}) {
    const rows = [];
    for (const who of byPilot(approvedLog(pireps)).values()) {
        const pr = challengeProgress(ch, who.log);
        if (!pr.have) continue;
        rows.push({ memberId: who.memberId, name: who.name, callsign: who.callsign, have: pr.have, completedAt: pr.completedAt });
    }
    rows.sort((a, b) => b.have - a.have || a.name.localeCompare(b.name));
    return { finishers: rows.filter((r) => r.completedAt).length, flying: rows.length, top: rows.slice(0, limit) };
}

/** Live, upcoming or finished — by the calendar, not by anybody's progress. */
function phase(g, now = new Date()) {
    const t = now.getTime();
    if (g.startsAt && t < new Date(g.startsAt).getTime()) return 'upcoming';
    if (g.endsAt && t > new Date(g.endsAt).getTime()) return 'ended';
    return 'live';
}

/**
 * Completed tours and personal challenges, in the shape crewAwards uses — so
 * they appear on the awards shelf and across the top of the pilot's page next
 * to everything else they have earned, with no second shelf to look on.
 */
function goalAwards({ tours = [], challenges = [], pireps = [] }) {
    const catalog = [];
    const earned = [];
    const progress = {};
    for (const t of tours) {
        if (!t.active) continue;
        const id = `tour:${t.id}`;
        catalog.push({ id, name: t.award.name || t.title, desc: `Tour · ${t.legs.length} leg${t.legs.length === 1 ? '' : 's'}`, icon: t.award.icon || 'flag', tier: t.award.tier, need: t.legs.length });
        const pr = tourProgress(t, pireps);
        if (pr.complete) earned.push({ id, at: pr.completedAt, name: t.award.name || t.title, tier: t.award.tier, icon: t.award.icon || 'flag' });
        else progress[id] = { have: pr.done, need: pr.total };
    }
    for (const c of challenges) {
        // A crew challenge is won together, and belongs on the crew's page,
        // not on one pilot's shelf.
        if (!c.active || c.scope !== 'pilot') continue;
        const id = `challenge:${c.id}`;
        catalog.push({ id, name: c.award.name || c.title, desc: `Challenge · ${c.target.toLocaleString()} ${METRIC_LABELS[c.metric]}`, icon: c.award.icon || 'trophy', tier: c.award.tier, need: c.target });
        const pr = challengeProgress(c, pireps);
        if (pr.complete) earned.push({ id, at: pr.completedAt, name: c.award.name || c.title, tier: c.award.tier, icon: c.award.icon || 'trophy' });
        else progress[id] = { have: pr.have, need: pr.need };
    }
    return { catalog, earned, progress };
}

module.exports = {
    MAX_TOURS,
    MAX_CHALLENGES,
    MAX_LEGS,
    METRICS,
    SCOPES,
    TIERS,
    sanitizeTour,
    sanitizeTours,
    sanitizeChallenge,
    sanitizeChallenges,
    tourProgress,
    challengeProgress,
    tourBoard,
    challengeBoard,
    phase,
    goalAwards,
    approvedLog,
    aircraftMatches,
};
