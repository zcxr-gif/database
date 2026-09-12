// test-crew-shop-awards.js
// The v15 decision modules, without a database.
//
// crewShop, crewAwards, crewHealth and crewRetention's leave rule are all pure:
// they are handed a roster, a flight log and a VA's settings and return an
// answer. That is deliberate (see each file's header) and it is what makes the
// rules assertable here rather than only against somebody's Supabase project.
//
// What this does NOT cover, on purpose: the arithmetic that moves a balance. It
// lives in the VA's own database — crew_shop_buy and crew_shop_credit — because
// a debit that re-reads the price and tests the balance in one statement is the
// only kind that cannot be raced. There is nothing here to fake that would prove
// anything about it.
//
// Run:  node scripts/test-crew-shop-awards.js
'use strict';

const crewShop = require('../crewShop');
const crewAwards = require('../crewAwards');
const crewHealth = require('../crewHealth');
const crewRetention = require('../crewRetention');

let pass = 0;
const fails = [];
const check = (what, ok) => { if (ok) pass++; else fails.push(what); };

const DAY = 86400000;
const NOW = Date.UTC(2026, 0, 15);
const daysAgo = (n) => new Date(NOW - (n * DAY)).toISOString();

/* ---------------------------------------------------------------- settings */

{
    const off = crewShop.normalizeSettings(undefined);
    check('a VA that has never opened the screen has the shop off', off.enabled === false);
    check('…and pays nothing', Object.values(off.earn).every((v) => v === 0));
    check('…and the currency has a name rather than an empty string', off.currency.name === 'Points');

    const typo = crewShop.normalizeSettings({ enabled: true, earn: { perHour: 1e9 } });
    check('a rate of 1e9 is clamped rather than saved', typo.earn.perHour === 100000);
    const neg = crewShop.normalizeSettings({ earn: { perHour: -50 } });
    check('a negative rate floors at zero', neg.earn.perHour === 0);
    const junk = crewShop.normalizeSettings({ earn: { perLanding: 'twelve' } });
    check('a rate that is not a number is zero, not NaN', junk.earn.perLanding === 0);
}

{
    // The merge is what stops "turn it off" zeroing every rate on the way out.
    const saved = crewShop.toRecord({ enabled: true, earn: { perHour: 120, perLanding: 25 } }, null);
    check('rates save flat onto the VA record', saved.perHour === 120 && saved.perLanding === 25);
    const off = crewShop.toRecord({ enabled: false }, saved);
    check('turning the shop off keeps the rates', off.perHour === 120 && off.enabled === false);
    const renamed = crewShop.toRecord({ currency: { name: 'Miles', short: 'mi' } }, off);
    check('renaming the currency keeps the rates and the off switch',
        renamed.currencyShort === 'mi' && renamed.perHour === 120 && renamed.enabled === false);
}

/* ------------------------------------------------------------- what it pays */

{
    const rates = { perHour: 120, perLanding: 25, fleetBonus: 30, violationPenalty: 50 };
    // 2h15 = 2.25h. 2.25*120 + 25 + 30 = 325.
    const flight = { durationMin: 135, landings: 1, violations: 0, inFleet: true };
    check('a 2h15 flight in the VA’s own colours pays the worked example',
        crewShop.earnFor(flight, rates) === 325);
    check('the server’s worked example is the same arithmetic', crewShop.examplePay(rates) === 325);
    check('out of fleet loses exactly the fleet bonus',
        crewShop.earnFor({ ...flight, inFleet: false }, rates) === 295);
    check('a violation costs exactly the penalty',
        crewShop.earnFor({ ...flight, violations: 1 }, rates) === 275);
    check('more violations than the flight was worth pays nothing rather than taking a balance',
        crewShop.earnFor({ ...flight, violations: 40 }, rates) === 0);
    check('a VA with no rates set pays nothing for a real flight',
        crewShop.earnFor(flight, {}) === 0);
}

{
    const member = { _id: 'm1', name: 'Rae', callsign: 'BAW22', createdAt: daysAgo(400), points: { balance: 1200, earned: 3000, spent: 1800 } };
    const w = crewShop.wallet(member, { rank: 'Captain' });
    check('the card carries the balance the roster row holds', w.balance === 1200);
    check('…and the lifetime figures separately from it', w.earned === 3000 && w.spent === 1800);
    check('a pilot with no roster row has no card at all, rather than a zeroed one',
        crewShop.wallet(null) === null);
    check('a pre-v15 roster row reads as zero rather than NaN',
        crewShop.wallet({ _id: 'm2' }).balance === 0);
}

/* -------------------------------------------------------------------- awards */

{
    const member = { _id: 'm1', name: 'Rae' };
    const flight = (n, extra) => ({
        status: 'approved', memberId: 'm1', durationMin: 120, landings: 1,
        origin: 'EGLL', destination: `EG${String(n).padStart(2, '0')}`,
        flownAt: daysAgo(300 - n), ...extra,
    });

    const none = crewAwards.forMember({ member, pireps: [] });
    check('a pilot who has never flown has earned nothing', none.earned.length === 0);
    check('…and every locked badge still says what it takes',
        Object.keys(none.progress).length === crewAwards.CATALOG.length);
    check('…and the first one reads 0 of 1', none.progress['first-flight'].have === 0);

    const one = crewAwards.forMember({ member, pireps: [flight(1)] });
    check('one approved flight earns the first badge',
        one.earned.some((e) => e.id === 'first-flight'));
    check('…dated to the flight, not to now',
        one.earned.find((e) => e.id === 'first-flight').at === daysAgo(299));

    const twelve = crewAwards.forMember({ member, pireps: Array.from({ length: 12 }, (_, i) => flight(i + 1)) });
    check('ten flights earns the ten-flight badge', twelve.earned.some((e) => e.id === 'flights-10'));
    check('…and it is dated to the TENTH flight, not the twelfth',
        twelve.earned.find((e) => e.id === 'flights-10').at === daysAgo(300 - 10));
    check('twenty-four hours flown earns the ten-hour badge', twelve.earned.some((e) => e.id === 'hours-10'));
    check('a locked badge reports progress toward it',
        twelve.progress['flights-50'].have === 12 && twelve.progress['flights-50'].need === 50);
    check('progress rounds DOWN, so 24.x hours is not shown as 25',
        twelve.progress['hours-50'].have === 24);

    const pending = crewAwards.forMember({ member, pireps: [flight(1), { ...flight(2), status: 'pending' }] });
    check('a pending report counts for nothing', pending.progress['flights-10'].have === 1);
    const somebodyElse = crewAwards.forMember({ member, pireps: [{ ...flight(1), memberId: 'm2' }] });
    check('another pilot’s flights count for nothing', somebodyElse.earned.length === 0);

    const long = crewAwards.forMember({ member, pireps: [flight(1), flight(2, { durationMin: 9 * 60 })] });
    check('long haul is one flight over eight hours, not eight hours of flying',
        long.earned.some((e) => e.id === 'long-haul'));
    const short = crewAwards.forMember({ member, pireps: Array.from({ length: 6 }, (_, i) => flight(i + 1)) });
    check('…and twelve hours in six legs does not earn it',
        !short.earned.some((e) => e.id === 'long-haul'));

    const viaIf = crewAwards.forMember({
        member: { _id: 'm1', ifUserId: 'if-9' },
        pireps: [{ ...flight(1), memberId: null, ifUserId: 'if-9' }],
    });
    check('a flight captured before the roster row was linked still counts',
        viaIf.earned.some((e) => e.id === 'first-flight'));
}

/* -------------------------------------------------------------- crew health */

{
    const pilot = (id, extra) => ({ _id: id, name: id, status: 'active', createdAt: daysAgo(200), ...extra });
    const flew = (id, agoDays) => ({ status: 'approved', memberId: id, durationMin: 60, flownAt: daysAgo(agoDays) });

    const members = [
        pilot('regular'),                                   // flying happily
        pilot('quiet'),                                     // flew a lot, stopped
        pilot('newbie', { createdAt: daysAgo(30) }),        // joined, never filed
        pilot('yesterday', { createdAt: daysAgo(1) }),      // joined this week
        pilot('away', { status: 'loa', loaUntil: daysAgo(-20), loaReason: 'Exams' }),
        pilot('backAlready', { status: 'loa', loaUntil: daysAgo(10) }),
        pilot('gone', { status: 'inactive' }),
    ];
    const pireps = [
        ...[2, 6, 10, 14].map((d) => flew('regular', d)),
        ...[70, 76, 84, 92].map((d) => flew('quiet', d)),
        ...[70, 76, 84].map((d) => flew('backAlready', d)),
    ];
    const g = crewHealth.groups({ members, pireps, rules: {}, now: NOW });
    const ids = (list) => list.map((r) => r.id);

    check('a pilot who is still flying is on no list', !ids(g.quiet).includes('regular'));
    check('a pilot who flew regularly and stopped is going quiet', ids(g.quiet).includes('quiet'));
    check('a pilot who joined a month ago and never filed never started', ids(g.never).includes('newbie'));
    check('a pilot who joined yesterday is not accused of anything', ids(g.never).includes('yesterday') === false);
    check('a pilot on leave is on the away list and nowhere else',
        ids(g.away).includes('away') && !ids(g.quiet).includes('away'));
    check('leave that has run out stops being leave',
        !ids(g.away).includes('backAlready') && ids(g.quiet).includes('backAlready'));
    check('somebody already marked inactive is not chased', !JSON.stringify(g).includes('"gone"'));
    check('every row carries eight weeks of shape',
        g.quiet.every((r) => Array.isArray(r.weeks) && r.weeks.length === crewHealth.SPARK_WEEKS));
    check('the shape is empty for somebody who has not flown in eight weeks',
        g.quiet.find((r) => r.id === 'quiet').weeks.every((n) => n === 0));

    // The sweep's window is the VA's own, not a number of ours.
    const swept = crewHealth.groups({
        members, pireps, now: NOW,
        rules: { enabled: true, inactivity: true, inactivityDays: 75, inactivityAction: 'inactive' },
    });
    check('with a 75-day sweep, the quiet pilot is nearly out instead',
        ids(swept.edge).includes('quiet') && !ids(swept.quiet).includes('quiet'));
    check('…and the board says how long they have', swept.edge.find((r) => r.id === 'quiet').removedInDays <= 14);
    check('a pilot on leave is still not swept', ids(swept.away).includes('away'));

    const empty = crewHealth.groups({ members: [pilot('regular')], pireps: [flew('regular', 2)], now: NOW });
    check('an airline where everybody is flying has four empty lists',
        !empty.quiet.length && !empty.never.length && !empty.edge.length && !empty.away.length);
}

/* ------------------------------------------- leave, against the roster sweep */

{
    const rules = { enabled: true, inactivity: true, inactivityDays: 30, inactivityAction: 'remove' };
    const base = { _id: 'p', name: 'Sam', createdAt: daysAgo(300) };
    const pireps = [{ status: 'approved', memberId: 'p', durationMin: 60, flownAt: daysAgo(90) }];

    const unprotected = crewRetention.assess({ members: [{ ...base, status: 'active' }], pireps, rules, now: NOW });
    check('a pilot 90 days silent is due for removal', unprotected.inactivityDue.length === 1);

    const onLeave = crewRetention.assess({
        members: [{ ...base, status: 'loa', loaUntil: daysAgo(-20) }], pireps, rules, now: NOW,
    });
    check('the same pilot, away until next month, is exempt', onLeave.inactivityDue.length === 0);
    check('…and the sweep says why', onLeave.exempt[0].reason === 'loa');

    const expired = crewRetention.assess({
        members: [{ ...base, status: 'loa', loaUntil: daysAgo(5) }], pireps, rules, now: NOW,
    });
    check('leave that ended five days ago no longer exempts them', expired.inactivityDue.length === 1);

    const openEnded = crewRetention.assess({
        members: [{ ...base, status: 'loa' }], pireps, rules, now: NOW,
    });
    check('leave with no date — every hand-set one from before v15 — behaves as it always did',
        openEnded.inactivityDue.length === 0);
}

/* ------------------------------------------------------------------- report */

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL  ' + f);
process.exit(fails.length ? 1 : 0);
