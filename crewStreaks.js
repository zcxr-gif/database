'use strict';

/*
 * crewStreaks.js
 * Flying week after week, and what that is worth.
 *
 * WHAT A STREAK IS
 * ----------------
 * The number of weeks in a row a pilot has flown at least one approved flight.
 * Not hours, not flights, not miles — those are all already counted somewhere
 * in this product and all three reward the same thing: volume. A streak rewards
 * the one thing a virtual airline actually needs and cannot buy, which is
 * SOMEBODY COMING BACK. A pilot who flies two hours every week for a year is
 * worth more to a VA than one who flies a hundred hours in March and is never
 * seen again, and until this file there was nothing anywhere in the crew center
 * that could tell the two apart.
 *
 * WEEKS, AND WHY NOT DAYS
 * -----------------------
 * The obvious shape is the daily streak every mobile app has, and it is wrong
 * here for a reason that is specific to this product: the unit of work is a
 * FLIGHT, and the shortest real one is about forty minutes. A daily streak asks
 * for forty minutes a day forever, which is an ask nobody with a job can meet —
 * so within a fortnight it is a feature that only punishes people, and the
 * pilots it punishes hardest are the ones who fly the long legs.
 *
 * A week is the period a VA already runs on. Route of the week, the weekly
 * roster, the group flight on Sunday. One flight a week is a real commitment
 * that a real person can actually keep, and keeping it for a year is worth
 * something.
 *
 * Weeks are UTC and start on Monday, which is what crewFeatured already means
 * by a week. A pilot in Auckland and a pilot in Los Angeles are on the same
 * week; the alternative is a streak that breaks or holds depending on where
 * somebody is standing.
 *
 * THE CURRENT WEEK IS NEVER THE ONE THAT BREAKS IT
 * ------------------------------------------------
 * A streak is alive all the way to Sunday night. Opening the crew center on
 * Monday morning must not say "streak lost" to somebody who has six days left
 * to fly — that is the single most common way a streak feature is built wrong,
 * and it turns the thing into a source of unearned bad news. So the count is
 * taken from the last week that is OVER, and this week's flying extends it.
 *
 * LEAVE FREEZES IT
 * ----------------
 * A pilot who sets leave in the crew center has told their airline they are not
 * flying. Ending their streak for it would make the honest thing to do the
 * expensive one, and the predictable result is that nobody ever sets leave
 * again. A week that falls entirely inside somebody's leave is skipped: it does
 * not count towards the streak and it does not break it.
 *
 * WHAT IT PAYS — AND THAT IT PAYS THROUGH A FLIGHT
 * ------------------------------------------------
 * Two things:
 *
 *   perWeek      a percentage on top of what every approved flight pays, one
 *                step per week held, capped. It stacks with the club bonus and
 *                it is deliberately small per step — the number that matters is
 *                the cap, and the pull is the climb towards it.
 *
 *   milestones   a one-off payment carried by the flight that takes a pilot
 *                across a given week. Four weeks, twelve, twenty-six, a year.
 *
 * BOTH ARRIVE AS PART OF A FLIGHT'S PAYMENT, and that is the load-bearing
 * decision in this file. The crew center has exactly one currency supply — an
 * approved flight report — and everything that has ever gone wrong with a VA's
 * hand-rolled economy has gone wrong because there were two. A "give Rae 500
 * for her streak" button is a second supply, unaudited and unreversible, and
 * the shop's own header says why it does not exist.
 *
 * So a streak milestone is not paid TO a pilot, it is paid ON a flight: it
 * rides on the approval that earned it, it is written into that report's
 * `points_awarded` like everything else, and rejecting the flight takes it back
 * with the rest. No new table, no new column, no second ledger, and every
 * guarantee the flight payment already has comes along for free.
 *
 * MILESTONES FIRE ON THE CROSSING, WHICH IS WHY THERE IS NOTHING TO REMEMBER
 * -------------------------------------------------------------------------
 * The obvious implementation of "pay this once" is a column recording that it
 * was paid. That is a schema migration in three hundred VA projects for one
 * integer, and it would be the only piece of streak state anywhere.
 *
 * It is not needed, because a crossing is derivable: count the streak with this
 * flight and count it without, and a milestone that sits between the two has
 * just been reached. The flight that takes somebody from three weeks to four
 * pays the four-week milestone; every later flight that week counts four both
 * ways and pays nothing. The streak is a function of the logbook, and the
 * logbook is already there.
 *
 * NOTHING HERE TALKS TO A DATABASE. Handed some flights and some settings, it
 * says how long the streak is and what it is worth. The I/O is in the routes.
 */

const int = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt === undefined ? min : dflt;
    return Math.max(min, Math.min(max, n));
};

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

/* 1970-01-01 was a Thursday, so the Monday that opens the week containing the
 * epoch is 1969-12-29. Everything below counts weeks from there, which makes a
 * week an integer — and two weeks being consecutive a subtraction rather than a
 * calendar argument. */
const MONDAY_EPOCH = -3 * DAY_MS;

/** The most a single week of streak may add. A step, not a jackpot. */
const MAX_PER_WEEK = 25;
/** The ceiling the steps climb towards, however many weeks are held. */
const MAX_BONUS = 200;
/** The most milestones a VA may set. Four is the shape; this is a wall. */
const MAX_MILESTONES = 8;
/** The furthest back a streak is counted. Four years of weeks. */
const MAX_WEEKS = 208;
/** The most one milestone may pay. The shop's own ceiling, for the same reason. */
const MAX_MILESTONE_PAY = 1e5;

/* ===========================================================================
 * WEEKS
 * ======================================================================== */

/** The week `t` falls in, as an integer. Monday-based, UTC. */
function weekIndex(t) {
    const d = t instanceof Date ? t : new Date(t == null ? Date.now() : t);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return NaN;
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((midnight - MONDAY_EPOCH) / WEEK_MS);
}

/** When that week opens (Monday 00:00 UTC). */
const weekStart = (i) => new Date(MONDAY_EPOCH + i * WEEK_MS);
/** When it closes — the instant the next one opens, so a streak's deadline. */
const weekEnd = (i) => new Date(MONDAY_EPOCH + (i + 1) * WEEK_MS);

/**
 * The date a flight counts on.
 *
 * `flownAt` rather than when it was filed or approved, and that matters: staff
 * approving a fortnight's backlog on a Sunday must not collapse a pilot's whole
 * history into one week. A report with no flown date falls back to when it was
 * created, which is the closest thing to the truth we have.
 */
const flightAt = (f) => (f && (f.flownAt || f.flown_at || f.createdAt || f.created_at)) || null;

/** Every week this pilot has an approved flight in, as a set of week indexes. */
function weeksFlown(flights, { exclude = '' } = {}) {
    const skip = String(exclude || '');
    const out = new Set();
    for (const f of flights || []) {
        if (!f || String(f.status || '') !== 'approved') continue;
        if (skip && String(f._id || f.id || '') === skip) continue;
        const at = flightAt(f);
        if (!at) continue;
        const w = weekIndex(at);
        if (Number.isFinite(w)) out.add(w);
    }
    return out;
}

/* ===========================================================================
 * LEAVE
 *
 * Only the leave a pilot is on NOW, because that is the only leave the roster
 * row remembers — `loaSince` and `loaUntil` are one period, not a history. That
 * is the case worth covering anyway: the pilot who set leave, came back, and
 * found their streak gone is the one who never sets it again.
 *
 * Open-ended leave (an 'loa' member with no `loaUntil`) runs to now, so it
 * holds a streak for as long as it lasts and stops holding it the moment they
 * are back on the roster.
 * ======================================================================== */
function leaveSpan(member, now = Date.now()) {
    const m = member || {};
    if (String(m.status || '') !== 'loa') return null;
    const from = m.loaSince ? new Date(m.loaSince).getTime() : NaN;
    if (!Number.isFinite(from)) return null;
    const until = m.loaUntil ? new Date(m.loaUntil).getTime() : NaN;
    return { from, to: Number.isFinite(until) ? until : now };
}

/** Is that whole week inside the pilot's leave? Partly is not enough. */
function weekOnLeave(span, i) {
    if (!span) return false;
    return span.from <= weekStart(i).getTime() && span.to >= weekEnd(i).getTime() - 1;
}

/* ===========================================================================
 * THE SETTINGS
 *
 * EVERY DEFAULT IS THE INERT ONE, the same rule the shop's rates and the clubs'
 * benefits follow and for the same reason: deploying a file must not start
 * paying a bonus in three hundred airlines that did not ask for one.
 *
 * There is no `enabled` flag, deliberately, and the clubs are the precedent.
 * The streak itself costs nothing and is nobody's decision — it is a fact about
 * a pilot's logbook, it is true whether or not anyone is looking, and a pilot
 * who has flown eleven weeks running should be able to see that they have. What
 * a VA turns on is what it PAYS, and that is `perWeek` and `milestones`, both
 * of which are nothing until somebody sets them.
 * ======================================================================== */

/** One milestone, bounded: a week to reach and what reaching it pays. */
const normalizeMilestone = (m) => ({
    weeks: int(m && m.weeks, 1, MAX_WEEKS, 1),
    bonus: int(m && m.bonus, 0, MAX_MILESTONE_PAY, 0),
});

/**
 * A VA's streak settings, bounded.
 *
 * Milestones are sorted and de-duplicated by week: two set at twelve weeks is
 * one milestone whose value nobody can predict, and the higher payment is kept
 * because that is the one a VA meant.
 */
function normalize(cfg) {
    const c = cfg || {};
    const rows = Array.isArray(c.milestones) ? c.milestones : [];
    const byWeek = new Map();
    for (const row of rows.slice(0, MAX_MILESTONES * 2)) {
        const m = normalizeMilestone(row);
        const had = byWeek.get(m.weeks);
        if (!had || m.bonus > had.bonus) byWeek.set(m.weeks, m);
    }
    return {
        perWeek: int(c.perWeek, 0, MAX_PER_WEEK, 0),
        maxBonus: int(c.maxBonus, 0, MAX_BONUS, 0),
        freezeOnLeave: c.freezeOnLeave === undefined ? true : !!c.freezeOnLeave,
        milestones: [...byWeek.values()]
            .sort((a, b) => a.weeks - b.weeks)
            .slice(0, MAX_MILESTONES),
    };
}

const fromRecord = (rec) => normalize(rec);

/**
 * A patch from the back office, merged over what is saved.
 *
 * A merge for the two numbers and a REPLACE for the milestones, which is the
 * same split crewShop.toRecord and crewClubs.toRecord make between them: the
 * rate fields arrive one at a time from a form, and the milestone list arrives
 * whole from a screen that draws all of it — a merge there would make "delete a
 * milestone" impossible to express.
 */
function toRecord(patch, current) {
    const now = fromRecord(current);
    const p = patch || {};
    return normalize({
        perWeek: p.perWeek === undefined ? now.perWeek : p.perWeek,
        maxBonus: p.maxBonus === undefined ? now.maxBonus : p.maxBonus,
        freezeOnLeave: p.freezeOnLeave === undefined ? now.freezeOnLeave : p.freezeOnLeave,
        milestones: p.milestones === undefined ? now.milestones : p.milestones,
    });
}

/** True where this VA's streaks actually give a pilot anything. */
const pays = (cfg) => {
    const c = normalize(cfg);
    return !!(c.perWeek && c.maxBonus) || c.milestones.some((m) => m.bonus > 0);
};

/* ===========================================================================
 * WHERE A PILOT STANDS
 * ======================================================================== */

/**
 * One pilot's streak, worked out from their logbook.
 *
 * `weeks` counts weeks that are FLOWN. A week skipped because the pilot was on
 * leave is neither counted nor allowed to break the run — a freeze is not a
 * reward, it is the absence of a punishment.
 *
 * `endsAt` is the deadline: the instant the streak lapses if nothing else is
 * flown. Flying this week moves it to the end of NEXT week, which is why a
 * pilot who has already flown is shown a date eight days out and one who has
 * not is shown this Sunday.
 */
function streakFrom(flights, { now = Date.now(), member = null, freezeOnLeave = true } = {}) {
    const weeks = weeksFlown(flights);
    const here = weekIndex(now);
    const span = freezeOnLeave ? leaveSpan(member, now) : null;
    const frozen = (i) => weekOnLeave(span, i);

    // The current week never breaks a streak — it is not over. Start the walk
    // at the last week that IS over unless something has already been flown in
    // this one.
    let cursor = weeks.has(here) ? here : here - 1;
    const floor = here - MAX_WEEKS;
    let count = 0;
    while (cursor > floor) {
        if (weeks.has(cursor)) { count++; cursor--; continue; }
        if (frozen(cursor)) { cursor--; continue; }
        break;
    }

    const flownThisWeek = weeks.has(here);
    // Held while they are on leave: the deadline is not a real date for
    // somebody who has told us they are not flying, and printing one would be
    // the bad news the freeze exists to prevent.
    const onLeave = frozen(here);
    return {
        weeks: count,
        flownThisWeek,
        onLeave,
        // Nothing to lose is not the same as about to lose something.
        atRisk: count > 0 && !flownThisWeek && !onLeave,
        endsAt: weekEnd(flownThisWeek ? here + 1 : here),
        weekStartsAt: weekStart(here),
        longest: Math.max(count, longestRun(weeks)),
        totalWeeks: weeks.size,
    };
}

/** The longest run anywhere in this pilot's history, freezes ignored. */
function longestRun(weeks) {
    const all = [...weeks].sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    let last = null;
    for (const w of all) {
        run = last !== null && w === last + 1 ? run + 1 : 1;
        last = w;
        if (run > best) best = run;
    }
    return best;
}

/* ===========================================================================
 * WHAT IT IS WORTH
 * ======================================================================== */

/**
 * The percentage a streak of `weeks` adds to every flight.
 *
 * Linear and capped, because those are the two properties that make it legible:
 * a pilot can work out what next week is worth in their head, and they can see
 * where it stops. A curve would be neither.
 *
 * Zero at zero weeks and zero at one: a single week is not a streak, it is
 * having flown. The first step lands at two.
 */
function bonusFor(weeks, cfg) {
    const c = normalize(cfg);
    const n = Math.max(0, Math.round(Number(weeks) || 0));
    if (n < 2 || !c.perWeek || !c.maxBonus) return 0;
    return Math.min(c.maxBonus, c.perWeek * (n - 1));
}

/** The week at which the bonus stops climbing, or null where it never does. */
function capAt(cfg) {
    const c = normalize(cfg);
    if (!c.perWeek || !c.maxBonus) return null;
    return Math.ceil(c.maxBonus / c.perWeek) + 1;
}

/**
 * The milestone a flight has just crossed, if it crossed one.
 *
 * `before` is the streak without this flight and `after` the streak with it —
 * see the header for why that is the whole of the bookkeeping. A milestone
 * strictly above the one and at or below the other has just been reached.
 *
 * Where a single flight crosses two at once (a backdated approval can fill a
 * gap and jump a streak several weeks), the HIGHEST is paid and only the
 * highest. Paying both would be paying twice for one moment, and the highest is
 * the one the pilot will say they reached.
 */
function milestoneCrossed(before, after, cfg) {
    const c = normalize(cfg);
    const lo = Math.max(0, Math.round(Number(before) || 0));
    const hi = Math.max(0, Math.round(Number(after) || 0));
    if (hi <= lo) return null;
    const hit = c.milestones.filter((m) => m.bonus > 0 && m.weeks > lo && m.weeks <= hi);
    if (!hit.length) return null;
    return hit[hit.length - 1];
}

/** The next milestone above `weeks`, or null at the top of the list. */
function nextMilestone(weeks, cfg) {
    const c = normalize(cfg);
    const n = Math.max(0, Math.round(Number(weeks) || 0));
    return c.milestones.find((m) => m.bonus > 0 && m.weeks > n) || null;
}

/**
 * What a streak gives, in the shape a page prints it — the same contract
 * crewClubs.benefitsOf has, so a card can draw a club's benefits and a streak's
 * benefits from one loop.
 */
function benefitsOf(cfg, { weeks = null, short = 'pts' } = {}) {
    const c = normalize(cfg);
    const out = [];
    const cap = capAt(c);
    if (c.perWeek && c.maxBonus) {
        const held = weeks == null ? null : bonusFor(weeks, c);
        out.push({
            kind: 'streak',
            value: held == null ? c.perWeek : held,
            label: held == null
                ? `${c.perWeek}% more per week flown, up to ${c.maxBonus}%`
                : (held >= c.maxBonus
                    ? `${held}% more on every flight — the most a streak pays`
                    : `${held}% more on every flight, climbing to ${c.maxBonus}%`),
            detail: cap
                ? `Every week you fly adds ${c.perWeek}%. ${cap} weeks running is the most it pays.`
                : 'Added to whatever your flying already pays.',
        });
    }
    for (const m of c.milestones) {
        if (!m.bonus) continue;
        out.push({
            kind: 'milestone',
            value: m.bonus,
            weeks: m.weeks,
            label: `${m.bonus.toLocaleString()} ${short} at ${weeksText(m.weeks)}`,
            detail: 'Paid once, on the flight that gets you there.',
        });
    }
    return out;
}

/** Weeks, as a person says them. `4 weeks`, `a year`, `6 months`. */
function weeksText(n) {
    const w = Math.max(0, Math.round(Number(n) || 0));
    if (w === 1) return '1 week';
    if (w === 52) return 'a year';
    if (w === 26) return '6 months';
    if (w === 13) return '3 months';
    if (w && w % 52 === 0) return `${w / 52} years`;
    return `${w} weeks`;
}

/* ===========================================================================
 * WHAT TO OFFER A VA WHO HAS SET NONE OF THIS
 *
 * The same answer crewShop.suggestedItems gives to "what does a VA sell" and
 * crewClubs.suggestedBenefits gives to "what should Gold be worth": a worked
 * starting point, RETURNED rather than written, so a VA taps once and owns
 * ordinary settings they can edit like any other.
 *
 * PRICED IN FLIGHTS, not in points, for the reason the shelf suggestions are: a
 * VA paying 120 an hour and a VA paying 5 an hour are running the same economy
 * at different scales, and a fixed "1,500 at twelve weeks" means a fortnight to
 * one of them and a lifetime to the other. The unit is one ordinary flight —
 * crewShop.examplePay — so the milestones a VA is offered and the worked example
 * under their rates come from one number.
 *
 * THE FOUR WEEKS ARE A MONTH, A QUARTER, A HALF-YEAR AND A YEAR, because those
 * are the four lengths of time a person already has a feeling about. Eleven
 * weeks is not a milestone, it is a number.
 * ======================================================================== */
const SUGGESTED_MILESTONES = [
    { weeks: 4, flights: 1 },
    { weeks: 13, flights: 4 },
    { weeks: 26, flights: 10 },
    { weeks: 52, flights: 25 },
];

/** 3% a week to a 30% cap — eleven weeks running to reach the top of it. */
const SUGGESTED_PER_WEEK = 3;
const SUGGESTED_MAX_BONUS = 30;

/**
 * Sensible settings, priced against what this VA's own flights pay.
 *
 * A VA whose flights pay nothing yet gets the two percentages and milestones at
 * zero: a milestone priced from a rate of zero is zero, and offering a
 * meaningless number is worse than offering none. They set their rates first,
 * which is the screen this button sits under.
 */
function suggested(unitPay) {
    const unit = Math.max(0, Math.round(Number(unitPay) || 0));
    return normalize({
        perWeek: SUGGESTED_PER_WEEK,
        maxBonus: SUGGESTED_MAX_BONUS,
        freezeOnLeave: true,
        milestones: SUGGESTED_MILESTONES.map((m) => ({
            weeks: m.weeks,
            // Rounded to something a person would have typed. A milestone of
            // "1,387" reads as a bug in a way "1,400" does not.
            bonus: round2(unit * m.flights),
        })),
    });
}

/** To two significant figures, which is how people write prices. */
function round2(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 100) return v;
    const mag = Math.pow(10, String(v).length - 2);
    return Math.round(v / mag) * mag;
}

/* ===========================================================================
 * ON THE WIRE
 * ======================================================================== */

/**
 * One pilot's streak, as their own card draws it.
 *
 * Small on purpose, like crewClubs.memberClub: this is merged into payloads
 * that already carry a wallet and a club, and it must not double the size of a
 * response.
 */
function publicStreak(summary, cfg, { short = 'pts' } = {}) {
    const s = summary || {};
    const c = normalize(cfg);
    const weeks = Math.max(0, Math.round(Number(s.weeks) || 0));
    const next = nextMilestone(weeks, c);
    return {
        weeks,
        longest: Math.max(weeks, Math.round(Number(s.longest) || 0)),
        totalWeeks: Math.max(0, Math.round(Number(s.totalWeeks) || 0)),
        flownThisWeek: !!s.flownThisWeek,
        atRisk: !!s.atRisk,
        onLeave: !!s.onLeave,
        endsAt: s.endsAt || null,
        // What they are getting for it right now, and what the next step adds.
        bonus: bonusFor(weeks, c),
        nextBonus: bonusFor(weeks + 1, c),
        maxBonus: c.maxBonus,
        capAt: capAt(c),
        next: next ? { weeks: next.weeks, bonus: next.bonus, away: next.weeks - weeks } : null,
        benefits: benefitsOf(c, { weeks, short }),
    };
}

/** The settings themselves, as staff see them. */
const publicSettings = (cfg, { short = 'pts' } = {}) => {
    const c = normalize(cfg);
    return { ...c, pays: pays(c), capAt: capAt(c), benefits: benefitsOf(c, { short }) };
};

module.exports = {
    MAX_PER_WEEK,
    MAX_BONUS,
    MAX_MILESTONES,
    MAX_MILESTONE_PAY,
    MAX_WEEKS,
    SUGGESTED_MILESTONES,
    SUGGESTED_PER_WEEK,
    SUGGESTED_MAX_BONUS,
    weekIndex,
    weekStart,
    weekEnd,
    weeksFlown,
    leaveSpan,
    weekOnLeave,
    normalize,
    fromRecord,
    toRecord,
    pays,
    streakFrom,
    longestRun,
    bonusFor,
    capAt,
    milestoneCrossed,
    nextMilestone,
    benefitsOf,
    weeksText,
    suggested,
    publicStreak,
    publicSettings,
};
