/*
 * scripts/test-va-portal-naming.js
 *
 * WHAT A PORTAL LOGIN IS CALLED.
 *
 * `provisionOwnerAccount` built the username from the VA's NAME, so the owner
 * of AFKLM Virtual signed in as @afklmva while the very same row displayed
 * "jpp370" — their Discord name — beside it. Two names for one person, and the
 * one they had to type was the one nothing else called them. It collides by
 * design too: run two VAs and you get two logins named after airlines, neither
 * recognisably yours.
 *
 * The rep path has always keyed off the Discord username. These are the rules
 * for owners, now the same:
 *
 *   • the Discord username the caller passes wins — it is the freshest, fetched
 *     live at approval time, where `ad.ownerName` is whatever they were called
 *     on the day they applied
 *   • `ad.ownerName` next, since the bot captured it from Discord
 *   • the VA name ONLY as the fallback, for an ad with no Discord owner at all
 *   • 'Unknown' is the ad schema's placeholder, not somebody's name, and must
 *     never become either a username or a display name
 *
 * None of this touches an account that already exists: provisioning is
 * idempotent and a rename is a deliberate act (the Accounts tab, or
 * scripts/rename-va-portal-logins.js), never a side effect of re-approval.
 *
 * Run:  node scripts/test-va-portal-naming.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const vaPortal = require('../vaPortal');
const { VaPortalAccount, provisionOwnerAccount, provisionRepAccount } = vaPortal;

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

/**
 * Stand the model up for one provisioning call.
 *
 * `taken` is the set of usernames already in use, which is the only thing
 * uniqueUsernameFrom asks about; `existingOwner` / `existingRep` stand in for
 * the idempotency checks.
 */
function stub({ taken = [], existing = null } = {}) {
    const made = [];
    VaPortalAccount.findOne = async () => existing;
    VaPortalAccount.exists = async (q) => (q && q.username && taken.includes(q.username) ? { _id: 'x' } : null);
    VaPortalAccount.create = async (doc) => { made.push(doc); return { ...doc, _id: 'new' }; };
    return made;
}

const AD = {
    _id: 'ad1', name: 'AFKLM Virtual', ownerId: '1234567890', ownerName: 'jpp370',
};

(async () => {
    /* --------------------------------------------- the bug, from the report */
    {
        stub();
        const r = await provisionOwnerAccount(AD);
        check('an owner login is named after the person, not the airline',
            r.username === 'jpp370', r.username);
        check('…and is not the VA name any more', r.username !== 'afklm-virtual', r.username);
    }

    /* ------------------------------------- a live Discord name beats a stale one */
    {
        stub();
        const r = await provisionOwnerAccount(AD, { discordUsername: 'jpp.370.new' });
        check('the username the caller fetched wins over the stored one',
            r.username === 'jpp-370-new', r.username);
    }

    /* ---------------------------------------------- no Discord owner at all */
    {
        // An admin-authored listing: 'Unknown' is the ad schema's default, not
        // anybody's name, so the VA name is all there is to go on.
        const made = stub();
        const r = await provisionOwnerAccount({ _id: 'ad2', name: 'Oceanic VA', ownerName: 'Unknown' });
        check('an ad with no Discord owner falls back to the VA name',
            r.username === 'oceanic-va', r.username);
        check('…and never shows "Unknown" as a display name',
            made[0].displayName === 'Oceanic VA', made[0].displayName);
    }
    {
        stub();
        const r = await provisionOwnerAccount({ _id: 'ad3', name: 'Blank Air', ownerName: '' });
        check('…as does one with no owner name recorded', r.username === 'blank-air', r.username);
    }

    /* --------------------------------- one person, two VAs: no silent collision */
    {
        stub({ taken: ['jpp370'] });
        const r = await provisionOwnerAccount(AD);
        check('a second VA for the same person gets a distinct login',
            r.username === 'jpp370-2', r.username);
    }

    /* ------------------------------------------------ the display name, and case */
    {
        const made = stub();
        await provisionOwnerAccount(AD);
        check('the display name stays the Discord name', made[0].displayName === 'jpp370', made[0].displayName);
        check('…and the Discord id is kept on the account',
            made[0].discordUserId === AD.ownerId, made[0].discordUserId);
    }
    {
        stub();
        const r = await provisionOwnerAccount({ ...AD, ownerName: 'JPP.370' });
        check('a username is normalized the way the create path normalizes',
            r.username === 'jpp-370', r.username);
    }
    {
        stub();
        const r = await provisionOwnerAccount({ ...AD, ownerName: 'UNKNOWN' });
        check('the placeholder is caught whatever its case',
            r.username === 'afklm-virtual', r.username);
    }

    /* ------------------------------------------ an existing account is left alone */
    {
        const sitting = { _id: 'o1', username: 'afklmva', vaName: 'AFKLM Virtual', save: async () => {} };
        stub({ existing: sitting });
        const r = await provisionOwnerAccount(AD);
        check('re-approving a VA never renames the login it already has',
            r.created === false && r.username === 'afklmva', [r.created, r.username]);
        check('…and mints no new password for it', r.password === null, r.password);
    }

    /* ------------------------------- the rep path, which already did this right */
    {
        stub();
        const r = await provisionRepAccount(AD, { discordUserId: '999', discordUsername: 'robin' });
        check('a rep login is still named after the rep', r.username === 'robin', r.username);
    }

    console.log(`${pass} passed, ${fails.length} failed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
