'use strict';

/*
 * crewRetention.js
 * Who is still on the roster, and who has stopped being on it.
 *
 * WHAT LIVES HERE
 * ---------------
 * Two rules a VA can switch on, and nothing else:
 *
 *   PROBATION   a new recruit has N days to fly and log their first flight.
 *               If they do not, they are removed — or marked inactive, if the
 *               VA would rather keep the record.
 *
 *   INACTIVITY  an established pilot who has not logged a flight in N days is
 *               marked inactive — or removed, if the VA wants the roster to be
 *               only people who fly.
 *
 * The whole file is DECISIONS. It reads a roster and a set of flight reports
 * and returns what is due; it does not talk to a database, post a webhook, or
 * know what time it is unless told. That is what makes it testable, and it is
 * the same split crewSchedules.js follows — the rules that are enforced live
 * beside the rules that are explained, so the two cannot disagree.
 *
 * WHY THIS IS NOT A CHECK-RIDE
 * ----------------------------
 * A check-ride (see crew_members.checks_passed) is staff signing a pilot off
 * for a rung. This is the opposite shape: nobody signs anything, the pilot
 * simply flies, and the only question is whether a flight arrived in time. A VA
 * that wants an induction with no ceremony wants THIS — one flight, logged —
 * and the two features are independent. A VA can run either, both, or neither.
 *
 * WHAT COUNTS AS FLYING
 * ---------------------
 * A VALIDATED flight report, and only that. A pending report is a claim staff
 * have not looked at yet, and letting one stop the clock would mean a pilot
 * could hold their place indefinitely by filing something nobody approves.
 * Reports are matched to a pilot by member id, falling back to the Infinite
 * Flight user id for reports captured automatically before a member was linked.
 *
 * WHO IS NEVER SWEPT
 * ------------------
 * Four groups, and each for a reason that has bitten a VA somewhere:
 *
 *   · Pilots on leave of absence. LOA is the roster saying "this person told us
 *     they would be away"; removing them for being away is the one outcome the
 *     status exists to prevent.
 *   · Staff, when the VA leaves exemptStaff on. The person who runs the events
 *     calendar may go a month without flying it, and an airline that deletes
 *     its own event manager for that has a bug, not a policy.
 *   · Anyone already inactive. The rule has already been applied to them; the
 *     alternative is that "mark inactive" quietly becomes "delete" on the next
 *     sweep, which is not what the VA switched on.
 *   · Everybody, while the feature is off — which is how it ships. This removes
 *     people's accounts. It does not get a default.
 */

const DAY_MS = 24 * 3600 * 1000;

/** What a rule may do when its deadline passes. */
const ACTIONS = ['remove', 'inactive'];

/** Who chooses a new pilot's probation routes. */
const PICKS = ['random', 'staff'];
const MAX_PROBATION_ROUTES = 10;

const int = (v, lo, hi, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

const when = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The VA's settings, bounded.
 *
 * Every default here is the inert one. A VA that has never opened this screen
 * gets a normalized object that does nothing at all, because the alternative is
 * that shipping this file deletes somebody's roster.
 */
function normalizeRules(cfg) {
    const c = cfg || {};
    const action = (v, def) => (ACTIONS.includes(v) ? v : def);
    return {
        // The master switch. OFF unless a VA has said otherwise — the opposite
        // of crewSchedules, and deliberately so: a schedule that appears
        // uninvited is a surprise, a roster sweep that runs uninvited is a
        // support ticket about missing pilots.
        enabled: !!c.enabled,

        // --- Probation: the first flight ---
        firstFlight: !!c.firstFlight,
        // 1–90 days. Below a day is not a window, and past ninety a VA is not
        // running a probation, they are running the inactivity rule.
        firstFlightDays: int(c.firstFlightDays, 1, 90, 7),
        // Removal is the default because it is what a probation window is FOR:
        // an account that never flew has no logbook to preserve.
        firstFlightAction: action(c.firstFlightAction, 'remove'),
        // Days BEFORE the deadline to warn. 0 turns the warning off.
        firstFlightWarnDays: int(c.firstFlightWarnDays, 0, 30, 2),
        // 0 is the rule as it always was: any one validated flight. Above it,
        // the new pilot has that many SET routes to fly in the window — picked
        // at random from the network, or handed to them by staff.
        firstFlightRoutes: int(c.firstFlightRoutes, 0, MAX_PROBATION_ROUTES, 0),
        firstFlightRoutePick: PICKS.includes(c.firstFlightRoutePick) ? c.firstFlightRoutePick : 'random',

        // --- Inactivity: the long silence ---
        inactivity: !!c.inactivity,
        inactivityDays: int(c.inactivityDays, 7, 365, 30),
        // Marking, not removing. An established pilot has hours, a rank and a
        // flight history; throwing that away because they had a quiet month is
        // a much bigger act than closing an account that never flew, so the
        // default is the reversible one and a VA has to choose otherwise.
        inactivityAction: action(c.inactivityAction, 'inactive'),
        inactivityWarnDays: int(c.inactivityWarnDays, 0, 60, 7),

        // Staff run the airline; flying it is not their job description.
        exemptStaff: c.exemptStaff === undefined ? true : !!c.exemptStaff,
    };
}

/** The settings as the crew center may read them. Same shape; nothing secret. */
const publicRules = (cfg) => normalizeRules(cfg);

/**
 * The last validated flight for each member, keyed by member id.
 *
 * Built once per sweep rather than scanned per pilot: a VA with 300 pilots and
 * 20,000 reports is 6,000,000 comparisons the other way round.
 */
function lastFlightIndex(pireps = []) {
    const byMember = new Map();
    const byIfUser = new Map();
    for (const p of pireps) {
        if (!p || p.status !== 'approved') continue;
        const t = when(p.flownAt || p.createdAt);
        if (!t) continue;
        const keep = (map, key) => {
            if (!key) return;
            const cur = map.get(key);
            if (!cur || t > cur) map.set(key, t);
        };
        keep(byMember, p.memberId && String(p.memberId));
        keep(byIfUser, p.ifUserId && String(p.ifUserId));
    }
    return { byMember, byIfUser };
}

/**
 * When this member last flew, or null if they never have.
 *
 * `_id` first, then `id`. The roster rows this is handed come out of crewStore,
 * where a member is `_id` — both the Supabase mapper and a mongoose `.lean()`
 * document, which carries no `id` virtual. Reading only `id` therefore looked up
 * the string "undefined" for every pilot and found nothing, which did not fail
 * loudly: it made every pilot without an Infinite Flight link look as though
 * they had NEVER FLOWN, so the inactivity rule never reached them and the
 * probation rule reached the wrong ones.
 */
function lastFlightFor(member, index) {
    if (!member) return null;
    const byId = index.byMember.get(String(member._id || member.id || ''));
    // The IF id is the fallback, not the primary: reports captured
    // automatically can land before the roster row is linked to an account, and
    // a pilot whose first flight was captured that way has flown.
    const byIf = member.ifUserId ? index.byIfUser.get(String(member.ifUserId)) : null;
    if (byId && byIf) return byId > byIf ? byId : byIf;
    return byId || byIf || null;
}

/**
 * Has this member already been warned about the state they are currently in?
 *
 * One timestamp covers both rules because the anchor moves. A probation warning
 * is anchored to the join date and an inactivity warning to the last flight, so
 * a warning recorded BEFORE the current anchor belongs to a previous cycle —
 * which is exactly what "they flew, then went quiet again" looks like. No reset
 * is needed anywhere: flying moves the anchor past the old warning and the next
 * silence warns afresh.
 */
const alreadyWarned = (member, anchor) => {
    const w = when(member && member.retentionWarnedAt);
    if (!w) return false;
    return !anchor || w >= anchor;
};

/**
 * Is this member off-limits to the sweep, and why?
 *
 * `now` is what makes leave finite. Before v15 'loa' was a flag with nothing
 * attached — staff set it by hand and it exempted a pilot forever, which is the
 * right behaviour for a flag nobody could put a date on. A pilot who says they
 * are away until the 14th has told us when to start counting again, and
 * ignoring that would turn every exam week into a permanent exemption. A leave
 * with no `loaUntil` is open-ended and keeps behaving exactly as it always did,
 * which is every hand-set one from before the column existed.
 */
function exemptReason(member, rules, now = Date.now()) {
    if (!member) return 'unknown';
    if (member.status === 'loa') {
        const until = when(member.loaUntil);
        if (!until || until.getTime() > now) return 'loa';
    }
    if (member.status === 'inactive') return 'already inactive';
    if (rules.exemptStaff && isStaff(member)) return 'staff';
    return '';
}

/**
 * Does this roster row belong to somebody who runs the airline?
 *
 * `role` on a member is a free-text job title the VA chose, so this cannot be
 * an equality check against a fixed list. Anything non-empty means the VA gave
 * this person a job, and that is the signal — the failure mode is a pilot
 * mislabelled as staff surviving a sweep, which is the right way round.
 */
const isStaff = (member) => !!String((member && member.role) || '').trim();

/**
 * What is due, right now.
 *
 * Returns four lists, each of { member, dueAt, days, action } — the two that
 * warn and the two that act. Nothing is applied here; the caller decides
 * whether to write anything, which is what lets the same function power both
 * the sweep and the dry run a VA reads before switching this on.
 */
function assess({ members = [], pireps = [], rules = {}, now = Date.now(), assignments = {}, routes = [] } = {}) {
    const r = normalizeRules(rules);
    const out = {
        rules: r,
        probationWarn: [], probationDue: [],
        inactivityWarn: [], inactivityDue: [],
        // Staff mode: new pilots with no routes chosen yet. Not on a clock —
        // nobody is removed for a list their staff have not written.
        awaitingRoutes: [],
        exempt: [],
        checked: 0,
    };
    if (!r.enabled) return out;

    const index = lastFlightIndex(pireps);
    const t = now instanceof Date ? now.getTime() : Number(now);
    const routesById = new Map(assignableRoutes(routes).map((x) => [routeKey(x), x]));
    const given = cleanAssignments(assignments);

    for (const m of members) {
        if (!m) continue;
        const why = exemptReason(m, r, t);
        if (why) { out.exempt.push({ member: m, reason: why }); continue; }
        out.checked += 1;

        const flown = lastFlightFor(m, index);
        const joined = when(m.createdAt);

        // PROBATION ON SET ROUTES — through only when every assigned route
        // that still exists has been flown. Clocked from the later of joining
        // and being handed the routes.
        if (r.firstFlight && r.firstFlightRoutes) {
            const a = given[String(m._id || m.id || '')];
            const prog = a ? probationProgress(m, a, pireps, routesById) : null;
            if (prog && prog.required) {
                if (!prog.left.length) { /* through probation — on to inactivity below */ } else {
                    const start = Math.max(joined ? joined.getTime() : 0, when(a.at).getTime());
                    const dueAt = new Date(start + r.firstFlightDays * DAY_MS);
                    const daysLeft = Math.ceil((dueAt.getTime() - t) / DAY_MS);
                    const extra = { routes: prog, by: a.by };
                    if (t >= dueAt.getTime()) {
                        out.probationDue.push({ member: m, dueAt, days: r.firstFlightDays, action: r.firstFlightAction, ...extra });
                    } else if (r.firstFlightWarnDays && daysLeft <= r.firstFlightWarnDays && !alreadyWarned(m, new Date(start))) {
                        out.probationWarn.push({ member: m, dueAt, days: daysLeft, action: r.firstFlightAction, ...extra });
                    }
                    continue;
                }
            } else if (!flown && r.firstFlightRoutePick === 'staff' && !a) {
                out.awaitingRoutes.push({ member: m });
                continue;
            }
        }

        // PROBATION — never flown at all. Anchored on the join date, so a
        // roster imported wholesale does not have its entire membership swept
        // on day one... unless the VA's rows genuinely are that old, which is
        // the honest reading of the data they gave us.
        if (r.firstFlight && !flown) {
            if (!joined) continue; // no join date, no clock; leave them alone
            const dueAt = new Date(joined.getTime() + r.firstFlightDays * DAY_MS);
            const daysLeft = Math.ceil((dueAt.getTime() - t) / DAY_MS);
            if (t >= dueAt.getTime()) {
                out.probationDue.push({ member: m, dueAt, days: r.firstFlightDays, action: r.firstFlightAction });
            } else if (r.firstFlightWarnDays && daysLeft <= r.firstFlightWarnDays && !alreadyWarned(m, joined)) {
                out.probationWarn.push({ member: m, dueAt, days: daysLeft, action: r.firstFlightAction });
            }
            continue; // a pilot on probation is not also "inactive"
        }

        // INACTIVITY — flew once, then stopped.
        if (r.inactivity && flown) {
            const dueAt = new Date(flown.getTime() + r.inactivityDays * DAY_MS);
            const daysLeft = Math.ceil((dueAt.getTime() - t) / DAY_MS);
            if (t >= dueAt.getTime()) {
                out.inactivityDue.push({ member: m, dueAt, days: r.inactivityDays, action: r.inactivityAction, lastFlightAt: flown });
            } else if (r.inactivityWarnDays && daysLeft <= r.inactivityWarnDays && !alreadyWarned(m, flown)) {
                out.inactivityWarn.push({ member: m, dueAt, days: daysLeft, action: r.inactivityAction, lastFlightAt: flown });
            }
        }
    }
    return out;
}

/* ---------------------------------------------------------------------------
 * PROBATION ROUTES
 *
 * "Fly one flight in your first week" proves somebody can file a report. A VA
 * that wants to know they can fly ITS network asks for set routes instead:
 * three legs, say, either drawn at random from what the airline publishes or
 * chosen by staff for that pilot.
 *
 * The assignment is stored per pilot (memberId → { routeIds, by, at }) on the
 * VA's record, beside the rules. It is handed out only to a pilot who has not
 * flown yet — so switching this on never puts an established pilot back on
 * probation — and the clock starts when it is handed out, not at the join
 * date, so a pilot whose staff took four days to choose still gets the full
 * window.
 *
 * A route deleted from the network after it was assigned cannot be flown, so
 * it stops counting: the requirement shrinks rather than becoming impossible.
 * ------------------------------------------------------------------------- */

/** Routes a new pilot may be handed: our own, published, with both airports. */
const assignableRoutes = (routes = []) => routes.filter((r) => r && (r.kind || 'own') === 'own'
    && r.active !== false && r.origin && r.destination && (r._id || r.id));
const routeKey = (r) => String((r && (r._id || r.id)) || '');

/** `n` distinct routes, at random. `rand` is injectable so tests can pin it. */
function pickRoutes(routes, n, rand = Math.random) {
    const pool = assignableRoutes(routes).map(routeKey);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.max(0, n));
}

/** The stored assignments, bounded. Anything unreadable is dropped. */
function cleanAssignments(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, a] of Object.entries(raw)) {
        if (!id || !a || typeof a !== 'object') continue;
        const routeIds = [...new Set((Array.isArray(a.routeIds) ? a.routeIds : []).map((x) => String(x || '').slice(0, 80)).filter(Boolean))]
            .slice(0, MAX_PROBATION_ROUTES);
        const at = when(a.at);
        if (!routeIds.length || !at) continue;
        out[String(id).slice(0, 80)] = { routeIds, by: a.by === 'staff' ? 'staff' : 'random', at: at.toISOString() };
    }
    return out;
}

/**
 * Which of a pilot's assigned routes they have flown, from their validated
 * reports. A report counts for a route when it names it, or — because plenty
 * of pilots file without picking the route — when it flew the same airports.
 */
function probationProgress(member, assignment, pireps = [], routesById = new Map()) {
    const ids = ((assignment && assignment.routeIds) || []).filter((id) => routesById.has(id));
    const mid = String((member && (member._id || member.id)) || '');
    const ifu = member && member.ifUserId ? String(member.ifUserId) : '';
    const mine = pireps.filter((p) => p && p.status === 'approved'
        && ((mid && String(p.memberId || '') === mid) || (ifu && String(p.ifUserId || '') === ifu)));
    const up = (v) => String(v || '').trim().toUpperCase();
    const done = ids.filter((id) => {
        const r = routesById.get(id);
        return mine.some((p) => (p.routeId && String(p.routeId) === id)
            || (up(p.origin) && up(p.origin) === up(r.origin) && up(p.destination) === up(r.destination)));
    });
    return { required: ids.length, done, left: ids.filter((id) => !done.includes(id)) };
}

/**
 * Hand routes to every new pilot who needs them and has none, and forget the
 * assignments of pilots no longer on the roster. Random mode only — in staff
 * mode a person chooses. Returns { assignments, added: [memberId], changed }.
 */
function assignMissing({ members = [], pireps = [], rules = {}, assignments = {}, routes = [], now = Date.now(), rand = Math.random } = {}) {
    const r = normalizeRules(rules);
    const next = cleanAssignments(assignments);
    const before = JSON.stringify(next);
    const onRoster = new Set(members.filter(Boolean).map((m) => String(m._id || m.id || '')));
    for (const id of Object.keys(next)) if (!onRoster.has(id)) delete next[id];
    const added = [];
    if (r.enabled && r.firstFlight && r.firstFlightRoutes && r.firstFlightRoutePick === 'random') {
        const index = lastFlightIndex(pireps);
        const t = now instanceof Date ? now.getTime() : Number(now);
        for (const m of members) {
            const id = String((m && (m._id || m.id)) || '');
            if (!id || next[id] || exemptReason(m, r, t) || !when(m.createdAt) || lastFlightFor(m, index)) continue;
            const routeIds = pickRoutes(routes, r.firstFlightRoutes, rand);
            if (!routeIds.length) break; // no network to draw from; the plain rule applies
            next[id] = { routeIds, by: 'random', at: new Date(t).toISOString() };
            added.push(id);
        }
    }
    return { assignments: next, added, changed: JSON.stringify(next) !== before };
}

/** A one-line summary of a sweep, for a log or a webhook footer. */
function summarize(result) {
    const n = (a) => (a || []).length;
    return [
        `${result.checked} checked`,
        n(result.probationWarn) ? `${n(result.probationWarn)} warned (first flight)` : '',
        n(result.probationDue) ? `${n(result.probationDue)} due (first flight)` : '',
        n(result.inactivityWarn) ? `${n(result.inactivityWarn)} warned (inactive)` : '',
        n(result.inactivityDue) ? `${n(result.inactivityDue)} due (inactive)` : '',
    ].filter(Boolean).join(' · ');
}

module.exports = {
    ACTIONS,
    PICKS,
    MAX_PROBATION_ROUTES,
    assignableRoutes,
    pickRoutes,
    cleanAssignments,
    probationProgress,
    assignMissing,
    DAY_MS,
    normalizeRules,
    publicRules,
    assess,
    summarize,
    lastFlightIndex,
    lastFlightFor,
    isStaff,
};
