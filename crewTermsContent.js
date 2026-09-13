'use strict';

/* =========================================================================
 * CREW CENTER — PILOT PRIVACY NOTICE & CONDITIONS (structured source)
 *
 * The same shape as vaTermsContent.js, so the same page renderer draws both:
 * each clause is { heading, blocks }, where a block is either { p: '…' } or
 * { list: ['…'] }.
 *
 * ONE RULE FOR EDITING THIS FILE: every sentence describes something the code
 * actually does, and the clause says where. Where a claim names a table it is a
 * table in supabase/crew-center-schema.sql; where it names a route it is a
 * route in this repo. A privacy notice that describes a system nobody built is
 * worse than none, because people believe it.
 *
 * Bump CREW_TERMS_VERSION in crewTerms.js when any of this changes — that is
 * what asks every pilot again.
 * ========================================================================= */

const {
    CREW_TERMS_VERSION,
    CREW_TERMS_EFFECTIVE_DATE,
    CREW_TERMS_CONTACT_EMAIL,
} = require('./crewTerms');

const INTRO = 'A Crew Center is the place a virtual airline runs its roster, its flying and its paperwork. '
    + 'The software is built and hosted by Inflight (“we”, “us”); the airline is run by the people who run it '
    + '(“your VA”). This notice explains what the Crew Center holds about you, where it lives, who can see it, '
    + 'and what is expected of you while you use it. It covers the Crew Center only — your VA may have its own '
    + 'rules on top, and those are theirs to set.';

const CLAUSES = [
    {
        heading: '1. Who Holds What',
        blocks: [
            { p: 'This is the first thing to understand, because almost everything else follows from it: your pilot account and your flying records are stored in your VA’s own database, not in ours. When a VA sets up a Crew Center they connect their own Supabase project, and the roster, the logins, the flights, the applications and the messages are written there.' },
            { p: 'What Inflight holds centrally is the VA’s listing and branding, and the VA’s own staff logins. Pilot credentials are not among them: we cannot sign in as you, and we cannot reset your password — only your VA can.' },
            { p: 'If your VA stops using Inflight, they keep all of it, because we never had a copy to hand back.' },
        ],
    },
    {
        heading: '2. Your Account',
        blocks: [
            { p: 'A Crew Center account is issued by your VA — there is no public sign-up, and nothing in the Crew Center creates an account for you. Your VA’s staff either create one when they accept your application or add one for a pilot already on the roster.' },
            { p: 'The account holds a username, the name you are shown by, a bcrypt hash of your password, and an email address if your VA recorded one. The password itself is not stored — not by your VA and not by us — which is why a forgotten password is replaced rather than recovered.' },
            { p: 'The password you are first given was generated for you and has been seen by whoever handed it over, so the Crew Center asks you to change it before you do anything else.' },
            { p: 'Signing in gives your browser a session token that is good for seven days and is stored by the page itself. Closing the tab does not end it; it expires on its own.' },
        ],
    },
    {
        heading: '3. Signing In With Discord',
        blocks: [
            { p: 'Linking Discord is optional. It is a second key to the account you already have, and never a way to get one: linking is done from inside your own account page while you are signed in, and the sign-in button looks up an account that is already linked or signs nobody in.' },
            { p: 'We ask Discord for one thing — “identify”, the shortest permission Discord offers. We do not ask for your email address and we do not ask which servers you are in.' },
            { p: 'When you link, your Crew Center login records:' },
            { list: [
                'your Discord account id — the thing that actually identifies you, and the only part matched on;',
                'your Discord display name or handle, so your VA’s staff can see who the link belongs to;',
                'your avatar, so the Crew Center can show it;',
                'the date you linked.',
            ] },
            { p: 'The access token Discord issues during sign-in is used once, to ask who you are, and is never stored. We are not asking to act on your behalf and have nothing to refresh.' },
            { p: 'A link belongs to one Crew Center. If you fly for two VAs on Inflight you link separately at each, and neither can see the other’s. Within one VA, one Discord account opens one login.' },
            { p: 'You can unlink at any time from your account page, and unlinking is allowed even if it leaves the password as your only way in — your VA can always reset that.' },
        ],
    },
    {
        heading: '4. What the Crew Center Holds About You',
        blocks: [
            { p: 'In your VA’s database, depending on which parts of the Crew Center your VA uses:' },
            { list: [
                'your roster row — the name and callsign you fly under, your credited hours, your status (active, on leave, inactive), the aircraft you fly, any check-rides you have been signed off for, and your Infinite Flight account and IFC name if your VA recorded them;',
                'your flight reports — the legs you file or that are captured for you, and whether staff approved them;',
                'your bookings and event sign-ups;',
                'messages your VA’s staff send you, in your inbox;',
                'your membership application, if you joined through the Crew Center’s join form — the email address you gave, your answers to the VA’s questions, and the Infinite Flight grade we looked up;',
                'check-ride requests, where your VA runs them;',
                'shop orders and your balance, where your VA runs a shop.',
            ] },
            { p: 'Documents and links your VA publishes may be gated on rank. That gate decides what you are shown; it does not record what you read.' },
        ],
    },
    {
        heading: '5. Flights Captured Automatically',
        blocks: [
            { p: 'If your roster row carries your Infinite Flight account, your VA’s staff can run a sync that reads your recent Infinite Flight logbook and files any flights it has not already seen as reports on your record. Flights it has seen before are not filed twice.' },
            { p: 'The logbook is read from Infinite Flight, not from your device, and only for pilots whose roster row is linked to an Infinite Flight account and is active. If you would rather this did not happen, ask your VA to remove the Infinite Flight link from your roster row.' },
        ],
    },
    {
        heading: '6. Who Can See It',
        blocks: [
            { list: [
                'Your VA’s staff, according to what their role allows. A VA gives its team specific permissions — the roster, flight reviews, the schedule, messaging pilots — and staff see what those permissions cover.',
                'Other pilots at your VA see what the Crew Center shows publicly: the roster, the noticeboard, events, and anything your VA publishes to the crew.',
                'Inflight staff can open a Crew Center to support it. That access exists so a VA whose crew center is broken can be helped; it is not used to read a VA’s roster for any other purpose.',
                'Anyone at all, for the parts your VA chooses to publish — a VA can run a public website and public embeds from its Crew Center data.',
            ] },
            { p: 'Your password is visible to nobody, including your VA and including us. Only its hash is stored.' },
        ],
    },
    {
        heading: '7. What Is Expected of You',
        blocks: [
            { list: [
                'Keep your login to yourself. Anything done with it is recorded as done by you.',
                'File flights you actually flew, with the details they were actually flown with.',
                'Follow your VA’s own rules, which sit on top of this notice.',
            ] },
            { p: 'Your VA’s staff can suspend or remove your Crew Center account. That is their decision to make about their own roster, and it is not one we take for them or overturn on request.' },
        ],
    },
    {
        heading: '8. Leaving',
        blocks: [
            { p: 'You can unlink Discord yourself, at any time, from your account page.' },
            { p: 'Your Crew Center account and roster row belong to your VA’s database, so removing them is something your VA does — ask your VA’s staff. Because the data is theirs and not ours, we cannot delete it on their behalf.' },
        ],
    },
    {
        heading: '9. Changes to This Notice',
        blocks: [
            { p: `This is version ${CREW_TERMS_VERSION}, effective ${CREW_TERMS_EFFECTIVE_DATE}. When the notice changes, the version changes with it and you are asked again the next time you sign in. Your account records which version you agreed to and when — nothing else about the agreement is stored.` },
            { p: 'You are not locked out while you have not answered. The Crew Center keeps working; it asks again.' },
        ],
    },
    {
        heading: '10. Contact',
        blocks: [
            { p: 'Anything about your own account, your hours, your roster row or your flights: ask your VA’s staff. They hold the data and they are the only ones who can change it.' },
            { p: `Anything about the Crew Center itself, or about this notice: ${CREW_TERMS_CONTACT_EMAIL}.` },
        ],
    },
];

module.exports = {
    TITLE: 'Inflight Crew Center',
    SUBTITLE: 'Privacy Notice & Conditions for Pilots',
    VERSION: CREW_TERMS_VERSION,
    EFFECTIVE_DATE: CREW_TERMS_EFFECTIVE_DATE,
    INTRO,
    CLAUSES,
};
