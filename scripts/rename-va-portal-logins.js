/*
 * scripts/rename-va-portal-logins.js
 *
 * RENAMING THE OWNER LOGINS THAT WERE NAMED AFTER THE AIRLINE.
 *
 * `provisionOwnerAccount` used to build the username from the VA's name, so the
 * owner of AFKLM Virtual signs in as @afklmva while the row displays "jpp370",
 * their Discord name, beside it. vaPortal.js now names new owner logins after
 * the person. This is the other half: the accounts already made the old way.
 *
 * A USERNAME IS A CREDENTIAL. Renaming one changes what somebody types to sign
 * in, and nothing tells them — their saved password will autofill against a
 * username that no longer exists. So this script does NOTHING by default: it
 * prints the renames it would make, and only writes them when run with
 * --apply. Tell the owners before you use that flag; the report is written so
 * you can paste the list straight into a message.
 *
 *   node scripts/rename-va-portal-logins.js              # report only
 *   node scripts/rename-va-portal-logins.js --apply      # actually rename
 *   node scripts/rename-va-portal-logins.js --apply --va "AFKLM Virtual"
 *
 * WHAT IT WILL NOT TOUCH:
 *   • accounts whose username already matches their Discord name
 *   • accounts with no Discord identity on file (nothing better to call them)
 *   • accounts a person or staff member renamed by hand — i.e. anything not
 *     still holding the exact VA-derived name the old code would have given it,
 *     because that is somebody's deliberate choice and not this script's to undo
 *   • a target name somebody else already holds; those are reported and skipped
 *     rather than guessed at with a -2 suffix, since a collision here usually
 *     means the same person owns two VAs and you want to pick the names
 *
 * Needs MONGO_URI in the environment, the same one the server uses.
 */
'use strict';

// The same normalization uniqueUsernameFrom applies, so "would the old code
// have produced this name?" and "what should it be now?" are asked in the same
// terms the live code uses.
const slug = (s) => String(s || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);

/**
 * Decide what should happen to one account. Pure, so the rules above are
 * testable without a database standing behind them — see
 * scripts/test-va-portal-rename-plan.js.
 *
 * @param {Object} account  the portal account row (username, vaName, vaAdId)
 * @param {Object|null} ad  its VA ad, for the owner's Discord name
 * @returns {{action: 'rename'|'skip', to?: string, why?: string}}
 */
function planRename(account, ad) {
    const ownerName = String((ad && ad.ownerName) || '').trim();
    if (!ownerName || ownerName.toLowerCase() === 'unknown') {
        return { action: 'skip', why: 'no Discord name on file' };
    }
    const want = slug(ownerName);
    if (!want || want === account.username) {
        return { action: 'skip', why: 'already named after the person' };
    }
    // Only the untouched VA-derived name is this script's to change. A username
    // that is neither that nor the Discord name was set by hand, by the owner or
    // by staff, and that choice is not ours to undo.
    const vaSlug = slug((ad && ad.name) || account.vaName);
    if (account.username !== vaSlug && !new RegExp(`^${vaSlug}-\\d+$`).test(account.username)) {
        return { action: 'skip', why: 'renamed by hand already — left alone' };
    }
    return { action: 'rename', to: want };
}

// Importing this file for its rules must not open a database or read argv.
if (require.main !== module) {
    module.exports = { slug, planRename };
    return;
}

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const vaFlag = process.argv.indexOf('--va');
const ONLY_VA = vaFlag !== -1 ? process.argv[vaFlag + 1] : null;

(async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set — nothing to connect to.');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);

    // Read through the driver rather than the app's models: requiring server.js
    // would start a web server, and vaPortal.js only needs the one collection.
    const accounts = mongoose.connection.db.collection('vaportalaccounts');
    const ads = mongoose.connection.db.collection('virtualairlineads');

    const filter = { role: 'owner', createdVia: 'bot' };
    if (ONLY_VA) filter.vaName = ONLY_VA;
    const rows = await accounts.find(filter).toArray();

    const rename = [];
    const collide = [];
    const skipped = [];

    for (const a of rows) {
        const ad = a.vaAdId ? await ads.findOne({ _id: a.vaAdId }) : null;
        const plan = planRename(a, ad);
        if (plan.action === 'skip') { skipped.push([a.username, plan.why]); continue; }
        const clash = await accounts.findOne({ username: plan.to, _id: { $ne: a._id } });
        if (clash) { collide.push([a.username, plan.to, a.vaName]); continue; }
        rename.push({ id: a._id, from: a.username, to: plan.to, va: a.vaName, display: a.displayName });
    }

    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\n${rows.length} bot-created owner account(s) examined.\n`);

    if (rename.length) {
        console.log(APPLY ? 'RENAMING:' : 'WOULD RENAME (run with --apply to do it):');
        for (const r of rename) console.log(`  @${pad(r.from, 24)} → @${pad(r.to, 24)} ${r.va || ''}`);
        console.log('');
    } else {
        console.log('Nothing to rename.\n');
    }

    if (collide.length) {
        console.log('SKIPPED — the name they should have is already taken:');
        for (const [from, want, va] of collide) console.log(`  @${pad(from, 24)} wanted @${pad(want, 24)} ${va || ''}`);
        console.log('  (usually the same person owning two VAs — pick names by hand.)\n');
    }
    if (skipped.length) {
        console.log(`SKIPPED — ${skipped.length} account(s) left alone:`);
        for (const [name, why] of skipped) console.log(`  @${pad(name, 24)} ${why}`);
        console.log('');
    }

    if (APPLY && rename.length) {
        let done = 0;
        for (const r of rename) {
            // One at a time, and keyed on the name we read, so a rename that
            // landed from somewhere else between the read and the write is not
            // quietly overwritten.
            const res = await accounts.updateOne(
                { _id: r.id, username: r.from },
                { $set: { username: r.to } },
            );
            if (res.modifiedCount) done += 1;
            else console.log(`  ! @${r.from} changed underneath us — skipped.`);
        }
        console.log(`Renamed ${done} of ${rename.length}.`);
        console.log('Tell these owners their username changed; their password is unaffected.\n');
    } else if (rename.length) {
        console.log('Nothing was written. Re-run with --apply once the owners have been told.\n');
    }

    await mongoose.disconnect();
})().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
