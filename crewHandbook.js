'use strict';

/*
 * crewHandbook.js
 * A pilot handbook a VA can start from.
 *
 * WHY THIS EXISTS
 * ---------------
 * The document library has had a 'handbook' kind since v11 and ships empty, so
 * every VA that wants one writes it from nothing. The half they all write twice
 * is the same half: how signing in works, what the ranks mean, how to file a
 * flight, where the schedule is. That half is not the VA's — it is a
 * description of software we wrote, and we are the ones who know when it
 * changes.
 *
 * So this is the mechanical half, written once, and the VA supplies the half
 * that is actually theirs.
 *
 * IT ARRIVES AS A DRAFT, AND THAT IS NOT A TECHNICALITY
 * -----------------------------------------------------
 * Publishing it for them would put a document in their crew's hands, under
 * their airline's name, that they have never read. So it lands in the library
 * as a draft: staff read it, cut what does not apply, fill in the bracketed
 * parts, and publish it when it says what they want said.
 *
 * PLAIN TEXT, NOT MARKDOWN
 * ------------------------
 * The library renders a text document verbatim, keeping line breaks and nothing
 * else (see crewDocuments.js in the tracker — it is deliberately not parsed as
 * markdown or HTML, because a VA's manual is written by whoever has the
 * password). So the body below is written to be read exactly as it is typed:
 * no hashes, no asterisks, no syntax that only looks like formatting somewhere
 * else.
 *
 * EVERY CLAIM IS CHECKABLE
 * ------------------------
 * The handbook describes what the crew center actually does and nothing more.
 * Where a VA's own choice decides the answer — whether they run a shop, whether
 * check-rides are required, what their ranks are — it says so and leaves a
 * bracket rather than inventing a policy the VA never set. Anything in square
 * brackets is a question for the VA, and they are listed at the end so staff
 * can find them.
 */

const { CREW_TERMS_PAGE_PATH } = require('./crewTerms');

/** Nothing in the body should be able to break out of a plain-text field. */
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * The handbook, for one VA.
 *
 * @param {Object} opts
 * @param {string} [opts.vaName]  the airline's name, so it reads as theirs
 * @param {string} [opts.slug]    only used to build the terms link
 * @returns {{title, summary, kind, source, body, status, revision}}
 */
function starterHandbook(opts = {}) {
    const va = str(opts.vaName, 80) || 'the airline';
    // The site, not this API — same reason CREW_TERMS_PAGE_PATH is a site path.
    // Falls back to the public address rather than to a relative link: this
    // text is read inside a crew center, pasted into Discord, and printed.
    const base = String(process.env.CREW_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://inflight.info')
        .replace(/\/+$/, '');
    const terms = `${base}${CREW_TERMS_PAGE_PATH}`;

    const body = [
        `PILOT HANDBOOK — ${va}`,
        '',
        'This handbook covers how the crew center works. Your airline’s own rules —',
        'how often you must fly, what callsign to use, how to request leave — are set',
        'by staff, and anywhere this handbook does not know the answer it says so in',
        '[square brackets] for staff to fill in.',
        '',
        '',
        '1. YOUR ACCOUNT',
        '',
        'You did not sign yourself up. A crew center account is created for you by',
        'staff — either when your application is accepted, or afterwards if you were',
        'added to the roster first. There is no public sign-up and no way to create an',
        'account from the sign-in page.',
        '',
        'The password you were given was generated and handed to you, so the crew',
        'center asks you to change it the first time you sign in. Nobody holds a copy',
        'of your password, staff included: if you lose it, staff issue a new one, they',
        'cannot look up the old one.',
        '',
        'Signing in keeps you signed in for seven days.',
        '',
        '',
        '2. SIGNING IN WITH DISCORD',
        '',
        'You can link your Discord account and use the "Continue with Discord" button',
        'instead of typing a password.',
        '',
        'It is a second key to the account you already have. It is not a way to get an',
        'account, and being in the airline’s Discord server does not give you one: the',
        'button signs in an account that has already been linked, and nothing else.',
        '',
        'To link it: sign in with your password, open your account page, and press',
        '"Link Discord". You are sent to Discord, you approve it, and you come back.',
        'From then on the button signs you in.',
        '',
        'What gets stored is your Discord id, your display name and your avatar, so',
        'the crew center can recognise you and show who the link belongs to. We ask',
        'Discord for nothing else — not your email, not the servers you are in.',
        '',
        'You can unlink at any time from the same page. Your password still works',
        'afterwards.',
        '',
        'If you fly for more than one airline on Inflight, link separately at each.',
        'The link belongs to one crew center, and one Discord account opens one login',
        'within an airline.',
        '',
        '',
        '3. STAFF WHO ALSO FLY',
        '',
        'If you are on the staff team, your management login is a separate, central',
        'account — it is how you administer the airline. To fly as well, open your',
        'account page and set up your pilot side: it creates a pilot record of your',
        'own on this airline’s roster, so you can be booked onto departures, file',
        'flights, receive messages, and link Discord like anybody else.',
        '',
        'It is yours. You do not need a second username and password, and you do not',
        'need to borrow another pilot’s account. Signing in with Discord afterwards',
        'still signs you in as staff, with everything you manage intact.',
        '',
        '',
        '4. THE ROSTER, HOURS AND RANKS',
        '',
        'Your roster row carries the name and callsign you fly under, your credited',
        'hours and your status. Hours are credited when a flight report is approved.',
        '',
        'Rank is not stored — it is read off your hours against the airline’s ladder,',
        'so a promotion happens the moment the hours land. Some rungs can be set to',
        'require a check-ride: you reach the hours, you are marked as ready, and a',
        'staff member signs you off before the rank is yours.',
        '',
        `[Staff: list ${va}’s ranks and their requirements here, or point at where`,
        'they are published.]',
        '',
        '',
        '5. FLYING AND FILING',
        '',
        'A flight becomes hours by being filed as a report and approved by staff.',
        '',
        'You can file a flight yourself from the crew center. If your roster row is',
        'linked to your Infinite Flight account, staff can also run a sync that reads',
        'your recent Infinite Flight logbook and files flights it has not seen before,',
        'so a leg you flew under the airline’s callsign can end up on your record',
        'without you typing it in. The same flight is never filed twice.',
        '',
        '[Staff: say whether pilots file their own flights, rely on the sync, or both,',
        'and what you expect a report to include.]',
        '',
        '',
        '6. THE SCHEDULE, EVENTS AND THE ROUTE NETWORK',
        '',
        'Where the airline publishes them, you will find:',
        '',
        '- the route network — the legs the airline flies, some of which may be',
        '  gated on rank. A gated route is still shown, with what it takes to open it.',
        '- the schedule — departures you can book onto. A booking is yours until you',
        '  give it up.',
        '- events — flights the airline runs together, which you sign up for.',
        '',
        '',
        '7. DOCUMENTS, THE NOTICEBOARD AND YOUR INBOX',
        '',
        'The library holds the airline’s standing paperwork: manuals, SOPs, this',
        'handbook. Some documents can be gated on rank; a gated one is listed with',
        'the reason rather than hidden, so you can see it exists.',
        '',
        'The noticeboard is the airline talking to everybody. Your inbox is the',
        'airline talking to you — an accepted application, a booking, a check-ride.',
        '',
        '',
        '8. TIME OFF AND GOING QUIET',
        '',
        'Your status can be active, on leave, or inactive. Airlines that run a roster',
        'sweep warn pilots who have not flown inside their window before anything',
        'happens to their place on the roster.',
        '',
        `[Staff: say how much flying ${va} expects, over what period, how to ask for`,
        'leave, and what happens to a pilot who goes quiet.]',
        '',
        '',
        '9. WHAT IS EXPECTED',
        '',
        '- Keep your login to yourself. Anything done with it is recorded as you.',
        '- File flights you actually flew, as you actually flew them.',
        '- Follow the airline’s rules, which sit on top of this handbook.',
        '',
        '[Staff: add your airline’s own conduct rules here.]',
        '',
        '',
        '10. YOUR DATA',
        '',
        'Your account, your roster row and your flights live in this airline’s own',
        'database — Inflight hosts the software, the airline holds the data. Anything',
        'about your own record is a question for staff, because they are the ones who',
        'can answer it and change it.',
        '',
        'The crew center’s privacy notice and conditions for pilots is here:',
        terms,
        '',
        '',
        '11. WHO TO ASK',
        '',
        `[Staff: who a pilot should contact, and where — a Discord channel, a name, a`,
        'ticket. This is the question this handbook is asked most, and it is the one',
        'only you can answer.]',
        '',
        '',
        '— — —',
        '',
        'STAFF: BEFORE PUBLISHING',
        '',
        'This draft was added by Inflight as a starting point. It describes how the',
        'crew center works and nothing about how you run your airline. Fill in every',
        '[bracketed] part, cut any section you do not use, and publish it when it says',
        'what you want said. It is yours from here — we do not edit it again.',
    ].join('\n');

    return {
        title: 'Pilot Handbook',
        summary: 'How the crew center works — signing in, ranks, filing flights, the schedule and your data. A starting point to edit and publish as your own.',
        kind: 'handbook',
        source: 'text',
        body,
        // A draft, always. See the header for why this is not a default anybody
        // should be able to override from a request body.
        status: 'draft',
        revision: '',
    };
}

module.exports = { starterHandbook };
