'use strict';
// test-crew-password-reset.js
// Getting back in without asking a human: the token's lifetime, the rate
// limiter, and the writes that end a reset.
//
// WHAT THIS FILE IS DEFENDING
//
// The feature's whole design rests on the server telling the caller NOTHING —
// same answer for an account that exists and one that does not, for one with an
// email address and one without, for a caller inside the rate limit and one
// over it. That property lives in the route (server.js), and everything the
// route needs in order to keep it lives in here: a limiter that answers the
// same shape whatever it decides, patches that carry no message, and a staff
// shape that cannot leak a credential.
//
// So most of what is checked below is what this CANNOT do:
//
//   * the link is never stored, in any form that can be sent to anybody
//   * a hash with no expiry is not a live link
//   * a second request kills the first link rather than leaving two
//   * a password change of ANY kind kills the outstanding link
//   * an ordinary password change still works on a project that has not got
//     the reset columns — the tidy-up must never break the thing that works
//   * a refused caller still burns their own allowance
//   * the staff queue shape carries no token, no hash and no password
//   * the reset columns are NOT droppable in crewStore's LATE_COLUMNS
//
// Pure module test — no network, no database, no mongoose.
//   Run:  node scripts/test-crew-password-reset.js

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const R = require(path.join('..', 'crewPasswordReset.js'));
const crewAccounts = require(path.join('..', 'crewAccounts.js'));

let pass = 0;
const fails = [];
const ok = (what, cond, extra) => {
    if (cond) { pass++; console.log('  ✓', what); return; }
    fails.push(what + (extra === undefined ? '' : ` — ${String(JSON.stringify(extra)).slice(0, 300)}`));
    console.log('  ✗', what, extra === undefined ? '' : `\n      ${String(JSON.stringify(extra)).slice(0, 300)}`);
};

const MINUTE = 60 * 1000;

/* ==========================================================================
 * 1. THE TOKEN
 * ======================================================================= */
console.log('\nThe link, and what is kept of it');
{
    const a = R.mintToken();
    const b = R.mintToken();
    ok('a link is minted with its hash', !!a.token && !!a.hash);
    ok('…and two of them are not the same', a.token !== b.token && a.hash !== b.hash);
    ok('…the token is URL-safe, because it travels in one',
        /^[A-Za-z0-9_-]+$/.test(a.token), a.token);
    ok('…and long enough to be unguessable', a.token.length >= 40, a.token.length);

    ok('the hash is hex SHA-256', /^[a-f0-9]{64}$/.test(a.hash), a.hash);
    ok('…is what the token hashes to, so a link can be looked up',
        R.hashToken(a.token) === a.hash);
    /* THE PROPERTY THE WHOLE STORAGE DESIGN RESTS ON. If the token can be
       recovered from what is stored, the row holds a password. */
    ok('…and does not contain the token', !a.hash.includes(a.token));
    ok('a hash of nothing never matches a minted one',
        R.hashToken('') !== a.hash && R.hashToken(null) !== a.hash);
}

console.log('\nWhether a link is still good');
{
    const now = new Date('2026-09-17T12:00:00Z');
    const live = { resetTokenHash: 'x', resetTokenExpiresAt: new Date(now.getTime() + 5 * MINUTE) };
    const dead = { resetTokenHash: 'x', resetTokenExpiresAt: new Date(now.getTime() - MINUTE) };

    ok('an account that never asked has no link', R.tokenState({}, now) === 'none');
    ok('…and nor has one with the hash cleared',
        R.tokenState({ resetTokenHash: '', resetTokenExpiresAt: live.resetTokenExpiresAt }, now) === 'none');
    ok('a link inside its window is live', R.tokenState(live, now) === 'live' && R.isLive(live, now));
    ok('…and one past it is expired', R.tokenState(dead, now) === 'expired' && !R.isLive(dead, now));
    /* A row written by something that did not go through requestPatch. Treating
       it as live would make a link with no end date out of a bug. */
    ok('a hash with no expiry is NOT a live link',
        R.tokenState({ resetTokenHash: 'x' }, now) === 'expired');
    ok('…and nor is one with an unreadable expiry',
        R.tokenState({ resetTokenHash: 'x', resetTokenExpiresAt: 'not a date' }, now) === 'expired');
    ok('the boundary is closed — a link expiring now is gone',
        R.tokenState({ resetTokenHash: 'x', resetTokenExpiresAt: now }, now) === 'expired');
    ok('nothing at all is not a live link', !R.isLive(null, now) && !R.isLive(undefined, now));
}

/* ==========================================================================
 * 2. WHAT GETS WRITTEN
 * ======================================================================= */
console.log('\nRecording a request');
{
    const now = new Date('2026-09-17T12:00:00Z');
    const { hash } = R.mintToken();

    const emailed = R.requestPatch({ hash }, now);
    ok('an emailed request stores the hash', emailed.resetTokenHash === hash);
    ok('…with an expiry TTL_MINUTES out',
        emailed.resetTokenExpiresAt.getTime() === now.getTime() + R.TTL_MINUTES * MINUTE,
        { got: emailed.resetTokenExpiresAt, ttl: R.TTL_MINUTES });
    ok('…and is not in the staff queue', emailed.resetNeedsStaff === false && emailed.resetReason === '');
    ok('…and records when they asked', emailed.resetRequestedAt === now);

    const staffed = R.requestPatch({ needsStaff: true, reason: R.REASON.NO_EMAIL }, now);
    ok('a request with nowhere to email mints no link',
        staffed.resetTokenHash === '' && staffed.resetTokenExpiresAt === null);
    ok('…and lands in the staff queue with the reason',
        staffed.resetNeedsStaff === true && staffed.resetReason === 'no_email');
    ok('…which is also recorded for one we could not reach',
        R.requestPatch({ needsStaff: true, reason: R.REASON.EMAIL_FAILED }, now).resetReason === 'email_failed');

    /* A pilot who asks twice must not end up with two live links, so a request
       always replaces. Checked as "every field the previous state could have
       used is present in the patch" — a patch that omits one leaves the old
       value behind. */
    const fields = ['resetTokenHash', 'resetTokenExpiresAt', 'resetRequestedAt', 'resetNeedsStaff', 'resetReason'];
    ok('a request overwrites every field of the one before it',
        fields.every((f) => f in emailed) && fields.every((f) => f in staffed),
        { emailed: Object.keys(emailed), staffed: Object.keys(staffed) });
    ok('…so the newest link is the only live one',
        R.requestPatch({ needsStaff: true, reason: R.REASON.NO_EMAIL }, now).resetTokenHash === '');
    ok('a reason is not kept on a request that is not the staff\'s',
        R.requestPatch({ hash, needsStaff: false, reason: R.REASON.NO_EMAIL }, now).resetReason === '');
}

console.log('\nClearing one');
{
    const c = R.clearPatch();
    ok('clearing takes the link', c.resetTokenHash === '' && c.resetTokenExpiresAt === null);
    ok('…and takes it out of the staff queue',
        c.resetNeedsStaff === false && c.resetReason === '' && c.resetRequestedAt === null);
    ok('…and a cleared row reads as having no link', R.tokenState({ ...c }) === 'none');
}

/* ==========================================================================
 * 3. THE RATE LIMITER
 *
 * Per account AND per caller, because the two protect different things: one
 * stops a pilot's inbox being used as a mailbox to shout into, the other stops
 * one machine walking a username list.
 * ======================================================================= */
console.log('\nHow often somebody may ask');
{
    R._reset();
    const t0 = Date.parse('2026-09-17T12:00:00Z');
    ok('a first ask is allowed', R.allow('acct1', 'ip1', t0));
    ok('…a second one seconds later is not', !R.allow('acct1', 'ip1', t0 + 5000));
    ok('…still not, a minute later', !R.allow('acct1', 'ip1', t0 + 60 * 1000));
    ok('…and allowed again once the cooldown has passed',
        R.allow('acct1', 'ip1', t0 + 3 * MINUTE));

    /* An hourly ceiling as well as a cooldown: one ask every two minutes for an
       hour is thirty emails to somebody who asked for one. */
    R._reset();
    let allowed = 0;
    const last = 19 * 3 * MINUTE;
    for (let i = 0; i < 20; i++) if (R.allow('acct2', 'ip2', t0 + i * 3 * MINUTE)) allowed++;
    ok('an account has an hourly ceiling as well as a cooldown', allowed <= 5, allowed);
    /* The hour runs from the LAST ask, not the first, because a refused ask is
       recorded too — so somebody hammering the form extends their own wait
       rather than resetting it. */
    ok('…and it does not lift while they are still hammering it',
        !R.allow('acct2', 'ip2', t0 + last + 30 * MINUTE));
    ok('…but does an hour after they stopped',
        R.allow('acct2', 'ip2', t0 + last + 61 * MINUTE));

    /* THE HALF THAT MATTERS FOR SOMEBODY WALKING A LIST. Each ask names a
       different account, so no per-account limit ever applies — only the
       caller's own. */
    R._reset();
    let walked = 0;
    for (let i = 0; i < 40; i++) if (R.allow(`victim${i}`, 'oneMachine', t0 + i * 1000)) walked++;
    ok('one caller cannot walk a username list', walked <= 20, walked);

    /* An ask that matched nothing must still cost the caller, or the limit is
       one you can stay under forever by being wrong. */
    R._reset();
    let misses = 0;
    for (let i = 0; i < 40; i++) if (R.allow('', 'prober', t0 + i * 1000)) misses++;
    ok('…and a miss costs the caller the same as a hit', misses <= 20, misses);

    R._reset();
    ok('two callers do not share an allowance',
        R.allow('acctA', 'ipX', t0) && R.allow('acctB', 'ipY', t0));
    ok('…and two accounts do not share a cooldown',
        !R.allow('acctA', 'ipX', t0 + 1000) && R.allow('acctC', 'ipX', t0 + 1000));

    /* A refused ask still counts, so somebody hammering the same account does
       not get a free allowance by being turned away. */
    R._reset();
    R.allow('acctD', 'ipD', t0);
    for (let i = 1; i < 10; i++) R.allow('acctD', 'ipD', t0 + i * 1000);
    ok('a refused ask still counts against the hour',
        !R.allow('acctD', 'ipD', t0 + 4 * MINUTE));

    /* THE ANSWER CARRIES NOTHING. A limiter that said WHY would be the oracle
       the whole design exists to close, one layer down. */
    R._reset();
    ok('the answer is a bare yes or no', typeof R.allow('acctE', 'ipE', t0) === 'boolean');
}

/* ==========================================================================
 * 4. WHERE A LINK LANDS, AND WHAT STAFF SEE
 * ======================================================================= */
console.log('\nThe link, and the message');
{
    const url = R.resetUrl('https://inflight.info/crew/ba', 'tok en/+');
    ok('a link lands on the crew centre\'s own sign-in page',
        url.startsWith('https://inflight.info/crew/ba?reset='), url);
    ok('…with the token escaped, because a token is not a URL',
        url.includes(encodeURIComponent('tok en/+')) && !url.includes(' '), url);
    ok('…and joins an address that already has a query',
        R.resetUrl('https://x/crew/ba?embed=1', 'abc') === 'https://x/crew/ba?embed=1&reset=abc');
    ok('no address means no link, rather than a broken one',
        R.resetUrl('', 'abc') === '' && R.resetUrl('https://x', '') === '');

    const msg = R.buildIssuedMessage({
        vaName: 'British Airways Virtual', name: 'Sam Reyes',
        username: 'sreyes', password: 'TST-9K4Z', signInUrl: 'https://inflight.info/crew/ba',
    });
    ok('the pasted message names the pilot and the airline',
        msg.includes('Sam Reyes') && msg.includes('British Airways Virtual'), msg);
    ok('…carries the login on its own lines, so a paste cannot run them together',
        /\n\s+Username: sreyes\n\s+Temporary password: TST-9K4Z/.test(msg), msg);
    ok('…says where to type it', msg.includes('https://inflight.info/crew/ba'), msg);
    ok('…and says it is replaced on first sign-in',
        /choose your own password/i.test(msg), msg);
    ok('a message with no password does not pretend to carry one',
        !/Temporary password/.test(R.buildIssuedMessage({ vaName: 'X', signInUrl: 'https://x' })));
}

console.log('\nWhat the Logins tab is given');
{
    const row = R.staffRequest({
        _id: 'a1', username: 'sreyes', displayName: 'Sam Reyes', email: 'sam@example.com',
        passwordHash: '$2a$12$averyrealbcrypthash', resetTokenHash: 'f'.repeat(64),
        resetTokenExpiresAt: new Date(), resetRequestedAt: new Date('2026-09-17T12:00:00Z'),
        resetNeedsStaff: true, resetReason: 'email_failed',
    });
    ok('a request says who asked', row.id === 'a1' && row.name === 'Sam Reyes' && row.username === 'sreyes');
    ok('…when they asked', row.askedAt instanceof Date);
    ok('…and why it reached a human', row.reason === 'email_failed');
    /* The dashboard says a different thing for somebody we could not reach than
       for somebody there was never an address for, so the address goes out. */
    ok('…with the address, which is what tells those two apart',
        row.email === 'sam@example.com');

    /* THE ONE SHAPE THAT LEAVES THE SERVER FOR THIS FEATURE, so this is the
       only place to get it wrong. */
    const json = JSON.stringify(row);
    ok('and nothing else: no hash', !json.includes('f'.repeat(64)) && !('resetTokenHash' in row));
    ok('…no password hash', !json.includes('bcrypt') && !('passwordHash' in row));
    ok('…and no expiry to work a window out from', !('resetTokenExpiresAt' in row));
    ok('the keys are exactly what the dashboard reads',
        JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['askedAt', 'email', 'id', 'name', 'reason', 'username']),
        Object.keys(row));
}

/* ==========================================================================
 * 5. THE WRITES THAT END A RESET
 * ======================================================================= */
console.log('\nThe password a pilot chooses at the end of a link');

// A store that records every write, so a test can say "one write, and this is
// what was in it" rather than only checking the row it left behind.
function fakeStore(account) {
    const writes = [];
    return {
        writes,
        row: account,
        getAccount: async (id) => (String(id) === String(account._id) ? account : null),
        updateAccount: async (id, patch) => {
            writes.push({ id: String(id), patch });
            Object.assign(account, patch);
            return account;
        },
    };
}

const LIVE = () => ({
    _id: 'a1', username: 'sreyes', displayName: 'Sam Reyes', active: true,
    passwordHash: bcrypt.hashSync('the-old-one', 10),
    mustChangePassword: true,
    resetTokenHash: 'a'.repeat(64), resetTokenExpiresAt: new Date(Date.now() + 10 * MINUTE),
    resetRequestedAt: new Date(), resetNeedsStaff: false, resetReason: '',
});

(async () => {
    {
        const store = fakeStore(LIVE());
        const out = await crewAccounts.setPasswordFromReset(store, store.row, 'correct horse battery');
        ok('a good password is accepted', out.ok === true && out.username === 'sreyes', out);
        ok('…and hashed, never stored as typed',
            store.row.passwordHash !== 'correct horse battery'
            && await bcrypt.compare('correct horse battery', store.row.passwordHash));
        ok('…so the old one stops working',
            !await bcrypt.compare('the-old-one', store.row.passwordHash));
        /* ONE WRITE. Two would leave a window where the password has changed
           and the link is still live, or the link is spent and the password is
           not set — which locks the pilot out with their one link gone. */
        ok('…in a single write, with the link dying in the same one',
            store.writes.length === 1
            && store.writes[0].patch.resetTokenHash === ''
            && store.writes[0].patch.resetTokenExpiresAt === null,
            store.writes.map((w) => Object.keys(w.patch)));
        ok('…so the link is spent', R.tokenState(store.row) === 'none');
        ok('…and they are not nagged about a password they chose themselves',
            store.row.mustChangePassword === false);
        ok('…and nothing waits on staff either', store.row.resetNeedsStaff === false);
    }

    {
        const store = fakeStore(LIVE());
        const out = await crewAccounts.setPasswordFromReset(store, store.row, 'short');
        ok('a password too short to be worth having is refused',
            out.error && out.status === 400, out);
        /* The page checks this too, but the page is not the only thing that can
           post to the route — and a refusal must not spend the link, or a typo
           costs the pilot their way back in. */
        ok('…without spending the link', store.writes.length === 0 && R.isLive(store.row));
    }

    {
        const store = fakeStore(LIVE());
        const out = await crewAccounts.setPasswordFromReset(store, null, 'correct horse battery');
        ok('no account is a 404, not a write', out.status === 404 && store.writes.length === 0);
    }

    console.log('\nEvery other way a password changes');
    {
        const store = fakeStore(LIVE());
        const out = await crewAccounts.changePassword(store, 'a1', 'the-old-one', 'a brand new one');
        ok('a pilot changing their own password still works', out.ok === true, out);
        /* The doc's promise: a token is invalidated by the password being
           changed ANY other way. A pilot who remembers their password
           mid-reset must not leave a live link in somebody's inbox. */
        ok('…and it kills the link somebody emailed them',
            R.tokenState(store.row) === 'none' && store.row.resetNeedsStaff === false);
    }

    {
        const store = fakeStore(LIVE());
        const out = await crewAccounts.resetPassword(store, 'a1');
        ok('staff issuing a password works', !!(out && out.password), out);
        ok('…kills the link too', R.tokenState(store.row) === 'none');
        ok('…takes the request out of the queue', store.row.resetNeedsStaff === false);
        ok('…and still asks them to replace it, as an invitation does',
            store.row.mustChangePassword === true);
    }

    /* A PROJECT THAT HAS NOT GOT THE COLUMNS MUST STILL BE ABLE TO CHANGE A
       PASSWORD. The reset columns are not droppable, so folding the tidy-up
       into the main write would make an ordinary password change fail outright
       on every VA that has not re-run the SQL — breaking the thing that works
       to clean up after a feature they have not got. */
    {
        const store = fakeStore(LIVE());
        let n = 0;
        const inner = store.updateAccount;
        store.updateAccount = async (id, patch) => {
            n++;
            if ('resetTokenHash' in patch && !('passwordHash' in patch)) {
                const e = new Error('column "reset_token_hash" does not exist');
                e.code = 'store_schema_outdated';
                throw e;
            }
            return inner(id, patch);
        };
        const out = await crewAccounts.changePassword(store, 'a1', 'the-old-one', 'a brand new one');
        ok('a password change survives a project with no reset columns',
            out.ok === true && n >= 2, { out, n });
        ok('…and the new password is really set',
            await bcrypt.compare('a brand new one', store.row.passwordHash));

        const store2 = fakeStore(LIVE());
        store2.updateAccount = async (id, patch) => {
            if ('resetTokenHash' in patch && !('passwordHash' in patch)) throw new Error('nope');
            return fakeStore(store2.row).updateAccount(id, patch);
        };
        const out2 = await crewAccounts.resetPassword(store2, 'a1');
        ok('…and so does a staff reset', !!(out2 && out2.password), out2);
    }

    /* ======================================================================
     * 6. THE SCHEMA, AND THE ONE RULE ABOUT IT
     * =================================================================== */
    console.log('\nThe schema the columns need');
    {
        const sqlPath = path.join(__dirname, '..', 'supabase', 'crew-center-schema.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'crewStore.js'), 'utf8');
        const crewStore = require(path.join('..', 'crewStore.js'));
        const COLS = ['reset_token_hash', 'reset_token_expires_at', 'reset_requested_at',
            'reset_needs_staff', 'reset_reason'];

        ok('every reset column is added by the setup SQL',
            COLS.every((c) => new RegExp(`add column if not exists\\s+${c}\\b`).test(sql)),
            COLS.filter((c) => !new RegExp(`add column if not exists\\s+${c}\\b`).test(sql)));
        ok('…additively, so a VA re-runs the script rather than dropping a table',
            !/drop table\s+(if exists\s+)?crew_accounts/i.test(sql));
        ok('…and the link lookup has an index, because it runs unauthenticated',
            /create index if not exists crew_accounts_reset_token_idx/.test(sql));

        // The stamped version and the code's expectation drifting apart is how
        // a VA ends up being told to update a database that is already current.
        const stamped = (sql.match(/insert into crew_schema_info \(id, version\) values \(1, (\d+)\)/) || [])[1];
        ok('the SQL stamps the version the code expects',
            Number(stamped) === crewStore.EXPECTED_SCHEMA_VERSION,
            { stamped, expected: crewStore.EXPECTED_SCHEMA_VERSION });
        ok('…which is the version the reset feature needs',
            crewStore.PASSWORD_RESET_SCHEMA_VERSION <= crewStore.EXPECTED_SCHEMA_VERSION,
            { resets: crewStore.PASSWORD_RESET_SCHEMA_VERSION, expected: crewStore.EXPECTED_SCHEMA_VERSION });

        /* THE RULE WORTH A TEST OF ITS OWN, and read out of the source because
           LATE_COLUMNS is private and the invariant is about what somebody
           might add to it later.
           A droppable column is one a row is still valid without. On a reset
           request the column IS the write: drop reset_token_hash and the update
           succeeds, stores nothing, and the pilot is told a way back in is on
           its way. It never arrives, and nothing says why. */
        const late = (storeSrc.match(/crew_accounts: new Set\(\[([^\]]*)\]\)/) || [])[1] || '';
        ok('no reset column is droppable in LATE_COLUMNS',
            COLS.every((c) => !late.includes(c)), late.trim());
    }

    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error('\nthrew:', err); process.exit(1); });
