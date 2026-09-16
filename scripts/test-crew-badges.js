'use strict';
// Conformance test for crewBadges.js — the row across the top of a pilot's own
// page: their rank, their club, their awards and what they have claimed.
//
// The properties worth protecting are the ones that would put a claim about a
// person on the most prominent row of the page:
//
//   * nothing is invented. No rank, no badge; no club, no badge. A VA that has
//     said nothing about somebody must not have words put in its mouth
//   * an order still in the queue is not a thing they wear, and a refunded one
//     is not either
//   * two of the same thing is one badge with a count, dated from the FIRST
//   * a badge whose shelf item has since been deleted still draws
//   * the order is the argument: rank, club, awards newest first, then claimed
//   * a pilot with four hundred receipts cannot make the response enormous
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const B = require(path.join('..', 'crewBadges.js'));
const crewClubs = require(path.join('..', 'crewClubs.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

const CATALOG = [
    { id: 'hours-10', name: '10 hours', icon: 'clock', tier: 'bronze' },
    { id: 'ports-25', name: '25 airports', icon: 'map', tier: 'silver' },
    { id: 'long-haul', name: 'Long haul', icon: 'moon', tier: 'gold' },
];
const order = (name, status, extra) => ({
    _id: Math.random().toString(36).slice(2), itemName: name, status, price: 500, code: 'SECRET',
    createdAt: '2026-03-01T00:00:00Z', decidedAt: '2026-03-02T00:00:00Z', ...(extra || {}),
});

console.log('\n nothing is invented');
{
    const empty = B.forPilot({});
    T('a pilot with nothing wears nothing', empty.badges.length, 0);
    T('…and the count says so', empty.total, 0);
    T('no rank, no rank badge', B.rankBadge(null), null);
    T('…and a rank with no name is not a rank', B.rankBadge({ name: '  ' }), null);
    T('no club, no club badge', B.clubBadge(null), null);
    T('an award the catalogue no longer names is dropped rather than drawn blank',
        B.awardBadges([{ id: 'gone', at: '2026-01-01' }], CATALOG).length, 0);
    T('…but one the catalogue lost that carries its own name survives',
        B.awardBadges([{ id: 'gone', at: '2026-01-01', name: 'Retired badge' }], CATALOG)[0].name,
        'Retired badge');
}

console.log('\n the rank');
{
    const r = B.rankBadge({ name: 'First Officer', color: '#123456', icon: 'star', image: '' });
    T('it is a rank badge', r.kind, 'rank');
    T('…in the colour the VA painted the rung', r.color, '#123456');
    T('…with the VA’s own icon', r.icon, 'star');
    T('…labelled, so a row of badges is readable', r.note, 'Rank');
    T('…and it opens the ladder it came from', r.opens, 'training');
    T('a rung with no icon still has one', B.rankBadge({ name: 'Captain' }).icon, 'badge-check');
    // An uploaded image IS the badge where a VA gave one; the icon is only
    // what shows while it loads.
    T('an uploaded image is carried',
        B.rankBadge({ name: 'Captain', image: 'https://cdn.test/capt.png' }).image, 'https://cdn.test/capt.png');
}

console.log('\n the club');
{
    const plain = B.clubBadge(crewClubs.memberClub(undefined, 260));
    T('it is a club badge', plain.kind, 'club');
    T('…named', plain.name, 'Gold');
    T('…in the club’s colour', plain.color, '#B8860B');
    T('a club that gives nothing claims nothing', plain.note, 'Club');
    T('…and opens the clubs screen', plain.opens, 'clubs');

    const paying = B.clubBadge({ key: 'gold', name: 'Gold', color: '#B8860B',
        benefits: [{ kind: 'earn' }, { kind: 'priority' }] });
    T('a club that gives something says how much', paying.note, 'Club · 2 benefits');
    T('…and one benefit is not "1 benefits"',
        B.clubBadge({ key: 'g', name: 'Gold', benefits: [{ kind: 'earn' }] }).note, 'Club · 1 benefit');
}

console.log('\n the awards');
{
    const earned = [
        { id: 'hours-10', at: '2026-01-05T00:00:00Z' },
        { id: 'long-haul', at: '2026-06-02T00:00:00Z' },
        { id: 'ports-25', at: '2026-03-11T00:00:00Z' },
    ];
    const rows = B.awardBadges(earned, CATALOG);
    T('every earned award is worn', rows.length, 3);
    // The newest is the one they have not seen yet.
    T('…newest first', rows.map((r) => r.name), ['Long haul', '25 airports', '10 hours']);
    T('…coloured by tier', rows[0].color, B.TIER_COLOUR.gold);
    T('…and a tier nobody recognises gets no colour rather than a wrong one',
        B.awardBadges([{ id: 'x', name: 'Odd', tier: 'copper', at: '2026-01-01' }], []).map((r) => r.color), ['']);
    T('an award opens the awards panel', rows[0].opens, 'awards');
    T('nothing earned is an empty row, not an error', B.awardBadges([], CATALOG).length, 0);
}

console.log('\n what they claimed');
{
    const items = [{ id: 'i1', name: 'A badge on your profile', icon: 'shield', image: '' }];
    const rows = B.heldBadges([
        order('A badge on your profile', 'fulfilled', { itemId: 'i1', decidedAt: '2026-05-01T00:00:00Z' }),
        order('A badge on your profile', 'fulfilled', { itemId: 'i1', decidedAt: '2026-02-01T00:00:00Z' }),
        order('Your own callsign', 'fulfilled', { itemId: 'i9' }),
        order('Lead the next group flight', 'placed'),
        order('Request a livery', 'cancelled'),
    ], items);

    T('two of the same thing is one badge', rows.length, 2);
    T('…with a count', rows[0].count, 2);
    T('…dated from the first one, not the latest', rows[0].at, '2026-02-01T00:00:00Z');
    T('an order still in the queue is not worn',
        rows.some((r) => r.name === 'Lead the next group flight'), false);
    T('nor is a refunded one', rows.some((r) => r.name === 'Request a livery'), false);
    T('the shelf’s own icon is used where the item is still there', rows[0].icon, 'shield');
    T('…and an item the VA has since deleted still draws', rows[1].icon, 'gift');
    T('a holding never carries what it cost', rows[0].price, undefined);
    T('…nor the code', rows[0].code, undefined);
    T('the most-held is first', rows[0].name, 'A badge on your profile');
    T('a claimed badge opens the shop', rows[0].opens, 'shop');
}

console.log('\n the whole row');
{
    const out = B.forPilot({
        rank: { name: 'First Officer', color: '#123456' },
        club: crewClubs.memberClub(undefined, 120),
        earned: [{ id: 'hours-10', at: '2026-01-05T00:00:00Z' }],
        catalog: CATALOG,
        orders: [order('A badge on your profile', 'fulfilled')],
        items: [],
    });
    // The order IS the argument: what the airline calls you, what your flying
    // earned you, what you crossed a line for, what you chose to spend it on.
    T('the row reads rank, club, award, claimed',
        out.badges.map((b) => b.kind), ['rank', 'club', 'award', 'held']);
    T('…and is counted per kind', out.counts, { rank: 1, club: 1, award: 1, held: 1 });
    T('…with a total a rail can say "+n more" from', out.total, 4);

    // A pilot with four hundred receipts must not make this response enormous.
    const many = B.forPilot({
        rank: { name: 'Captain' },
        orders: Array.from({ length: 400 }, (_, i) => order(`Thing ${i}`, 'fulfilled')),
    });
    T('a rail is capped', many.badges.length, B.MAX_BADGES);
    T('…but the total is honest about what was cut', many.total, 401);
    T('…and the rank survives the cut, because it is first', many.badges[0].kind, 'rank');
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
