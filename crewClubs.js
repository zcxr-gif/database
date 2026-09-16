'use strict';

/*
 * crewClubs.js
 * What a pilot's flying earns them, and what that is worth.
 *
 * WHAT A CLUB IS, AND WHY IT IS NOT A RANK
 * ----------------------------------------
 * A VA already has a ladder: the rank ladder. It is the right shape for what it
 * does and the wrong shape for this, because a rank is something the AIRLINE
 * gives you. Staff sign off a check-ride, staff edit the hours, staff decide
 * you are a Captain. That is a job title, and it is a decision.
 *
 * A club is not a decision. It is a count. You fly, you cross a line, you are
 * in — nobody signs anything and nobody can forget to. That is why every real
 * airline runs both, why the two never collapse into one, and why this is a
 * second ladder rather than a coat of paint on the first.
 *
 * ON HOURS, because hours are the one number every VA on the platform already
 * has. Not on the shop's currency: a VA that has not turned the shop on has no
 * currency at all, and a club that only exists once you are running an economy
 * is a club most airlines would never see.
 *
 * WHAT A CLUB ACTUALLY GIVES
 * --------------------------
 * Three things, and every one of them is enforced on the server:
 *
 *   earnBonus    a percentage on top of what every approved flight pays. The
 *                strongest of the three because it compounds: a Gold pilot
 *                out-earns a Standard one on identical flying, which is the
 *                whole proposition of a frequent flyer scheme.
 *
 *   earlyHours   how long a newly stocked item is theirs alone. The shelf is
 *                the same shelf; they simply see it first. Deliberately a
 *                WINDOW rather than a permanent gate — a club-only item is a
 *                shelf split in two, where early access is one shelf that
 *                rewards you for being further up it.
 *
 *   priority     their orders sort to the front of the queue staff work. Costs
 *                the VA nothing, costs other pilots nothing, and is the single
 *                most-felt benefit in aviation.
 *
 * EVERY BENEFIT DEFAULTS TO NOTHING. The clubs themselves exist out of the box
 * — they are the finish on the pilot's card and they are cosmetic until asked
 * otherwise — but deploying a file must not start paying a 20% bonus in three
 * hundred airlines that did not ask for one. That is the same rule crewShop's
 * settings follow, for the same reason. `suggestedBenefits` is the answer to
 * "what should I put here", offered in the back office and never written
 * without a tap.
 *
 * NOTHING HERE TALKS TO A DATABASE. Handed a ladder and a number of hours, it
 * says which club that is and what it is worth. The I/O is in the routes.
 */

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const int = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt === undefined ? min : dflt;
    return Math.max(min, Math.min(max, n));
};

/* ===========================================================================
 * THE LADDER A VA STARTS WITH
 *
 * Five, and five is a decision. A club per rank would mean a twelve-rung
 * airline had twelve clubs, which is a palette rather than a progression —
 * nobody can tell the eighth from the ninth. Five steps are distinguishable at
 * a glance and they are what every airline in the world has converged on.
 *
 * The hours are the shape of a real VA's roster: most pilots in the first two,
 * a useful number in the middle, and a top that takes a year of genuine flying
 * to reach. A club everybody is in is not a club.
 *
 * The names are the ones a pilot already knows the meaning of without being
 * told, and a VA may rename all five.
 * ======================================================================== */
const DEFAULTS = [
    { key: 'standard', name: 'Standard', minHours: 0, color: '#4A5568' },
    { key: 'bronze', name: 'Bronze', minHours: 25, color: '#A4622B' },
    { key: 'silver', name: 'Silver', minHours: 100, color: '#7C8794' },
    { key: 'gold', name: 'Gold', minHours: 250, color: '#B8860B' },
    { key: 'platinum', name: 'Platinum', minHours: 500, color: '#2C3446' },
];

/** The most clubs a VA may run. See above — five is the shape, this is a wall. */
const MAX_CLUBS = 8;
/** The most a club may pay on top of a flight. A rate, not a lottery. */
const MAX_BONUS = 100;
/** The longest a shelf item may be held back for a club. Two weeks. */
const MAX_EARLY_HOURS = 336;

/**
 * A ladder in a known shape.
 *
 * Sorted by hours, junk dropped, and the bottom rung always at zero — a pilot
 * on their first day is in a club, because the alternative is somebody with no
 * club at all standing on a page that is entirely about clubs. That is the same
 * rule crewRanks applies to the bottom of the rank ladder and for the same
 * reason.
 *
 * An empty or absent list is the five above rather than nothing. A VA that has
 * never opened this screen has clubs; what they do not have is benefits.
 */
function normalizeClubs(list) {
    const rows = Array.isArray(list) ? list : [];
    const clean = rows
        .filter((c) => c && str(c.name, 30))
        .slice(0, MAX_CLUBS)
        .map((c, i) => ({
            // Stable across a rename, because it is what an item's early-access
            // setting points at — a VA renaming "Gold" to "Emerald" must not
            // silently unlock everything that was waiting on it.
            key: str(c.key, 20).toLowerCase().replace(/[^a-z0-9]/g, '') || `club${i + 1}`,
            name: str(c.name, 30),
            minHours: int(c.minHours, 0, 100000, 0),
            color: str(c.color, 20),
            earnBonus: int(c.earnBonus, 0, MAX_BONUS, 0),
            earlyHours: int(c.earlyHours, 0, MAX_EARLY_HOURS, 0),
            priority: !!c.priority,
        }))
        .sort((a, b) => a.minHours - b.minHours);
    if (!clean.length) {
        return DEFAULTS.map((d) => ({ ...d, earnBonus: 0, earlyHours: 0, priority: false }));
    }
    // Two clubs with one key is one club with a name nobody can predict. The
    // later one is renamed rather than dropped: a VA who duplicated a row meant
    // to have two clubs.
    const seen = new Set();
    for (let i = 0; i < clean.length; i++) {
        let key = clean[i].key;
        let n = 2;
        while (seen.has(key)) key = `${clean[i].key}${n++}`;
        clean[i].key = key;
        seen.add(key);
    }
    // The bottom of the ladder is always reachable from zero hours.
    clean[0].minHours = 0;
    return clean;
}

const fromRecord = (rec) => normalizeClubs(rec);

/**
 * A ladder from the back office, bounded.
 *
 * A replace rather than a merge, because this arrives from one screen that
 * draws the whole ladder — and a merge would make "delete a club" impossible to
 * express.
 */
const toRecord = (list) => normalizeClubs(list);

/* ===========================================================================
 * WHERE A PILOT STANDS
 * ======================================================================== */

/** The club `hours` puts somebody in. Never null — see normalizeClubs. */
function clubFor(clubs, hours) {
    const ladder = normalizeClubs(clubs);
    const h = Math.max(0, Number(hours) || 0);
    let held = ladder[0];
    for (const c of ladder) { if (h >= c.minHours) held = c; else break; }
    return held;
}

/** Where that club sits. -1 for a club that is not on this ladder. */
function clubIndex(clubs, key) {
    const want = str(key, 20).toLowerCase();
    if (!want) return -1;
    return normalizeClubs(clubs).findIndex((c) => c.key === want);
}

/**
 * The next one up, and how far off it is.
 *
 * Null at the top, which is a real state and reads differently on a page: "you
 * are in the highest club" is an arrival, where an empty progress bar is a bug.
 */
function nextClub(clubs, hours) {
    const ladder = normalizeClubs(clubs);
    const h = Math.max(0, Number(hours) || 0);
    const up = ladder.find((c) => c.minHours > h);
    if (!up) return null;
    return { ...up, hoursAway: Math.max(0, Math.round((up.minHours - h) * 10) / 10) };
}

/**
 * Does a club at `key` sit at or above `needKey` on this ladder?
 *
 * Open when nothing is required, and — deliberately — open when the required
 * club is not on the ladder any more. A VA who deletes a club must not
 * accidentally lock every pilot out of a shelf; the failure mode has to be "the
 * gate lapses", not "the shop quietly closes". Same rule as crewRanks.meetsRank.
 */
function meetsClub(clubs, key, needKey) {
    const need = str(needKey, 20).toLowerCase();
    if (!need) return true;
    const ladder = normalizeClubs(clubs);
    const want = ladder.findIndex((c) => c.key === need);
    if (want < 0) return true;
    const at = ladder.findIndex((c) => c.key === str(key, 20).toLowerCase());
    return at >= want;
}

/**
 * What a member looks like once the ladder has been applied.
 *
 * Small on purpose: this is merged into payloads every surface already receives
 * — the wallet, the roster, the crew list — so it must not double the size of a
 * response for two hundred pilots.
 */
function memberClub(clubs, hours) {
    const ladder = normalizeClubs(clubs);
    const held = clubFor(ladder, hours);
    const at = ladder.findIndex((c) => c.key === held.key);
    const up = nextClub(ladder, hours);
    return {
        key: held.key,
        name: held.name,
        // 0-based, with `of` beside it, so a card can draw the ladder as pips
        // without knowing how many clubs this airline runs.
        index: at < 0 ? 0 : at,
        of: ladder.length,
        color: held.color || '',
        minHours: held.minHours,
        // What they actually get. Sent with the club rather than looked up
        // separately, because a badge that names a club and a list that names
        // its benefits are two things that must never disagree.
        benefits: benefitsOf(held),
        next: up ? {
            key: up.key, name: up.name, minHours: up.minHours, hoursAway: up.hoursAway,
            // What crossing that line is actually worth — the only part of
            // "247 hours to Gold" that makes anybody fly another leg.
            benefits: benefitsOf(up),
        } : null,
    };
}

/* ===========================================================================
 * WHAT A CLUB IS WORTH
 * ======================================================================== */

/** The three, in the shape a page prints them. Empty where a club gives none. */
function benefitsOf(club) {
    const c = club || {};
    const out = [];
    const bonus = int(c.earnBonus, 0, MAX_BONUS, 0);
    const early = int(c.earlyHours, 0, MAX_EARLY_HOURS, 0);
    if (bonus) {
        out.push({
            kind: 'earn',
            value: bonus,
            label: `${bonus}% more on every flight`,
            detail: 'Added to whatever your flying already pays, on every approved report.',
        });
    }
    if (early) {
        out.push({
            kind: 'early',
            value: early,
            label: early >= 48 ? `${Math.round(early / 24)} days' early access to the shop`
                : `${early}h early access to the shop`,
            detail: 'Anything new on the shelf is yours first.',
        });
    }
    if (c.priority) {
        out.push({
            kind: 'priority',
            value: 1,
            label: 'Your orders are handled first',
            detail: 'They sort to the front of the queue your staff work through.',
        });
    }
    return out;
}

/** True where any club on this ladder actually gives something. */
const hasBenefits = (clubs) => normalizeClubs(clubs).some((c) => c.earnBonus || c.earlyHours || c.priority);

/**
 * What one approved flight pays, once the pilot's club is taken into account.
 *
 * A multiplier on the base rather than a flat addition: the rates are the VA's
 * statement of what flying is worth, and a club says "your flying is worth more"
 * — which is a percentage, not a tip.
 *
 * Rounded once, at the end. Rounding the base and then the bonus loses a point
 * on most flights and is the kind of arithmetic pilots notice and nobody can
 * explain.
 */
function payWithClub(base, club) {
    const amount = Math.max(0, Math.round(Number(base) || 0));
    const bonus = int(club && club.earnBonus, 0, MAX_BONUS, 0);
    if (!amount || !bonus) return amount;
    return Math.round(amount * (1 + bonus / 100));
}

/* ===========================================================================
 * EARLY ACCESS
 *
 * The one benefit that has to answer a question about a specific thing at a
 * specific moment, so it is a function rather than a number.
 *
 * WHAT IT IS NOT: a club-only item. A shelf split into "yours" and "not yours"
 * is two shelves, and the half a pilot cannot buy is a wall with prices on it.
 * A window is one shelf that rewards you for being further up it, and the thing
 * a Standard pilot sees is "opens to everyone in two days" — which is an
 * argument for flying, where a locked row is an argument for leaving.
 *
 * IT APPLIES TO NEW STOCK ONLY, measured from when the item was added. A VA
 * whose whole shelf is a year old changes nothing by turning this on; the next
 * thing they add is what their Gold pilots get first. That is the correct
 * behaviour and it is why this reads `createdAt` rather than a column somebody
 * would have to set per item.
 * ======================================================================== */

/** The longest window any club on this ladder is given. 0 where none is. */
const longestOf = (ladder) => ladder.reduce((n, c) => Math.max(n, c.earlyHours || 0), 0);

/**
 * When an item opens to everybody, given the ladder.
 *
 * The window is the LONGEST any club is given, because that is the only reading
 * that makes sense: if Gold gets 24h and Platinum 48h, the item is held back
 * for 48 hours, and Gold joins after 24. Null when no club is given early
 * access at all, which is every VA until one asks.
 */
function opensAt(clubs, item) {
    const longest = longestOf(normalizeClubs(clubs));
    if (!longest) return null;
    const added = item && (item.createdAt || item.created_at);
    const t = added ? new Date(added).getTime() : NaN;
    if (!Number.isFinite(t)) return null;
    return new Date(t + longest * 3600000);
}

/**
 * May a pilot in `clubKey` see and buy this item yet?
 *
 * Returns a reason rather than a boolean, because every caller needs one: the
 * shelf draws a chip saying when it opens, and the buy route refuses with a
 * sentence. A single `false` would have both of them inventing their own.
 *
 * Staff pass `canManage` and are never held back — they stock the shelf, and a
 * VA unable to see what they just added would file it as a bug.
 */
function accessTo(clubs, item, { clubKey = '', hours = null, canManage = false, now = Date.now() } = {}) {
    const open = { open: true, early: false, opensAt: null, needs: null };
    if (canManage) return open;
    const opens = opensAt(clubs, item);
    if (!opens) return open;
    const at = opens.getTime();
    if (now >= at) return open;

    const ladder = normalizeClubs(clubs);
    const added = new Date(item.createdAt || item.created_at).getTime();
    // Their own club's window, when they are in one that has any.
    const key = str(clubKey, 20).toLowerCase()
        || (hours == null ? '' : clubFor(ladder, hours).key);
    const mine = ladder.find((c) => c.key === key);
    if (mine && mine.earlyHours && now >= added + (longestOf(ladder) - mine.earlyHours) * 3600000) {
        return { open: true, early: true, opensAt: opens, needs: null };
    }
    // Shut. Name the lowest club that could have it now, so the chip says
    // something a pilot can act on rather than only "not yet".
    const needs = ladder
        .filter((c) => c.earlyHours && now >= added + (longestOf(ladder) - c.earlyHours) * 3600000)
        .sort((a, b) => a.minHours - b.minHours)[0] || null;
    return { open: false, early: false, opensAt: opens, needs: needs ? { key: needs.key, name: needs.name, minHours: needs.minHours } : null };
}


/* ===========================================================================
 * WHAT TO OFFER A VA WHO HAS NOT SET ANY OF THIS
 *
 * The same answer crewShop.suggestedItems gives to "what does a virtual airline
 * sell": a worked starting point, returned rather than written, so a VA taps
 * once and owns an ordinary ladder they can edit like any other.
 *
 * The numbers climb but do not run away. 20% at the top is a real advantage
 * that a Standard pilot can still see past; 50% would make the first four
 * clubs feel like a punishment for not having flown yet.
 * ======================================================================== */
const SUGGESTED = [
    { earnBonus: 0, earlyHours: 0, priority: false },
    { earnBonus: 5, earlyHours: 0, priority: false },
    { earnBonus: 10, earlyHours: 0, priority: false },
    { earnBonus: 15, earlyHours: 24, priority: true },
    { earnBonus: 20, earlyHours: 48, priority: true },
];

/**
 * The ladder a VA has, with a sensible set of benefits written onto it.
 *
 * Keyed by POSITION rather than by name: a VA that has renamed its clubs, added
 * a sixth or deleted one still gets an offer that climbs in the right order.
 * The bottom club always gets nothing — a benefit everybody has is not a
 * benefit, it is a rate change.
 */
function suggestedBenefits(clubs) {
    const ladder = normalizeClubs(clubs);
    const n = ladder.length;
    return ladder.map((c, i) => {
        if (i === 0 || n === 1) return { ...c, earnBonus: 0, earlyHours: 0, priority: false };
        // Spread the five suggestions across however many clubs there are, so
        // the top club always lands on the top offer.
        const at = Math.round((i / (n - 1)) * (SUGGESTED.length - 1));
        return { ...c, ...SUGGESTED[Math.max(1, Math.min(SUGGESTED.length - 1, at))] };
    });
}

/** One club, as any caller may see it. */
const publicClub = (c) => ({
    key: c.key,
    name: c.name,
    minHours: c.minHours,
    color: c.color || '',
    earnBonus: c.earnBonus || 0,
    earlyHours: c.earlyHours || 0,
    priority: !!c.priority,
    benefits: benefitsOf(c),
});

module.exports = {
    DEFAULTS,
    MAX_CLUBS,
    MAX_BONUS,
    MAX_EARLY_HOURS,
    SUGGESTED,
    normalizeClubs,
    fromRecord,
    toRecord,
    clubFor,
    clubIndex,
    nextClub,
    meetsClub,
    memberClub,
    benefitsOf,
    hasBenefits,
    payWithClub,
    opensAt,
    accessTo,
    suggestedBenefits,
    publicClub,
};
