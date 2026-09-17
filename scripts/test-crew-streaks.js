// test-crew-streaks.js
// The streak, and the rates that were added alongside it. No database.
//
// crewStreaks is pure by design (see its header): handed some flights and some
// settings it says how long a run is and what that is worth, and every decision
// in it — where a week starts, that the current week never breaks a run, that
// leave freezes one, that a milestone fires on the crossing — is assertable
// here rather than only against somebody's Supabase project.
//
// What this does NOT cover, on purpose: the payment itself. It happens in the
// VA's own database, in crew_shop_credit, which is what guarantees one payment
// per flight. There is nothing here to fake that would prove anything about it.
//
// Run:  node scripts/test-crew-streaks.js
'use strict';

const crewStreaks = require('../crewStreaks');
const crewShop = require('../crewShop');

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

// A Thursday, so "this week" has days either side of it in every assertion
// below and nothing accidentally passes by sitting on a boundary.
const NOW = Date.UTC(2026, 1, 12, 12, 0, 0);
const HERE = crewStreaks.weekIndex(NOW);

/** An approved flight in the week `n` weeks before this one. */
const inWeek = (back, id) => ({
    _id: id || `f${back}`,
    status: 'approved',
    // Wednesday of that week — away from both edges.
    flownAt: new Date(crewStreaks.weekStart(HERE - back).getTime() + 2 * 86400000 + 36e5).toISOString(),
});

/* ------------------------------------------------------------------- weeks */

{
    const mon = Date.UTC(2026, 1, 9);          // Monday
    const sun = Date.UTC(2026, 1, 15, 23, 59); // the Sunday after it
    check('a Monday and the Sunday after it are one week',
        crewStreaks.weekIndex(mon) === crewStreaks.weekIndex(sun));
    check('…and the Sunday before is the week before',
        crewStreaks.weekIndex(Date.UTC(2026, 1, 8, 23, 0)) === crewStreaks.weekIndex(mon) - 1);
    check('a week opens on a Monday, in UTC',
        crewStreaks.weekStart(crewStreaks.weekIndex(mon)).getUTCDay() === 1);
    check('…and closes exactly a week later',
        crewStreaks.weekEnd(HERE) - crewStreaks.weekStart(HERE) === 7 * 86400000);

    /* The timezone question, and the reason the answer is UTC: two pilots
       filing the same flight from opposite sides of the world must be on the
       same week, or a streak holds or breaks depending on where somebody is
       standing. */
    check('the week is the same number either side of the dateline',
        crewStreaks.weekIndex('2026-02-12T23:00:00Z') === crewStreaks.weekIndex('2026-02-12T01:00:00Z'));

    check('a report with no date at all is not counted as a week',
        crewStreaks.weeksFlown([{ status: 'approved' }]).size === 0);
    check('a pending report is not a week flown',
        crewStreaks.weeksFlown([{ ...inWeek(1), status: 'pending' }]).size === 0);
    check('…nor a rejected one',
        crewStreaks.weeksFlown([{ ...inWeek(1), status: 'rejected' }]).size === 0);
    check('a report with no flown date falls back to when it was filed',
        crewStreaks.weeksFlown([{ status: 'approved', createdAt: new Date(NOW).toISOString() }]).size === 1);
}

/* ------------------------------------------------------------- the counting */

const streak = (flights, opts) => crewStreaks.streakFrom(flights, { now: NOW, ...(opts || {}) });

{
    check('a pilot who has never flown is on no streak', streak([]).weeks === 0);
    check('one flight this week is a one-week streak', streak([inWeek(0)]).weeks === 1);

    const four = [inWeek(0), inWeek(1), inWeek(2), inWeek(3)];
    check('four weeks back to back is a four-week streak', streak(four).weeks === 4, streak(four).weeks);
    check('two flights in one week are still one week',
        streak([inWeek(0, 'a'), inWeek(0, 'b'), inWeek(1)]).weeks === 2);

    /* THE ONE THAT MATTERS MOST. Opening the crew center on Monday morning
       must not tell somebody with six days left to fly that they have lost a
       streak — it is the single most common way this feature is built wrong. */
    const lastWeek = [inWeek(1), inWeek(2), inWeek(3)];
    const s = streak(lastWeek);
    check('a run that has not been flown in yet THIS week is still alive', s.weeks === 3, s.weeks);
    check('…and says so: nothing flown this week', s.flownThisWeek === false);
    check('…and that it is the one at risk', s.atRisk === true);
    check('…with the deadline at the end of this week',
        s.endsAt.getTime() === crewStreaks.weekEnd(HERE).getTime());

    const flownNow = streak([inWeek(0), inWeek(1)]);
    check('flying this week moves the deadline to the end of next week',
        flownNow.endsAt.getTime() === crewStreaks.weekEnd(HERE + 1).getTime());
    check('…and nothing is at risk while this week is already flown', flownNow.atRisk === false);
    check('a pilot on no streak at all is not "at risk" of losing one',
        streak([]).atRisk === false);

    // The week before last, and nothing since: that run is over.
    check('a missed week ends the run', streak([inWeek(2), inWeek(3)]).weeks === 0);
    check('…and a gap in the middle only counts back to the gap',
        streak([inWeek(0), inWeek(1), inWeek(3), inWeek(4)]).weeks === 2);
}

{
    const history = [inWeek(0), inWeek(2), inWeek(3), inWeek(4), inWeek(5), inWeek(6)];
    const s = streak(history);
    check('a broken run still remembers the longest one', s.longest === 5, s.longest);
    check('…and the total number of weeks ever flown', s.totalWeeks === 6);
    check('the longest is never reported below the current one',
        streak([inWeek(0), inWeek(1)]).longest === 2);
}

/* --------------------------------------------------------------- the freeze */

{
    // Declared leave covering the last three whole weeks.
    const onLeave = {
        status: 'loa',
        loaSince: new Date(crewStreaks.weekStart(HERE - 3)).toISOString(),
        loaUntil: new Date(crewStreaks.weekEnd(HERE)).toISOString(),
    };
    const before = [inWeek(4), inWeek(5), inWeek(6)];

    check('leave holds a run rather than ending it',
        streak(before, { member: onLeave }).weeks === 3,
        streak(before, { member: onLeave }).weeks);
    check('…and a frozen week is not counted as flown either',
        streak(before, { member: onLeave }).weeks === 3);
    check('a VA that has turned the freeze off loses the run as normal',
        streak(before, { member: onLeave, freezeOnLeave: false }).weeks === 0);
    check('a pilot who is back on the roster gets no freeze',
        streak(before, { member: { ...onLeave, status: 'active' } }).weeks === 0);

    /* PART of a week inside leave is not a frozen week. Somebody who took
       Thursday to Sunday off was flying on the Monday. */
    const halfWeek = {
        status: 'loa',
        loaSince: new Date(crewStreaks.weekStart(HERE - 1).getTime() + 3 * 86400000).toISOString(),
        loaUntil: new Date(crewStreaks.weekEnd(HERE - 1)).toISOString(),
    };
    check('half a week of leave does not freeze that week',
        streak([inWeek(2), inWeek(3)], { member: halfWeek }).weeks === 0);

    const openEnded = { status: 'loa', loaSince: new Date(crewStreaks.weekStart(HERE - 2)).toISOString() };
    check('open-ended leave freezes up to now',
        streak([inWeek(3), inWeek(4)], { member: openEnded }).weeks === 2);
}

/* ------------------------------------------------------------- the settings */

{
    const off = crewStreaks.normalize(undefined);
    check('a VA that has never opened this screen pays nothing for a streak',
        off.perWeek === 0 && off.maxBonus === 0 && off.milestones.length === 0);
    check('…and the freeze is on, because leave must stay cheap to declare',
        off.freezeOnLeave === true);
    check('a VA with no settings does not "pay" for streaks', crewStreaks.pays(off) === false);

    const typo = crewStreaks.normalize({ perWeek: 1e9, maxBonus: 1e9 });
    check('a percentage of 1e9 is clamped rather than saved',
        typo.perWeek === crewStreaks.MAX_PER_WEEK && typo.maxBonus === crewStreaks.MAX_BONUS);

    const dupes = crewStreaks.normalize({
        milestones: [{ weeks: 12, bonus: 100 }, { weeks: 4, bonus: 50 }, { weeks: 12, bonus: 900 }],
    });
    check('two milestones at one week are one milestone', dupes.milestones.length === 2);
    check('…and it is the larger payment that is kept',
        dupes.milestones[1].bonus === 900, dupes.milestones);
    check('…sorted, so a list reads as a climb', dupes.milestones[0].weeks === 4);

    const saved = crewStreaks.toRecord({ perWeek: 3, maxBonus: 30, milestones: [{ weeks: 4, bonus: 300 }] }, null);
    const merged = crewStreaks.toRecord({ perWeek: 5 }, saved);
    check('changing one percentage keeps the milestones',
        merged.milestones.length === 1 && merged.perWeek === 5);
    check('sending an empty milestone list deletes them, because a replace is how you delete',
        crewStreaks.toRecord({ milestones: [] }, saved).milestones.length === 0);
}

/* ----------------------------------------------------------- what it is worth */

{
    const cfg = { perWeek: 3, maxBonus: 30 };
    check('one week is not a streak and pays nothing', crewStreaks.bonusFor(1, cfg) === 0);
    check('the first step lands at two weeks', crewStreaks.bonusFor(2, cfg) === 3);
    check('…and climbs a step a week', crewStreaks.bonusFor(6, cfg) === 15);
    check('…and stops at the cap', crewStreaks.bonusFor(200, cfg) === 30);
    check('the cap is reported as the week it is reached',
        crewStreaks.capAt(cfg) === 11 && crewStreaks.bonusFor(11, cfg) === 30);
    check('a VA that pays no percentage pays none however long the run',
        crewStreaks.bonusFor(100, { maxBonus: 50 }) === 0);
}

{
    const cfg = { milestones: [{ weeks: 4, bonus: 300 }, { weeks: 13, bonus: 1200 }] };
    check('the flight that crosses four weeks carries the milestone',
        (crewStreaks.milestoneCrossed(3, 4, cfg) || {}).bonus === 300);
    check('the next flight that week carries nothing',
        crewStreaks.milestoneCrossed(4, 4, cfg) === null);
    check('a run that never reaches one carries nothing',
        crewStreaks.milestoneCrossed(1, 2, cfg) === null);
    check('a run past one, still climbing, carries nothing',
        crewStreaks.milestoneCrossed(5, 6, cfg) === null);
    /* A backdated approval can fill a gap and jump a run several weeks at once.
       One moment pays one milestone, and it is the one the pilot will say they
       reached. */
    check('a flight that crosses two at once pays the higher, once',
        (crewStreaks.milestoneCrossed(2, 20, cfg) || {}).weeks === 13);
    check('a milestone set to nothing is not a milestone',
        crewStreaks.milestoneCrossed(3, 4, { milestones: [{ weeks: 4, bonus: 0 }] }) === null);
    check('the next one up is named while it is still ahead',
        crewStreaks.nextMilestone(5, cfg).weeks === 13);
    check('…and there is none above the last', crewStreaks.nextMilestone(52, cfg) === null);
}

/* ----------------------------------------------------- the suggested settings */

{
    const rates = { perHour: 120, perLanding: 25, fleetBonus: 30 };
    const unit = crewShop.examplePay(rates);               // one ordinary flight
    const s = crewStreaks.suggested(unit);

    check('there is a sensible set to start from', s.milestones.length === 4);
    check('…that pays a percentage as well as the milestones', crewStreaks.pays(s) === true);
    check('…and the weeks are lengths of time a person has a feeling about',
        s.milestones.map((m) => m.weeks).join() === '4,13,26,52');

    /* THE POINT OF PRICING IN FLIGHTS: a fixed number is a fortnight of flying
       to one airline and a lifetime to another. */
    const month = s.milestones[0];
    const year = s.milestones[3];
    check('a month of flying is worth about one flight',
        month.bonus >= unit * 0.9 && month.bonus <= unit * 1.1, month.bonus);
    check('…and a year of it about twenty-five',
        year.bonus >= unit * 22 && year.bonus <= unit * 28, year.bonus);
    check('a VA whose flights pay nothing is offered no milestone figures',
        crewStreaks.suggested(0).milestones.every((m) => m.bonus === 0));
}

/* --------------------------------------------------------------- on the wire */

{
    const cfg = crewStreaks.normalize({ perWeek: 3, maxBonus: 30, milestones: [{ weeks: 13, bonus: 1200 }] });
    const pub = crewStreaks.publicStreak(streak([inWeek(0), inWeek(1), inWeek(2)]), cfg);
    check('the card carries the run', pub.weeks === 3);
    check('…what it is paying right now', pub.bonus === 6);
    check('…and what one more week adds', pub.nextBonus === 9);
    check('…and how far the next milestone is', pub.next.weeks === 13 && pub.next.away === 10);
    check('the benefits read as sentences, like a club’s',
        pub.benefits.length === 2 && /every flight/.test(pub.benefits[0].label));

    const none = crewStreaks.publicStreak(streak([]), crewStreaks.normalize({}));
    check('an airline that pays nothing still tells a pilot their run',
        none.weeks === 0 && none.bonus === 0 && none.benefits.length === 0);
}

/* =======================================================================
 * THE RATES THAT ARRIVED WITH IT
 * ==================================================================== */

{
    const all = crewShop.normalizeSettings({}).earn;
    check('every rate in the list is normalized, so none can be silently dropped',
        crewShop.RATES.every((k) => all[k] === 0));

    /* THE BUG THIS SHAPE EXISTS TO PREVENT. The back office has offered an
       event bonus since the shop shipped; the normalizer listed four rates by
       hand, so it was typed, saved, and dropped on the way back out. */
    const rec = crewShop.toRecord({ enabled: true, earn: { eventBonus: 400 } }, null);
    check('an event bonus survives the trip to the VA record', rec.eventBonus === 400);
    check('…and back off it again', crewShop.fromRecord(rec).earn.eventBonus === 400);
}

{
    const rates = {
        perHour: 100, perLanding: 20, per100Nm: 5,
        fleetBonus: 50, routeBonus: 40, scheduleBonus: 30,
        eventBonus: 200, featuredBonus: 150, cleanBonus: 25,
        violationPenalty: 60,
    };
    // 2h = 200, one landing = 20, 500nm = 25. Nothing else set on the report.
    const plain = { durationMin: 120, landings: 1, distanceNm: 500, violations: 0 };
    check('an ordinary leg pays time, landings and distance',
        crewShop.earnFor(plain, rates) === 200 + 20 + 25 + 25, crewShop.earnFor(plain, rates));

    const each = (patch) => crewShop.earnFor({ ...plain, ...patch }, rates) - crewShop.earnFor(plain, rates);
    check('flying one of the airline’s own aircraft pays the fleet bonus', each({ inFleet: true }) === 50);
    check('a leg on the route network pays the route bonus', each({ routeId: 'r1' }) === 40);
    check('a rostered departure pays the schedule bonus', each({ scheduleId: 's1' }) === 30);
    check('an event flight pays the event bonus', each({ eventId: 'e1' }) === 200);
    check('the featured route pays the featured bonus', each({ isFeatured: true }) === 150);
    check('a violation costs the penalty and the clean bonus together',
        each({ violations: 1 }) === -(60 + 25));
    check('a leg with no landing is not a clean flight',
        crewShop.earnFor({ ...plain, landings: 0 }, rates) === 200 + 25);
    check('distance is per hundred miles, not per mile',
        crewShop.earnFor({ ...plain, distanceNm: 1000 }, rates)
            - crewShop.earnFor(plain, rates) === 25);
    check('more violations than the flight was worth still pays nothing rather than taking a balance',
        crewShop.earnFor({ ...plain, violations: 99 }, rates) === 0);

    const lines = crewShop.earnLines({ ...plain, inFleet: true, eventId: 'e1' }, rates);
    check('the working is shown line by line', lines.length === 6, lines.map((l) => l.key));
    check('…and the lines sum to the number that is paid',
        lines.reduce((n, l) => n + l.amount, 0) === crewShop.earnFor({ ...plain, inFleet: true, eventId: 'e1' }, rates));
    check('a rate a VA has not set does not appear as a nought line',
        crewShop.earnLines(plain, { perHour: 100 }).length === 1);
}

/* --------------------------------------------------- club and streak together */

{
    const rates = { perHour: 100 };
    const flight = { durationMin: 120, landings: 1 };   // 200 flat

    const plain = crewShop.payFor(flight, rates, {});
    check('a pilot in no club on no streak is paid the flight', plain.total === 200);

    const both = crewShop.payFor(flight, rates, {
        clubName: 'Gold', clubPercent: 20, streakWeeks: 11, streakPercent: 30,
    });
    /* THEY ADD, THEY DO NOT COMPOUND. 20% and 30% is 50%, not 56% — compounding
       is the shape nobody can do in their head, and it makes a club's value
       depend on something that has nothing to do with clubs. */
    check('a club bonus and a streak bonus add rather than compound', both.total === 300, both.total);
    check('…and both are shown separately, though they were applied together',
        both.lines.filter((l) => l.key === 'club' || l.key === 'streak').length === 2);
    check('…and the lines still sum to what is paid',
        both.lines.reduce((n, l) => n + l.amount, 0) === both.total);
    check('the streak line names the run, so the pilot can see where it came from',
        both.lines.find((l) => l.key === 'streak').label === '11-week streak');

    const milestone = crewShop.payFor(flight, rates, {
        clubPercent: 20, streakWeeks: 4, streakPercent: 9,
        milestone: { weeks: 4, bonus: 500 },
    });
    /* A milestone is the one thing in the economy that is not proportional to
       the flying, so it lands after the multipliers rather than inside them. */
    check('a milestone is added flat, not multiplied by the bonuses',
        milestone.total === Math.round(200 * 1.29) + 500, milestone.total);
    check('…and is reported separately from the percentages',
        milestone.milestone.weeks === 4 && milestone.milestone.bonus === 500);

    const swallowed = crewShop.payFor(
        { durationMin: 60, landings: 1, violations: 10 },
        { perHour: 100, violationPenalty: 60 },
        { clubPercent: 20 },
    );
    check('a flight swallowed by its penalties pays nothing, not a negative',
        swallowed.total === 0);
    check('…but the penalty line is still shown, so a VA can see what swallowed it',
        swallowed.lines.some((l) => l.key === 'violationPenalty' && l.amount < 0));
}

/* ------------------------------------------------------------------- report */

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL  ' + f);
process.exit(fails.length ? 1 : 0);
