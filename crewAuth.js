// crewAuth.js
// Sign-in for the Crew Center (inflight.info/crew/<slug>).
//
// One cascading login, tried in this order:
//   1. a PILOT account in the VA's OWN data store   (crew_accounts, their project)
//   2. VaPortalAccount scoped to THIS crew center's VA  (owner | staff)
//   3. StaffUser (Inflight staff)                       (oversight into any VA)
//
// Step 1 is the one that moved. A pilot's account belongs to the VA in the same
// way their hours do, so it is stored in the VA's project and read back through
// crewStore — Inflight holds no pilot credentials for any VA. Steps 2 and 3 are
// our own accounts: the VA's staff administer their partnership with us, and
// Inflight staff have oversight, so those stay central.
//
// Owner/staff/Inflight land on the management dashboard; pilots land on the pilot
// home. The static login page stores the returned Bearer token itself (no
// cross-site cookies), so CORS stays simple (no credentials).
//
// Required env: JWT_SECRET (the SAME secret staffAuth / vaPortal sign with).

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
// Only for the two facts /me reports about websites: whether this deployment
// hosts them, and what a VA's address would be. No route here touches a site.
const vaSites = require('./vaSites');

const crewStore = require('./crewStore');
const crewAccounts = require('./crewAccounts');
// Signing in with Discord. The rules and the two calls that touch the network
// live there; the routes that use them are at the bottom of this file.
const crewDiscord = require('./crewDiscord');
const crewInvite = require('./crewInvite');
// The pilot-facing privacy notice. Only the version and where to read it are
// needed here — the words live in crewTermsContent.js and are served by their
// own public route, because a document you have to be signed in to read is one
// nobody has read.
const { CREW_TERMS_VERSION, CREW_TERMS_PAGE_PATH } = require('./crewTerms');
// The schedule's rules are normalised by the module that enforces them, so the
// bounds a VA can save and the bounds the endpoints apply are one definition.
const crewSchedules = require('./crewSchedules');
const crewRetention = require('./crewRetention');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

/**
 * The pilot row belonging to one of our central staff accounts, or null. v17.
 *
 * Swallows everything, and every caller depends on that: a staff member signs
 * in to MANAGE an airline, and a project that is unreachable, on an older
 * schema, or has no such row must cost them the pilot side and never the
 * session. "No pilot row" and "could not ask" are the same answer here — in
 * both cases there is nothing to hang a Discord link or an inbox on, and in
 * both cases the dashboard they came for works.
 */
/**
 * A store that could not answer, said in the store's own words.
 *
 * The adapter already knows the difference between "this VA has not connected a
 * project", "the project is read-only because it ran out of room", and "the
 * schema is older than this code, and here is the column" — each with its own
 * status and a fix the VA can act on. Re-deriving a shorter list of those here
 * is how a route ends up answering "something went wrong" to a problem the
 * store had already diagnosed.
 */
function storeFail(res, err, log, fallback) {
    if (err instanceof crewStore.CrewStoreError) {
        if (err.detail) console.warn(`crew store [${err.code}]:`, err.detail);
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(`${log}:`, err && err.message ? err.message : err);
    return res.status(500).json({ error: fallback });
}

async function boundPilotRow(store, portalAccountId) {
    if (!store || typeof store.getAccountByPortal !== 'function') return null;
    try { return await store.getAccountByPortal(portalAccountId); } catch { return null; }
}

/**
 * Retire the invitation that let a pilot in, the moment they use it.
 *
 * Deliberately returns nothing and swallows everything. This runs after a
 * password has already been checked and accepted, so there is no outcome here —
 * including "the store went away mid-login" — that should turn a successful
 * sign-in into a failure. The worst case is an invitation that stays readable
 * until it expires, which is what would have happened anyway.
 */
function claimInvitation(store, accountId) {
    if (!store || !accountId || typeof store.getApplicationByInviteAccount !== 'function') return;
    Promise.resolve()
        .then(async () => {
            const appDoc = await store.getApplicationByInviteAccount(String(accountId));
            // No invitation, or one that has already been spent. Either way
            // there is nothing left to clear, and re-stamping a claim date that
            // is already set would only move it.
            if (!appDoc || !appDoc.invitePassword) return;
            await store.updateApplication(appDoc._id, crewInvite.claimPatch());
        })
        .catch((err) => console.warn('crew login: could not clear invitation —', err?.message || err));
}
const TOKEN_TTL = '7d';

// Known layout presets + login looks (mirrors the crew center front-end).
const CREW_LAYOUTS = ['editorial', 'console', 'split', 'classic'];
const LOGIN_LOOKS = ['center', 'split'];

/* WHAT IS BEHIND THE SIGN-IN CARD.
 *
 * Separate from the look, and deliberately so. A look is the LAYOUT — where the
 * card sits and what is beside it; a backdrop is what fills the space around
 * it. They are genuinely independent: every backdrop works under either layout,
 * so two small choices give a VA twelve pages instead of two, and neither can
 * be combined into something broken.
 *
 * `auto` is the default and is the answer for almost everybody: use the
 * airline's banner where there is one, and the drawn field where there is not.
 * A VA who has never opened this screen gets the right thing without choosing.
 *
 * The four drawn ones need no photograph at all, which matters more than it
 * sounds: most VAs never upload a banner, and until now their sign-in page was
 * a grey dot field with a card on it.
 */
const LOGIN_BACKDROPS = ['auto', 'banner', 'aurora', 'grid', 'horizon', 'paper'];
// How a topic opens in the crew center: a slide-over on the dashboard, or a
// page of its own with its own link. Mirrors CrewTopics.MODES in the tracker.
const CREW_TOPIC_MODES = ['sheet', 'page'];

const isHexColor = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '');
const clampStr = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cleanImageUrl = (u) => { const s = clampStr(u, 600); return /^https:\/\//i.test(s) ? s : ''; };

// A Discord INVITE link — discord.gg/abc123, or discord.com/invite/abc123.
// NOT the webhook URL the VA sets for notifications; that one is a secret and
// lives elsewhere. This one is public and is handed to accepted pilots.
//
// Validated strictly, and not as a formality: this string goes into an
// acceptance email that WE send, with our name on it. An unvalidated "invite"
// field is a phishing vector — a VA could point it anywhere and the message
// would still read as coming from Inflight. Anything that is not literally a
// Discord invite is rejected rather than sanitised into something plausible.
const isDiscordInviteUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    let u;
    try { u = new URL(url.trim()); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // Discord's own codes are alphanumeric; vanity URLs add hyphens. No slashes
    // in the pattern, so an extra path segment can't be smuggled through.
    const code = '[A-Za-z0-9-]{2,64}';
    const known = ['discord.gg', 'discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];
    if (!known.includes(host)) return false;
    if (!new RegExp(`^/(invite/)?${code}/?$`).test(u.pathname)) return false;
    // Only discord.gg may use the bare /code form; on the full domains an
    // invite always lives under /invite/.
    return host === 'discord.gg' || u.pathname.startsWith('/invite/');
};

// '' when nothing was supplied (a meaningful value — it clears a stored
// invite), the CANONICAL url when it is a real invite, and null when the caller
// sent something that is not one, so a handler can tell "cleared" from
// "rejected".
//
// Canonical, not merely trimmed: the returned string is rebuilt from the parsed
// URL, so what we store and later show a pilot is always origin + clean path.
// The parser resolves "/abc/../../x" to "/x" before the host check, so such a
// URL is on discord.gg either way and is safe — but echoing the traversal back
// to a pilot as their invite link would look like an attack. Rebuilding drops
// it, along with any query string or fragment an invite has no use for.
const cleanDiscordInvite = (url) => {
    const s = String(url == null ? '' : url).trim();
    if (!s) return '';
    if (!isDiscordInviteUrl(s)) return null;
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/+$/, '');
};

// Verify a crew Bearer token on a request (used by routes registered outside
// this module, e.g. the badge-image upload in server.js). Returns the crew
// payload or null.
function verifyCrewRequest(req) {
    const token = getBearer(req);
    if (!token) return null;
    try { const p = jwt.verify(token, JWT_SECRET); return p.typ === 'crew' ? p : null; }
    catch { return null; }
}

// Sanitize the VA-defined rank ladder / role list before saving.
function sanitizeRanks(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 40).map(r => ({
        name: clampStr(r && r.name, 40),
        minHours: Math.max(0, Math.min(100000, Number(r && r.minHours) || 0)),
        // v14. Sectors as well as hours, when a VA wants both. See crewRanks.
        minFlights: Math.max(0, Math.min(100000, Number(r && r.minFlights) || 0)),
        color: isHexColor(r && r.color) ? r.color : '',
        icon: clampStr(r && r.icon, 30),
        image: cleanImageUrl(r && r.image),
        // v7. A rung a pilot cannot reach on hours alone — staff sign them off.
        // A VA's choice, per rung: most gate none, or one (the step up to
        // Captain). See crewRanks for how it resolves.
        requiresCheck: !!(r && r.requiresCheck),
        // What the check-ride actually is, in the VA's words. Shown to the
        // pilot waiting on it, so "awaiting a check-ride" says what to do.
        checkNote: clampStr(r && r.checkNote, 300),
    })).filter(r => r.name).sort((a, b) => a.minHours - b.minHours);
}
function sanitizeRoles(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 40).map(r => ({
        name: clampStr(r && r.name, 40),
        color: isHexColor(r && r.color) ? r.color : '',
        icon: clampStr(r && r.icon, 30),
        image: cleanImageUrl(r && r.image),
        staff: !!(r && r.staff),
        // A short word from whoever holds the role — the CEO's welcome, in
        // practice. Clamped hard on purpose: this is a sentence beside a name
        // on a card, not the About page, and a role whose message runs to four
        // hundred words is a section the airline meant to write instead.
        message: clampStr(r && r.message, 400),
    })).filter(r => r.name);
}
function sanitizeFleet(arr) {
    if (!Array.isArray(arr)) return null;
    // `type` holds the aircraft name and `name` the livery — both are meant to be
    // the canonical Infinite Flight API strings (offered by the fleet editor) so
    // the tracker can match live flights to the fleet. Canonical aircraft names
    // ("Boeing 787-10 Dreamliner") run long, so type is clamped generously.
    return arr.slice(0, 100).map(a => ({
        type: clampStr(a && a.type, 60),
        name: clampStr(a && a.name, 80),
        image: cleanImageUrl(a && a.image),
        /* WHO THE PICTURE BELONGS TO.
         *
         * Most fleet photographs on this platform are not the airline's: the
         * fleet editor pulls them from the community aircraft library, where
         * every picture already carries the name of the person who supplied it.
         * That name was being thrown away at the point of use, so a VA's public
         * fleet page showed a dozen photographs and credited none of them.
         *
         * Stored beside the address it belongs to, so it travels with the
         * picture into the crew centre, the feed and the hosted website — and
         * so a VA who has a photographer of their own can type one. */
        /* Whether the picture came from the community library or from the
         * airline. It decides whether the fleet editor may replace it when the
         * aircraft or the livery changes — an upload is theirs and is never
         * overwritten, a library photo of the aeroplane the row used to name is
         * not a photo of the one it names now. */
        imageAuto: !!(a && a.imageAuto),
        photographer: clampStr(a && a.photographer, 80),
        // A page to credit back to, not a picture — cleanImageUrl is the wrong
        // check for it. https only, because this ends up in an href on a public
        // site that is not ours.
        photoLink: /^https:\/\//i.test(clampStr(a && a.photoLink, 300)) ? clampStr(a.photoLink, 300) : '',
    })).filter(a => a.type || a.name);
}
/* CODESHARE PARTNERS.
 *
 * Same shape as a fleet row for the aeroplanes, because they ARE fleet rows —
 * somebody else's fleet. That means the same canonical Infinite Flight names,
 * the same photo-credit fields, and the same cleanImageUrl on the picture.
 *
 * Two things differ from sanitizeFleet, both because a partner is a heading
 * rather than a row:
 *
 *   - a partner with no NAME is dropped entirely. The name is the key routes
 *     match on; a nameless partner could never be pointed at, and would sit on
 *     the public site as an untitled logo.
 *   - the logo goes through cleanImageUrl like any other picture, because it is
 *     rendered in an <img> on a public page the VA does not control.
 *
 * Bounded at 40 partners with 60 aeroplanes each: a VA that sells seats on forty
 * airlines is already unusual, and the cap is what stops a settings save from
 * becoming an upload.
 */
function sanitizePartners(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, 40).map((p) => ({
        name: clampStr(p && p.name, 60),
        logo: cleanImageUrl(p && p.logo),
        aircraft: (Array.isArray(p && p.aircraft) ? p.aircraft : []).slice(0, 60).map((a) => ({
            type: clampStr(a && a.type, 60),
            name: clampStr(a && a.name, 80),
            image: cleanImageUrl(a && a.image),
            imageAuto: !!(a && a.imageAuto),
            photographer: clampStr(a && a.photographer, 80),
            photoLink: /^https:\/\//i.test(clampStr(a && a.photoLink, 300)) ? clampStr(a.photoLink, 300) : '',
        })).filter((a) => a.type || a.name),
    })).filter((p) => {
        if (!p.name) return false;
        // Case-folded, because that is how routes match a partner and how
        // codesharePartners groups them. Two rows differing only in case are one
        // partner with two logos, and the editor would show a duplicate nobody
        // could tell apart.
        const k = p.name.trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// The Instagram wall. A handle, and up to MAX_SOCIAL_POSTS posts.
//
// THE URL IS NEVER STORED. Staff paste a share link; this parses it down to the
// `{kind, code}` pair and keeps only that. Every consumer rebuilds the embed
// address from the code, so a pasted `javascript:`, a look-alike host
// (`instagram.com.evil.test`) or a tracking-laden redirect cannot survive as
// far as an iframe `src` — not here, not in the public feed, and not on a VA's
// hosted site. This mirrors parsePost in the tracker's crewSocial.js, which
// does the same job at the point of drawing; doing it in both places means
// neither has to trust the other.
//
// An unparseable entry is DROPPED rather than refused. The crew dashboard
// already refuses one at the point of typing with a message naming the bad
// link, which is where a person can act on it; a save that 400s on one stale
// row would take the other eleven down with it.
const MAX_SOCIAL_POSTS = 12;
function parseSocialPost(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // The host must BE instagram, not merely end with it.
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;
    const m = u.pathname.match(/(?:^|\/)(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})/);
    if (!m) return null;
    return { kind: m[1] === 'reels' ? 'reel' : m[1], code: m[2] };
}
function sanitizeSocial(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const handle = clampStr(String(raw.handle || '').replace(/^@+/, ''), 40);
    const seen = new Set();
    const posts = [];
    (Array.isArray(raw.posts) ? raw.posts : []).forEach((entry) => {
        if (posts.length >= MAX_SOCIAL_POSTS) return;
        // Accept either what a person pasted or what we stored, so a round trip
        // through the settings screen does not empty the wall.
        const p = (entry && typeof entry === 'object' && entry.code && entry.kind)
            ? parseSocialPost(`https://www.instagram.com/${entry.kind}/${entry.code}/`)
            : parseSocialPost(typeof entry === 'string' ? entry : (entry && entry.url));
        if (!p || seen.has(p.code)) return;
        seen.add(p.code);
        posts.push(p);
    });
    return { handle, posts };
}
// The wall, on the way out. Built from the stored code every time, which is
// the whole point of storing the code: a consumer that renders `embedUrl`
// without thinking still cannot be handed a hostile address.
//
// `url` is the canonical post (for an "open on Instagram" link), `embedUrl` the
// frame. Both are ours, assembled here from `[A-Za-z0-9_-]`.
function publicSocial(ad) {
    const sc = (ad && ad.crewSocial) || {};
    const posts = (Array.isArray(sc.posts) ? sc.posts : [])
        .filter(p => p && p.code && (p.kind === 'p' || p.kind === 'reel' || p.kind === 'tv'))
        .slice(0, MAX_SOCIAL_POSTS)
        .map(p => ({
            kind: p.kind,
            code: p.code,
            url: `https://www.instagram.com/${p.kind}/${p.code}/`,
            embedUrl: `https://www.instagram.com/${p.kind}/${p.code}/embed/`,
        }));
    return { handle: String(sc.handle || ''), posts };
}
function sanitizeForm(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 30).map(q => ({
        label: clampStr(q && q.label, 120),
        type: ['text', 'textarea', 'select'].includes(q && q.type) ? q.type : 'text',
        options: Array.isArray(q && q.options) ? q.options.slice(0, 20).map(o => clampStr(o, 60)).filter(Boolean) : [],
        required: !!(q && q.required),
    })).filter(q => q.label);
}
// Extensible join requirements. Numeric-threshold types are auto-checked
// against real IF stats; 'agree' is a custom checkbox the applicant must tick.
const REQ_TYPES = ['grade', 'hours', 'landings', 'xp', 'flights', 'violations', 'agree'];
function sanitizeRequirements(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 20).map(r => {
        const type = REQ_TYPES.includes(r && r.type) ? r.type : 'agree';
        if (type === 'agree') {
            return { type, value: 0, label: clampStr(r && r.label, 200), required: r && r.required === false ? false : true };
        }
        // grade caps at 5; the rest are open-ended non-negative integers.
        const cap = type === 'grade' ? 5 : 10000000;
        return { type, value: Math.max(0, Math.min(cap, Math.round(Number(r && r.value) || 0))), label: clampStr(r && r.label, 200), required: true };
    }).filter(r => (r.type === 'agree' ? r.label : r.value > 0));
}

// ---- Staff permissions ----
// The catalog of things a staff member can be granted. This is the ONE place to
// extend the permission system — add a row here (and gate an endpoint on it) and
// it flows through to the owner's role builder automatically. Owner-only powers
// (connect Supabase, manage the team itself) are deliberately NOT here.
const CREW_CAPABILITIES = [
    { id: 'roster.manage',          group: 'Roster',        label: 'Add, edit & remove pilots' },
    { id: 'applications.review',    group: 'Recruitment',   label: 'Review applications — accept / decline' },
    { id: 'settings.recruitment',   group: 'Recruitment',   label: 'Edit join settings, questions & requirements' },
    { id: 'settings.branding',      group: 'Appearance',    label: 'Change appearance, ranks, roles & fleet' },
    { id: 'settings.notifications', group: 'Notifications',  label: 'Manage Discord & email notifications' },
    { id: 'routes.manage',          group: 'Operations',    label: 'Create & manage the route network' },
    { id: 'flights.review',         group: 'Operations',    label: 'Review flights (PIREPs) & auto-tracking' },
    { id: 'events.manage',          group: 'Operations',    label: 'Create & manage events and the gate board' },
    { id: 'schedules.manage',       group: 'Operations',    label: 'Build the schedule & assign bookings' },
    // Split out of roster.manage. Writing to the noticeboard was gated on
    // "add, edit & remove pilots", which made the two jobs one: a VA could not
    // have somebody who writes to the crew without also handing them the
    // roster, and could not have a flight reviewer who was NOT able to post
    // notices in the airline's name. See the compatibility note in
    // effectiveCaps — a role built before this split does not lose the power.
    { id: 'announcements.manage',   group: 'Communications', label: 'Post & pin notices on the noticeboard' },
    // The VA's standing with Inflight — warnings included. Owner-only until an
    // owner grants it, which is the point: some VAs have a person who handles
    // the partnership and is not the owner, and the alternative was that owner
    // forwarding screenshots.
    { id: 'partnership.view',       group: 'Partnership',   label: 'See the Inflight partnership & warnings' },
    // v11. The library. Its own capability rather than folded into
    // settings.branding, because publishing the operations manual is a different
    // job from choosing the airline's colours and is usually a different person —
    // and because a rank-gated document is an access control decision, which is
    // not something to hand out with the logo picker.
    { id: 'documents.manage',       group: 'Communications', label: 'Publish & manage the document library' },
    // v11. Messaging the crew. Separate from announcements.manage for the reason
    // that split was made in the first place: a notice is posted to a board
    // anyone can read, and a message lands in one pilot's inbox addressed to
    // them. A VA may well want somebody who writes notices but does not message
    // pilots individually, and the reverse.
    { id: 'members.message',        group: 'Communications', label: 'Message pilots individually or by rank' },
    // v12. The quick-links board. Shares documents.manage's reasoning — a
    // rank-gated link is an access control decision — but is its own capability
    // because the jobs differ in practice: the person who curates "where do I get
    // the liveries" is rarely the person who writes the operations manual, and a
    // VA should be able to hand out the first without the second.
    { id: 'links.manage',           group: 'Communications', label: 'Curate the quick-links board' },

    // ---- Owner-grade. Read the note under CREW_OWNER_GRADE_CAPS. ----
    //
    // v13. These three powers were owner-only and hard-coded, and the reason to
    // open them is the same one that produced partnership.view: a VA of any
    // size has people who are not the owner and whose job needs one of them.
    // Somebody runs the airline day to day and needs to build the team;
    // somebody keeps the integrations working and is not the person whose name
    // is on the partnership. The alternative to delegating was the owner
    // handing over their own login, which is worse in every way — it is
    // unauditable, it cannot be narrowed, and it cannot be taken back without a
    // password change.
    { id: 'integrations.manage',    group: 'Owner-level',    label: 'Connect Infinite Flight & the data store' },
    { id: 'team.manage',            group: 'Owner-level',    label: 'Create staff roles & assign the team' },
    { id: 'retention.manage',       group: 'Owner-level',    label: 'Configure & run the roster sweep' },
    // v14. The public website. Owner-grade for the reason the three above are:
    // this publishes pages to the world in the airline's name, on an address
    // that is the airline's. It is also genuinely somebody else's job at most
    // VAs of any size — the person who writes the website is rarely the person
    // who runs the roster — so it is a permission an owner can hand over rather
    // than a power only they have.
    { id: 'site.manage',            group: 'Owner-level',    label: 'Build & publish the public website' },
];
const CREW_CAP_IDS = CREW_CAPABILITIES.map(c => c.id);

/**
 * The capabilities that are NOT part of the unassigned-staff default.
 *
 * effectiveCaps gives a staff member with no role assignment everything, so
 * that switching the permission system on does not lock out a team that never
 * had roles. That default is load-bearing and stays — but it means the set of
 * capabilities and the set of things an unassigned staff member can do are the
 * same list, and adding a row to that list silently hands the new power to
 * every unassigned staff member at every VA the moment this deploys.
 *
 * For the day-to-day capabilities that was always fine: they describe work
 * those people were already doing. For these three it is not. Nobody should
 * wake up able to disconnect their airline's Infinite Flight account, rewrite
 * the team's permissions or start deleting pilots because a row was added to a
 * catalogue.
 *
 * So these are opt-in only. An owner grants them by ticking them on a role,
 * having read the line — which is exactly the bar the presets note below
 * describes, and the reason there is still no preset with the lot ticked.
 */
const CREW_OWNER_GRADE_CAPS = ['integrations.manage', 'team.manage', 'retention.manage', 'site.manage'];

/** What a staff member with no role assigned gets: everything except the above. */
const CREW_DEFAULT_STAFF_CAPS = CREW_CAP_IDS.filter(id => !CREW_OWNER_GRADE_CAPS.includes(id));

/**
 * Ready-made roles.
 *
 * The permission system worked before this and almost nobody used it, for a
 * reason worth naming: it asked a volunteer airline manager to read eleven
 * capability ids and decide which combination adds up to "the person who
 * approves flight reports". That is our model of the product, not theirs. VAs
 * do not think in capabilities, they think in JOBS — somebody does the PIREPs,
 * somebody runs recruitment, somebody organises events.
 *
 * So these are the jobs, with the capabilities already worked out. An owner
 * picks one, renames it if they like, and edits the ticks afterwards — a preset
 * is a starting point that becomes an ordinary role the moment it lands, not a
 * type of role with behaviour of its own. Nothing downstream knows a role came
 * from here.
 *
 * Deliberately NOT included: anything that would let a preset grant more than
 * the owner realised. There is no "deputy owner" preset with the lot ticked —
 * an owner who wants that can tick the lot themselves, having seen each line.
 */
const CREW_ROLE_PRESETS = [
    {
        id: 'pirep-manager',
        name: 'PIREP manager',
        color: '#0EA5E9',
        description: 'Reviews flight reports and keeps auto-tracking honest.',
        permissions: ['flights.review'],
    },
    {
        id: 'roster-manager',
        name: 'Roster manager',
        color: '#4F46E5',
        description: 'Looks after the pilots — adding, editing, promoting.',
        permissions: ['roster.manage'],
    },
    {
        id: 'recruiter',
        name: 'Recruiter',
        color: '#16A34A',
        description: 'Handles applications and how the airline recruits.',
        permissions: ['applications.review', 'settings.recruitment', 'roster.manage'],
    },
    {
        id: 'ops-manager',
        name: 'Operations manager',
        color: '#D97706',
        description: 'Runs the network and the week — routes, schedule, bookings.',
        permissions: ['routes.manage', 'schedules.manage', 'flights.review'],
    },
    {
        id: 'events-coordinator',
        name: 'Events coordinator',
        color: '#DB2777',
        description: 'Organises group flights and works the gate board.',
        permissions: ['events.manage'],
    },
    {
        id: 'schedule-manager',
        name: 'Schedule manager',
        color: '#7C3AED',
        description: 'Publishes the flying and assigns legs to pilots.',
        permissions: ['schedules.manage'],
    },
    {
        id: 'comms',
        name: 'Communications',
        color: '#0891B2',
        description: 'Writes to the crew, keeps the manuals & links, looks after Discord & email.',
        permissions: ['announcements.manage', 'members.message', 'documents.manage',
            'links.manage', 'settings.notifications', 'events.manage'],
    },
    {
        id: 'brand-manager',
        name: 'Brand manager',
        color: '#BE185D',
        description: 'Owns how the crew center looks, plus ranks and fleet.',
        permissions: ['settings.branding'],
    },
    {
        id: 'partnership-liaison',
        name: 'Partnership liaison',
        color: '#475569',
        description: 'Watches the airline’s standing with Inflight.',
        permissions: ['partnership.view'],
    },
    {
        id: 'chief-of-staff',
        name: 'Chief of staff',
        color: '#B45309',
        description: 'Runs the airline day to day and builds the team.',
        // The COO. Everything about people — who is on the roster, who joins,
        // who holds which role — plus the two ways of talking to them.
        //
        // NOT integrations.manage, and NOT retention.manage. This is the
        // closest preset to "deputy owner" and it is still not that: the job
        // is running the team, which does not require the power to disconnect
        // the airline's Infinite Flight account or to start a sweep that
        // removes pilots. An owner who wants either on this role ticks it,
        // having read the line — same bar as before, and the reason the note
        // above about no all-ticked preset still holds.
        permissions: [
            'team.manage', 'roster.manage', 'applications.review',
            'announcements.manage', 'members.message',
        ],
    },
    {
        id: 'technical-manager',
        name: 'Technical manager',
        color: '#0F766E',
        description: 'Keeps the integrations and the data store working.',
        // The tech person. Deliberately narrow: the integrations, and the two
        // operational capabilities whose failures they are the ones to
        // diagnose — a schedule that will not sync and a PIREP that will not
        // auto-approve are both reported to this person, and both are
        // impossible to look at without being able to open the screen.
        permissions: ['integrations.manage', 'schedules.manage', 'flights.review'],
    },
    {
        id: 'observer',
        name: 'Observer',
        color: '#6B7280',
        // The one that has to exist and is easy to forget. A staff account with
        // no role assigned keeps FULL access (see effectiveCaps), so "I want
        // them to see the dashboard and change nothing" is not the absence of a
        // role — it is a role with nothing ticked.
        description: 'Sees the crew center and changes nothing.',
        permissions: [],
    },
];

function slugifyRoleId(s) {
    const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || ('role-' + Math.random().toString(36).slice(2, 8));
}
// Owner-defined staff roles: a name + colour + a set of capability ids.
//
// `ceiling` is what the SAVER may hand out, and `prevRoles` what each role
// already carried. Both undefined for the owner (or Inflight), for whom the
// ceiling is everything — the historical behaviour and still the common case.
//
// A delegate with team.manage passes their own effective capabilities, which is
// what stops the delegation from being a way around itself. The previous roles
// come with it because the ceiling applies to what a save ADDS: a capability
// already on the role is a fact the owner established, and re-sending it — which
// every save does, the whole config goes at once — must not quietly strip it.
// teamSaveFailure has already refused an overreaching save by this point; this
// is the same rule enforced where the write happens, so a future caller that
// skips the check cannot widen anything.
function sanitizeStaffRoles(arr, ceiling, prevRoles) {
    if (!Array.isArray(arr)) return null;
    const allowed = ceiling ? new Set(ceiling) : null;
    const before = Array.isArray(prevRoles) ? prevRoles : [];
    const seen = new Set();
    return arr.slice(0, 30).map(r => {
        let id = slugifyRoleId(clampStr(r && r.id, 40) || (r && r.name));
        while (seen.has(id)) id = id + '-' + Math.random().toString(36).slice(2, 4);
        seen.add(id);
        const had = new Set(((before.find(p => p && p.id === id) || {}).permissions) || []);
        return {
            id, name: clampStr(r && r.name, 40),
            color: isHexColor(r && r.color) ? r.color : '',
            permissions: Array.isArray(r && r.permissions)
                ? r.permissions.filter(c => CREW_CAP_IDS.includes(c) && (!allowed || allowed.has(c) || had.has(c)))
                : [],
        };
    }).filter(r => r.name);
}

const capLabel = (id) => {
    const known = CREW_CAPABILITIES.find(c => c.id === id);
    return known ? known.label : id;
};

/**
 * Would this save hand out something the saver does not have?
 *
 * The question that makes team.manage safe to delegate. Without it the
 * capability is a superset of every other one, and there are two ways through,
 * not one:
 *
 *   1. Edit a role and tick a capability you do not hold.
 *   2. Leave the roles alone and assign yourself to one somebody else built.
 *
 * The second is the one that is easy to miss. A chief of staff who cannot tick
 * "connect Infinite Flight" can still point their own username at the technical
 * manager role the owner already made, and arrive at the same place without
 * editing a permission at all. Both are checked here.
 *
 * WHAT IS COMPARED, AND WHY IT IS NOT JUST "held ⊇ wanted". The whole team
 * config is sent on every save, so a delegate saving an unrelated change
 * re-sends every role and assignment in the airline — including the ones they
 * could never have created. Judging the payload on its own would refuse every
 * save they ever make while a role richer than they are exists, which is most
 * airlines, immediately.
 *
 * So what is judged is the DIFFERENCE. A capability already on that role, and
 * an assignment that already existed exactly, are pre-existing facts and pass
 * through untouched. What must be within the saver's own capabilities is what
 * this save is adding.
 *
 * REFUSED, NOT FILTERED. Dropping the offending tick silently would show
 * somebody a role that does not match what they configured, with no reason
 * why — and would turn an attempt to escalate into a shrug. A 403 that names
 * the capability is the honest answer to both.
 *
 * Returns a sentence for the 403, or '' when the save is clean.
 */
function teamSaveFailure({ roles, assignments }, prev, held) {
    const allowed = new Set(held || []);
    const prevRoles = Array.isArray(prev && prev.roles) ? prev.roles : [];
    const prevAsn = Array.isArray(prev && prev.assignments) ? prev.assignments : [];
    const roleById = (list, id) => list.find(r => r && r.id === id) || null;

    // 1. No role may GAIN a capability the saver does not hold.
    if (Array.isArray(roles)) {
        for (const role of roles) {
            const before = roleById(prevRoles, role && role.id);
            const had = new Set((before && before.permissions) || []);
            for (const cap of (Array.isArray(role && role.permissions) ? role.permissions : [])) {
                if (!CREW_CAP_IDS.includes(cap) || allowed.has(cap) || had.has(cap)) continue;
                return `You can’t grant “${capLabel(cap)}” — it isn’t one of your own permissions.`;
            }
        }
    }

    // 2. No NEW assignment may point at a role that is richer than the saver.
    //
    // Read against the roles as this save leaves them, not as they were: a save
    // that both creates a role and assigns somebody to it has to be judged on
    // what that person will actually end up holding.
    if (Array.isArray(assignments)) {
        const after = Array.isArray(roles) ? roles : prevRoles;
        for (const a of assignments) {
            const uname = String((a && a.username) || '').toLowerCase();
            const roleId = String((a && a.roleId) || '');
            if (!uname || !roleId) continue;
            const existed = prevAsn.some(x =>
                String((x && x.username) || '').toLowerCase() === uname && String((x && x.roleId) || '') === roleId);
            if (existed) continue;
            const target = roleById(after, roleId);
            for (const cap of (target && target.permissions) || []) {
                if (!CREW_CAP_IDS.includes(cap) || allowed.has(cap)) continue;
                return `You can’t put anyone in “${(target && target.name) || roleId}” — it carries “${capLabel(cap)}”, which isn’t one of your own permissions.`;
            }
        }
    }

    // 3. No assignment may GAIN a per-person capability the saver lacks.
    //
    // The same hole as 1 and 2, through the third door that now exists: ticking
    // a box directly on a person is granting a capability, so it answers to the
    // same ceiling. Judged as a DIFFERENCE for the same reason — the whole
    // config is re-sent on every save, and a tick the owner put there last
    // month is a fact, not something this save is adding.
    if (Array.isArray(assignments)) {
        for (const a of assignments) {
            const uname = String((a && a.username) || '').toLowerCase();
            if (!uname) continue;
            const before = prevAsn.find(x => String((x && x.username) || '').toLowerCase() === uname);
            const had = new Set((before && before.permissions) || []);
            for (const cap of (Array.isArray(a && a.permissions) ? a.permissions : [])) {
                if (!CREW_CAP_IDS.includes(cap) || allowed.has(cap) || had.has(cap)) continue;
                return `You can’t give @${uname} “${capLabel(cap)}” — it isn’t one of your own permissions.`;
            }
        }
    }

    return '';
}
// Which staff account (by login username) holds which role, and what it holds
// on top of that role.
//
// `permissions` is the per-PERSON grant, and it is what makes "give this one
// person this one extra thing" possible without inventing a role for it. Roles
// were the only unit before, so an airline that wanted its events organiser to
// also approve PIREPs — just that one person, just that one extra — had to
// build and maintain a second role that differed by a single tick. The two
// coexist deliberately: a role is the reusable job, the per-person list is the
// exception, and what somebody holds is the union.
//
// `roleId` is therefore optional now. An assignment with permissions and no
// role is a person configured entirely by hand, which is the whole point of
// this; an assignment with neither is not an assignment and is dropped.
function sanitizeAssignments(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, 300).map(a => ({
        username: clampStr(a && a.username, 60).toLowerCase(),
        roleId: clampStr(a && a.roleId, 40),
        permissions: [...new Set((Array.isArray(a && a.permissions) ? a.permissions : [])
            .filter(c => CREW_CAP_IDS.includes(c)))],
    })).filter(a => {
        if (!a.username || seen.has(a.username)) return false;
        if (!a.roleId && !a.permissions.length) return false;
        seen.add(a.username); return true;
    });
}
/**
 * Capabilities that used to be part of another one.
 *
 * Splitting a capability in two is a silent downgrade for everybody already
 * using it: a VA who ticked "add, edit & remove pilots" for their roster
 * manager last month had also, without being asked, given them the
 * noticeboard — and the morning after the split that person opens the
 * dashboard and the composer is gone, with nothing to explain it.
 *
 * So a role holding the OLD capability keeps the new one until an owner edits
 * that role, at which point the ticks on screen become the whole truth. Written
 * as data rather than as an `if` in the middle of the resolver, because the next
 * split will want the same treatment and should not have to rediscover why.
 */
const CAPABILITY_HEIRS = {
    'roster.manage': ['announcements.manage'],
};

/**
 * The capabilities a caller effectively has.
 *
 * Owner + Inflight get everything; pilots get nothing. A staff member gets
 * their assigned role's permissions — but a staff member with NO assignment
 * keeps full access, so turning the system on does not silently lock out a VA's
 * existing team until they choose to give people roles. That default is why
 * "see everything, change nothing" has to be an Observer role with nothing
 * ticked rather than the absence of one.
 */
function effectiveCaps(va, p) {
    if (!p) return [];
    if (p.kind === 'inflight' || p.role === 'owner') return CREW_CAP_IDS.slice();
    if (p.role !== 'staff') return [];
    const roles = Array.isArray(va && va.staffRoles) ? va.staffRoles : [];
    const asn = Array.isArray(va && va.staffAssignments) ? va.staffAssignments : [];
    const uname = String(p.uname || '').toLowerCase();
    const a = uname && asn.find(x => String(x.username || '').toLowerCase() === uname);
    if (a) {
        // The union of the reusable job and the exceptions made for this
        // person. Either half may be empty: a role with nothing ticked is the
        // Observer, and a person with permissions and no role is configured
        // entirely by hand. A roleId that no longer resolves contributes
        // nothing rather than voiding the whole assignment — deleting a role
        // should not silently revoke a tick made against the person.
        const held = new Set();
        const role = a.roleId ? roles.find(r => r.id === a.roleId) : null;
        if (role) (role.permissions || []).filter(c => CREW_CAP_IDS.includes(c)).forEach(c => held.add(c));
        (Array.isArray(a.permissions) ? a.permissions : [])
            .filter(c => CREW_CAP_IDS.includes(c)).forEach(c => held.add(c));
        for (const [older, heirs] of Object.entries(CAPABILITY_HEIRS)) {
            if (held.has(older)) heirs.forEach((h) => held.add(h));
        }
        return [...held];
    }
    // Unassigned staff → full, minus the owner-grade set. Still the
    // non-breaking default for everything that default was written for; see
    // CREW_OWNER_GRADE_CAPS for why the new powers are not in it.
    return CREW_DEFAULT_STAFF_CAPS.slice();
}

// Which dashboard a role routes to.
function viewForRole(role) {
    return role === 'pilot' ? 'pilot' : 'owner';
}

function signCrewToken(payload) {
    // typ:'crew' namespaces these so they can't be swapped for a staff/portal cookie.
    return jwt.sign({ ...payload, typ: 'crew' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function getBearer(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
}

// Resolve the VA for a crew slug (slug first, callsign fallback), approved only.
//
// The selection carries the VA's data-store connection (crewStore.SELECT pulls
// in the select:false service key) because the login below has to open the VA's
// project to check a pilot's password. Nothing in this module returns the `va`
// object itself — every response is assembled field by field — so the key does
// not escape by being along for the ride.
async function resolveVa(slug) {
    const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
    const raw = String(slug || '').trim().toLowerCase();
    if (!raw) return null;
    const sel = `${crewStore.SELECT} staffRoles staffAssignments`;
    let va = await VirtualAirlineAd.findOne({ slug: raw, status: 'approved' })
        .select(sel).lean();
    if (!va) {
        va = await VirtualAirlineAd.findOne({ callsign: raw.toUpperCase(), status: 'approved' })
            .select(sel).lean();
    }
    return va;
}

/**
 * The body a successful sign-in answers with, however it was signed in.
 *
 * Extracted the day Discord became a second door. Both doors establish exactly
 * the same thing — this person is that account at this VA — and a second copy
 * of "what a session looks like" is how one of them ends up quietly missing a
 * capability, or handing out a token with a field the other has. The doors
 * differ in how they decide WHO; they must not differ in what they hand over.
 */
/**
 * Where this session stands with the pilot terms.
 *
 * `applies` is the interesting field. An account is asked only when there is
 * somewhere to record the answer — a crew_accounts row, which an ordinary pilot
 * always has and a staff member has only once they have set up their pilot
 * side. Inflight oversight never has one and is never asked: they are not a
 * pilot at anybody's airline and there is no row to write it on.
 *
 * When it does not apply, `accepted` is true rather than false. The consumer of
 * this is a prompt, and a prompt that fires for somebody who cannot answer it
 * is a prompt with no button.
 */
function crewTermsState(acceptedVersion, applies) {
    return {
        version: CREW_TERMS_VERSION,
        url: CREW_TERMS_PAGE_PATH,
        applies: !!applies,
        accepted: applies ? String(acceptedVersion || '') === CREW_TERMS_VERSION : true,
    };
}

function crewSession(va, identity, username, slugFallback) {
    const view = viewForRole(identity.role);
    const token = signCrewToken({
        sub: identity.sub, kind: identity.kind, role: identity.role, view,
        slug: va.slug || String(slugFallback || '').toLowerCase(), vaId: String(va._id),
        name: identity.name, uname: username,
    });
    const payload = { kind: identity.kind, role: identity.role, uname: username };
    const caps = effectiveCaps(va, payload);
    return {
        token, view, role: identity.role, oversight: identity.kind === 'inflight', name: identity.name,
        username,
        // The password this account was issued was generated for them and
        // has been seen by whoever handed it over, so the crew center
        // asks for a new one before it lets them do anything else. Only
        // a store-backed account can change it here (see
        // POST /api/crew/:slug/account/password); central accounts are
        // told to use the portal.
        mustChangePassword: !!identity.mustChangePassword,
        canChangePassword: identity.kind === 'crew',
        // The notice, and whether this account has answered the current version
        // of it. Never a gate — see crewTerms.js — so this rides along with
        // every session and the page decides when to ask.
        terms: crewTermsState(identity.termsVersion, identity.termsApplies),
        caps, capabilities: CREW_CAPABILITIES, rolePresets: CREW_ROLE_PRESETS,
        va: { name: va.name, slug: va.slug || null, code: va.callsign || null },
    };
}

function registerCrewAuthRoutes(app) {
    // --- Sign in ---
    app.post('/api/crew/:slug/login', async (req, res) => {
        try {
            const va = await resolveVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });

            const username = String((req.body && req.body.username) || '').toLowerCase().trim();
            const password = String((req.body && req.body.password) || '');
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required.' });
            }

            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const StaffUser = mongoose.model('StaffUser');

            let identity = null;

            // 1) A pilot account in the VA's OWN data store.
            //
            // Deliberately tolerant of a store that cannot answer: a VA
            // half-way through connecting a project, or one whose project is
            // briefly unreachable, must not lock its own staff out of the
            // dashboard they would use to fix it. A failure here means "not
            // this identity" and the cascade continues.
            try {
                const store = await crewStore.forVa(va);
                const pilot = await crewAccounts.authenticate(store, username, password);
                if (pilot) {
                    identity = {
                        sub: String(pilot._id), kind: 'crew', role: pilot.role || 'pilot',
                        name: pilot.displayName || pilot.username,
                        mustChangePassword: !!pilot.mustChangePassword,
                        termsVersion: pilot.termsVersion || '',
                        termsApplies: true,
                    };
                    // The invitation has done its job. Clearing it here rather
                    // than on the password change is on purpose: arriving is the
                    // proof it was delivered, and a pilot who signs in and then
                    // wanders off should not leave a live credential on a status
                    // page anyone they forwarded the link to can still read.
                    //
                    // Fire-and-forget, and it must stay that way — a store that
                    // cannot record this is not a reason to refuse a login whose
                    // password we have already verified.
                    claimInvitation(store, pilot._id);
                }
            } catch (err) {
                if (err && err.code !== 'store_not_connected') {
                    console.warn('crew login: pilot store lookup failed —', err.message || err);
                }
            }

            // 2) A VA staff account that belongs to THIS crew center's VA.
            if (!identity) {
                const acct = await VaPortalAccount.findOne({ username });
                if (acct && acct.active && String(acct.vaAdId) === String(va._id)
                    && await bcrypt.compare(password, acct.passwordHash)) {
                    acct.lastLoginAt = new Date();
                    await acct.save();
                    identity = {
                        sub: String(acct._id), kind: 'va', role: acct.role,
                        name: acct.displayName || acct.username,
                        mustChangePassword: !!acct.mustChangePassword,
                    };
                }
            }

            // A staff member who has set up a pilot side is asked about the
            // terms like any other pilot, because they now have a row that can
            // record the answer. One who has not is not asked about a notice
            // that has nowhere to be written down.
            if (identity && identity.kind === 'va') {
                const row = await boundPilotRow(await crewStore.forVa(va).catch(() => null), identity.sub);
                if (row) { identity.termsVersion = row.termsVersion || ''; identity.termsApplies = true; }
            }

            // 3) Otherwise an Inflight staff member (oversight into any crew center).
            if (!identity) {
                const staff = await StaffUser.findOne({ username });
                if (staff && staff.active && await bcrypt.compare(password, staff.passwordHash)) {
                    staff.lastLoginAt = new Date();
                    await staff.save();
                    identity = { sub: String(staff._id), kind: 'inflight', role: 'inflight', name: staff.displayName || staff.username };
                }
            }

            // Same response whether the user was missing or the password was wrong.
            if (!identity) return res.status(401).json({ error: 'Invalid username or password.' });

            res.set('Cache-Control', 'no-store');
            res.json(crewSession(va, identity, username, req.params.slug));
        } catch (err) {
            console.error('Crew login error:', err);
            res.status(500).json({ error: 'Sign-in failed.' });
        }
    });

    // --- Crew settings (owner/staff or Inflight can change; e.g. the layout) ---
    app.post('/api/crew/:slug/settings', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });

        const slug = String(req.params.slug || '').toLowerCase();
        // Pilots can't change crew settings; a VA account is bound to its own crew.
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner' || p.role === 'staff')) {
            return res.status(403).json({ error: 'Not allowed to change crew settings.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
            const ad = await VirtualAirlineAd.findById(va._id);
            if (!ad) return res.status(404).json({ error: 'Crew center not found.' });

            // Per-capability gate: staff can only change the areas their role allows.
            const caps = effectiveCaps(ad, p);
            const can = (c) => caps.includes(c);
            const body = req.body || {};
            const touchesBranding = ['layout', 'accent', 'loginLook', 'loginBackdrop', 'topicMode', 'ranks', 'roles', 'fleet', 'social'].some(f => body[f] !== undefined);
            const touchesRecruit = ['joinMode', 'minGrade', 'callsignPrefix', 'discordInvite', 'applicationForm', 'joinRequirements'].some(f => body[f] !== undefined);
            const touchesTeam = body.staffRoles !== undefined || body.staffAssignments !== undefined;
            const touchesOps = body.pirepAutoApprove !== undefined;
            const touchesSchedule = body.schedule !== undefined;
            const touchesRetention = body.retention !== undefined;
            if (touchesBranding && !can('settings.branding')) return res.status(403).json({ error: 'You don’t have permission to change appearance.' });
            if (touchesRecruit && !can('settings.recruitment')) return res.status(403).json({ error: 'You don’t have permission to change recruitment settings.' });
            const isOwner = isInflight || p.role === 'owner';
            if (touchesTeam && !can('team.manage')) {
                return res.status(403).json({ error: 'You don’t have permission to manage staff roles.' });
            }
            // The no-escalation rule, and the reason team.manage is safe to
            // hand out at all. An owner holds everything, so this can only ever
            // fire for a delegate — who may grant what they hold and nothing
            // else, by either route. See teamSaveFailure.
            if (touchesTeam && !isOwner) {
                const overreach = teamSaveFailure(
                    {
                        roles: body.staffRoles,
                        // An assignments-only save still has to be judged
                        // against the roles that exist, or "point myself at the
                        // technical manager" would pass for want of a role
                        // array to look at.
                        assignments: body.staffAssignments,
                    },
                    { roles: ad.staffRoles || [], assignments: ad.staffAssignments || [] },
                    caps,
                );
                if (overreach) return res.status(403).json({ error: overreach });
            }
            if (touchesOps && !can('flights.review')) return res.status(403).json({ error: 'You don’t have permission to change flight tracking.' });
            // Gated on the same capability as building the schedule itself. A
            // staff member trusted to publish the week is the one who decides
            // how it is bid for; one who is not should not be able to switch
            // self-service booking off for the whole airline.
            if (touchesSchedule && !can('schedules.manage')) return res.status(403).json({ error: 'You don’t have permission to change the schedule settings.' });
            // Owner-grade and now delegable, but only deliberately. These
            // settings remove pilots from the roster on a timer, which is why
            // retention.manage is excluded from the unassigned-staff default
            // and is in none of the presets: the only way to hold it is for an
            // owner to have ticked that specific line on a role.
            if (touchesRetention && !can('retention.manage')) {
                return res.status(403).json({ error: 'You don’t have permission to change the roster sweep.' });
            }

            if (typeof req.body?.layout === 'string') {
                const layout = req.body.layout.toLowerCase();
                const allowed = (Array.isArray(ad.allowedLayouts) && ad.allowedLayouts.length)
                    ? ad.allowedLayouts : CREW_LAYOUTS;
                if (!CREW_LAYOUTS.includes(layout) || !allowed.includes(layout)) {
                    return res.status(400).json({ error: 'That layout isn’t available for this crew center.' });
                }
                ad.layout = layout;
            }
            if (typeof req.body?.accent === 'string') {
                const a = req.body.accent.trim();
                if (a && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(a)) {
                    return res.status(400).json({ error: 'Enter a valid hex colour like #1c1a16.' });
                }
                ad.crewAccent = a; // '' clears it (falls back to the derived accent)
            }
            // How a topic opens in the crew center. Stored as the crew's
            // default only: the dashboard lets a device override it, so this
            // is what somebody's first visit gets, not what they are held to.
            if (typeof req.body?.topicMode === 'string') {
                const mode = req.body.topicMode.toLowerCase();
                if (!CREW_TOPIC_MODES.includes(mode)) {
                    return res.status(400).json({ error: 'Unknown way of opening topics.' });
                }
                ad.crewTopicMode = mode;
            }
            if (typeof req.body?.loginLook === 'string') {
                const look = req.body.loginLook.toLowerCase();
                if (!LOGIN_LOOKS.includes(look)) {
                    return res.status(400).json({ error: 'Unknown login look.' });
                }
                ad.loginLook = look;
            }
            if (typeof req.body?.loginBackdrop === 'string') {
                const bg = req.body.loginBackdrop.toLowerCase();
                if (!LOGIN_BACKDROPS.includes(bg)) {
                    return res.status(400).json({ error: 'Unknown sign-in backdrop.' });
                }
                ad.loginBackdrop = bg;
            }
            // Where the airline is from. Two letters, upper case, or cleared —
            // the flag and the country's name are derived from the code
            // everywhere they are drawn, so anything else is not a country and
            // is refused rather than stored as one.
            if (req.body?.country !== undefined) {
                const cc = String(req.body.country || '').trim().toUpperCase();
                if (cc && !/^[A-Z]{2}$/.test(cc)) {
                    return res.status(400).json({ error: 'Country must be a two-letter country code, or empty.' });
                }
                ad.country = cc;
            }
            if (req.body?.ranks !== undefined) {
                const r = sanitizeRanks(req.body.ranks);
                if (r) ad.ranks = r;
            }
            if (req.body?.roles !== undefined) {
                const r = sanitizeRoles(req.body.roles);
                if (r) ad.roles = r;
            }
            if (req.body?.fleet !== undefined) {
                const f = sanitizeFleet(req.body.fleet);
                if (f) ad.crewFleet = f;
            }
            // Note the shape, as with `social` below: `partners` in and out,
            // `crewPartners` on the document.
            if (req.body?.partners !== undefined) {
                const p = sanitizePartners(req.body.partners);
                if (p) ad.crewPartners = p;
            }
            // The Instagram wall. Note the shape: `social` in and out, `crewSocial`
            // on the document — the settings screen has always spoken the short
            // name, and the VA record prefixes crew-center fields.
            if (req.body?.social !== undefined) {
                const sc = sanitizeSocial(req.body.social);
                if (sc) ad.crewSocial = sc;
            }
            // How this VA runs its schedule. Normalised by the same module that
            // ENFORCES these rules, so what is stored and what is applied
            // cannot disagree — a settings screen with its own idea of the
            // bounds is how a cap of 500 gets saved and then never applied.
            if (req.body?.schedule !== undefined && req.body.schedule !== null) {
                const incoming = req.body.schedule;
                if (typeof incoming !== 'object') {
                    return res.status(400).json({ error: 'Schedule settings must be an object.' });
                }
                // Merged over what is stored, not replacing it: the settings
                // screen sends the field that changed, and a partial body must
                // not reset the other five to their defaults.
                const merged = { ...crewSchedules.normalizeRules(ad.crewSchedule), ...incoming };
                const rules = crewSchedules.normalizeRules(merged);
                // A rank gate naming a rung that does not exist would lock the
                // schedule for everybody, silently. Same rule the route and
                // event gates follow: an unknown rung lapses OPEN.
                if (rules.minRank && !(Array.isArray(ad.ranks) ? ad.ranks : []).some(
                    (r) => String(r.name || '').toLowerCase() === rules.minRank.toLowerCase())) {
                    rules.minRank = '';
                }
                ad.crewSchedule = rules;
            }
            // The roster sweep. Merged and normalised the same way the schedule
            // rules are, and by the module that ENFORCES them — a settings
            // screen with its own idea of the bounds is how "90 days" gets
            // saved and "7" gets applied.
            if (req.body?.retention !== undefined && req.body.retention !== null) {
                const incoming = req.body.retention;
                if (typeof incoming !== 'object') {
                    return res.status(400).json({ error: 'Retention settings must be an object.' });
                }
                const merged = { ...crewRetention.normalizeRules(ad.crewRetention), ...incoming };
                ad.crewRetention = crewRetention.normalizeRules(merged);
            }
            if (typeof req.body?.joinMode === 'string' && ['free', 'application'].includes(req.body.joinMode)) {
                ad.joinMode = req.body.joinMode;
            }
            if (req.body?.minGrade !== undefined) {
                ad.minGrade = Math.max(0, Math.min(5, Number(req.body.minGrade) || 0));
            }
            if (typeof req.body?.callsignPrefix === 'string') {
                ad.callsignPrefix = req.body.callsignPrefix.trim().slice(0, 10);
            }
            // The VA's Discord invite, offered to every pilot they accept. The
            // accept dialog pre-fills from this and can override it per pilot.
            if (req.body?.discordInvite !== undefined) {
                const inv = cleanDiscordInvite(req.body.discordInvite);
                if (inv === null) {
                    return res.status(400).json({ error: 'That is not a Discord invite link. Use a discord.gg or discord.com/invite address.' });
                }
                ad.crewDiscordInvite = inv;
            }
            if (req.body?.applicationForm !== undefined) {
                const f = sanitizeForm(req.body.applicationForm);
                if (f) ad.applicationForm = f;
            }
            if (req.body?.joinRequirements !== undefined) {
                const r = sanitizeRequirements(req.body.joinRequirements);
                if (r) {
                    ad.joinRequirements = r;
                    // Keep minGrade mirrored from a grade requirement so the public
                    // directory + legacy gate stay in sync with the builder.
                    const g = r.find(x => x.type === 'grade');
                    if (g) ad.minGrade = Math.max(0, Math.min(5, g.value));
                }
            }
            if (touchesTeam) {
                // A delegate may only write ticks they hold. The 403 above has
                // already refused an overreaching save outright; passing the
                // set here too means the ceiling is enforced at the point of
                // writing as well as at the point of checking, so a future
                // caller that reaches this without the check cannot widen it.
                if (req.body.staffRoles !== undefined) { const r = sanitizeStaffRoles(req.body.staffRoles, isOwner ? null : caps, ad.staffRoles || []); if (r) ad.staffRoles = r; }
                if (req.body.staffAssignments !== undefined) { const a = sanitizeAssignments(req.body.staffAssignments); if (a) ad.staffAssignments = a; }
            }
            if (touchesOps) ad.crewPirepAutoApprove = !!req.body.pirepAutoApprove;
            await ad.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                layout: ad.layout, allowedLayouts: ad.allowedLayouts, accent: ad.crewAccent || '',
                loginLook: ad.loginLook || 'center', loginBackdrop: ad.loginBackdrop || 'auto',
                topicMode: ad.crewTopicMode || 'sheet',
                country: ad.country || '',
                ranks: ad.ranks || [], roles: ad.roles || [], fleet: ad.crewFleet || [],
                partners: ad.crewPartners || [],
                joinMode: ad.joinMode, minGrade: ad.minGrade, callsignPrefix: ad.callsignPrefix || '',
                discordInvite: ad.crewDiscordInvite || '',
                applicationForm: ad.applicationForm || [], joinRequirements: ad.joinRequirements || [],
                staffRoles: ad.staffRoles || [], staffAssignments: ad.staffAssignments || [],
                pirepAutoApprove: !!ad.crewPirepAutoApprove,
                // Echoed unconditionally. The crew dashboard treats a missing
                // `social` in this reply as "the backend does not store it yet"
                // and warns that the wall will be empty after a reload, so an
                // empty wall must come back as {handle:'',posts:[]}, not absent.
                social: publicSocial(ad),
            });
        } catch (err) {
            console.error('Crew settings error:', err);
            // A rejected WRITE is not a server fault, and reporting it as one is
            // how a schema that could never store a fleet row survived unnoticed:
            // every save came back as a bare "Could not save settings." with the
            // real reason (`Cast to [string] failed at path crewFleet.0`) visible
            // only in the logs. Name the field that was refused so the next one
            // is diagnosable from the dashboard.
            if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
                const path = err.path || Object.keys(err.errors || {})[0] || '';
                return res.status(400).json({
                    error: path
                        ? `The server refused to store “${path}”. This is a bug on our side — please report it.`
                        : 'The server refused those settings. This is a bug on our side — please report it.',
                });
            }
            res.status(500).json({ error: 'Could not save settings.' });
        }
    });


    // --- Who there is to assign (owner, Inflight, or a delegate with team.manage) ---
    //
    // The team editor keys an assignment on a staff member's LOGIN username,
    // and until now the owner had to remember it and type it correctly. That
    // is the step the whole permission system was failing at: a name typed
    // with a typo, or a pilot's roster name typed instead of their login,
    // saves cleanly and grants nothing, with nothing on screen to say so.
    //
    // Nothing here is secret — these accounts already appear in the VA portal's
    // own team list, to the same people. Pilot logins are deliberately NOT
    // returned: a pilot cannot hold a staff role, so offering one would be
    // offering an assignment that does nothing.
    app.get('/api/crew/:slug/staff-accounts', async (req, res) => {
        const p = verifyCrewRequest(req);
        if (!p) return res.status(401).json({ error: 'Not authenticated.' });

        const slug = String(req.params.slug || '').toLowerCase();
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner' || p.role === 'staff')) {
            return res.status(403).json({ error: 'Not allowed.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });

            // Same gate as the team editor itself: an owner, Inflight, or a
            // delegate the owner handed team.manage to. A staff member without
            // it has no business reading their colleagues' login names.
            if (!(isInflight || p.role === 'owner')) {
                const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
                const ad = await VirtualAirlineAd.findById(va._id).select('staffRoles staffAssignments').lean();
                if (!effectiveCaps(ad, p).includes('team.manage')) {
                    return res.status(403).json({ error: 'Not allowed.' });
                }
            }

            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const rows = await VaPortalAccount
                .find({ vaAdId: va._id, role: { $in: ['owner', 'staff'] } })
                .select('username displayName role active crewMemberId')
                .sort({ role: 1, username: 1 })
                .lean();

            // The roster, so the editor can offer the people the airline
            // actually has. A store that cannot answer is not an error here:
            // the staff list above is the part that must render, and a VA
            // half-way through connecting a project should still see it.
            const byMember = new Map(rows
                .filter(a => a.crewMemberId)
                .map(a => [String(a.crewMemberId), a.username]));
            let roster = [];
            try {
                const store = await crewStore.forVa(va);
                roster = await store.listMembers({ limit: 2000 });
            } catch (err) {
                if (err && err.code !== 'store_not_connected') {
                    console.warn('crew staff-accounts: roster unavailable —', err.message || err);
                }
            }

            res.set('Cache-Control', 'no-store');
            res.json({
                accounts: rows.map(a => ({
                    username: a.username,
                    displayName: a.displayName || a.username,
                    role: a.role,
                    active: a.active !== false,
                    crewMemberId: a.crewMemberId || null,
                })),
                // WHO THERE IS TO PROMOTE.
                //
                // The list above answers "who already has a staff login", and
                // for most VAs that is one row: the owner. Which made the team
                // editor read as broken — an airline with three pilots on the
                // roster opened a screen full of roles and permissions and had
                // nobody to give them to, with nothing on the page to say that
                // staff logins are a separate thing created somewhere else.
                //
                // So the roster comes back with it. Nothing here is a secret:
                // GET /roster is public and returns more than this.
                roster: roster.map(m => ({
                    memberId: String(m._id),
                    name: m.name || '',
                    callsign: m.callsign || '',
                    // Already staff — offered as context, not as a candidate.
                    staffUsername: byMember.get(String(m._id)) || null,
                })),
            });
        } catch (err) {
            console.error('Crew staff-accounts error:', err);
            res.status(500).json({ error: 'Could not load the staff accounts.' });
        }
    });

    // --- Make a roster pilot a staff member (owner or Inflight only) ---
    //
    // The step that was missing. Until now "give somebody permissions" meant
    // leaving the crew center, creating a second login by hand in the VA
    // portal, and coming back to assign a role to a username typed from memory.
    // An owner looking at their own roster could not act on it.
    //
    // OWNER ONLY, and not delegable to team.manage like the read above. An
    // unassigned staff account inherits CREW_DEFAULT_STAFF_CAPS — everything
    // bar the owner-grade set — so being able to mint one is a bigger power
    // than being able to assign a role, and the no-escalation rule that makes
    // team.manage safe does not cover it.
    //
    // For the same reason a role (or at least one tick) is REQUIRED: the
    // assignment is written in the same breath as the account, so a person
    // promoted here can never land on that permissive default.
    app.post('/api/crew/:slug/staff-accounts', async (req, res) => {
        const p = verifyCrewRequest(req);
        if (!p) return res.status(401).json({ error: 'Not authenticated.' });

        const slug = String(req.params.slug || '').toLowerCase();
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner')) {
            return res.status(403).json({ error: 'Only the owner can make somebody staff.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });

            const memberId = clampStr(req.body && req.body.memberId, 80);
            if (!memberId) return res.status(400).json({ error: 'Pick somebody from the roster.' });

            const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
            const ad = await VirtualAirlineAd.findById(va._id);
            if (!ad) return res.status(404).json({ error: 'Crew center not found.' });

            const roleId = clampStr(req.body && req.body.roleId, 40);
            const permissions = [...new Set((Array.isArray(req.body && req.body.permissions) ? req.body.permissions : [])
                .filter(c => CREW_CAP_IDS.includes(c)))];
            const roles = Array.isArray(ad.staffRoles) ? ad.staffRoles : [];
            if (roleId && !roles.some(r => r && r.id === roleId)) {
                return res.status(400).json({ error: 'That role no longer exists — reload and pick again.' });
            }
            if (!roleId && !permissions.length) {
                return res.status(400).json({
                    error: 'Give them a role, or tick at least one permission. A staff account with neither would get the full staff default.',
                    code: 'role_required',
                });
            }

            const store = await crewStore.forVa(va);
            const member = await store.getMember(memberId);
            if (!member) return res.status(404).json({ error: 'That pilot is not on the roster.' });

            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const already = await VaPortalAccount
                .findOne({ vaAdId: va._id, crewMemberId: String(member._id) })
                .select('username').lean();
            if (already) {
                return res.status(409).json({ error: `@${already.username} is already staff.` });
            }

            // THE ONE IDENTITY, WHERE WE CAN HAVE IT.
            //
            // The login cascade tries the VA's own pilot store FIRST, so a
            // staff account minted under a name that pilot already signs in
            // with would be unreachable behind their pilot row — they would
            // type the password they know and land back on the pilot page.
            //
            // So when they have a pilot login we take it over rather than
            // sitting behind it: same username, the same bcrypt hash copied
            // across, and the pilot row deactivated so the cascade falls
            // through to the staff account. They keep the credentials they
            // already had and simply become staff. crewMemberId points back at
            // their roster row, which is what keeps them able to fly (see the
            // `kind === 'va'` branch of the pilot resolver in server.js).
            //
            // Two cases fall back to a fresh login with a generated password:
            // a pilot with no login at all, and one whose username is already
            // taken elsewhere in the portal (usernames are globally unique).
            // The response says which happened rather than leaving the owner to
            // guess why a password did or did not appear.
            const pilotAcct = await Promise.resolve()
                .then(() => (typeof store.getAccountByMember === 'function'
                    ? store.getAccountByMember(String(member._id)) : null))
                .catch(() => null);

            let username = '';
            let passwordHash = '';
            let issuedPassword = null;
            let keptTheirLogin = false;

            const pilotName = String((pilotAcct && pilotAcct.username) || '').toLowerCase().trim();
            if (pilotName && pilotAcct.passwordHash && !(await VaPortalAccount.exists({ username: pilotName }))) {
                username = pilotName;
                passwordHash = pilotAcct.passwordHash;
                keptTheirLogin = true;
            } else {
                const base = crewAccounts.baseUsername(member.name || pilotName || 'staff') || 'staff';
                username = base;
                for (let n = 2; await VaPortalAccount.exists({ username }); n += 1) {
                    username = `${base}${n}`;
                    if (n > 99) { username = `${base}${Date.now().toString(36)}`; break; }
                }
                issuedPassword = crewAccounts.generatePassword();
                passwordHash = await bcrypt.hash(issuedPassword, 12);
            }

            const account = await VaPortalAccount.create({
                username,
                displayName: member.name || username,
                passwordHash,
                role: 'staff',
                vaAdId: va._id,
                vaName: va.name || '',
                crewMemberId: String(member._id),
                createdVia: 'owner',
                createdByName: p.name || p.uname || '',
                active: true,
                // Only when we issued the password. Taking over a login they
                // already chose a password for must not nag them to change it.
                mustChangePassword: !!issuedPassword,
            });

            // Stand the pilot row down only where the staff account actually
            // replaces it. Deliberately after the account exists: if the create
            // failed we would otherwise have locked a pilot out of a login and
            // given them nothing in exchange.
            if (keptTheirLogin) {
                await store.updateAccount(pilotAcct._id, { active: false })
                    .catch(err => console.warn('crew promote: could not stand down the pilot login —', err?.message || err));
            }

            // The assignment, in the same breath as the account. See above.
            const asn = Array.isArray(ad.staffAssignments) ? ad.staffAssignments.slice() : [];
            asn.push({ username, roleId, permissions });
            ad.staffAssignments = sanitizeAssignments(asn) || asn;
            await ad.save();

            res.set('Cache-Control', 'no-store');
            res.status(201).json({
                account: {
                    username: account.username,
                    displayName: account.displayName,
                    role: account.role,
                    active: true,
                    crewMemberId: account.crewMemberId,
                },
                // Shown once, and only when there was one to issue.
                password: issuedPassword,
                keptTheirLogin,
            });
        } catch (err) {
            console.error('Crew staff promote error:', err);
            res.status(500).json({ error: 'Could not make them staff.' });
        }
    });

    // --- Connect the VA's Supabase project (owner or Inflight only) ---
    // Stores the project URL + public anon key (browser-safe) and, optionally,
    // the secret service-role key (never returned). Staff/pilots cannot touch it.
    app.post('/api/crew/:slug/supabase', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });

        const slug = String(req.params.slug || '').toLowerCase();
        const isInflight = p.kind === 'inflight';
        if (!(isInflight || p.role === 'owner')) {
            return res.status(403).json({ error: 'Only the VA owner can connect Supabase.' });
        }
        if (!isInflight && p.slug && p.slug !== slug) {
            return res.status(403).json({ error: 'Wrong crew center.' });
        }

        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const VirtualAirlineAd = mongoose.model('VirtualAirlineAd');
            const ad = await VirtualAirlineAd.findById(va._id).select('+supabaseServiceKey');
            if (!ad) return res.status(404).json({ error: 'Crew center not found.' });

            const body = req.body || {};
            if (body.url !== undefined) {
                const u = String(body.url || '').trim().replace(/\/+$/, '');
                if (u && !/^https:\/\/[a-z0-9.-]+/i.test(u)) {
                    return res.status(400).json({ error: 'Enter a valid https Supabase project URL.' });
                }
                ad.supabaseUrl = u;
            }
            if (body.anonKey !== undefined) ad.supabaseAnonKey = String(body.anonKey || '').trim();
            // Only overwrite the secret when a new non-empty value is supplied, so
            // re-saving without re-typing it doesn't wipe it. '' with clear:true clears.
            if (typeof body.serviceKey === 'string' && body.serviceKey.trim()) {
                ad.supabaseServiceKey = body.serviceKey.trim();
            } else if (body.clearServiceKey === true) {
                ad.supabaseServiceKey = '';
            }
            await ad.save();
            res.set('Cache-Control', 'no-store');
            res.json({
                connected: !!(ad.supabaseUrl && ad.supabaseAnonKey),
                url: ad.supabaseUrl || '',
                anonKey: ad.supabaseAnonKey || '',
                hasServiceKey: !!ad.supabaseServiceKey,
            });
        } catch (err) {
            console.error('Crew supabase save error:', err);
            res.status(500).json({ error: 'Could not save the Supabase connection.' });
        }
    });

    // --- Who am I (verify a Bearer token for this crew center) ---
    /* =====================================================================
     * SIGNING IN WITH DISCORD
     *
     * Four routes, and the shape of the flow is the reason for each of them:
     *
     *   GET  /auth/discord            the pilot leaves for Discord
     *   GET  /auth/discord/callback   Discord sends them back here, to the API
     *   POST /auth/discord/exchange   the crew center swaps the handoff for a session
     *   DEL  /account/discord         unlink
     *
     * THE THIRD ONE IS WHY THIS IS NOT TWO ROUTES. The callback lands on the
     * API and the session it establishes belongs to a page on another origin.
     * The crew center has never used a cookie — that is why its CORS is as
     * simple as it is — so the session has to cross the redirect, and a bearer
     * token good for a week has no business being in a URL. What crosses is a
     * ninety-second handoff that can be spent at exactly one endpoint, and it
     * crosses in the FRAGMENT, which no server ever sees.
     *
     * Every failure below leaves through the same door: back to the crew center
     * with ?discord=<reason> in the QUERY, where the page can read it and say
     * something. None of them says which of "no such link", "wrong airline" or
     * "that account is switched off" happened in a way that would let somebody
     * enumerate a roster by trying Discord accounts.
     * =================================================================== */

    /* WHERE A PILOT IS SENT BACK TO.
     *
     * The origin is configuration and the path is this platform's own
     * /crew/<slug> — neither is ever taken from the request, because a redirect
     * whose destination a caller can influence is an open redirect with a login
     * attached to it.
     *
     * THE SLUG IS THE CANONICAL ONE, sealed into the state before the pilot
     * ever left. That is what makes this right for somebody who flies for two
     * airlines: the crew center they pressed the button in is the crew center
     * they come back to, and the account that is looked up lives in THAT
     * airline's own database. A pilot linked at two VAs has two rows in two
     * projects, and nothing here can cross from one to the other.
     *
     * `embed` is the one thing the page gets a say in, and it is a boolean: it
     * decides whether ?embed=1 rides along so the app's overlay keeps its
     * chrome. It cannot change where the pilot lands, only how that page dresses
     * itself. Without it, a pilot who signed in inside the app was answered with
     * the standalone page in the overlay's frame.
     */
    const crewPageFor = (slug, embed, where) => {
        const base = String(process.env.CREW_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '')
            .replace(/\/+$/, '');
        const s = encodeURIComponent(String(slug || '').toLowerCase());
        /* WHERE THEY CAME FROM, AND THEREFORE WHERE THEY GO BACK TO.
         *
         * A SIGN-IN always lands on the crew center's front door: they were not
         * signed in when they left, and the page has to spend the handoff for a
         * session before anything else can be drawn.
         *
         * A LINK is the opposite. That person was already signed in, standing on
         * their account page or their dashboard, and sending them to the sign-in
         * page — which is what this did before `where` existed — answered "link
         * Discord" with a login form and no word about whether it worked. The
         * confirmation lives on the page they started from, so that is the page
         * they come back to.
         *
         * A FIXED SET of three, chosen here from the sealed state. Never a URL
         * or a path from the request: a redirect whose destination a caller can
         * influence is an open redirect with a login attached to it. */
        const path = where === 'pilot' ? `${base}/crew-pilot.html?va=${s}&`
            : where === 'dashboard' ? `${base}/crew-dashboard.html?va=${s}&`
                : `${base}/crew/${s}?`;
        return embed ? `${path}embed=1&` : path;
    };
    const backToCrew = (res, slug, reason, embed, where) =>
        res.redirect(`${crewPageFor(slug, embed, where)}discord=${encodeURIComponent(reason)}`);

    /* --- 1a. Leaving for Discord, to SIGN IN -----------------------------
     *
     * A plain redirect, because there is nothing to authenticate: a login flow
     * can only ever find an account that is already linked, so starting one
     * proves nothing and costs nothing. The button on the sign-in page is an
     * ordinary navigation to here.
     */
    app.get('/api/crew/:slug/auth/discord', async (req, res) => {
        if (!crewDiscord.configured()) {
            return backToCrew(res, req.params.slug, 'unavailable');
        }
        const va = await resolveVa(req.params.slug);
        if (!va) return backToCrew(res, req.params.slug, 'unknown');
        const slug = va.slug || String(req.params.slug).toLowerCase();
        res.set('Cache-Control', 'no-store');
        res.redirect(crewDiscord.authorizeUrl(crewDiscord.signState({
            slug, intent: 'login', sub: '', embed: String(req.query.embed || '') === '1',
        }), req));
    });

    /* --- 1b. Leaving for Discord, to LINK --------------------------------
     *
     * Answers with the address rather than redirecting to it, and that is the
     * whole design of this route.
     *
     * A link flow has to know WHICH account is linking, and the only
     * trustworthy answer is the caller's own session — which lives in an
     * Authorization header, which a browser cannot attach to a navigation. The
     * obvious workaround is to let the token ride in the query string instead,
     * and it is the wrong one: it puts a week-long credential into browser
     * history, into a Referer and into every log between here and there.
     *
     * So the page POSTs (header and all), gets back a URL that carries only a
     * signed state, and navigates to that. The account id is sealed into the
     * state here and is never read from anything the browser hands back later,
     * which is what stops a link round trip being aimed at somebody else.
     */
    app.post('/api/crew/:slug/auth/discord/link', async (req, res) => {
        const slug = String(req.params.slug || '').toLowerCase();
        const p = verifyCrewRequest(req);
        // A link has to be written on a row, so the caller needs one. A pilot
        // IS one. A staff member has one once they have set up their pilot side
        // (v17) — and is told to do that rather than handed a button that would
        // fail on the way back. Inflight oversight has none at anybody's
        // airline and is not offered the button at all.
        if (!p || (p.kind !== 'crew' && p.kind !== 'va')) {
            return res.status(401).json({ error: 'Sign in to your crew center first.' });
        }
        if (p.slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        if (!p.sub) return res.status(401).json({ error: 'Sign in to your crew center first.' });
        if (!crewDiscord.configured()) {
            return res.status(503).json({ error: 'Signing in with Discord is not switched on here.', code: 'unavailable' });
        }
        const va = await resolveVa(slug);
        if (!va) return res.status(404).json({ error: 'Crew center not found.' });

        /* WHICH ROW THE LINK LANDS ON.
           Always a crew_accounts id, whichever kind of session asked, so the
           callback that comes back has exactly one shape to handle and cannot
           be made to write a Discord id somewhere that is not a pilot row. For
           a staff session that is their bound pilot side, looked up here rather
           than taken from anything the browser sent. */
        let sub = String(p.sub);
        if (p.kind === 'va') {
            let row = null;
            try { row = await boundPilotRow(await crewStore.forVa(va), String(p.sub)); }
            catch { row = null; }
            if (!row) {
                return res.status(409).json({
                    error: 'Set up your pilot side first — then you can link Discord to it.',
                    code: 'no_pilot_side',
                });
            }
            sub = String(row._id);
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            url: crewDiscord.authorizeUrl(crewDiscord.signState({
                slug: va.slug || slug, intent: 'link', sub,
                embed: String((req.body && req.body.embed) || '') === '1',
                // Taken from the SESSION, not from the request: a pilot links
                // from their account page and a staff member from their
                // dashboard, and which of the two this is has already been
                // established by the token above.
                back: p.kind === 'va' ? 'dashboard' : 'pilot',
            }), req),
        });
    });

    /* WHY THE CALLBACK WENT WRONG, IN ONE WORD THE PAGE CAN PRINT.
     *
     * This used to be three store codes and then 'failed' for everything else,
     * and 'failed' is drawn by the crew center as "Discord didn't answer.
     * Please try again." That sentence is right for exactly one of the things
     * that actually happen here. For the rest it is advice that cannot ever
     * work, and a pilot who follows it fails again and reports that Discord is
     * down — which sends the VA's staff, and us, looking in the wrong place.
     *
     * Every branch below is a DIFFERENT PERSON'S problem to fix:
     *
     *   needs_update   the VA's staff, by re-running the setup SQL
     *   store_offline  nobody, yet — the VA's project did not answer
     *   store_denied   the VA's staff, by re-copying their service key
     *   store_readonly the VA's staff, by making room in Supabase
     *   link_taken     the pilot, by unlinking that Discord elsewhere
     *   discord_setup  US. Discord answered and said no: the secret, the
     *                  client id, or a redirect URI that does not match the
     *                  one registered on the application. A pilot retrying is
     *                  wasted effort, and the log line below is the whole
     *                  diagnosis — it names Discord's own error slug and the
     *                  redirect_uri we sent.
     *   failed         genuinely unknown, and only now does "try again" apply.
     *
     * Every one of them is LOGGED with the store's or Discord's own detail,
     * because the reason a pilot sees has to stay vague enough not to enumerate
     * a roster and the reason in the log does not.
     */
    function discordFailure(err, slug) {
        const code = (err && err.code) || '';
        const detail = (err && err.detail) || '';
        const say = (reason) => {
            const line = [`Crew Discord callback [${reason}]`, slug, code, detail,
                !detail && err && err.message].filter(Boolean).join(' · ');
            if (reason === 'failed' || reason === 'discord_setup') console.error(line);
            else console.warn(line);
            return reason;
        };

        // The VA's project. Each of these already carries the store's own
        // sentence and its own fix; what is chosen here is only which of them
        // the pilot's page is allowed to say out loud.
        if (code === 'store_schema_missing' || code === 'store_accounts_missing'
            || code === 'store_schema_outdated') return say('needs_update');
        if (code === 'store_unreachable' || code === 'store_timeout') return say('store_offline');
        if (code === 'store_unauthorized') return say('store_denied');
        if (code === 'store_read_only') return say('store_readonly');
        /* The unique index on (va_slug, discord_id) firing anyway. The check
           above it is a read and this is the write, so two link attempts a
           moment apart can both pass the read — and the loser has to be told
           the same thing the check would have told them, not "Discord didn't
           answer". */
        if (code === 'store_conflict') return say('link_taken');

        // Discord itself. 'refused' means it answered and declined, which is
        // always a configuration fault at our end rather than a bad moment.
        if (code === 'discord_refused') return say('discord_setup');
        if (code === 'discord_unreachable') return say('failed');

        return say('failed');
    }

    /* --- 2. Coming back from Discord -------------------------------------- */
    app.get('/api/crew/auth/discord/callback', async (req, res) => {
        const state = crewDiscord.readState(req.query.state);
        // Nothing to go back to. A callback with no readable state is either
        // expired, forged, or somebody opening the URL out of their history,
        // and in none of those cases do we know which crew center to return to.
        if (!state) return res.status(400).type('text/plain').send('That sign-in link has expired. Please try again from your crew center.');

        const slug = state.slug;
        const embed = state.embed;
        // Only a link has somewhere else to go back to; a sign-in has to land
        // on the front door to spend its handoff.
        const back = state.intent === 'link' ? state.back : '';
        // The pilot pressed Cancel on the consent screen, which is a decision
        // rather than a fault.
        if (req.query.error || !req.query.code) return backToCrew(res, slug, 'cancelled', embed, back);

        try {
            const va = await resolveVa(slug);
            if (!va) return backToCrew(res, slug, 'unknown', embed, back);

            const profile = await crewDiscord.fetchProfile(await crewDiscord.exchangeCode(req.query.code, req));
            const store = await crewStore.forVa(va);

            /* --- LINKING ---
               The account was decided before the pilot ever left for Discord.
               All that is established here is which Discord identity came
               back. */
            if (state.intent === 'link') {
                const account = await store.getAccount(state.sub);
                if (!account || !account.active) return backToCrew(res, slug, 'link_denied', embed, back);

                // One Discord identity, one login, per crew center. The unique
                // index is the thing that actually enforces this; the check is
                // here so the pilot gets a sentence instead of a constraint
                // violation.
                const taken = await store.getAccountByDiscord(profile.id);
                if (taken && String(taken._id) !== String(account._id)) {
                    return backToCrew(res, slug, 'link_taken', embed, back);
                }

                await store.updateAccount(account._id, {
                    discordId: profile.id,
                    discordUsername: crewDiscord.displayName(profile),
                    discordAvatar: profile.avatar,
                    discordLinkedAt: new Date(),
                });
                return backToCrew(res, slug, 'linked', embed, back);
            }

            /* --- SIGNING IN ---
               The one question, asked once: which account is already written
               against this Discord id. A miss is a miss — nothing is created,
               nothing is claimed, and no other way of matching is tried. */
            const account = await store.getAccountByDiscord(profile.id);
            if (!account) return backToCrew(res, slug, 'not_linked', embed);
            if (!account.active) return backToCrew(res, slug, 'not_linked', embed);

            claimInvitation(store, account._id);
            const handoff = crewDiscord.signHandoff({ slug, sub: String(account._id) });
            res.set('Cache-Control', 'no-store');
            // The FRAGMENT, so the credential is never in a log, a Referer or a
            // proxy's history. The query beside it is only a hint for the page.
            return res.redirect(`${crewPageFor(slug, embed)}discord=ok#discord=${encodeURIComponent(handoff)}`);
        } catch (err) {
            return backToCrew(res, slug, discordFailure(err, slug), embed, back);
        }
    });

    /* --- 3. The handoff, for a session ------------------------------------
     *
     * Spending the handoff re-reads the account rather than trusting anything
     * inside the token beyond the id: the ninety seconds between the callback
     * and this call are ninety seconds in which staff could have switched the
     * account off, and the login it produces has to be the one the password
     * door would have produced at this instant.
     */
    app.post('/api/crew/:slug/auth/discord/exchange', async (req, res) => {
        const d = crewDiscord.readHandoff((req.body && req.body.code) || '');
        const slug = String(req.params.slug || '').toLowerCase();
        if (!d || !d.sub || d.slug !== slug) {
            return res.status(401).json({ error: 'That sign-in has expired. Please try again.' });
        }
        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const store = await crewStore.forVa(va);
            const account = await store.getAccount(d.sub);
            if (!account || !account.active) {
                return res.status(401).json({ error: 'That sign-in has expired. Please try again.' });
            }

            /* --- A STAFF MEMBER'S PILOT SIDE. v17. ---
               The row says which central account it belongs to, and that
               account — not this row — decides what the session can do. Read
               fresh, for the same reason the row above is: the ninety seconds
               since the callback are ninety seconds in which the person could
               have been removed from the team, and the session this produces
               has to be the one the password door would produce right now.

               A role is never taken from the row. The row's role is 'pilot' and
               is written into a project the VA's own people can edit; if it
               were consulted here, editing a database would be a way to grant
               capabilities. */
            if (account.portalAccountId) {
                const acct = await mongoose.model('VaPortalAccount')
                    .findById(account.portalAccountId)
                    .select('username displayName role active vaAdId mustChangePassword').lean();
                // Gone, switched off, or moved to another airline. Refused
                // rather than quietly downgraded to a pilot session: somebody
                // whose staff account has been taken away should be told their
                // sign-in no longer works, not handed a lesser one and left to
                // work out what changed.
                if (!acct || acct.active === false || String(acct.vaAdId) !== String(va._id)) {
                    return res.status(401).json({ error: 'That sign-in has expired. Please try again.' });
                }
                res.set('Cache-Control', 'no-store');
                return res.json(crewSession(va, {
                    sub: String(acct._id), kind: 'va', role: acct.role,
                    name: acct.displayName || acct.username,
                    mustChangePassword: !!acct.mustChangePassword,
                    termsVersion: account.termsVersion || '',
                    termsApplies: true,
                }, acct.username, slug));
            }

            res.set('Cache-Control', 'no-store');
            res.json(crewSession(va, {
                sub: String(account._id), kind: 'crew', role: account.role || 'pilot',
                name: account.displayName || account.username,
                mustChangePassword: !!account.mustChangePassword,
                termsVersion: account.termsVersion || '',
                termsApplies: true,
            }, account.username, slug));
        } catch (err) {
            console.error('Crew Discord exchange error:', err && err.message ? err.message : err);
            res.status(500).json({ error: 'Sign-in failed.' });
        }
    });

    /* --- 4. Unlinking -----------------------------------------------------
     *
     * Always allowed, and deliberately not gated on having another way in: a
     * pilot who unlinks still has the password their VA issued, and staff can
     * reset it. The alternative — refusing until they prove they know it —
     * makes the safer action the harder one.
     */
    app.delete('/api/crew/:slug/account/discord', async (req, res) => {
        const p = verifyCrewRequest(req);
        const slug = String(req.params.slug || '').toLowerCase();
        if (!p || (p.kind !== 'crew' && p.kind !== 'va')) return res.status(401).json({ error: 'Not authenticated.' });
        if (p.slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const store = await crewStore.forVa(va);
            // Whichever row the link was written on is the row it is cleared
            // from — the caller's own, never one named in the request.
            const rowId = p.kind === 'crew'
                ? String(p.sub)
                : String((await boundPilotRow(store, String(p.sub)) || {})._id || '');
            if (!rowId) return res.json({ ok: true, discord: { available: crewDiscord.configured(), linked: false, name: '', avatar: '' } });
            await store.updateAccount(rowId, {
                discordId: '', discordUsername: '', discordAvatar: '', discordLinkedAt: null,
            });
            res.json({ ok: true, discord: { available: crewDiscord.configured(), linked: false, name: '', avatar: '' } });
        } catch (err) {
            console.error('Crew Discord unlink error:', err && err.message ? err.message : err);
            res.status(500).json({ error: 'That could not be unlinked.' });
        }
    });

    /* =====================================================================
     * A STAFF MEMBER'S OWN PILOT SIDE. v17.
     *
     * THE PROBLEM THIS SOLVES. A VA's owner and staff sign in with one of OUR
     * central accounts, which has no row in the VA's project. So the people who
     * run the airline could manage everything about it and be nobody in it:
     * nothing to link Discord to, nothing to address a message to, no login of
     * their own on the roster they administer.
     *
     * What existed instead was claiming a ROSTER row (POST /me/pilot, in
     * server.js) — which makes them bookable and no more — or being handed a
     * second, ordinary pilot login by somebody with roster.manage. The second
     * is two credentials for one person and an account that is theirs only by
     * convention; it is what this replaces.
     *
     * WHAT THIS DOES NOT DO. It does not take, claim or merge anybody else's
     * pilot account. It creates a row that belongs to the caller's own central
     * account, and it will only ever create one — called twice, it returns the
     * one they already have.
     *
     * WHAT IT CANNOT DO. Grant anything. The row's role is 'pilot' and the
     * session's capabilities are still resolved from the central account (see
     * effectiveCaps); a row in a project the VA's own people can write to must
     * never be able to promote anybody.
     * =================================================================== */
    app.post('/api/crew/:slug/me/pilot-side', async (req, res) => {
        const p = verifyCrewRequest(req);
        const slug = String(req.params.slug || '').toLowerCase();
        if (!p) return res.status(401).json({ error: 'Not authenticated.' });
        // A pilot already has one: it is the account they signed in with.
        if (p.kind === 'crew') {
            return res.status(400).json({
                error: 'You already have a pilot account — this is it.',
                code: 'already_a_pilot',
            });
        }
        // Inflight oversight is not a pilot at anybody's airline, and must not
        // be able to put itself on a VA's roster.
        if (p.kind !== 'va') {
            return res.status(403).json({
                error: 'An Inflight staff login cannot fly for a VA.',
                code: 'not_a_va_account',
            });
        }
        if (p.slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const VaPortalAccount = mongoose.model('VaPortalAccount');
            const acct = await VaPortalAccount.findById(p.sub)
                .select('username displayName active vaAdId crewMemberId').lean();
            if (!acct || acct.active === false || String(acct.vaAdId) !== String(va._id)) {
                return res.status(403).json({ error: 'That account does not belong to this crew center.' });
            }
            const store = await crewStore.forVa(va);
            if (typeof store.getAccountByPortal !== 'function') {
                return res.status(409).json({
                    error: 'This crew center’s data store cannot hold a staff pilot account yet.',
                    code: 'unsupported_store',
                });
            }

            const name = String(acct.displayName || acct.username || 'Staff').trim();

            /* THE ROSTER ROW.
               In order of preference: one they asked for, the one they have
               already claimed, or a new one in their own name. The third is the
               point of the whole route — a staff member should not have to pick
               somebody else's row off the roster to be a pilot — and it is why
               this creates rather than only links. */
            let member = null;
            const wanted = String((req.body && req.body.memberId) || '').trim();
            if (wanted) {
                member = await store.getMember(wanted);
                if (!member) return res.status(404).json({ error: 'That pilot isn’t on this roster.' });
                /* NOT SOMEBODY ELSE'S. The request may name any roster row, so
                   this is the check that stops a staff member binding their
                   pilot side to a pilot who signs in as themselves — two
                   identities on one record, each able to cancel the other's
                   flying, and the pilot's own login no longer findable by their
                   roster row. The same rule POST /me/pilot applies; this is the
                   other door into it.
                   Their own binding passes, because re-running this route with
                   the row they already hold has to be a no-op and not a refusal. */
                if (typeof store.getAccountByMember === 'function') {
                    const owner = await store.getAccountByMember(member._id).catch(() => null);
                    if (owner && String(owner.portalAccountId || '') !== String(acct._id)) {
                        return res.status(409).json({
                            error: 'That pilot already has their own crew center login.',
                            code: 'pilot_has_login',
                        });
                    }
                }
            } else if (acct.crewMemberId) {
                member = await store.getMember(acct.crewMemberId);
            }
            /* Already on the roster under their own name? Take that row rather
               than adding a second of them — see findUnclaimedNamesake for why
               a duplicate is worse than it looks. */
            if (!member) {
                member = await crewAccounts.findUnclaimedNamesake(store, name, String(acct._id));
            }
            if (!member) {
                member = await store.createMember({
                    name,
                    // Left for them to fill in on the roster: a callsign is the
                    // VA's to issue in their own numbering, and guessing one
                    // risks handing out a number another pilot already flies.
                    callsign: '',
                    hours: 0,
                    status: 'active',
                });
            }

            const r = await crewAccounts.provisionStaffAccount(store, {
                portalAccountId: String(acct._id),
                displayName: name,
                username: acct.username || '',
                memberId: member ? member._id : null,
                vaName: va.name || '',
            });

            // Keep the central account's own pointer in step, so the roster
            // link staff already had (POST /me/pilot) and this agree about who
            // they are rather than each holding half an answer.
            if (member && String(acct.crewMemberId || '') !== String(member._id)) {
                await VaPortalAccount.findByIdAndUpdate(acct._id, { crewMemberId: String(member._id) }).catch(() => {});
            }

            res.set('Cache-Control', 'no-store');
            res.status(r.created ? 201 : 200).json({
                created: r.created,
                account: crewAccounts.publicAccount(r.account),
                pilot: member
                    ? { memberId: member._id, name: member.name, callsign: member.callsign || '', hours: Number(member.hours) || 0 }
                    : null,
                discord: {
                    available: crewDiscord.configured(),
                    linked: !!(r.account && r.account.discordId),
                    name: (r.account && r.account.discordUsername) || '',
                    avatar: crewDiscord.avatarUrl({
                        id: (r.account && r.account.discordId) || '',
                        avatar: (r.account && r.account.discordAvatar) || '',
                    }),
                },
            });
        } catch (err) {
            /* A project that has not run the v17 SQL has no portal_account_id
               column, so the lookup that finds an existing row fails before
               anything is written — and the store says exactly that, with the
               column named and the button to press. A VA that has connected no
               project at all, or one that has gone read-only, each get their
               own sentence for the same reason. This is staff reading it, and
               staff are the people who can act on every one of them. */
            storeFail(res, err, 'Crew pilot-side error', 'Could not set up your pilot account.');
        }
    });

    /* =====================================================================
     * AGREEING TO THE PILOT TERMS
     *
     * Records a version against the caller's own account row and nothing else:
     * no name, no address, no copy of what they were shown. The version IS the
     * record — it says which words were on the screen, because the words for a
     * version do not change (a change is what a new version is).
     *
     * It refuses a version that is not the current one. The only reason to send
     * an old version is a page that has been open since before a change, and
     * accepting that would record an agreement to a document nobody had in
     * front of them.
     * =================================================================== */
    app.post('/api/crew/:slug/account/terms', async (req, res) => {
        const p = verifyCrewRequest(req);
        const slug = String(req.params.slug || '').toLowerCase();
        if (!p || (p.kind !== 'crew' && p.kind !== 'va')) return res.status(401).json({ error: 'Not authenticated.' });
        if (p.slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        const sent = String((req.body && req.body.version) || '');
        if (sent && sent !== CREW_TERMS_VERSION) {
            return res.status(409).json({
                error: 'This notice has been updated since that page was opened. Reload and read it again.',
                code: 'version_moved',
                terms: crewTermsState('', true),
            });
        }
        try {
            const va = await resolveVa(slug);
            if (!va) return res.status(404).json({ error: 'Crew center not found.' });
            const store = await crewStore.forVa(va);
            const row = p.kind === 'crew'
                ? await store.getAccount(p.sub)
                : await boundPilotRow(store, String(p.sub));
            // Nothing to write it on. Answered as the truth rather than as an
            // error: a staff member with no pilot side was never asked.
            if (!row) return res.json({ ok: true, terms: crewTermsState('', false) });
            await store.updateAccount(row._id, {
                termsVersion: CREW_TERMS_VERSION,
                termsAcceptedAt: new Date(),
            });
            res.set('Cache-Control', 'no-store');
            res.json({ ok: true, terms: crewTermsState(CREW_TERMS_VERSION, true) });
        } catch (err) {
            /* Deliberately NOT storeFail here, which is the one place that
               distinction matters: this is a PILOT reading the answer, and the
               store's own sentences name columns and point at Settings → Data
               store, which is a screen they cannot open. The notice was read
               either way; it is the RECORD that could not be kept, so they are
               told plainly and pointed at the people who can fix it. */
            if (err instanceof crewStore.CrewStoreError) {
                if (err.detail) console.warn(`crew store [${err.code}]:`, err.detail);
                return res.status(409).json({
                    error: 'Your crew center’s database needs updating before this can be recorded. Ask your staff to re-run the setup SQL.',
                    code: 'needs_update',
                });
            }
            console.error('Crew terms accept error:', err && err.message ? err.message : err);
            res.status(500).json({ error: 'That could not be recorded.' });
        }
    });

    app.get('/api/crew/:slug/me', async (req, res) => {
        const token = getBearer(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated.' });
        let p;
        try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid session.' }); }
        if (p.typ !== 'crew') return res.status(401).json({ error: 'Invalid session.' });
        const slug = String(req.params.slug || '').toLowerCase();
        if (p.slug && slug && p.slug !== slug) return res.status(403).json({ error: 'Wrong crew center.' });
        // Resolve fresh caps from the VA (so an owner's change takes effect without
        // waiting for re-login). The owner also gets the role config to manage it.
        const va = await resolveVa(slug || p.slug);
        const caps = effectiveCaps(va, p);
        const isOwner = p.kind === 'inflight' || p.role === 'owner';
        const canManageTeam = isOwner || caps.includes('team.manage');
        // Re-read the "you still owe us a password change" flag from the store
        // rather than trusting the token: the flag clears mid-session, and a
        // stale claim in a 7-day token would either nag someone who has already
        // changed it or stop nagging someone who reloaded before doing so.
        let mustChangePassword = false;
        /* WHAT THE ACCOUNT PAGE DRAWS UNDER "Signing in".
           `available` is about this deployment (is there a Discord application
           configured at all); `linked` is about this pilot. They are separate
           because the answers differ and the sentences differ: one is "we do
           not offer that", the other is "you have not set it up".
           Only a store-backed pilot account can hold a link, so a VA staff or
           Inflight login is told it is unavailable rather than shown a button
           that would refuse them. */
        let discord = { available: false, linked: false, name: '', avatar: '' };
        /* THE PILOT SIDE. v17.
           For a pilot it is their own account and always there. For a staff
           member it is the bound row, which exists only once they have set one
           up — so `pilotSide` reports both facts: whether they CAN have one
           (only our central accounts can; a pilot already is one) and whether
           they have. The account page draws a "set up your pilot side" button
           off the first and the Discord controls off the second. */
        let pilotSide = { applies: p.kind === 'va', ready: p.kind === 'crew', memberId: null };
        let terms = crewTermsState('', false);
        if ((p.kind === 'crew' || p.kind === 'va') && va) {
            discord.available = crewDiscord.configured();
            try {
                const store = await crewStore.forVa(va);
                const account = p.kind === 'crew'
                    ? await store.getAccount(p.sub)
                    : await boundPilotRow(store, String(p.sub));
                if (account) {
                    // A staff member's bound row has no password to change, so
                    // the nag is a pilot's alone — see provisionStaffAccount.
                    mustChangePassword = p.kind === 'crew' && !!account.mustChangePassword;
                    terms = crewTermsState(account.termsVersion, true);
                    if (p.kind === 'va') { pilotSide.ready = true; pilotSide.memberId = account.memberId || null; }
                    if (account.discordId) {
                        discord.linked = true;
                        discord.name = account.discordUsername || '';
                        discord.avatar = crewDiscord.avatarUrl({ id: account.discordId, avatar: account.discordAvatar });
                    }
                }
            } catch { /* unreachable store — don't block "who am I" on it */ }
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            role: p.role, view: p.view, name: p.name, oversight: p.kind === 'inflight',
            username: p.uname || '',
            mustChangePassword,
            canChangePassword: p.kind === 'crew',
            discord,
            pilotSide,
            terms,
            caps, capabilities: CREW_CAPABILITIES, rolePresets: CREW_ROLE_PRESETS,
            // Keyed on the capability rather than on being the owner, or a
            // chief of staff would be told they may manage the team and then
            // handed an empty team to manage.
            //
            // `grantable` is what the role builder may offer THIS person. The
            // server refuses an overreaching save either way; sending the
            // ceiling means the screen greys the lines out instead of letting
            // somebody tick one, press save and collect a 403 explaining that
            // the box they were shown was never theirs to tick.
            staffRoles: (canManageTeam && va && va.staffRoles) || [],
            staffAssignments: (canManageTeam && va && va.staffAssignments) || [],
            grantable: canManageTeam ? (isOwner ? CREW_CAP_IDS.slice() : caps.slice()) : [],
            // Websites are always available: every VA has an address at
            // inflight.info/va/<slug> whether or not this deployment hands out
            // subdomains, so the crew centre's Website tile is never hidden.
            // Kept as a field rather than dropped because the tile reads it and
            // a deployment could yet turn the feature off.
            siteHosting: true,
            siteUrl: vaSites.siteUrlFor((va && va.slug) || slug || p.slug || ''),
        });
    });
}

module.exports = {
    registerCrewAuthRoutes, viewForRole, verifyCrewRequest, effectiveCaps,
    isDiscordInviteUrl, cleanDiscordInvite,
    CREW_CAPABILITIES, CREW_CAP_IDS, CREW_ROLE_PRESETS, CAPABILITY_HEIRS,
    CREW_OWNER_GRADE_CAPS, CREW_DEFAULT_STAFF_CAPS, teamSaveFailure,
    parseSocialPost, sanitizeSocial, publicSocial, MAX_SOCIAL_POSTS,
};
