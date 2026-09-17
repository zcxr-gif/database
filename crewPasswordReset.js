'use strict';

/*
 * crewPasswordReset.js
 * A pilot who has forgotten their password, and the three ways back in.
 *
 * WHY THIS IS NOT JUST "EMAIL A RESET LINK"
 * -----------------------------------------
 * Because for most VAs an email reset would do nothing at all. Email in the
 * crew center is bring-your-own-provider and off by default, and a pilot only
 * has an address on file if they gave one. "A reset link has been sent to your
 * email" that silently reaches nobody is worse than the Discord message they
 * were about to send, because now they are waiting for it as well.
 *
 * So there are three ways back, and the server picks whichever THIS airline
 * and THIS account can actually support:
 *
 *   discord   they linked it. There was never anything to reset — the sign-in
 *             page already offers the button, and nothing here has to happen.
 *   email     the VA runs a provider AND the account has an address: a
 *             one-time link, and no staff member is involved at any point.
 *   staff     everything else. The request lands in the crew center as a login
 *             waiting to be handed over, and the press that issues and sends
 *             it is one press.
 *
 * THE CALLER IS NEVER TOLD WHICH
 * ------------------------------
 * This is the part worth guarding, and it is why `request()` returns nothing
 * useful. A server that answers "check your email" for one username and "we
 * have told your staff" for another is a server that will tell a stranger
 * which usernames exist at this airline, and which of them have an address on
 * file. It takes about four minutes to turn that into a list.
 *
 * So the route above this answers identically in every case — found, not
 * found, has an email, has none, rate-limited — and `request()` is shaped to
 * make that the easy thing to do: it resolves to nothing at all, and every
 * decision it took stays in here. The rate limiter is part of that promise: a
 * 429 would be the same oracle by another route, so a caller who is over the
 * limit gets the same silence as one who is not.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * -------------------------------
 * Never the token — only its SHA-256. A reset link is a bearer credential for
 * one account, and a readable copy of one sitting in a row is a password by
 * another name. The link is sent once and cannot be recovered from the
 * database afterwards, which is the same trade crew_accounts makes with the
 * bcrypt hash and the opposite of the one crewInvite.js makes deliberately for
 * a temporary password a staff member has to read out.
 *
 * A token is single-use and short-lived. It is invalidated by a successful
 * reset, by a later request (the newest link is the only live one), and by the
 * password being changed any other way — see clearPatch, which crewAccounts.js
 * applies on every password change.
 *
 * Env:
 *   CREW_RESET_TTL_MINUTES   how long a link stays good (default 60).
 */

const crypto = require('crypto');

const TTL_MINUTES = (() => {
    const n = parseInt(process.env.CREW_RESET_TTL_MINUTES, 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
})();

const MINUTE_MS = 60 * 1000;

// Why the request reached a human. Stored so the dashboard can say it, because
// "this one is yours to pass on" is only actionable with the reason attached.
const REASON = { NO_EMAIL: 'no_email', EMAIL_FAILED: 'email_failed' };

const asDate = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/**
 * A fresh link token and the hash that goes in the row.
 *
 * 32 bytes from the CSPRNG, base64url so it survives a URL, an address bar and
 * an email client that decides to be clever about punctuation. The hash is
 * plain SHA-256 rather than bcrypt on purpose: this is a 256-bit random value,
 * not a password, so there is no dictionary to slow an attacker down with —
 * and the lookup has to be an indexed equality match on a table we do not want
 * to scan on an unauthenticated route.
 */
function mintToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
}

const hashToken = (token) => crypto.createHash('sha256')
    .update(String(token || ''), 'utf8').digest('hex');

/**
 * The only correct way to ask "is this row's link still good?".
 *
 * @returns {'none'|'live'|'expired'}
 */
function tokenState(account, now = new Date()) {
    if (!account || !account.resetTokenHash) return 'none';
    const expires = asDate(account.resetTokenExpiresAt);
    // A row with a hash and no expiry is not a live link. It is a row written
    // by something that did not go through requestPatch, and treating it as
    // live would make a link with no end date out of a bug.
    if (!expires) return 'expired';
    return now.getTime() >= expires.getTime() ? 'expired' : 'live';
}

const isLive = (account, now) => tokenState(account, now) === 'live';

// ---------------------------------------------------------------------------
// Patches. Returned rather than applied, like crewInvite.js, so the caller
// decides when to write and can fold them into an update it was making anyway.
// ---------------------------------------------------------------------------

/**
 * Record a request. Mints the link when this one is going to be emailed, and
 * records the reason when it is not.
 *
 * A request always replaces whatever was there before: the newest link is the
 * only live one, and a pilot who asks twice must not be left with two.
 */
function requestPatch({ hash = '', needsStaff = false, reason = '' } = {}, now = new Date()) {
    return {
        resetTokenHash: hash ? String(hash) : '',
        resetTokenExpiresAt: hash ? new Date(now.getTime() + TTL_MINUTES * MINUTE_MS) : null,
        resetRequestedAt: now,
        resetNeedsStaff: !!needsStaff,
        resetReason: needsStaff ? String(reason || '') : '',
    };
}

/**
 * Nothing is outstanding any more.
 *
 * Applied on a successful reset, when staff issue a password, when staff
 * dismiss a request, and on every ordinary password change — which is what
 * makes "changing your password kills the reset link somebody emailed you"
 * true rather than aspirational.
 */
const clearPatch = () => ({
    resetTokenHash: '',
    resetTokenExpiresAt: null,
    resetRequestedAt: null,
    resetNeedsStaff: false,
    resetReason: '',
});

// ---------------------------------------------------------------------------
// Rate limiting
//
// Per account AND per caller, because the two protect different things: the
// per-account limit stops somebody using a pilot's inbox as a mailbox to shout
// into, and the per-caller limit stops one machine walking a username list.
//
// In memory, and deliberately so. This is one process per VA's traffic, the
// window is an hour, and the failure mode of a restart is that somebody gets
// one extra email — which is a far better trade than a table of reset attempts
// in every VA's project. The counters are keyed by hash, never by the username
// or address that was typed.
// ---------------------------------------------------------------------------

const PER_ACCOUNT_COOLDOWN_MS = 2 * MINUTE_MS;   // no second link inside two minutes
const PER_ACCOUNT_HOURLY = 5;
const PER_CALLER_HOURLY = 20;
const HOUR_MS = 60 * MINUTE_MS;

const _hits = new Map();   // key -> number[] (timestamps, newest last)
let _sweptAt = 0;

function _record(key, now) {
    const at = _hits.get(key) || [];
    const fresh = at.filter((t) => now - t < HOUR_MS);
    fresh.push(now);
    _hits.set(key, fresh);
    return fresh;
}

function _count(key, now) {
    return (_hits.get(key) || []).filter((t) => now - t < HOUR_MS);
}

// Keep the map from growing without bound on a busy process. Cheap, amortised,
// and only ever drops entries that are already outside every window.
function _sweep(now) {
    if (now - _sweptAt < HOUR_MS) return;
    _sweptAt = now;
    for (const [key, at] of [..._hits.entries()]) {
        const fresh = at.filter((t) => now - t < HOUR_MS);
        if (fresh.length) _hits.set(key, fresh); else _hits.delete(key);
    }
}

/**
 * May this caller ask for this account again?
 *
 * Records the attempt as it answers, so a caller who is refused still counts
 * towards their own limit — otherwise the limit is a thing you can stay under
 * forever by being refused.
 *
 * @param {string} accountKey  an account id, or '' when nothing matched
 * @param {string} callerKey   a hash of the caller's IP
 */
function allow(accountKey, callerKey, now = Date.now()) {
    _sweep(now);
    const caller = callerKey ? _record(`ip:${callerKey}`, now) : [];
    if (caller.length > PER_CALLER_HOURLY) return false;
    // Nothing matched. The caller's own limit still applied above — which is
    // the half that matters for somebody walking a list of usernames — and
    // there is no account to rate-limit.
    if (!accountKey) return true;
    const key = `acct:${accountKey}`;
    const before = _count(key, now);
    const last = before.length ? before[before.length - 1] : 0;
    const mine = _record(key, now);
    if (last && now - last < PER_ACCOUNT_COOLDOWN_MS) return false;
    return mine.length <= PER_ACCOUNT_HOURLY;
}

/** Forget every counter. For tests. */
function _reset() { _hits.clear(); _sweptAt = 0; }

// ---------------------------------------------------------------------------
// The wording
// ---------------------------------------------------------------------------

/** Where a link lands: the crew center's own sign-in page, which reads `?reset`. */
const resetUrl = (signInUrl, token) => (signInUrl && token
    ? `${signInUrl}${signInUrl.includes('?') ? '&' : '?'}reset=${encodeURIComponent(token)}`
    : '');

/**
 * The message a staff member pastes to a pilot they have just issued a
 * password to. Plain text with blank lines between blocks, for the reason
 * crewInvite.js's is: the IFC is a Discourse forum and Discord is Discord, and
 * anything cleverer than plain text survives neither.
 */
function buildIssuedMessage({
    vaName = '', name = '', username = '', password = '', signInUrl = '',
} = {}) {
    const who = String(name || '').trim();
    const va = String(vaName || '').trim() || 'the crew';
    const lines = [];
    lines.push(who
        ? `${who} — here is a new password for your ${va} crew center login.`
        : `Here is a new password for your ${va} crew center login.`);
    if (username && password) {
        lines.push('', 'Your crew center login:');
        if (signInUrl) lines.push(`  ${signInUrl}`);
        lines.push(`  Username: ${username}`);
        lines.push(`  Temporary password: ${password}`);
        lines.push('', 'You\'ll be asked to choose your own password the first time you sign in. This temporary one stops working the moment you do.');
    } else if (signInUrl) {
        lines.push('', `Sign in to the crew center: ${signInUrl}`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shapes handed out
// ---------------------------------------------------------------------------

/**
 * One row of the Logins tab: a pilot who has asked and not been dealt with.
 *
 * `email` is the address itself rather than a boolean, because the dashboard
 * says a different thing for a pilot we could not reach ("we could not email
 * them") than for one there was never an address for — and a request only
 * reaches this list at all when the email did not happen. Nothing here is a
 * credential: the token is a hash in a row nobody reads back, and the password
 * does not exist until staff press the button.
 */
const staffRequest = (a) => a && {
    // The account id IS the request id. There is at most one outstanding
    // request per account by construction (requestPatch replaces), so a
    // separate identifier would be a second name for the same thing.
    id: a._id,
    name: a.displayName || '',
    username: a.username || '',
    email: a.email || '',
    askedAt: asDate(a.resetRequestedAt),
    reason: a.resetReason || '',
};

module.exports = {
    REASON,
    TTL_MINUTES,
    mintToken,
    hashToken,
    tokenState,
    isLive,
    requestPatch,
    clearPatch,
    allow,
    resetUrl,
    buildIssuedMessage,
    staffRequest,
    _reset,
};
