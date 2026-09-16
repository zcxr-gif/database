'use strict';

/*
 * crewBadges.js
 * Everything a pilot wears, in one list.
 *
 * WHY THIS EXISTS
 * ---------------
 * A pilot's standing was scattered across four screens. Their rank was in the
 * top bar and on a card. Their club was inside the shop. Their awards were
 * behind a tile. The things they had actually SPENT their flying on were in a
 * receipts list that only they could open. Every one of those is the same kind
 * of fact — "this is what I am at this airline" — and not one of them was
 * anywhere near the top of the page.
 *
 * So this is the join, and the crew center draws it across the hero: the first
 * thing a pilot sees when they open the page is what they have to show for it.
 *
 * FOUR SOURCES, ONE ORDER, AND THE ORDER IS THE ARGUMENT
 * -----------------------------------------------------
 *   1. RANK    what the airline calls them. First because it is the one thing
 *              here somebody else decided, and it is how they are addressed.
 *   2. CLUB    what their flying earned them automatically.
 *   3. AWARDS  what their flying earned them by crossing a line, newest first,
 *              because the newest is the one they have not seen yet.
 *   4. HELD    what they chose to spend it on. Last, and deliberately not
 *              hidden: almost everything a VA sells is a thing whose entire
 *              value is that other people can see it, and a badge nobody can
 *              see is not a badge.
 *
 * NOTHING HERE IS NEW INFORMATION. Every one of these four is already readable
 * by this pilot on some other screen of the same crew center. What changes is
 * that they are in one row, in one order, at the top — which is the whole
 * feature.
 *
 * NOTHING HERE TALKS TO A DATABASE. Handed a member, a rank, a club, an awards
 * result and a list of orders, it returns the row. The I/O is in the route.
 */

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/* Colours for the four award tiers, which is the ONE thing on a badge that the
 * server has to decide rather than read. A rank and a club carry a colour the
 * VA set; an award carries a tier, and a tier is a word.
 *
 * Kept identical to crewAwards.js's own palette in the browser — the awards
 * panel and this row draw the same badge, and two of them disagreeing about
 * what gold looks like is the kind of thing nobody files but everybody sees. */
const TIER_COLOUR = {
    bronze: '#B4794A',
    silver: '#9AA3B2',
    gold: '#C9A227',
    platinum: '#6E8BFF',
};

/** How many badges a rail is willing to carry. Beyond this it is a wall. */
const MAX_BADGES = 24;

/**
 * The rank, as a badge.
 *
 * Null rather than a placeholder for a pilot with no rank: a VA that has not
 * written a ladder has not said anything about this person, and inventing
 * "Unranked" would be putting a word in their mouth on the most prominent row
 * of the page.
 */
function rankBadge(rank) {
    if (!rank || !str(rank.name, 40)) return null;
    return {
        kind: 'rank',
        id: 'rank',
        name: str(rank.name, 40),
        // A VA may hand a rung an uploaded image; where they have, it IS the
        // badge and the icon is only what shows while it loads.
        image: str(rank.image, 600),
        icon: str(rank.icon, 30) || 'badge-check',
        color: str(rank.color, 20),
        note: 'Rank',
        // Which panel this badge belongs to, so a tap goes somewhere useful
        // rather than nowhere. Decided here because the grouping is this
        // file's; the browser only has to obey it.
        opens: 'training',
    };
}

/** The club, as a badge. */
function clubBadge(club) {
    if (!club || !str(club.name, 30)) return null;
    const gets = Array.isArray(club.benefits) ? club.benefits.length : 0;
    return {
        kind: 'club',
        id: `club:${str(club.key, 20)}`,
        name: str(club.name, 30),
        image: '',
        icon: 'medal',
        color: str(club.color, 20),
        // What the club is worth, in the two words a rail has room for. A club
        // that gives nothing says which club it is and stops there, rather than
        // claiming a benefit the VA has not attached.
        note: gets ? `Club · ${gets === 1 ? '1 benefit' : `${gets} benefits`}` : 'Club',
        opens: 'clubs',
    };
}

/**
 * The awards they have earned, newest first.
 *
 * Joined to the catalogue for the name and the icon, and falling back to what
 * the earned row itself carries — crewAwards sends both, and a badge whose
 * catalogue entry has since been renamed should still draw.
 */
function awardBadges(earned, catalog) {
    const by = new Map((catalog || []).map((a) => [String(a.id), a]));
    return (earned || [])
        .map((e) => {
            const a = by.get(String(e && e.id)) || {};
            const name = str(a.name || (e && e.name), 40);
            if (!name) return null;
            const tier = str(a.tier || (e && e.tier), 20);
            return {
                kind: 'award',
                id: `award:${str(e.id, 40)}`,
                name,
                image: '',
                icon: str(a.icon || (e && e.icon), 30) || 'award',
                color: TIER_COLOUR[tier] || '',
                note: 'Earned',
                at: (e && e.at) || null,
                opens: 'awards',
            };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
}

/**
 * What this pilot has claimed from the shop.
 *
 * DELIVERED ONLY, and the reason is the same one crewShop.holdings gives: an
 * order still in the queue is a thing somebody asked for, and a refunded one is
 * a thing they no longer have. Wearing either would be a claim.
 *
 * Grouped by the order's own copy of the name rather than by item id, so an
 * item the VA has since taken off the shelf is still worn — `item_id` is `on
 * delete set null` precisely so a receipt survives that.
 *
 * `icon` comes off the shelf where the item is still there. A VA that chose a
 * shield for their badge gets a shield here; one whose item has been deleted
 * gets the generic mark rather than nothing.
 */
function heldBadges(orders, items) {
    const HELD = new Set(['fulfilled', 'delivered', 'claimed']);
    const byId = new Map((items || []).map((i) => [String(i.id || i._id), i]));
    const out = new Map();
    for (const o of orders || []) {
        if (!o || !HELD.has(str(o.status, 20))) continue;
        const name = str(o.itemName, 60);
        if (!name) continue;
        const key = name.toLowerCase();
        const at = o.decidedAt || o.createdAt || null;
        const found = out.get(key);
        if (found) {
            found.count += 1;
            // The date worn is the date they FIRST had one. "Since June" is a
            // truer thing to say about a badge somebody holds three of than
            // the date the third one was handed over.
            if (at && (!found.at || new Date(at) < new Date(found.at))) found.at = at;
            continue;
        }
        const item = byId.get(String(o.itemId || '')) || null;
        out.set(key, {
            kind: 'held',
            id: `held:${key.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
            name,
            image: str(item && item.image, 600),
            icon: str(item && item.icon, 30) || 'gift',
            color: '',
            note: 'Claimed',
            at,
            count: 1,
            opens: 'shop',
        });
    }
    return [...out.values()]
        .sort((a, b) => b.count - a.count || new Date(b.at || 0) - new Date(a.at || 0));
}

/**
 * The whole row, in the order above.
 *
 * `total` is what a rail needs to say "+6 more" honestly when it can only draw
 * so many; the badges themselves are capped here so a pilot with four hundred
 * receipts cannot make this response enormous.
 */
function forPilot({ rank = null, club = null, earned = [], catalog = [], orders = [], items = [] } = {}) {
    const rows = [
        rankBadge(rank),
        clubBadge(club),
        ...awardBadges(earned, catalog),
        ...heldBadges(orders, items),
    ].filter(Boolean);
    return {
        badges: rows.slice(0, MAX_BADGES),
        total: rows.length,
        // Counted per kind so a page can say "3 awards" without walking the
        // list, and so a rail knows whether there is anything but a rank to
        // draw — which is the difference between a row and a lonely chip.
        counts: rows.reduce((n, b) => { n[b.kind] = (n[b.kind] || 0) + 1; return n; }, {}),
    };
}

module.exports = {
    TIER_COLOUR,
    MAX_BADGES,
    rankBadge,
    clubBadge,
    awardBadges,
    heldBadges,
    forPilot,
};
