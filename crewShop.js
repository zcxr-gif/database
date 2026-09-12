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

/**
 * The card, for the pilot it belongs to.
 *
 * `cardNumber` is derived from the member id rather than stored: it is a
 * membership number, not an account that holds money, and issuing one would
 * mean a column whose only job is to be printed. Stable per pilot, which is the
 * whole requirement — the client derives the same thing when the server has not
 * sent one, and this is here so the two agree.
 */
function wallet(member, { rank = '' } = {}) {
    if (!member) return null;
    const pts = member.points || {};
    return {
        pilotId: member._id,
        name: member.name || '',
        callsign: member.callsign || '',
        rank,
        since: member.createdAt || null,
        balance: Math.max(0, Number(pts.balance) || 0),
        earned: Math.max(0, Number(pts.earned) || 0),
        spent: Math.max(0, Number(pts.spent) || 0),
    };
}

module.exports = {
    RATES,
    normalizeSettings,
    fromRecord,
    toRecord,
    earnFor,
    examplePay,
    publicItem,
    publicOrder,
    wallet,
};
