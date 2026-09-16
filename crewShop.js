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
 *              currency and set four rates. Normalizing that is this file's
 *              job, because the four numbers arrive from a form and a rate of
 *              1e9 is a VA's typo, not a decision.
 *
 *   EARNING    what one approved flight pays. One function, used by both doors
 *              into approval (a staff member pressing the button, and the
 *              auto-approve rule in the PIREP sweep), so the two cannot drift.
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

/** The four rates, in the order the back office draws them. */
const RATES = ['perHour', 'perLanding', 'fleetBonus', 'violationPenalty'];

const int = (v, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
};
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * The VA's shop settings, bounded.
 *
 * Every default is the inert one. A VA that has never opened this screen gets a
 * shop that is off, pays nothing and is called "Points" — because the
 * alternative is that deploying this file starts an economy in three hundred
 * airlines that did not ask for one.
 *
 * The ceiling on a rate is 100,000. It is not a policy about how much a VA may
 * pay; it is the difference between a typo and a balance nobody can ever spend.
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
        earn: {
            perHour: int(earn.perHour, 0, 1e5),
            perLanding: int(earn.perLanding, 0, 1e5),
            fleetBonus: int(earn.fleetBonus, 0, 1e5),
            violationPenalty: int(earn.violationPenalty, 0, 1e5),
        },
    };
}

/**
 * The VA record's shop field, in the shape the rest of this file works in.
 *
 * The record stores the six numbers flat (`currencyName`, `perHour`, …) and
 * everything else here reads them nested, because nested is the shape the panel
 * sends and the shape a reader can see the structure of. One adapter each way,
 * in the one file that knows both, rather than the nesting leaking into every
 * caller.
 */
const fromRecord = (rec) => normalizeSettings(rec && {
    enabled: rec.enabled,
    currency: { name: rec.currencyName, short: rec.currencyShort },
    earn: {
        perHour: rec.perHour,
        perLanding: rec.perLanding,
        fleetBonus: rec.fleetBonus,
        violationPenalty: rec.violationPenalty,
    },
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
    return {
        enabled: next.enabled,
        currencyName: next.currency.name,
        currencyShort: next.currency.short,
        perHour: next.earn.perHour,
        perLanding: next.earn.perLanding,
        fleetBonus: next.earn.fleetBonus,
        violationPenalty: next.earn.violationPenalty,
    };
}

/**
 * What one approved flight pays.
 *
 * Hours are the flight's real duration rather than its credited hours: the two
 * are the same number everywhere in this product, and reading the minutes keeps
 * this honest for a report whose hours a staff member has edited by hand.
 *
 * Floored at zero. A flight with more violations than it was worth pays
 * nothing; it does not take a pilot's existing balance off them, because a
 * penalty is a rate on the flight and not a fine on the account.
 */
function earnFor(pirep, rates) {
    const r = normalizeSettings({ earn: rates }).earn;
    const p = pirep || {};
    const hours = Math.max(0, Number(p.durationMin) || 0) / 60;
    const landings = Math.max(0, Number(p.landings) || 0);
    const violations = Math.max(0, Number(p.violations) || 0);
    const total = (r.perHour * hours)
        + (r.perLanding * landings)
        + (p.inFleet ? r.fleetBonus : 0)
        - (r.violationPenalty * violations);
    return Math.max(0, Math.round(total));
}

/**
 * The worked example under the four inputs, computed the same way a real flight
 * is. The back office draws its own copy as the rates are typed; this is the
 * server's, so the sentence a VA reads before saving and the sum they get
 * afterwards come from one function.
 */
const exampleFlight = { durationMin: 135, landings: 1, violations: 0, inFleet: true };
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
 * `group` is the shelf it sits on in the picker, so twelve suggestions read as
 * five short lists rather than one long one.
 * ======================================================================== */
const CATALOGUE = [
    /* IDENTITY — what a pilot is called and what they fly as. The cheapest
       things on this list and the ones that get bought first, because they are
       the ones that show up in a screenshot. */
    {
        id: 'badge',
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
        group: 'Identity',
        name: 'Your own callsign',
        desc: 'Reserve a flight number that is yours. Nobody else on the roster files it.',
        icon: 'radio',
        flights: 8,
        limitPerPilot: 1,
    },
    {
        id: 'registration',
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
        group: 'The network',
        name: 'Name a route',
        desc: 'Nominate a sector. Staff add it to the network and it is flown as that week’s featured route.',
        icon: 'route',
        flights: 25,
        limitPerPilot: 1,
    },
    {
        id: 'livery',
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

/** One thing on the shelf, as any caller may see it. */
const publicItem = (i) => ({
    id: i._id,
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
function wallet(member, { rank = '', club = null } = {}) {
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
    CATALOGUE,
    NOMINAL_FLIGHT,
    roundPrice,
    suggestedItems,
    normalizeSettings,
    fromRecord,
    toRecord,
    earnFor,
    examplePay,
    publicItem,
    publicOrder,
    wallet,
    holdings,
    publicHolder,
};
