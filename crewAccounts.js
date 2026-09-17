'use strict';

/*
 * crewAccounts.js
 * A VA's pilots' crew center logins — created in, read from and changed in the
 * VA's OWN data store.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Pilot accounts used to be rows in our central VaPortalAccount collection,
 * alongside the VA's owner and staff logins. That made Inflight the custodian
 * of every pilot's credentials for every VA on the platform, which contradicts
 * the rule the rest of the crew center is built on: a VA's people are the VA's
 * data. So a pilot account is now a `crew_accounts` row inside the VA's own
 * Supabase project (see supabase/crew-center-schema.sql), reached through the
 * same crewStore interface as their roster and flight reports.
 *
 * What Inflight still holds centrally is the VA's *staff* logins — owner and
 * team accounts, which are how a VA administers its listing with us and are not
 * the VA's operational data. Pilots are.
 *
 * PASSWORDS
 * ---------
 * Nothing in THIS module stores a password. provisionPilotAccount and
 * resetPassword each generate one, return it once, and write only its bcrypt
 * hash to the VA's project. That remains true and is the property to protect
 * when changing anything here: the account's credential is the hash, and the
 * hash is all that lives on crew_accounts.
 *
 * What did change: the caller may now keep the returned password for a while.
 * An acceptance records it on the application row as an INVITATION, so a staff
 * member can still hand it over an hour later on the IFC and the applicant can
 * read it off their own status link. That copy is deliberately short-lived and
 * self-deleting — it is cleared the moment the pilot signs in, when staff
 * discard it, or when it ages out. crewInvite.js owns that lifecycle and
 * explains the trade; the schema file explains why it is not encrypted.
 *
 * So "there is no resend my password" is no longer quite the rule. There is a
 * window in which the invitation can be re-read, and after it closes the only
 * route back in is still a reset that mints a new one.
 *
 * The bcrypt cost (12) matches vaPortal/staffAuth, so a login costs the same
 * wherever the account lives.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// Only for clearPatch: a password that changes must take any outstanding reset
// link with it. See dropReset below.
const crewPasswordReset = require('./crewPasswordReset');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

// Ambiguous glyphs (0/O, 1/l/I) are left out: these get read off a screen or
// out of an email and typed by hand, and a password that cannot be transcribed
// is a support ticket.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 14) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    return out;
}

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * Take away any outstanding reset link and any request waiting on staff.
 *
 * Called after every password change, because "the link somebody emailed you
 * stops working once you have changed your password another way" has to be
 * enforced by the code rather than hoped for. A pilot who remembers their
 * password mid-reset, or a staff member who issues one from the account list
 * while a request sits in the queue, must not leave a live link behind.
 *
 * A SEPARATE, BEST-EFFORT WRITE, and that is the whole reason this function
 * exists rather than five more fields in the patches above. The reset columns
 * arrived in v19 and are deliberately not droppable (see LATE_COLUMNS in
 * crewStore.js), so folding them into the main update would make an ordinary
 * password change fail outright on every project that has not re-run the SQL —
 * breaking the thing that works to tidy up after a feature that project has
 * not got. So the password lands first, on its own, and this follows.
 *
 * Failing silently is correct here and only here: the worst case is a link that
 * outlives the password change until it expires on its own, on a project where
 * no link can have been minted in the first place.
 */
function dropReset(store, accountId) {
    return Promise.resolve()
        .then(() => store.updateAccount(accountId, crewPasswordReset.clearPatch()))
        .catch(() => null);
}

// A username derived from the pilot's name: lower-case, letters/digits/dots
// only. `usernameFor` then makes it unique within THIS crew center — uniqueness
// is per-VA now, not global, because the row lives in the VA's own project.
// Two VAs can each have a `jsmith`, and neither has to know about the other.
function baseUsername(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 24);
    return slug || 'pilot';
}

async function usernameFor(store, name) {
    const base = baseUsername(name);
    if (!await store.getAccountByUsername(base)) return base;
    // Numbered suffixes first (jsmith2, jsmith3 — the readable outcome), then a
    // random tail if this VA really does have a crowd of same-named pilots.
    for (let n = 2; n <= 9; n++) {
        const candidate = `${base}${n}`;
        if (!await store.getAccountByUsername(candidate)) return candidate;
    }
    for (let i = 0; i < 5; i++) {
        const candidate = `${base}.${crypto.randomBytes(2).toString('hex')}`;
        if (!await store.getAccountByUsername(candidate)) return candidate;
    }
    throw new Error('Could not find a free username for this pilot.');
}

/**
 * Provision a crew center login for a pilot, in the VA's own data store.
 *
 * Idempotent per pilot: called again for someone who already has an account it
 * returns theirs with `created: false` and no password, rather than minting a
 * second login or silently resetting the one they are already using. Identity
 * is the roster row when we have one (`memberId`) and the display name
 * otherwise — the join flow runs on the applicant's IFC name, so that is the
 * only handle a pilot accepted without a roster link has.
 *
 * @param {Object} store            a crewStore adapter (SupabaseStore | LegacyStore)
 * @param {Object} opts
 * @param {string} opts.displayName the pilot's name (their IFC name)
 * @param {string} [opts.memberId]  the roster row this login belongs to
 * @param {string} [opts.email]     so the VA can tell two same-named pilots apart
 * @param {string} [opts.createdByName]  which staff member accepted them
 * @param {string} [opts.vaName]    only used by the legacy adapter's denormalised copy
 * @returns {{account: Object, created: boolean, username: string, password: string|null}}
 */
async function provisionPilotAccount(store, opts = {}) {
    if (!store) throw new Error('provisionPilotAccount requires a crew store.');
    const displayName = clean(opts.displayName, 80);
    if (!displayName) throw new Error('provisionPilotAccount requires the pilot\'s name.');

    const existing = (opts.memberId && await store.getAccountByMember(opts.memberId))
        || await findByDisplayName(store, displayName);
    if (existing) {
        // Re-link a name-matched account to the roster row we now know about,
        // so the next lookup is by id rather than by a name someone may rename.
        if (opts.memberId && !existing.memberId) {
            await store.updateAccount(existing._id, { memberId: opts.memberId }).catch(() => {});
        }
        return { account: existing, created: false, username: existing.username, password: null };
    }

    const username = await usernameFor(store, displayName);
    const password = generatePassword();
    const account = await store.createAccount({
        username,
        displayName,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'pilot',
        memberId: opts.memberId || null,
        email: clean(opts.email, 120).toLowerCase(),
        active: true,
        mustChangePassword: true,
        createdVia: 'crew-center',
        createdByName: clean(opts.createdByName, 80),
        vaName: opts.vaName || '',
    });
    return { account, created: true, username, password };
}

/**
 * A staff member's OWN pilot account. v17.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A VA's owner and staff sign in with a central account of ours, and that
 * account has no row in the VA's project. Everything that is keyed on a
 * crew_accounts id therefore passes them by: an inbox message has nowhere to
 * land, a Discord link has nothing to be written against, and the crew center
 * has no record that is theirs in the way every pilot's login is theirs. What
 * they had instead was claiming a ROSTER row, which is enough to be booked onto
 * a departure and no more — or being handed a second, ordinary pilot login by
 * somebody with roster.manage, which is two credentials for one person and an
 * account that is only theirs by convention.
 *
 * So: one row, bound to the central account that owns it by
 * `portalAccountId`, and provisioned by that person themselves.
 *
 * THERE IS NO PASSWORD, AND THAT IS THE POINT
 * -------------------------------------------
 * The row is created with a hash of a value nobody has and nobody can ask for —
 * random bytes, hashed and dropped on the floor in the same expression. bcrypt
 * cannot be satisfied by any input, so the password door can never open this
 * row, and the cascade in the login route falls through it to the central
 * account the way it always did.
 *
 * That is deliberate. A second password for a person who already has one is a
 * second thing to lose, a second thing to phish and a second thing to rotate,
 * and it would exist only to open a door their central password already opens.
 * The ways in stay what they were: their staff password, or Discord once they
 * have linked it — which is the whole reason this row exists.
 *
 * IT CARRIES NO AUTHORITY
 * -----------------------
 * `role` is 'pilot' and must stay 'pilot'. A staff session's capabilities are
 * resolved from the central account (effectiveCaps in crewAuth.js), never from
 * here, and a row with role 'owner' in a project the VA's own people can write
 * to would be a way to grant capabilities by editing a database. The binding
 * says WHOSE pilot side this is; it never says what that person may do.
 *
 * Idempotent: called again by the same staff account it returns the row they
 * already have, rather than minting a second one.
 *
 * @param {Object} store             a crewStore adapter
 * @param {Object} opts
 * @param {string} opts.portalAccountId  the central account this belongs to
 * @param {string} opts.displayName      their name, as the roster should read it
 * @param {string} [opts.username]       preferred username; derived when absent
 * @param {string} [opts.memberId]       a roster row they have already claimed
 * @param {string} [opts.email]
 * @returns {{account: Object, created: boolean}}
 */
async function provisionStaffAccount(store, opts = {}) {
    if (!store) throw new Error('provisionStaffAccount requires a crew store.');
    const portalAccountId = clean(opts.portalAccountId, 40);
    if (!/^[a-f0-9]{24}$/i.test(portalAccountId)) {
        throw new Error('provisionStaffAccount requires the staff account it belongs to.');
    }
    const displayName = clean(opts.displayName, 80) || 'Staff';

    // Already has one. Re-point it at the roster row they have claimed since,
    // for the same reason provisionPilotAccount does: the next lookup should be
    // by id rather than by a name somebody may rename.
    const existing = typeof store.getAccountByPortal === 'function'
        ? await store.getAccountByPortal(portalAccountId)
        : null;
    if (existing) {
        if (opts.memberId && !existing.memberId) {
            await store.updateAccount(existing._id, { memberId: opts.memberId }).catch(() => {});
            existing.memberId = opts.memberId;
        }
        return { account: existing, created: false };
    }

    // A username is still required — it is what the roster, the account list and
    // every "who filed this" line reads — but it opens nothing on its own.
    const wanted = clean(opts.username, 60).toLowerCase();
    const username = wanted && !await store.getAccountByUsername(wanted)
        ? wanted
        : await usernameFor(store, wanted || displayName);

    const account = await store.createAccount({
        username,
        displayName,
        // Unopenable, by construction. See the note above.
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS),
        role: 'pilot',
        memberId: opts.memberId || null,
        email: clean(opts.email, 120).toLowerCase(),
        active: true,
        // There is no password to change, so nagging them to change it would be
        // asking for something they cannot do.
        mustChangePassword: false,
        createdVia: 'staff-pilot-side',
        createdByName: displayName,
        portalAccountId,
        vaName: opts.vaName || '',
    });
    return { account, created: true };
}

/**
 * A roster row that is this person, and is nobody else's. v17.
 *
 * THE HAZARD IT AVOIDS. A VA's owner is very often already on their own roster,
 * with hours on it, from before they ever had a reason to press "set up my
 * pilot account". Creating them a fresh row would leave two of them on the
 * roster — the one their crew knows with the hours, and a new empty one that
 * their bookings and reports would credit from then on. The hours are not lost,
 * which is somehow worse: they are visibly there, on the wrong person.
 *
 * So a namesake is ADOPTED rather than duplicated, on two conditions:
 *
 *   1. the name matches exactly (case aside) — a fuzzy match that adopted the
 *      wrong pilot would hand somebody another pilot's hours, which is a far
 *      worse failure than one duplicate row a staff member can merge by hand;
 *   2. nobody else's login is already against it. A row with a pilot's own
 *      account on it is a person who signs in as themselves, and two identities
 *      on one record can each cancel the other's flying.
 *
 * Matched in JS over the list for the reason provisionPilotAccount does the
 * same: the store interface has no case-insensitive name filter, rosters are
 * hundreds and not millions, and this runs once per staff member ever.
 */
async function findUnclaimedNamesake(store, displayName, portalAccountId) {
    const wanted = clean(displayName, 80).toLowerCase();
    if (!store || !wanted || typeof store.listMembers !== 'function') return null;
    const mine = clean(portalAccountId, 40);
    try {
        const members = await store.listMembers({ limit: 5000 });
        const named = (members || []).filter((m) => String(m.name || '').trim().toLowerCase() === wanted);
        // Two pilots of the same name and no way to tell which is meant: leave
        // it alone and let them pick, rather than guess between two people.
        if (named.length !== 1) return null;
        const m = named[0];
        if (typeof store.getAccountByMember !== 'function') return m;
        const owner = await store.getAccountByMember(m._id);
        if (!owner) return m;
        // Their own binding, from a previous go at this. Theirs to take back.
        return String(owner.portalAccountId || '') === mine ? m : null;
    } catch (err) {
        // A roster we cannot read is not a reason to refuse somebody a pilot
        // account — it only means we cannot spot a namesake, so one gets made.
        return null;
    }
}

/**
 * Point a staff member's pilot side at a different roster row — or at none. v17.
 *
 * WHY THIS EXISTS AS A FUNCTION. Two things record which pilot a staff member
 * is: the pointer on their central account (`VaPortalAccount.crewMemberId`) and
 * the `member_id` on their bound row. The bound row is the one read FIRST once
 * it exists, so writing only the central pointer leaves "I don't fly for this
 * airline" looking like it worked and changing nothing at all.
 *
 * Best-effort by contract. Every caller has already done the half that cannot
 * fail — the write to our own account — and a VA's project being unreachable,
 * or on a schema without the binding column, must not turn that into an error
 * the staff member has to make sense of. Returns whether it actually moved.
 */
async function repointStaffPilotSide(store, portalAccountId, memberId) {
    if (!store || typeof store.getAccountByPortal !== 'function') return false;
    const id = clean(portalAccountId, 40);
    if (!/^[a-f0-9]{24}$/i.test(id)) return false;
    const next = memberId ? String(memberId) : null;
    try {
        const own = await store.getAccountByPortal(id);
        if (!own) return false;
        // Nothing to do is not a failure, and re-writing the same value would
        // move `updated_at` on a row nobody changed.
        if (String(own.memberId || '') === String(next || '')) return false;
        await store.updateAccount(own._id, { memberId: next });
        return true;
    } catch (err) {
        return false;
    }
}

// The name match is done in JS over the account list rather than as a query:
// the store interface has no case-insensitive name filter, rosters are small
// (hundreds, not millions), and this runs once per acceptance.
async function findByDisplayName(store, displayName) {
    const wanted = displayName.toLowerCase();
    const all = await store.listAccounts({ limit: 5000 });
    return all.find((a) => String(a.displayName || '').toLowerCase() === wanted) || null;
}

/**
 * Check a username/password against the VA's own store.
 *
 * Returns null for "no such account", "wrong password" and "account disabled"
 * alike — the caller must not be able to tell which, and neither must the
 * person at the keyboard.
 *
 * A store that cannot answer (unreachable project, or one still on a schema
 * without crew_accounts) throws; the login route treats that as "not this
 * identity" and carries on down its cascade, so a VA mid-setup does not lock
 * its own staff out of the dashboard.
 */
async function authenticate(store, username, password) {
    const u = clean(username, 60).toLowerCase();
    const p = String(password || '');
    if (!u || !p) return null;
    const account = await store.getAccountByUsername(u);
    if (!account || !account.active || !account.passwordHash) return null;
    if (!await bcrypt.compare(p, account.passwordHash)) return null;
    // Best-effort: a failure to record the timestamp must not fail the login.
    store.updateAccount(account._id, { lastLoginAt: new Date() }).catch(() => {});
    return account;
}

/**
 * Change a pilot's own password. Requires the current one — a valid session is
 * not enough, because the session may be sitting on an unattended screen and
 * the password is the thing that gets it back.
 *
 * @returns {{ok: true} | {error: string, status: number}}
 */
async function changePassword(store, accountId, currentPassword, newPassword) {
    const account = await store.getAccount(accountId);
    if (!account) return { error: 'Account not found.', status: 404 };
    const next = String(newPassword || '');
    if (next.length < MIN_PASSWORD_LENGTH) {
        return { error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`, status: 400 };
    }
    if (!account.passwordHash || !await bcrypt.compare(String(currentPassword || ''), account.passwordHash)) {
        return { error: 'Your current password is incorrect.', status: 401 };
    }
    if (await bcrypt.compare(next, account.passwordHash)) {
        return { error: 'Choose a password you are not already using.', status: 400 };
    }
    await store.updateAccount(account._id, {
        passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS),
        mustChangePassword: false,
    });
    await dropReset(store, account._id);
    return { ok: true };
}

/**
 * The password a pilot chose for themselves at the far end of a reset link.
 *
 * NOT changePassword above, and the difference is the whole point: that one
 * requires the current password, which is the one thing this pilot has not
 * got. What stands in for it is the link — a 256-bit token that was emailed to
 * the address on the account, whose hash the caller has already matched and
 * whose lifetime it has already checked (crewPasswordReset.isLive).
 *
 * ONE WRITE, deliberately. The new hash and the death of the token are the
 * same update, so there is no window in which the password has changed and the
 * link is still live — and none in which the link is spent but the password is
 * not yet set, which would lock the pilot out with their one link gone.
 *
 * `mustChangePassword` is cleared rather than set: they have just chosen this
 * themselves, so there is nothing to nag them about. That is the opposite of
 * resetPassword below, where staff generate one and read it out.
 *
 * @returns {{ok: true, username: string} | {error: string, status: number}}
 */
async function setPasswordFromReset(store, account, newPassword) {
    if (!account) return { error: 'Account not found.', status: 404 };
    const next = String(newPassword || '');
    if (next.length < MIN_PASSWORD_LENGTH) {
        return { error: `Please choose at least ${MIN_PASSWORD_LENGTH} characters.`, status: 400 };
    }
    await store.updateAccount(account._id, {
        passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS),
        mustChangePassword: false,
        ...crewPasswordReset.clearPatch(),
    });
    return { ok: true, username: account.username };
}

/**
 * Staff resetting a pilot's password for them. Returns the new password once,
 * on the same terms as provisioning: it is shown and then gone.
 */
async function resetPassword(store, accountId) {
    const account = await store.getAccount(accountId);
    if (!account) return null;
    const password = generatePassword();
    await store.updateAccount(account._id, {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        mustChangePassword: true,
    });
    // Whatever they had asked for, they have now been given. This is also what
    // takes an issued request out of the Logins tab.
    await dropReset(store, account._id);
    return { username: account.username, password };
}

// What staff are allowed to see about a pilot's login. Never the hash — this is
// the only shape any handler returns, so there is one place to get it wrong.
const publicAccount = (a) => a && {
    id: a._id,
    username: a.username,
    displayName: a.displayName || '',
    memberId: a.memberId || null,
    active: a.active !== false,
    mustChangePassword: !!a.mustChangePassword,
    // v16/v17, as booleans. Whether a login has Discord on it and whether it is
    // a staff member's own pilot side are both things the account list has to
    // show — a reset-password button on a row with no password is a button that
    // cannot work, and staff need to know which row is theirs. Neither the
    // Discord id nor the central account id goes out: what the list needs is
    // the fact, not the identifier.
    discordLinked: !!a.discordId,
    staffOwned: !!a.portalAccountId,
    lastLoginAt: a.lastLoginAt || null,
    createdAt: a.createdAt || null,
};

module.exports = {
    provisionPilotAccount,
    provisionStaffAccount,
    repointStaffPilotSide,
    findUnclaimedNamesake,
    authenticate,
    changePassword,
    setPasswordFromReset,
    resetPassword,
    publicAccount,
    generatePassword,
    baseUsername,
    usernameFor,
    MIN_PASSWORD_LENGTH,
};
