'use strict';

/*
 * crewCodeshare.js
 * Two crew centres agreeing to fly each other's routes.
 *
 * WHY THIS EXISTS
 * ---------------
 * A codeshare used to be something a VA typed. Somebody at Aurora agreed a deal
 * with Borealis in Discord, then sat down and entered Borealis's network into
 * Aurora's crew centre one leg at a time — the name "Borealis Virtual" forty
 * times, the same logo URL forty times — and Borealis did the same the other
 * way. The day Borealis renumbered a flight, Aurora's copy went on offering the
 * old one, and nobody found out until a pilot flew it.
 *
 * Both airlines are already on this platform. So the deal can be made here:
 *
 *   1. Aurora opens Codeshare → Request, picks Borealis, ticks which Borealis
 *      routes its pilots want to fly (or "all of them") and, if it likes, which of
 *      its own it offers back.
 *   2. Borealis sees the request in its own crew centre, can untick anything,
 *      and accepts or declines.
 *   3. On accept, each side's chosen routes are written into the OTHER side's
 *      database as codeshares — partner name and logo filled in, linked back
 *      to the route they came from (crew_routes.partner_slug/source_route_id,
 *      v23).
 *   4. From then on a change to a shared route is followed: renumbered,
 *      re-equipped or withdrawn, the copy moves with it. Ending the agreement
 *      takes the copies away, and only the copies.
 *
 * WHERE IT LIVES
 * --------------
 * The AGREEMENT is central (a CrewCodeshare document in our database), because
 * it belongs to two airlines at once and neither one's Postgres is the right
 * home for a fact about the other. The ROUTES it produces live where every
 * route lives — in each VA's own project — so an airline that leaves the
 * platform keeps its network, codeshares included.
 *
 * WHAT IS NEVER SHARED
 * --------------------
 * Only a VA's OWN, PUBLISHED legs. A draft is not a flight yet, and a codeshare
 * of a codeshare is a third airline's route that the second one has no right
 * to hand on — so both are filtered out before anything is offered, and again
 * at every sync.
 *
 * WHAT THE TAKER KEEPS
 * --------------------
 * The partner owns the leg: its number, its airports, its aircraft, its
 * distance. The airline flying it as a codeshare owns how its pilots see it: the rank gate, the
 * notes, whether it is published, the gates. A sync writes only the first set,
 * so a VA that puts Borealis's long-haul behind Captain does not find the gate
 * gone the next time Borealis edits the route.
 *
 * NOTHING HERE TALKS TO A DATABASE. It is the rules and the arithmetic; the
 * I/O is in server.js, the same split crewAwards and crewCsv keep.
 */

const STATUSES = ['pending', 'active', 'declined', 'withdrawn', 'ended'];
const MODES = ['all', 'selected', 'none'];

// A request carries route ids, not routes. Bounded so a request is a request
// and not an upload; a real airline's network is well under it.
const MAX_SELECTED = 3000;
// How many requests one airline may have waiting on other airlines at once. A
// VA asking forty airlines in an afternoon is spamming the directory, not
// building a network.
const MAX_PENDING_OUT = 15;
const MESSAGE_MAX = 800;

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const fold = (v) => String(v || '').trim().toLowerCase();

/**
 * Which of a network one side takes: every eligible leg, a chosen few, or none.
 * `all` follows the network — a leg the partner adds tomorrow is flown tomorrow.
 * `selected` is exactly the ids listed, and a new leg waits to be ticked.
 */
function cleanSelection(sel, fallback = 'none') {
    const s = sel && typeof sel === 'object' ? sel : {};
    const mode = MODES.includes(s && s.mode) ? s.mode : fallback;
    const ids = mode === 'selected' && Array.isArray(s.routeIds)
        ? [...new Set(s.routeIds.map((i) => str(i, 64)).filter(Boolean))].slice(0, MAX_SELECTED)
        : [];
    // "Selected" with nothing selected is "none", said honestly.
    if (mode === 'selected' && !ids.length) return { mode: 'none', routeIds: [] };
    return { mode, routeIds: ids };
}

const selectionEmpty = (s) => !s || s.mode === 'none';

/**
 * A selection held inside a ceiling. The ceiling is what the airline that
 * OWNS the routes allows ("all", "these", "none"); the selection is what the
 * other airline asks to fly. The result is never wider than either — which is
 * the one rule that lets each side edit its half of an agreement alone.
 */
function narrowSelection(sel, limit) {
    const s = cleanSelection(sel);
    const l = cleanSelection(limit);
    if (l.mode === 'none' || s.mode === 'none') return { mode: 'none', routeIds: [] };
    if (l.mode === 'all') return s;
    if (s.mode === 'all') return { mode: 'selected', routeIds: l.routeIds.slice() };
    const allowed = new Set(l.routeIds);
    return cleanSelection({ mode: 'selected', routeIds: s.routeIds.filter((i) => allowed.has(i)) });
}

/** What a route has to be before anybody else may fly it as a codeshare. */
const shareable = (r) => !!r && r.active !== false && (r.kind || 'own') === 'own'
    && !!String(r.origin || '').trim() && !!String(r.destination || '').trim();

/** The legs a selection names, out of a network, in the network's order. */
function selectRoutes(routes, selection) {
    const sel = cleanSelection(selection);
    const own = (routes || []).filter(shareable);
    if (sel.mode === 'all') return own;
    if (sel.mode === 'none') return [];
    const want = new Set(sel.routeIds);
    return own.filter((r) => want.has(String(r._id || r.id)));
}

/* ---------------------------------------------------------------------------
 * Who is who in an agreement
 *
 * An agreement has a `from` (the airline that asked) and a `to` (the one that
 * was asked). Each side has two selections over the OTHER side's network:
 *
 *   takes  what it WANTS to fly — its own choice, kept as it was made, so
 *          "all of it" stays "all of it" when the partner later opens up more
 *   limit  what the partner ALLOWS it to fly — the partner's choice
 *
 * and what it actually flies is the one held inside the other (`flying`). The
 * rest of the product never has to think in from/to: `sideOf` answers "which
 * one is me", and `view` turns the document into "me" and "them".
 * ------------------------------------------------------------------------- */

/** What one side actually flies: its wish, inside the partner's allowance. */
const flying = (doc, side) => narrowSelection(doc && doc[`${side}Takes`], doc && doc[`${side}Limit`]);

function sideOf(doc, slug) {
    const s = fold(slug);
    if (doc && fold(doc.fromSlug) === s) return 'from';
    if (doc && fold(doc.toSlug) === s) return 'to';
    return null;
}
const otherSide = (side) => (side === 'from' ? 'to' : 'from');

/** The agreement from one airline's side of the table. */
function view(doc, slug, { linked = null } = {}) {
    const me = sideOf(doc, slug);
    if (!me) return null;
    const them = otherSide(me);
    const takes = (side) => cleanSelection(doc[`${side}Takes`]);
    const syncOf = (side) => {
        const s = (doc.sync && doc.sync[side]) || {};
        return {
            at: s.at || null,
            added: Number(s.added) || 0,
            updated: Number(s.updated) || 0,
            removed: Number(s.removed) || 0,
            routes: Number(s.routes) || 0,
            error: s.error || '',
        };
    };
    return {
        id: String(doc._id),
        status: STATUSES.includes(doc.status) ? doc.status : 'pending',
        // Whether I asked or was asked. Decides which buttons a pending one gets.
        direction: me === 'from' ? 'outgoing' : 'incoming',
        partner: {
            slug: doc[`${them}Slug`] || '',
            name: doc[`${them}Name`] || '',
            logo: doc[`${them}Logo`] || '',
            callsign: doc[`${them}Callsign`] || '',
        },
        // The partner's routes my pilots fly, and my routes theirs fly — as flown, and
        // as each side asked and allowed, so the editor can show all three.
        iTake: flying(doc, me),
        theyTake: flying(doc, them),
        iWant: takes(me),
        theyAllowMe: cleanSelection(doc[`${me}Limit`]),
        iAllowThem: cleanSelection(doc[`${them}Limit`]),
        message: doc.message || '',
        reply: doc.reply || '',
        requestedBy: doc.requestedBy || '',
        decidedBy: doc.decidedBy || '',
        endedBy: doc.endedBy || '',
        createdAt: doc.createdAt || null,
        decidedAt: doc.decidedAt || null,
        endedAt: doc.endedAt || null,
        mySync: syncOf(me),
        theirSync: syncOf(them),
        // How many codeshares on MY network came from this agreement, when the
        // caller counted them.
        linkedRoutes: linked == null ? null : Number(linked) || 0,
        canAccept: doc.status === 'pending' && me === 'to',
        canWithdraw: doc.status === 'pending' && me === 'from',
        canEnd: doc.status === 'active',
    };
}

/**
 * Whether a new request may be made. Returns an error sentence or ''.
 *
 * `existing` is every agreement either airline is party to — cheap, because an
 * airline has a handful — so the pair checks can be done in one place.
 */
function requestProblem({ fromSlug, toSlug, take, offer, existing = [], partnerOpen = true }) {
    const a = fold(fromSlug);
    const b = fold(toSlug);
    if (!b) return 'Pick the airline you want to codeshare with.';
    if (a === b) return 'That is your own airline.';
    if (!partnerOpen) return 'That airline is not taking codeshare requests at the moment.';
    if (selectionEmpty(take) && selectionEmpty(offer)) {
        return 'Pick at least one route — theirs to fly, or yours to offer them.';
    }
    const between = existing.filter((d) => {
        const pair = [fold(d.fromSlug), fold(d.toSlug)];
        return pair.includes(a) && pair.includes(b);
    });
    if (between.some((d) => d.status === 'active')) {
        return 'You already codeshare with this airline. Change which routes you fly from the agreement itself.';
    }
    if (between.some((d) => d.status === 'pending')) {
        return 'There is already a request waiting between you and this airline.';
    }
    const waiting = existing.filter((d) => d.status === 'pending' && fold(d.fromSlug) === a).length;
    if (waiting >= MAX_PENDING_OUT) {
        return `You have ${waiting} requests waiting on other airlines. Let some of them be answered first.`;
    }
    return '';
}

/* ---------------------------------------------------------------------------
 * The sync
 *
 * Given the partner's shareable legs as they are now and the codeshares this
 * airline holds from them, work out what to add, what to change and what to
 * take away. Pure, so it is tested without a database and the dry run and the
 * real run cannot disagree.
 * ------------------------------------------------------------------------- */

// What the partner owns about a leg. Only these are ever written by a sync.
const SOURCE_FIELDS = ['flightNumber', 'origin', 'destination', 'aircraft', 'distanceNm'];

/**
 * The codeshares on a network that came from one partner.
 *
 * By slug where the row has one. A project on a pre-v23 schema never stored a
 * slug, so there the partner's NAME stands in — but only on rows that were
 * never linked to anybody else, so a hand-typed codeshare that happens to name
 * the same airline is only ever claimed on a project that cannot tell the two
 * apart, and there it is the same flight.
 */
function linkedRows(routes, partner) {
    const slug = fold(partner && partner.slug);
    const name = fold(partner && partner.name);
    return (routes || []).filter((r) => r && r.kind === 'codeshare' && (
        (slug && fold(r.partnerSlug) === slug)
        || (!r.partnerSlug && !r.sourceRouteId && name && fold(r.partnerName) === name && r.__legacyLink === true)
    ));
}

/** Mark the rows a pre-v23 project could be holding for this partner. */
function adoptLegacy(routes, partner, { schemaLinks }) {
    if (schemaLinks) return routes || [];
    const name = fold(partner && partner.name);
    return (routes || []).map((r) => (r && r.kind === 'codeshare' && !r.partnerSlug && fold(r.partnerName) === name
        ? { ...r, __legacyLink: true } : r));
}

const legKey = (r) => [fold(r.flightNumber), fold(r.origin), fold(r.destination)].join('|');

/**
 * @param source    the partner's legs this airline takes (already selected)
 * @param existing  this airline's whole network
 * @param partner   { slug, name, logo }
 * @param schemaLinks whether this airline's project can store the link columns
 * @returns { create: [values], update: [{ id, values, before }], remove: [id], keep }
 */
function planSync({ source = [], existing = [], partner = {}, schemaLinks = true } = {}) {
    const mine = linkedRows(adoptLegacy(existing, partner, { schemaLinks }), partner);
    const bySource = new Map();
    const byLeg = new Map();
    for (const r of mine) {
        if (r.sourceRouteId) bySource.set(String(r.sourceRouteId), r);
        // Every held row is findable by its leg too — the fallback for a row
        // written before its project had a source column.
        if (!byLeg.has(legKey(r))) byLeg.set(legKey(r), r);
    }

    const partnerName = str(partner.name, 60) || 'Partner airline';
    const partnerLogo = /^https:\/\//i.test(String(partner.logo || '')) ? str(partner.logo, 600) : '';

    const create = [];
    const update = [];
    const claimed = new Set();
    for (const src of source) {
        if (!shareable(src)) continue;
        const sid = String(src._id || src.id || '');
        let held = (sid && bySource.get(sid)) || null;
        if (!held) {
            const byKey = byLeg.get(legKey(src));
            // Only adopt a leg-matched row that is not already somebody else's
            // copy — two partner routes with one number and one city pair are
            // two flights, and must not both claim the same row.
            if (byKey && !claimed.has(byKey) && (!byKey.sourceRouteId || !schemaLinks)) held = byKey;
        }
        const want = {
            flightNumber: str(src.flightNumber, 12),
            origin: str(src.origin, 4).toUpperCase(),
            destination: str(src.destination, 4).toUpperCase(),
            aircraft: str(src.aircraft, 60),
            distanceNm: Math.max(0, Math.round(Number(src.distanceNm) || 0)),
            kind: 'codeshare',
            partnerName,
            partnerLogo,
            partnerSlug: fold(partner.slug),
            sourceRouteId: sid,
        };
        if (held) {
            claimed.add(held);
            const diff = {};
            for (const k of [...SOURCE_FIELDS, 'partnerName', 'partnerLogo']) {
                if (String(held[k] == null ? '' : held[k]) !== String(want[k] == null ? '' : want[k])) diff[k] = want[k];
            }
            if (schemaLinks) {
                if (fold(held.partnerSlug) !== want.partnerSlug) diff.partnerSlug = want.partnerSlug;
                if (String(held.sourceRouteId || '') !== want.sourceRouteId) diff.sourceRouteId = want.sourceRouteId;
            }
            if (Object.keys(diff).length) update.push({ id: String(held._id || held.id), values: diff, before: held });
        } else {
            create.push({
                ...want,
                // Written once, on the way in. After that the notes are the
                // airline flying it as a codeshare, like the rank gate.
                notes: `Operated by ${partnerName}.`,
                active: true,
                minRank: '',
            });
        }
    }
    const gone = mine.filter((r) => !claimed.has(r)).map((r) => String(r._id || r.id));
    // A project without the link columns cannot tell a copy from a codeshare
    // somebody typed by hand under the same airline's name. It is told what
    // would go, and nothing goes: deleting a VA's own work on a guess is the
    // one mistake this must not make. The update button fixes it.
    const remove = schemaLinks ? gone : [];
    return {
        create, update, remove,
        stranded: schemaLinks ? 0 : gone.length,
        keep: mine.length - gone.length - update.length,
    };
}

/** The payload a finished sync leaves on the agreement for this side. */
const syncRecord = ({ plan, done = {}, routes = 0, error = '' }) => ({
    at: new Date(),
    added: Number(done.created ?? (plan ? plan.create.length : 0)) || 0,
    updated: Number(done.updated ?? (plan ? plan.update.length : 0)) || 0,
    removed: Number(done.removed ?? (plan ? plan.remove.length : 0)) || 0,
    routes: Number(routes) || 0,
    error: str(error, 300),
});

/** A directory entry, as the request picker draws it. */
const directoryEntry = (ad) => ({
    slug: ad.slug || '',
    name: ad.name || '',
    callsign: ad.callsign || '',
    logo: /^https:\/\//i.test(String(ad.logoUrl || '')) ? ad.logoUrl : '',
    country: ad.country || '',
    tagline: str(ad.tagline, 140),
});

/** Case- and accent-insensitive "does this airline match what was typed". */
function matchesQuery(ad, q) {
    const needle = fold(q).normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!needle) return true;
    const hay = [ad.name, ad.slug, ad.callsign, ...(Array.isArray(ad.callsigns) ? ad.callsigns : [])]
        .map((v) => fold(v).normalize('NFD').replace(/[̀-ͯ]/g, '')).join(' ');
    return needle.split(/\s+/).every((w) => hay.includes(w));
}

/**
 * Whether a partner name in an imported sheet is really this airline — so a
 * combined sheet ("operator" column with both airlines in it) sorts itself:
 * our rows come in as our own network, everybody else's as their codeshares.
 */
function isOwnOperator(name, va) {
    const n = fold(name);
    if (!n) return false;
    const own = [va && va.name, va && va.slug, va && va.callsign,
        ...((va && Array.isArray(va.callsigns)) ? va.callsigns : [])].map(fold).filter(Boolean);
    return own.includes(n);
}

/**
 * The import's `prepare` step for a route sheet, given who "we" are and the
 * logos we already know partners by. Pure, so the combined-sheet round trip is
 * tested through the real CSV planner.
 */
function operatorPrepare(va, logos = new Map()) {
    return (values) => {
        if (!('partnerName' in values)) return values;
        const out = { ...values };
        if (isOwnOperator(out.partnerName, va)) {
            out.kind = 'own';
            out.partnerName = '';
            return out;
        }
        if (String(out.partnerName || '').trim()) {
            if (!('kind' in values)) out.kind = 'codeshare';
            if (out.kind === 'codeshare' && !out.partnerLogo && logos.has(fold(out.partnerName))) {
                out.partnerLogo = logos.get(fold(out.partnerName));
            }
        }
        return out;
    };
}

module.exports = {
    operatorPrepare,
    STATUSES,
    MODES,
    MAX_PENDING_OUT,
    MAX_SELECTED,
    MESSAGE_MAX,
    SOURCE_FIELDS,
    cleanSelection,
    selectionEmpty,
    narrowSelection,
    flying,
    shareable,
    selectRoutes,
    sideOf,
    otherSide,
    view,
    requestProblem,
    linkedRows,
    adoptLegacy,
    planSync,
    syncRecord,
    directoryEntry,
    matchesQuery,
    isOwnOperator,
};
