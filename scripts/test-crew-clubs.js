'use strict';
// Conformance test for crewClubs.js — the club ladder and what each club is
// worth.
//
// The properties worth protecting are the ones that would quietly give a pilot
// something they have not earned, or quietly take away something they have:
//
//   * a VA that has never opened this screen has clubs and NO benefits — a
//     deploy must not start paying a 20% bonus in three hundred airlines
//   * every pilot is in a club, including one on their first day
//   * climbing never demotes anybody, and the top club is reachable
//   * a club key survives a rename, because an early-access window points at it
//   * deleting a club lapses its gate rather than closing the shop
//   * early access is a WINDOW on new stock, never a permanent wall, and staff
//     can always see what they just added
//   * the bonus is applied once, to the whole flight, and cannot be a lottery
//
// Pure module test — no network, no database, no mongoose.

const path = require('path');
const C = require(path.join('..', 'crewClubs.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

console.log('\n the ladder a VA starts with');
{
    const out = C.normalizeClubs(undefined);
    T('a VA that has never opened this has five clubs', out.length, 5);
    T('…named the words a pilot already knows', out.map((c) => c.name),
        ['Standard', 'Bronze', 'Silver', 'Gold', 'Platinum']);
    T('…reachable from zero hours', out[0].minHours, 0);
    T('…and NOTHING is being given away', C.hasBenefits(undefined), false);
    T('an empty list is the same as no list', C.normalizeClubs([]).length, 5);

    const messy = C.normalizeClubs([
        { name: 'Top', minHours: 900, earnBonus: 25 },
        { name: '', minHours: 10 },
        { name: 'Base', minHours: 40 },
    ]);
    T('a nameless club is dropped', messy.length, 2);
    T('…and the rest are sorted by hours', messy.map((c) => c.name), ['Base', 'Top']);
    T('…with the bottom pulled down to zero, whatever was typed', messy[0].minHours, 0);
    T('a rate of 1e9 is clamped rather than saved',
        C.normalizeClubs([{ name: 'A' }, { name: 'B', earnBonus: 1e9 }])[1].earnBonus, C.MAX_BONUS);
    T('…as is a window of a year',
        C.normalizeClubs([{ name: 'A' }, { name: 'B', earlyHours: 99999 }])[1].earlyHours, C.MAX_EARLY_HOURS);
    T('a VA cannot run forty clubs',
        C.normalizeClubs(Array.from({ length: 40 }, (_, i) => ({ name: `C${i}`, minHours: i }))).length, C.MAX_CLUBS);

    // Two rows with one key is one club with a name nobody can predict.
    const dupes = C.normalizeClubs([
        { key: 'gold', name: 'Gold', minHours: 0 },
        { key: 'gold', name: 'Gold Plus', minHours: 100 },
    ]);
    T('a duplicated key is renamed rather than dropped', dupes.length, 2);
    T('…and the two keys differ', dupes[0].key !== dupes[1].key, true);
}

console.log('\n where a pilot stands');
{
    const ladder = C.normalizeClubs(undefined);
    T('a pilot on their first day is in a club', C.clubFor(ladder, 0).key, 'standard');
    T('…and so is one with negative hours, whatever produced those', C.clubFor(ladder, -5).key, 'standard');
    T('crossing a line is crossing it', C.clubFor(ladder, 25).key, 'bronze');
    T('…and one hour short is not', C.clubFor(ladder, 24.9).key, 'standard');
    T('the top is reachable', C.clubFor(ladder, 500).key, 'platinum');
    T('…and nothing above it', C.clubFor(ladder, 50000).key, 'platinum');

    // Climbing must never move anybody DOWN.
    let last = -1;
    let fell = 0;
    for (let h = 0; h <= 700; h += 5) {
        const at = C.clubIndex(ladder, C.clubFor(ladder, h).key);
        if (at < last) fell++;
        last = at;
    }
    T('flying more never demotes anybody', fell, 0);

    const mid = C.memberClub(ladder, 120);
    T('the club knows where it sits', [mid.index, mid.of], [2, 5]);
    T('…and what is next', mid.next.name, 'Gold');
    T('…and how far off it is', mid.next.hoursAway, 130);
    T('at the top there is no next — an arrival, not an empty bar',
        C.memberClub(ladder, 900).next, null);
}

console.log('\n what a club is worth');
{
    T('a club that gives nothing says nothing', C.benefitsOf({ name: 'Standard' }).length, 0);
    const all = C.benefitsOf({ earnBonus: 15, earlyHours: 48, priority: true });
    T('…and one that gives everything says three things', all.length, 3);
    T('…the bonus first, because it is the one that compounds', all[0].kind, 'earn');
    T('a long window is said in days rather than hours', all[1].label, "2 days' early access to the shop");
    T('…and a short one in hours',
        C.benefitsOf({ earlyHours: 6 })[0].label, '6h early access to the shop');

    T('no bonus, no change', C.payWithClub(1000, { earnBonus: 0 }), 1000);
    T('a bonus is a percentage of the whole flight', C.payWithClub(1000, { earnBonus: 15 }), 1150);
    T('…rounded once, at the end', C.payWithClub(333, { earnBonus: 15 }), 383);
    T('a flight worth nothing is still worth nothing', C.payWithClub(0, { earnBonus: 20 }), 0);
    T('no club is not a penalty', C.payWithClub(1000, null), 1000);
    T('a bonus cannot be a lottery', C.payWithClub(1000, { earnBonus: 1e6 }), 2000);
    T('…nor a fine', C.payWithClub(1000, { earnBonus: -50 }), 1000);
}

console.log('\n early access to the shelf');
{
    const HOUR = 3600000;
    const now = Date.UTC(2026, 8, 16, 12, 0, 0);
    // Platinum 48h, Gold 24h. The item is held back 48 hours in total; Gold
    // joins after 24; everybody else at 48.
    const ladder = C.normalizeClubs([
        { key: 'standard', name: 'Standard', minHours: 0 },
        { key: 'silver', name: 'Silver', minHours: 100 },
        { key: 'gold', name: 'Gold', minHours: 250, earlyHours: 24 },
        { key: 'platinum', name: 'Platinum', minHours: 500, earlyHours: 48 },
    ]);
    const item = (hoursOld) => ({ _id: 'i1', createdAt: new Date(now - hoursOld * HOUR).toISOString() });
    const see = (clubKey, hoursOld) => C.accessTo(ladder, item(hoursOld), { clubKey, now });

    T('brand new: only the top club', see('platinum', 0).open, true);
    T('…and it is marked as early, so the shelf can say so', see('platinum', 0).early, true);
    T('…Gold cannot have it yet', see('gold', 0).open, false);
    T('…nor Standard', see('standard', 0).open, false);
    T('…and a shut tile names the club that could have it', see('standard', 0).needs.name, 'Platinum');
    T('…and when it opens to everybody',
        see('standard', 0).opensAt.toISOString(), new Date(now + 48 * HOUR).toISOString());

    T('a day later Gold joins', see('gold', 25).open, true);
    T('…Standard still waits', see('standard', 25).open, false);
    T('…and is now told Gold is the bar', see('standard', 25).needs.name, 'Gold');

    T('after the window it is everybody’s', see('standard', 49).open, true);
    T('…and nothing is marked early any more', see('platinum', 49).early, false);

    T('staff always see what they just added',
        C.accessTo(ladder, item(0), { clubKey: 'standard', canManage: true, now }).open, true);
    T('a ladder with no early access holds nothing back',
        C.accessTo(C.normalizeClubs(undefined), item(0), { clubKey: 'standard', now }).open, true);
    T('…and has no opening time to quote',
        C.opensAt(C.normalizeClubs(undefined), item(0)), null);
    T('an item with no date on it is not held back',
        C.accessTo(ladder, { _id: 'x' }, { clubKey: 'standard', now }).open, true);
    T('a shelf a year old is unaffected by turning this on', see('standard', 24 * 400).open, true);
    T('hours work where a key is not to hand',
        C.accessTo(ladder, item(0), { hours: 900, now }).open, true);
}

console.log('\n gates lapse rather than close');
{
    const ladder = C.normalizeClubs(undefined);
    T('nothing required is open to everybody', C.meetsClub(ladder, 'standard', ''), true);
    T('a club at the bar is in', C.meetsClub(ladder, 'gold', 'gold'), true);
    T('…and above it', C.meetsClub(ladder, 'platinum', 'gold'), true);
    T('…and below it is not', C.meetsClub(ladder, 'silver', 'gold'), false);
    // A VA deleting a club must not quietly shut a shelf nobody can reopen.
    T('a club that no longer exists lapses its gate',
        C.meetsClub(ladder, 'standard', 'emerald'), true);
}

console.log('\n what to offer a VA who has set none of this');
{
    const offered = C.suggestedBenefits(undefined);
    T('the offer is the ladder they already have', offered.length, 5);
    T('the bottom club gets nothing — a benefit everybody has is a rate change',
        [offered[0].earnBonus, offered[0].earlyHours, offered[0].priority], [0, 0, false]);
    T('…and the top gets the most', offered[4].earnBonus, 20);
    let fell = 0;
    for (let i = 1; i < offered.length; i++) if (offered[i].earnBonus < offered[i - 1].earnBonus) fell++;
    T('…and it climbs all the way up', fell, 0);
    T('offering is not writing — the defaults are untouched', C.hasBenefits(undefined), false);

    // A VA that renamed, added or deleted clubs still gets an offer that climbs
    // in the right order and tops out on the top club.
    const seven = C.suggestedBenefits(Array.from({ length: 7 }, (_, i) => ({ name: `C${i}`, minHours: i * 50 })));
    T('a seven-club ladder still tops out on its top club', seven[6].earnBonus, 20);
    T('…and still gives its bottom one nothing', seven[0].earnBonus, 0);
    const two = C.suggestedBenefits([{ name: 'A' }, { name: 'B', minHours: 50 }]);
    T('a two-club ladder gives the top one the top offer', two[1].earnBonus, 20);
    T('a one-club ladder has nothing to offer', C.suggestedBenefits([{ name: 'Only' }])[0].earnBonus, 0);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
