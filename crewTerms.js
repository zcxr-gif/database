'use strict';

/* =========================================================================
 * CREW CENTER — PILOT PRIVACY NOTICE & CONDITIONS (version + shape)
 *
 * The pilot-facing counterpart to vaTos.js, and deliberately a separate file
 * from it. The VA Advertisement Terms are a contract between us and an
 * AIRLINE — a partnership, a listing, an enforcement ladder. None of that is
 * anything a pilot signing in to fly has agreed to or should be shown. What a
 * pilot needs is the other document: what the crew center holds about them,
 * who can see it, and what is expected of them while they use it.
 *
 * WHY A VERSION STRING AND NOT A BOOLEAN
 * --------------------------------------
 * `crew_accounts.terms_version` holds the version an account agreed to, so the
 * question the crew center asks is "have they agreed to WHAT IS IN FRONT OF
 * THEM", not "have they ever agreed to anything". A notice that changes without
 * anybody being asked again is a notice nobody has agreed to. Bump VERSION when
 * the words change and every account is asked once more.
 *
 * THE ASK IS SOFT, ON PURPOSE
 * ---------------------------
 * Nothing in the crew center is gated on having agreed. A pilot who has not
 * answered still signs in, still reads their hours, still files a flight; what
 * they get is the notice, once per version, until they answer it. Locking a
 * roster out of its own crew center over a consent prompt would punish pilots
 * for a change their VA and we made between us — and a pilot who cannot get in
 * cannot read what they are being asked to agree to either.
 *
 * WHAT IT MUST NOT SAY
 * --------------------
 * Only what the code actually does. Every claim in crewTermsContent.js is
 * traceable to a table in supabase/crew-center-schema.sql or a route in this
 * repo, and the clauses carry the names so the next person can check. If a
 * feature is removed, the clause describing it is wrong and has to go with it.
 * ========================================================================= */

// Bump when the words in crewTermsContent.js change. Every pilot is asked once
// more when this moves; nobody is locked out while they have not answered.
const CREW_TERMS_VERSION = 'v1';

// Human-readable effective date, shown on the page and in the prompt.
const CREW_TERMS_EFFECTIVE_DATE = '2026-09-13';

// Where a pilot reads it in full. A public page — no sign-in, because somebody
// deciding whether to press "Continue with Discord" has not signed in yet, and
// a consent document you have to be inside the product to read is not one
// anybody has read.
//
// A path on the SITE, not on this API. The crew center a pilot is standing in
// is served from the site (see CREW_PUBLIC_BASE_URL), and a notice that sends
// them to a backend hostname to read it looks like somewhere else entirely.
// The page there draws itself from GET /api/crew-terms, so the words still have
// one home — this file's neighbour, crewTermsContent.js.
const CREW_TERMS_PAGE_PATH = '/crew-terms.html';

// Questions about the platform. Anything about their own roster row, hours or
// account goes to their VA first — see the contact clause.
const { TOS_CONTACT_EMAIL } = require('./vaTos');

// The short version, for the prompt itself. A pilot reads this and presses a
// button; the full document is a click away and most will not take it, so
// these five lines have to be true on their own rather than a teaser.
const CREW_TERMS_SUMMARY = [
    'Your crew center account, roster row, hours and flight reports live in your virtual airline’s own database — not ours.',
    'Linking Discord stores your Discord id, name and avatar against your login so the button can sign you in. Nothing else is read from Discord, and you can unlink it whenever you like.',
    'Your VA’s staff can see your roster row, your flights and the messages they send you. Inflight staff can see a crew center when they need to support it.',
    'Keep your login to yourself, and file flights you actually flew.',
    'If this notice changes, you will be asked again.',
];

module.exports = {
    CREW_TERMS_VERSION,
    CREW_TERMS_EFFECTIVE_DATE,
    CREW_TERMS_PAGE_PATH,
    CREW_TERMS_CONTACT_EMAIL: TOS_CONTACT_EMAIL,
    CREW_TERMS_SUMMARY,
};
