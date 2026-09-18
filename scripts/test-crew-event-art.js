// test-crew-event-art.js
// When an event's picture stops being ours to keep. No bucket, no database.
//
// A VA now UPLOADS an event banner instead of pasting a URL, which means we
// hold the file — and holding it means agreeing to let it go. The rule that
// decides when is crewEvents.bannerExpired, and it is pure precisely so that
// "what will the sweep delete tonight?" is a question with an answer here
// rather than only against somebody's live S3 bucket.
//
// The three guards are the whole point of this file, because each one, if it
// broke, would destroy something nobody could get back:
//
//   * a banner we do NOT host is never expired — a VA who linked their own
//     website's artwork years ago keeps it, and the row is never blanked.
//   * an event with no date is never expired — that is a draft somebody is
//     part way through writing, and the picture is the one they just picked.
//   * an event inside its grace is never expired — "look what we flew on
//     Saturday" needs its picture on the following weekend.
//
// Run:  node scripts/test-crew-event-art.js
'use strict';

/* crewStore requires axios at load time and nothing here makes a request — the
 * client is replaced wholesale. So where the dependency is not installed, a
 * stub is put in its place just far enough to let the module load; where axios
 * IS installed the real one loads, so this cannot hide an import problem. The
 * same shim scripts/test-crew-purge.js uses, and for the same reason. */
(function shimAxiosIfAbsent() {
    try { require.resolve('axios'); return; } catch (_) { /* not installed */ }
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request) {
        if (request === 'axios') { const nope = () => Promise.reject(new Error('axios is stubbed')); nope.default = nope; return nope; }
        return load.apply(this, arguments);
    };
})();

const crewEvents = require('../crewEvents');
const { SupabaseStore } = require('../crewStore');

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

const HOST = 'inflight-bucket.s3.eu-west-2.amazonaws.com';
const ours = (n) => `https://${HOST}/va-ads/banner/abc-${n}.webp`;
const theirs = 'https://someairline.example/img/fly-in.png';

// A Thursday at midday, so every date below sits clear of a boundary.
const NOW = Date.UTC(2026, 1, 12, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const daysAhead = (n) => new Date(NOW + n * DAY).toISOString();

const expired = (e, opts) => crewEvents.bannerExpired(e, { now: NOW, bucketHost: HOST, ...(opts || {}) });

/* ------------------------------------------------------------ what is ours */
{
    check('a banner on our bucket is ours', crewEvents.hostedBanner(ours(1), HOST));
    check('a banner on somebody else’s host is not', !crewEvents.hostedBanner(theirs, HOST));
    check('no banner at all is not', !crewEvents.hostedBanner('', HOST));

    // The three shapes a prefix or substring check would get wrong. Each of
    // these is a URL an attacker controls that "contains" our bucket name.
    check('a host that merely ENDS with our name is not ours',
        !crewEvents.hostedBanner(`https://evil-${HOST}/x.webp`, HOST));
    check('our name in the PATH is not ours',
        !crewEvents.hostedBanner(`https://evil.example/${HOST}/x.webp`, HOST));
    check('our name in the QUERY is not ours',
        !crewEvents.hostedBanner(`https://evil.example/x.webp?u=${HOST}`, HOST));
    check('our name as a USERINFO prefix is not ours',
        !crewEvents.hostedBanner(`https://${HOST}@evil.example/x.webp`, HOST));

    check('http is never ours, whatever the host',
        !crewEvents.hostedBanner(`http://${HOST}/x.webp`, HOST));
    check('nonsense is not a URL and is not ours',
        !crewEvents.hostedBanner('not a url at all', HOST));

    // A deployment with no bucket configured cannot tell what it hosts, and
    // must therefore never conclude that it hosts something.
    check('with no bucket configured, nothing is ours', !crewEvents.hostedBanner(ours(1), ''));
    check('…so nothing can expire either',
        !crewEvents.bannerExpired({ bannerUrl: ours(1), startsAt: daysAgo(400) }, { now: NOW, bucketHost: '' }));
}

/* --------------------------------------------------------- when it finished */
{
    check('an event ends when it says it ends',
        crewEvents.eventEndedAt({ startsAt: daysAgo(3), endsAt: daysAgo(2) })
            === Date.parse(daysAgo(2)));
    check('…and at its start where it never said',
        crewEvents.eventEndedAt({ startsAt: daysAgo(3) }) === Date.parse(daysAgo(3)));
    check('an event with no dates has no end', crewEvents.eventEndedAt({}) === null);
    check('…and neither has one with a date nobody can parse',
        crewEvents.eventEndedAt({ startsAt: 'next Thursday-ish' }) === null);
}

/* ------------------------------------------------------------- the deletion */
{
    check('a fly-in from two months ago has had its week',
        expired({ bannerUrl: ours(1), startsAt: daysAgo(60) }));
    check('one that ran yesterday has not',
        !expired({ bannerUrl: ours(2), startsAt: daysAgo(1) }));
    check('one that has not happened yet certainly has not',
        !expired({ bannerUrl: ours(3), startsAt: daysAhead(9) }));

    // The grace is the whole of the promise made on the form — "about a week
    // after the event" — so both sides of it are asserted.
    check('six days after is still inside the grace',
        !expired({ bannerUrl: ours(4), startsAt: daysAgo(6) }));
    check('eight days after is outside it',
        expired({ bannerUrl: ours(5), startsAt: daysAgo(8) }));

    // A long event is over when it ENDS, not when it starts. An overnight
    // group flight published as a ten-day expedition would otherwise lose its
    // artwork while it was still running.
    check('a long event is measured from its end, not its start',
        !expired({ bannerUrl: ours(6), startsAt: daysAgo(12), endsAt: daysAgo(2) }));
    check('…and does expire once the end has had its week too',
        expired({ bannerUrl: ours(7), startsAt: daysAgo(30), endsAt: daysAgo(9) }));
}

/* ------------------------------------------------- what is never swept away */
{
    check('a link to somebody else’s host is never expired, however old',
        !expired({ bannerUrl: theirs, startsAt: daysAgo(900) }));
    check('an event with no picture has nothing to expire',
        !expired({ bannerUrl: '', startsAt: daysAgo(900) }));

    // The draft guard. A staff member writing an event has uploaded the
    // picture before choosing the date; a rule that could not tell this apart
    // from an old event would delete their work as they typed.
    check('a dateless draft keeps the picture just uploaded to it',
        !expired({ bannerUrl: ours(8), startsAt: null, status: 'draft' }));
    check('…even when the crew center has been running for years',
        !expired({ bannerUrl: ours(9) }, { graceMs: 0 }));

    // A cancelled event is still a date in the calendar, and its artwork goes
    // on the same clock — not sooner, because pilots who signed up are still
    // reading the card, and not never.
    check('a cancelled event still inside its grace keeps its picture',
        !expired({ bannerUrl: ours(10), startsAt: daysAgo(2), status: 'cancelled' }));
    check('…and loses it on the same clock as any other',
        expired({ bannerUrl: ours(11), startsAt: daysAgo(20), status: 'cancelled' }));

    check('nothing at all is not expired', !expired(null));
}

/* -------------------------------------------------------- the grace is ours */
{
    // The sweep passes its own grace through, so a deployment that wanted a
    // different one — or a test that wants none — gets it honoured.
    check('a zero grace expires the moment the event is over',
        expired({ bannerUrl: ours(12), startsAt: daysAgo(1) }, { graceMs: 0 }));
    check('…but still not before it is over',
        !expired({ bannerUrl: ours(13), startsAt: daysAhead(1) }, { graceMs: 0 }));
    check('a negative grace is read as none rather than as time travel',
        !expired({ bannerUrl: ours(14), startsAt: daysAhead(1) }, { graceMs: -90 * DAY }));
    check('the default grace is the week the form promises',
        crewEvents.EVENT_ART_GRACE_MS === 7 * DAY, crewEvents.EVENT_ART_GRACE_MS);
}

/* ------------------------------------------ what the sweep even looks at */
//
// The rule above decides what to delete; this decides what the rule is ever
// SHOWN. A filter the wrong way round here would hand `bannerExpired` a list of
// events that have not happened yet — and every guard above would pass while
// the sweep took down the artwork for next weekend's fly-in.
{
    const calls = [];
    const store = Object.create(SupabaseStore.prototype);
    store.slug = 'testva';
    store.db = { select: (table, params) => { calls.push({ table, params }); return Promise.resolve([]); } };

    const CUTOFF = NOW - 7 * DAY;
    store.listEventsWithBanner({ startedBefore: CUTOFF }).then(() => {
        const c = calls[0] || { params: {} };
        check('the sweep reads the events table', c.table === 'crew_events', c.table);
        check('…only this airline’s rows', c.params.va_slug === 'eq.testva', c.params.va_slug);
        check('…only rows that actually carry a banner', c.params.banner_url === 'neq.', c.params.banner_url);
        check('…and only ones that started BEFORE the cutoff',
            c.params.starts_at === `lt.${new Date(CUTOFF).toISOString()}`, c.params.starts_at);

        report();
    }, (err) => { fails.push('the sweep query threw: ' + err.message); report(); });
}

/* ------------------------------------------------------------------- report */

function report() {
console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL  ' + f);
process.exit(fails.length ? 1 : 0);
}
