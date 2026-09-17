'use strict';

/*
 * crewShop.js
 * What a flight is worth, and what a pilot spends it on.
 *
 * WHAT LIVES HERE
 * ---------------
 * The rules, and nothing that talks to a database. Two of them:
 *
 *   SETTINGS   a VA's shop is off until they turn it on; they name their own
 *              currency and set their rates. Normalizing that is this file's
 *              job, because the numbers arrive from a form and a rate of 1e9 is
 *              a VA's typo, not a decision.
 *
 *   EARNING    what one approved flight pays, line by line. One function, used
 *              by both doors into approval (a staff member pressing the button,
 *              and the auto-approve rule in the PIREP sweep), so the two cannot
 *              drift — and used again by the screen that explains a payment to
 *              the pilot who got it, so the explanation cannot drift from the
 *              payment either.
 *
 * The arithmetic that MOVES a balance is deliberately not here: it is in the
 * VA's own database, in crew_shop_buy and crew_shop_credit, because a debit
 * that re-reads the price and tests the balance in the same statement is the
 * only kind that cannot be raced. This file decides what a flight is worth; the
 * database decides whether a pilot can afford something.
 *
 * WHY THE SETTINGS ARE NOT IN THE VA'S PROJECT
 * -------------------------------------------
 * They sit on the VA record next to the rank ladder, the fleet and the join
 * requirements — all the same class of thing: a handful of fields a VA sets
 * once, that the crew center reads before it has a session, and that the
 * dashboard needs in order to decide whether to draw a Shop tile at all. A row
 * in the VA's Postgres would mean a round trip to somebody else's database to
 * answer "is there a shop?" on every page load.
 */

/* ===========================================================================
 * THE RATES, IN THE ORDER THE BACK OFFICE DRAWS THEM
 *
 * The shop shipped with four: an hourly rate, a per-landing rate, a bonus for
 * flying the airline's own aircraft, and a penalty per violation. That is a
 * complete economy and it is a thin one, because three of the four are the same
 * sentence — "you flew, here is some money" — and the fourth is a fine. Nothing
 * in it could say that one flight was worth more to the airline than another.
 *
 * Every rate added here answers that, and each one is a thing a VA actually
 * asks its pilots to do:
 *
 *   per100Nm     the long haul. An hourly rate already pays for time, but a
 *                nine-hour sector is a different commitment from six ninety
 *                minute hops, and distance is the only number that says so.
 *                Per HUNDRED miles rather than per mile, because a rate a VA
 *                types as "12" and gets 60,000 from is a rate they typed
 *                wrong.
 *   routeBonus   flying the network the VA actually built, rather than any two
 *                airports. The single most common thing a VA wants and has
 *                never had a lever for.
 *   scheduleBonus  turning up for a rostered departure they booked a seat on.
 *   eventBonus   flying the group flight. The back office has offered this
 *                field since the shop shipped and nothing has ever paid it —
 *                see the note on earnFor.
 *   featuredBonus  flying the route of the week or the route of the day. The
 *                half of crewFeatured that was a suggestion with nothing
 *                behind it.
 *   cleanBonus   landing it with no violations. The mirror of the penalty, and
 *                the more useful half: a penalty punishes the bad flight, a
 *                clean bonus is a reason to fly the good one.
 *
 * EVERY ONE OF THEM DEFAULTS TO ZERO, so a VA that has run this shop for a year
 * sees exactly the economy they had until they open the screen and change it.
 * That is the same rule the original four follow.
 *
 * THEY ARE ALL PAID THROUGH THE FLIGHT, which is the rule the whole economy is
 * built on: an approved flight report is the only currency supply this product
 * has, because a second one is unauditable and every VA that has hand-rolled an
 * economy has had the argument about it. Nothing here hands a pilot anything —
 * it decides what a flight was worth.
 * ======================================================================== */
const RATES = [
    'perHour', 'perLanding', 'per100Nm',
    'fleetBonus', 'routeBonus', 'scheduleBonus', 'eventBonus', 'featuredBonus', 'cleanBonus',
    'violationPenalty',
];

const int = (v, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
};
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * The ceiling on any one rate.
 *
 * It is not a policy about how much a VA may pay; it is the difference between
 * a typo and a balance nobody can ever spend.
 */
const MAX_RATE = 1e5;

/**
 * The VA's shop settings, bounded.
 *
 * Every default is the inert one. A VA that has never opened this screen gets a
 * shop that is off, pays nothing and is called "Points" — because the
 * alternative is that deploying this file starts an economy in three hundred
 * airlines that did not ask for one.
 */
function normalizeSettings(cfg) {
    const c = cfg || {};
    const cur = c.currency || {};
    const earn = c.earn || {};
    return {
        enabled: !!c.enabled,
        currency: {
            name: str(cur.name, 24) || 'Points',
            short: str(cur.short, 6) || 'pts',
        },
        // Bounded one way, from one list: a rate added to RATES above is a rate
        // that is normalized, saved and paid, and there is no second place to
        // forget to add it. That is not tidiness — `eventBonus` spent two
        // releases in the back office being typed, saved and silently dropped
        // by a normalizer that listed the four rates it knew by hand.
        earn: RATES.reduce((out, k) => {
            out[k] = int(earn[k], 0, MAX_RATE);
            return out;
        }, {}),
    };
}

/**
 * The VA record's shop field, in the shape the rest of this file works in.
 *
 * The record stores the numbers flat (`currencyName`, `perHour`, …) and
 * everything else here reads them nested, because nested is the shape the panel
 * sends and the shape a reader can see the structure of. One adapter each way,
 * in the one file that knows both, rather than the nesting leaking into every
 * caller.
 *
 * The rates are lifted off the record BY NAME FROM `RATES` for the reason
 * normalizeSettings bounds them that way: one list, so a rate cannot exist in
 * the schema, be typed in the back office, and then be dropped on the floor by
 * an adapter nobody remembered to extend.
 */
const fromRecord = (rec) => normalizeSettings(rec && {
    enabled: rec.enabled,
    currency: { name: rec.currencyName, short: rec.currencyShort },
    earn: RATES.reduce((out, k) => { out[k] = rec[k]; return out; }, {}),
});

/**
 * A patch from the back office, merged over what is saved and flattened back.
 *
 * A merge rather than a replace: the settings screen saves the rates and the
 * currency together but turns the shop off on its own, and a replace would have
 * "turn it off" quietly reset every rate to zero.
 */
function toRecord(patch, current) {
    const now = fromRecord(current);
    const p = patch || {};
    const next = normalizeSettings({
        enabled: p.enabled === undefined ? now.enabled : p.enabled,
        currency: { ...now.currency, ...(p.currency || {}) },
        earn: { ...now.earn, ...(p.earn || {}) },
    });
    return RATES.reduce((out, k) => {
        out[k] = next.earn[k];
        return out;
    }, {
        enabled: next.enabled,
        currencyName: next.currency.name,
        currencyShort: next.currency.short,
    });
}

/* ===========================================================================
 * WHAT A FLIGHT IS WORTH
 *
 * One function builds the LINES — what each rate contributed and why — and
 * everything else in the product reads its total. That shape is deliberate and
 * it replaces an `earnFor` that returned a bare number.
 *
 * A bare number is fine right up until somebody asks the only question pilots
 * actually ask about a shop, which is "why did that flight pay 412?". With four
 * rates a staff member could work it out on paper. With ten of them, a club
 * bonus and a streak on top, nobody can — and an economy whose payments cannot
 * be explained is one every VA eventually turns off.
 *
 * So the explanation is not a second implementation for the UI to draw. It is
 * the SAME arithmetic, and the total is the sum of the lines the pilot is
 * shown. Two copies of a rule are two rules eventually; this file already
 * exists because approving by hand and approving by rule must price a flight
 * identically.
 * ======================================================================== */

/** What each rate is called where a pilot reads it, and what triggers it. */
const LINES = [
    { key: 'perHour', label: 'Flight time', per: (p) => Math.max(0, Number(p.durationMin) || 0) / 60 },
    { key: 'perLanding', label: 'Landings', per: (p) => Math.max(0, Number(p.landings) || 0) },
    { key: 'per100Nm', label: 'Distance', per: (p) => Math.max(0, Number(p.distanceNm) || 0) / 100 },
    { key: 'fleetBonus', label: 'Flown in your fleet', per: (p) => (p.inFleet ? 1 : 0) },
    { key: 'routeBonus', label: 'On the route network', per: (p) => (p.routeId ? 1 : 0) },
    { key: 'scheduleBonus', label: 'A rostered departure', per: (p) => (p.scheduleId ? 1 : 0) },
    /* EVENTS PAY, AND THEY PAY THROUGH THE FLIGHT.
     *
     * Every VA wants its group flights to be worth turning up to, and the
     * obvious way to do that — a button that hands out points for attendance —
     * is the one thing this economy does not have and must not get.
     *
     * So an event pays the way everything else does: the pilot flies it, files
     * it, a staff member approves it, and the approval carries this on top.
     * Signing up and not flying pays nothing, which is also the honest answer.
     *
     * This rate has been in the back office since the shop shipped. It was
     * never in the normalizer, so it was typed, saved to the VA record, and
     * dropped on the floor by fromRecord on the way back out — a VA could set
     * an event bonus, see it stick, and watch every event flight pay the plain
     * rate forever. See the note over RATES for the change that makes that
     * class of bug unrepresentable.
     */
    { key: 'eventBonus', label: 'Flown for an event', per: (p) => (p.eventId ? 1 : 0) },
    { key: 'featuredBonus', label: 'The featured route', per: (p) => (p.isFeatured ? 1 : 0) },
    /* The mirror of the penalty below, and the more useful half of it: a
     * penalty punishes a bad flight, where this is a reason to fly a good one.
     * A flight with no landings is not a clean flight, it is a flight that did
     * not finish — so it takes one. */
    {
        key: 'cleanBonus',
        label: 'No violations',
        per: (p) => ((Number(p.violations) || 0) === 0 && (Number(p.landings) || 0) > 0 ? 1 : 0),
    },
    { key: 'violationPenalty', label: 'Violations', sign: -1, per: (p) => Math.max(0, Number(p.violations) || 0) },
];

/**
 * What one approved flight pays, line by line, before club and streak.
 *
 * Hours are the flight's real duration rather than its credited hours: the two
 * are the same number everywhere in this product, and reading the minutes keeps
 * this honest for a report whose hours a staff member has edited by hand.
 *
 * `isFeatured` is the one input that is not on the report — a flight does not
 * know whether the route it flew is this week's pick, because that is a fact
 * about the airline on the day and crewFeatured owns it. The caller resolves it
 * and sets the flag; this file stays a function of its arguments.
 *
 * Floored at zero. A flight with more violations than it was worth pays
 * nothing; it does not take a pilot's existing balance off them, because a
 * penalty is a rate on the flight and not a fine on the account. The floor is
 * applied to the TOTAL rather than per line, so a VA can see the penalty that
 * swallowed a flight rather than a list that mysteriously sums to nothing.
 */
function earnLines(pirep, rates) {
    const r = normalizeSettings({ earn: rates }).earn;
    const p = pirep || {};
    const out = [];
    for (const line of LINES) {
        const rate = r[line.key] || 0;
        if (!rate) continue;
        const units = line.per(p);
        if (!units) continue;
        const amount = Math.round(rate * units) * (line.sign || 1);
        if (!amount) continue;
        out.push({ key: line.key, label: line.label, rate, units: Math.round(units * 100) / 100, amount });
    }
    return out;
}

/** The same sum as a single number — what the flight is worth on its own. */
function earnFor(pirep, rates) {
    const total = earnLines(pirep, rates).reduce((n, l) => n + l.amount, 0);
    return Math.max(0, Math.round(total));
}

/* ===========================================================================
 * AND WHAT THE PILOT IS WORTH
 *
 * Two multipliers sit on top of the flight: the pilot's club (crewClubs) and
 * their streak (crewStreaks). Neither is this file's business to work out — it
 * is handed the two percentages — but the ORDER they combine in is, because
 * that is a rule about money and it must have exactly one answer.
 *
 * THEY ADD, THEY DO NOT COMPOUND. 20% from Gold and 30% from a streak is 50%,
 * not 56%. Compounding is the shape nobody can do in their head, and it makes
 * the value of a club depend on something that has nothing to do with clubs.
 *
 * ROUNDED ONCE, AT THE END. Rounding the base, then the club, then the streak
 * loses a point on most flights, and it is the kind of arithmetic pilots notice
 * and nobody can explain.
 * ======================================================================== */

/**
 * The whole payment for one approved flight, with its working shown.
 *
 * `milestone` is a one-off that rides on this flight rather than a rate on it —
 * a streak milestone is the only thing in the economy that is not proportional
 * to the flying — so it is added after the multipliers rather than multiplied
 * by them. A pilot who crosses a year of flying gets what the VA said a year is
 * worth, not that plus a percentage of it.
 */
function payFor(pirep, rates, { clubName = '', clubPercent = 0, streakWeeks = 0, streakPercent = 0, milestone = null } = {}) {
    const lines = earnLines(pirep, rates);
    const base = Math.max(0, Math.round(lines.reduce((n, l) => n + l.amount, 0)));
    const club = Math.max(0, Math.round(Number(clubPercent) || 0));
    const streak = Math.max(0, Math.round(Number(streakPercent) || 0));
    const withBonus = Math.round(base * (1 + (club + streak) / 100));

    const extras = [];
    // Split back out for display, so the two bonuses can be shown separately
    // even though they were applied together. Attributed proportionally, with
    // the club taking the rounding remainder: one line has to, and the club is
    // the older and the more visible of the two.
    const uplift = withBonus - base;
    const streakShare = club + streak > 0 ? Math.round((uplift * streak) / (club + streak)) : 0;
    if (club) {
        extras.push({
            key: 'club', label: clubName ? `${clubName} bonus` : 'Club bonus',
            rate: club, units: 1, amount: uplift - streakShare,
        });
    }
    if (streak) {
        extras.push({
            key: 'streak', label: `${streakWeeks}-week streak`,
            rate: streak, units: 1, amount: streakShare,
        });
    }
    const bonus = Math.max(0, Math.round(Number(milestone && milestone.bonus) || 0));
    if (bonus) {
        extras.push({
            key: 'milestone',
            label: `${milestone.weeks} weeks running`,
            rate: bonus, units: 1, amount: bonus,
        });
    }
    return {
        lines: lines.concat(extras),
        base,
        clubPercent: club,
        streakPercent: streak,
        milestone: bonus ? { weeks: milestone.weeks, bonus } : null,
        total: Math.max(0, withBonus + bonus),
    };
}

/**
 * The worked example under the rates, computed the same way a real flight is.
 * The back office draws its own copy as the rates are typed; this is the
 * server's, so the sentence a VA reads before saving and the sum they get
 * afterwards come from one function.
 *
 * An ordinary in-fleet leg off the airline's own network: 2h 15m, one landing,
 * 980nm, clean. It has to exercise the bonuses to be worth printing — an
 * example that ignores six of the ten rates would tell a VA their new distance
 * rate changed nothing.
 */
const exampleFlight = {
    durationMin: 135, landings: 1, violations: 0, inFleet: true,
    distanceNm: 980, routeId: 'example',
};
const examplePay = (rates) => earnFor(exampleFlight, rates);

/* ===========================================================================
 * THE SHELF A VA STARTS WITH
 *
 * A shop with nothing in it is not a shop, and that is what every VA got: the
 * back office drew "Nothing yet." and a blank form with a name, a price and a
 * number of things in stock. Those are the easy three. The hard question, and
 * the one that actually stops somebody, is WHAT DOES A VIRTUAL AIRLINE SELL —
 * there is no warehouse, nothing ships, and a pilot who has flown forty hours
 * cannot be handed anything physical.
 *
 * So this is the answer to that question, written down: a dozen things a VA
 * can really give a pilot, every one of them deliverable by a staff member
 * reading the orders queue and doing something they can already do.
 *
 * THEY ARE SUGGESTIONS AND THEY ARE NOT SEEDED
 * --------------------------------------------
 * Nothing here is written into anybody's shelf. A VA taps one and it becomes an
 * ordinary item they own, edit and price like any other; a VA that wants none
 * of them never sees a row they did not put there. That is the same rule the
 * settings above follow and for the same reason — deploying a file must not
 * start an economy in three hundred airlines that did not ask for one — and it
 * is why this exports a function that RETURNS a catalogue rather than anything
 * that writes one.
 *
 * PRICED IN FLIGHTS, NOT IN POINTS
 * --------------------------------
 * The interesting decision. A fixed price is wrong for everybody: a VA paying
 * 120 an hour and a VA paying 5 an hour are running the same economy at
 * different scales, and "1,500" means a fortnight of flying to one of them and
 * a lifetime to the other. A suggestion priced in somebody else's currency is
 * worse than no suggestion, because it looks like advice.
 *
 * So each entry carries what it should cost in TYPICAL FLIGHTS, and the price
 * is worked out from the VA's own rates when the catalogue is read. `flights:
 * 8` means "about eight flights' worth", and it means that at any rate the VA
 * ever sets. The unit is examplePay above — the same 2h 15m in-fleet flight the
 * back office shows its worked example for — so the sentence a VA reads under
 * the rates and the prices they are offered come from one function.
 *
 * WHAT EARNED A PLACE
 * -------------------
 * Three tests, and a thing had to pass all of them:
 *
 *   1. A staff member can deliver it today. No new backend, no new column, no
 *      integration. Everything here is something a VA already does — rename a
 *      tail number, add a route, hand out a Discord role — just now in response
 *      to an order rather than a direct message.
 *   2. A pilot actually wants it. Status, a say in how the airline flies, or
 *      being seen. Those are what people fly for once the hours stop being the
 *      point.
 *   3. It cannot be bought twice into nonsense. Anything that would be absurd
 *      to hold two of carries its own limit, and anything genuinely scarce
 *      carries stock.
 *
 * `group` is the shelf it sits on in the picker, so the suggestions read as a
 * handful of short lists rather than one long one.
 *
 * AND `tier` IS HOW LOUDLY IT IS DRAWN
 * -----------------------------------
 * The shelf shipped as one grid of identical tiles, which is the right shape
 * for a shop where everything costs about the same and the wrong one for this
 * one. The three things on it a pilot will actually talk about in a Discord —
 * their own livery, the month they were the crew centre's hero, the route they
 * put on the network — were the same 180px card as "a line in the next NOTAM",
 * and the effect was that a shelf of genuinely good things read as a list of
 * odds and ends.
 *
 *   standard   an ordinary tile. Most of the shelf, and the default, so a VA
 *              that never touches this sees the shop they already had.
 *   showcase   a thing whose whole value is that other people can see it.
 *              Drawn wide, with room for the art, because a badge nobody
 *              notices on the shelf is a badge nobody buys.
 *   flagship   a thing that changes the AIRLINE rather than the pilot. Drawn
 *              as a full-width band at the top of the shelf with the price in
 *              it, because there are never more than a few and each one is a
 *              month of somebody's flying.
 *
 * WHAT A FLAGSHIP IS, AND WHY IT IS NEW
 * -------------------------------------
 * Every original suggestion is something a pilot buys FOR THEMSELVES. That is
 * the obvious half of the answer and it is the smaller half: what a pilot who
 * has flown two hundred hours at one airline actually wants is not another
 * badge, it is to have changed the airline. An aircraft type in the fleet that
 * is there because they bought it. A base the airline flies out of because
 * they opened it. An event with their name on it.
 *
 * Every one of those passes the same three tests as the rest of this list:
 * staff can deliver it today with the tools already in this product (the fleet
 * editor, the route network, the events calendar, the accent picker, the
 * banner), a pilot obviously wants it, and it carries stock so it cannot be
 * bought into nonsense. They are priced where they are — fifty to a hundred and
 * fifty flights — because a thing the whole airline lives with should cost
 * roughly what it is worth to the person who has flown that much.
 * ======================================================================== */
const CATALOGUE = [
    /* IDENTITY — what a pilot is called and what they fly as. The cheapest
       things on this list and the ones that get bought first, because they are
       the ones that show up in a screenshot. */
    {
        id: 'badge',
        tier: 'showcase',
        group: 'Identity',
        name: 'A badge on your profile',
        desc: 'A mark beside your name on the roster and your crew profile. Yours to keep.',
        icon: 'shield',
        flights: 3,
        // No limit: a badge is a collectable, and a pilot with four of them is
        // a pilot who has been here a while rather than a bug.
        limitPerPilot: 0,
    },
    {
        id: 'callsign',
        tier: 'showcase',
        group: 'Identity',
        name: 'Your own callsign',
        desc: 'Reserve a flight number that is yours. Nobody else on the roster files it.',
        icon: 'radio',
        flights: 8,
        limitPerPilot: 1,
    },
    {
        id: 'registration',
        tier: 'showcase',
        group: 'Identity',
        name: 'A tail number of your choosing',
        desc: 'Pick the registration on one of the airline’s aircraft. It goes on the fleet page under your name.',
        icon: 'plane',
        flights: 20,
        // Genuinely scarce — there are only so many airframes, and a fleet page
        // where everyone has named one has stopped meaning anything.
        stock: 10,
        limitPerPilot: 1,
    },

    /* THE NETWORK — a say in where the airline flies. The expensive end, and
       the reason a long-haul pilot keeps flying after they have run out of
       ranks to reach. */
    {
        id: 'route',
        tier: 'showcase',
        group: 'The network',
        name: 'Name a route',
        desc: 'Nominate a sector. Staff add it to the network and it is flown as that week’s featured route.',
        icon: 'route',
        flights: 25,
        limitPerPilot: 1,
    },
    {
        id: 'livery',
        tier: 'showcase',
        group: 'The network',
        name: 'Request a livery',
        desc: 'Nominate a livery for the fleet. If it can be flown, it gets added and you fly it first.',
        icon: 'paintbrush',
        flights: 30,
        stock: 3,
        limitPerPilot: 1,
    },
    {
        id: 'destination',
        group: 'The network',
        name: 'Open a new destination',
        desc: 'Pick an airport the airline does not serve yet. Staff build the routes into it.',
        icon: 'map-pin',
        flights: 40,
        limitPerPilot: 1,
    },

    /* EVENTS — the things that are worth something precisely because only one
       pilot can have them. */
    {
        id: 'slot',
        group: 'Events',
        name: 'First pick of the gate',
        desc: 'Choose your gate and your aircraft on the next group flight before signups open.',
        icon: 'ticket',
        flights: 6,
        limitPerPilot: 0,
    },
    {
        id: 'lead',
        tier: 'showcase',
        group: 'Events',
        name: 'Lead the next group flight',
        desc: 'Fly as number one. Everybody else is behind you and the screenshots are of your aircraft.',
        icon: 'users',
        // One, because two is not a lead.
        stock: 1,
        flights: 15,
        limitPerPilot: 1,
    },

    /* PROGRESSION — time and attempts, which are the two things a pilot cannot
       get any other way. Neither of these buys a rank: they buy another go and
       a longer clock, and the standard is unchanged. */
    {
        id: 'checkride',
        group: 'Getting on',
        name: 'An extra check-ride attempt',
        desc: 'One more go at your next check ride without waiting out the usual gap. The ride itself is unchanged.',
        icon: 'clipboard-check',
        flights: 10,
        limitPerPilot: 2,
    },
    {
        id: 'leave',
        group: 'Getting on',
        name: 'Thirty more days of leave',
        desc: 'Extend your leave without losing your rank or your seniority. For when life happens.',
        icon: 'calendar-plus',
        flights: 12,
        limitPerPilot: 1,
    },

    /* RECOGNITION — being seen by the rest of the airline, which for a lot of
       pilots is the only thing on this list they actually want. */
    {
        id: 'feature',
        tier: 'showcase',
        group: 'Recognition',
        name: 'Featured on the website',
        desc: 'Your name and your card on the airline’s own website for a month.',
        icon: 'star',
        // One at a time, or it is not featuring anybody.
        stock: 1,
        flights: 18,
        limitPerPilot: 1,
    },
    {
        id: 'notam',
        group: 'Recognition',
        name: 'A line in the next NOTAM',
        desc: 'Say something to the whole airline. Staff read it before it goes out.',
        icon: 'megaphone',
        flights: 4,
        limitPerPilot: 0,
    },
    {
        id: 'hero',
        tier: 'showcase',
        group: 'Recognition',
        name: 'Your photograph as the crew centre hero',
        desc: 'Your screenshot across the top of the crew centre — the first thing every pilot sees when they sign in — for a month.',
        icon: 'image',
        flights: 22,
        // One at a time. Two heroes is a hero nobody had.
        stock: 1,
        limitPerPilot: 1,
    },
    {
        id: 'title',
        tier: 'showcase',
        group: 'Identity',
        name: 'A title of your own',
        desc: 'A line under your name on the roster and your crew profile that is yours and nobody else’s. Staff approve the wording.',
        icon: 'type',
        flights: 9,
        limitPerPilot: 1,
    },
    {
        id: 'wall',
        tier: 'showcase',
        group: 'Recognition',
        name: 'A place on the wall',
        desc: 'Your name written into the airline’s handbook, in the section that lists the people who built it. It does not come off.',
        icon: 'scroll',
        flights: 35,
        limitPerPilot: 1,
    },

    /* ============ FOR THE AIRLINE ============
       The other half of the answer, and the half nothing on this list used to
       cover: what a pilot wants after two hundred hours is not another badge,
       it is to have CHANGED THE AIRLINE. Everything here is delivered with a
       tool that is already in this product — the fleet editor, the route
       network, the events calendar, the accent picker — and everything here is
       scarce, because a fleet everybody has added an aircraft to is a fleet
       that means nothing. */
    {
        id: 'fleet',
        tier: 'flagship',
        group: 'For the airline',
        name: 'Put an aircraft in the fleet',
        desc: 'Choose a type the airline does not operate. Staff add it, the whole roster can fly it, and it is in the fleet because you bought it.',
        icon: 'plane-takeoff',
        flights: 60,
        stock: 3,
        limitPerPilot: 1,
    },
    {
        id: 'base',
        tier: 'flagship',
        group: 'For the airline',
        name: 'Open a new base',
        desc: 'Name an airport and the airline starts flying out of it — routes in, routes out, and your name on the announcement.',
        icon: 'tower-control',
        flights: 90,
        stock: 2,
        limitPerPilot: 1,
    },
    {
        id: 'event',
        tier: 'flagship',
        group: 'For the airline',
        name: 'An event with your name on it',
        desc: 'The whole airline flies a group flight you chose — the city pair, the aircraft, the date. Staff build and run it.',
        icon: 'calendar-heart',
        flights: 45,
        stock: 4,
        limitPerPilot: 1,
    },
    {
        id: 'fleetlivery',
        tier: 'flagship',
        group: 'For the airline',
        name: 'A livery for the whole fleet',
        desc: 'Your livery on every airframe the airline operates, for a season. Everybody flies it and everybody knows whose it is.',
        icon: 'spray-can',
        flights: 120,
        // One. A fleet in two liveries is a fleet in no livery.
        stock: 1,
        limitPerPilot: 1,
    },
    {
        id: 'colours',
        tier: 'flagship',
        group: 'For the airline',
        name: 'The airline’s colours, for a week',
        desc: 'The crew centre wears an accent you picked for seven days — the login, the buttons, every badge. Staff set it back afterwards.',
        icon: 'palette',
        flights: 50,
        stock: 2,
        limitPerPilot: 1,
    },
    {
        id: 'charter',
        tier: 'flagship',
        group: 'For the airline',
        name: 'Charter the airline',
        desc: 'One sector, your choice, flown by everybody who signs up, under a flight number that is yours. The biggest thing on this shelf.',
        icon: 'crown',
        flights: 150,
        stock: 1,
        limitPerPilot: 1,
    },
];

/**
 * A price that looks like a price.
 *
 * Eight flights at a rate of 325 is 2,600, which is arithmetic rather than a
 * price tag — and a shelf of them reads as a spreadsheet. Rounded to a step
 * that grows with the number, so small things land on fives and expensive
 * things land on hundreds, the way every real price list in the world does.
 *
 * Rounded UP, never down, and never to zero: a suggestion that undercuts the
 * effort it was meant to represent is the one mistake here that costs a VA
 * something, because it is their pilots' hours being sold cheap.
 */
function roundPrice(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v <= 0) return 0;
    const step = v < 100 ? 5 : v < 1000 ? 25 : v < 10000 ? 50 : 100;
    return Math.ceil(v / step) * step;
}

/* What one typical flight is assumed to be worth on a VA that has not set a
 * rate yet. Without it every suggestion prices at nothing, and a shelf of free
 * things is worse than an empty one: a pilot buys the lot in one go and the
 * economy is over before the VA has finished setting it up.
 *
 * It is a placeholder and it says so — the back office tells a VA the prices
 * are worked out from their rate, and the moment they set one these move. */
const NOMINAL_FLIGHT = 250;

/**
 * The catalogue, priced for one VA.
 *
 * Returns items in exactly the shape POST /shop/items takes, so the back office
 * hands one straight back rather than translating it — and the moment it is
 * saved it is an ordinary item the VA owns, with no trace of having come from
 * here. That is deliberate: a suggestion that stayed special would be a second
 * kind of shelf item to reason about forever.
 */
function suggestedItems(settings) {
    const s = normalizeSettings(settings);
    const perFlight = examplePay(s.earn) || NOMINAL_FLIGHT;
    return CATALOGUE.map(c => ({
        id: c.id,
        group: c.group,
        // How loudly the shelf draws it. See the note over CATALOGUE: a
        // suggestion that arrives as an ordinary tile when it is the most
        // interesting thing a VA sells is a suggestion nobody takes up.
        tier: TIERS.includes(c.tier) ? c.tier : 'standard',
        name: c.name,
        desc: c.desc,
        icon: c.icon,
        image: '',
        price: roundPrice(c.flights * perFlight),
        stock: c.stock === undefined ? -1 : c.stock,
        limitPerPilot: c.limitPerPilot || 0,
        active: true,
    }));
}

/** How loudly the shelf draws a thing. See the note over CATALOGUE. */
const TIERS = ['standard', 'showcase', 'flagship'];

/** The tier a stored item carries, bounded. Anything unrecognised — including
 *  the absent value every item written before this existed carries — is an
 *  ordinary tile, which is what those items already were. */
const tierOf = (v) => (TIERS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'standard');

/** One thing on the shelf, as any caller may see it. */
const publicItem = (i) => ({
    id: i._id,
    // The shelf a VA has sorted this onto. The client has grouped by it since
    // the shelf could hold twenty things; it has never been sent, so nobody
    // has ever seen a grouped shelf. Now it is.
    group: i.group || '',
    tier: tierOf(i.tier),
    name: i.name,
    desc: i.desc,
    image: i.image,
    icon: i.icon,
    price: i.price,
    stock: i.stock,
    limitPerPilot: i.limitPerPilot,
    active: i.active,
});

/**
 * One order.
 *
 * `pilotName` and `callsign` are filled in for staff only — a pilot reading
 * their own receipts already knows who they are, and a shop is not a place to
 * publish who bought what.
 */
const publicOrder = (o, { member = null, canManage = false } = {}) => ({
    id: o._id,
    itemName: o.itemName,
    price: o.price,
    status: o.status,
    code: o.code,
    createdAt: o.createdAt,
    decidedAt: o.decidedAt,
    ...(canManage ? {
        pilotName: (member && member.name) || '',
        callsign: (member && member.callsign) || '',
        decidedBy: o.decidedBy || '',
    } : {}),
});

/* ===========================================================================
 * THE CARD'S FINISH
 *
 * A card that looks the same on a pilot's first day and on their thousandth
 * hour is a card that stops being worth looking at. So the face changes as they
 * climb — and what it changes with is their CLUB, which lives in crewClubs.js.
 *
 * WHY NOT THE RANK. The first cut of this keyed the finish to the rank ladder,
 * and that was wrong for a reason worth writing down: a rank is something the
 * airline GIVES you. Staff sign off a check-ride, staff edit hours, staff
 * decide you are a Captain — so a card painted by it changes when somebody
 * remembers to promote you. A club is a line you crossed by flying. Nobody has
 * to apply it, nobody can forget to, and it is what the card is actually about.
 *
 * SO THERE IS ALMOST NOTHING LEFT HERE. The ladder, the colours, the thresholds
 * and the benefits are all crewClubs'. This file's only remaining interest is
 * that a wallet CARRIES one — which is why `wallet` takes a club rather than
 * working one out. The card is drawn in four places (the pilot's home, the
 * shop's hero, the crew list, the dashboard tile) and four copies of a rule is
 * four chances for two of them to disagree about what somebody holds.
 * ======================================================================== */

/**
 * The card, for the pilot it belongs to.
 *
 * `cardNumber` is derived from the member id rather than stored: it is a
 * membership number, not an account that holds money, and issuing one would
 * mean a column whose only job is to be printed. Stable per pilot, which is the
 * whole requirement — the client derives the same thing when the server has not
 * sent one, and this is here so the two agree.
 */
function wallet(member, { rank = '', club = null, streak = null } = {}) {
    if (!member) return null;
    const pts = member.points || {};
    return {
        pilotId: member._id,
        name: member.name || '',
        callsign: member.callsign || '',
        // BOTH ladders, because they say different things and the card shows
        // both: the rank is what this airline calls them, the club is what
        // their flying has earned them.
        rank,
        club: club || null,
        // And the streak, which is neither — it is not a ladder, it does not go
        // up with volume, and it is the only number on this card that can go
        // DOWN. Null where the caller could not work one out (see the shop
        // route: a logbook that will not answer costs the line, not the card),
        // which a card draws as no streak rather than as a zero.
        streak: streak || null,
        // What the club was worked out from. On the card so "38h to Gold" can
        // be drawn without a second fetch of the roster row it came from.
        hours: Math.max(0, Math.round((Number(member.hours) || 0) * 10) / 10),
        since: member.createdAt || null,
        balance: Math.max(0, Number(pts.balance) || 0),
        earned: Math.max(0, Number(pts.earned) || 0),
        spent: Math.max(0, Number(pts.spent) || 0),
    };
}

/* ===========================================================================
 * WHAT A PILOT HOLDS
 *
 * The shop has always been able to tell a pilot what THEY bought and nobody
 * else. That is the right rule for a receipt — a shop is not a place to publish
 * who spent what — and the wrong one for the things people buy here, because
 * almost everything on the shelf is a thing whose entire value is that other
 * people can see it. A badge nobody can see is not a badge. "First pick of the
 * gate" that the rest of the roster never hears about is a discount on nothing.
 *
 * So holdings are public to the crew and receipts are not, and the line between
 * them is drawn here rather than in a route:
 *
 *   * DELIVERED ONLY. An order still in the queue is a thing somebody asked
 *     for, not a thing they hold, and a refunded one is a thing they no longer
 *     have. Both would read as a claim.
 *   * WHAT, AND HOW MANY. Never what it cost, never when, never the code. The
 *     price is the airline's business with that pilot; the code is a key.
 *   * NOTHING NEW IS PUBLISHED. The roster already hands out every name,
 *     callsign and rank without a gate. This adds "and they hold three badges",
 *     which is the sentence the badge was sold to produce.
 * ======================================================================== */
const HELD_STATUSES = new Set(['fulfilled', 'delivered', 'claimed']);

/**
 * One pilot's shelf, grouped.
 *
 * Grouped by the order's OWN copy of the name rather than by item id: an item
 * a VA has since taken off the shelf still exists in everybody's holdings, and
 * `crew_shop_orders.item_id` is `on delete set null` precisely so it survives.
 * Two orders of the same thing read as "×2", which is what a shelf looks like.
 */
function holdings(orders, { limit = 12 } = {}) {
    const byName = new Map();
    for (const o of orders || []) {
        if (!o || !HELD_STATUSES.has(String(o.status || ''))) continue;
        const name = str(o.itemName, 80);
        if (!name) continue;
        const key = name.toLowerCase();
        const at = byName.get(key);
        const when = o.decidedAt || o.createdAt || null;
        if (at) {
            at.count += 1;
            if (when && (!at.since || new Date(when) < new Date(at.since))) at.since = when;
        } else {
            byName.set(key, { name, count: 1, since: when, itemId: o.itemId || null });
        }
    }
    return [...byName.values()]
        // Most-held first, then alphabetical: a shelf reads as "what they have a
        // lot of", and ties that reorder themselves between two page loads look
        // like the data changed when it did not.
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, Math.max(1, limit));
}

/**
 * A pilot as the rest of the crew may see them: the card face, and the shelf.
 *
 * NO BALANCE. What somebody has left to spend is between them and the airline,
 * and a crew list that ranked pilots by it would turn a shop into a scoreboard
 * for who has flown the most hours — which the standings already are, honestly,
 * and on flying rather than on spending.
 *
 * `earned` IS here, because it is a fact about flying rather than about money:
 * it is the same statement as the hours column, denominated in whatever the VA
 * calls its currency, and it never goes down.
 */
const publicHolder = (member, { rank = '', club = null, orders = [], isMe = false } = {}) => ({
    pilotId: member._id,
    name: member.name || '',
    callsign: member.callsign || '',
    rank,
    club: club || null,
    hours: Math.round(Number(member.hours) || 0),
    since: member.createdAt || null,
    status: member.status || 'active',
    earned: Math.max(0, Number((member.points || {}).earned) || 0),
    holds: holdings(orders),
    isMe: !!isMe,
});

module.exports = {
    RATES,
    MAX_RATE,
    LINES,
    CATALOGUE,
    TIERS,
    tierOf,
    NOMINAL_FLIGHT,
    roundPrice,
    suggestedItems,
    normalizeSettings,
    fromRecord,
    toRecord,
    earnLines,
    earnFor,
    payFor,
    exampleFlight,
    examplePay,
    publicItem,
    publicOrder,
    wallet,
    holdings,
    publicHolder,
};
