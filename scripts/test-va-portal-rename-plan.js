/*
 * scripts/test-va-portal-rename-plan.js
 *
 * WHICH OLD LOGINS THE BACKFILL IS ALLOWED TO RENAME.
 *
 * scripts/rename-va-portal-logins.js changes what people type to sign in, so
 * the interesting part of it is not the write — it is everything it decides NOT
 * to touch. Those rules are a pure function (`planRename`) precisely so they can
 * be checked here rather than against a live database:
 *
 *   • an untouched VA-derived name becomes the owner's Discord name
 *   • a name somebody already chose by hand is left exactly as it is
 *   • an ad with no Discord owner ('Unknown', or blank) is left alone, because
 *     there is nothing better to call that account
 *   • an account already named after the person is a no-op, not a rename
 *
 * Collisions are not decided here: the script asks the database whether the
 * target name is free, and reports the clash rather than inventing a suffix.
 *
 * Run:  node scripts/test-va-portal-rename-plan.js
 */
'use strict';

const { planRename, slug } = require('./rename-va-portal-logins');

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`));
};

const AD = { name: 'AFKLM Virtual', ownerName: 'jpp370' };

/* ------------------------------------------------- the case from the report */
{
    const p = planRename({ username: 'afklm-virtual', vaName: 'AFKLM Virtual' }, AD);
    check('a VA-named login is renamed to the owner',
        p.action === 'rename' && p.to === 'jpp370', p);
}
{
    // uniqueUsernameFrom's collision suffix: still the old code's handiwork.
    const p = planRename({ username: 'afklm-virtual-2', vaName: 'AFKLM Virtual' }, AD);
    check('…including one that got a -2 from the old collision suffix',
        p.action === 'rename' && p.to === 'jpp370', p);
}

/* ----------------------------------------- choices that are not ours to undo */
{
    const p = planRename({ username: 'antony', vaName: 'AFKLM Virtual' }, AD);
    check('a hand-picked username is left alone',
        p.action === 'skip' && /by hand/.test(p.why), p);
}
{
    const p = planRename({ username: 'jpp370', vaName: 'AFKLM Virtual' }, AD);
    check('an account already named after the person is a no-op',
        p.action === 'skip' && /already named/.test(p.why), p);
}
{
    // A near-miss that is NOT the VA slug: two letters off, so somebody typed it.
    const p = planRename({ username: 'afklm-virtua', vaName: 'AFKLM Virtual' }, AD);
    check('…and a near-miss of the VA name counts as hand-picked too',
        p.action === 'skip' && /by hand/.test(p.why), p);
}

/* ------------------------------------------------------ no Discord identity */
{
    const p = planRename({ username: 'oceanic-va', vaName: 'Oceanic VA' },
        { name: 'Oceanic VA', ownerName: 'Unknown' });
    check('an ad with the Unknown placeholder is skipped',
        p.action === 'skip' && /no Discord name/.test(p.why), p);
}
{
    const p = planRename({ username: 'oceanic-va', vaName: 'Oceanic VA' },
        { name: 'Oceanic VA', ownerName: 'UNKNOWN' });
    check('…whatever its case', p.action === 'skip' && /no Discord name/.test(p.why), p);
}
{
    const p = planRename({ username: 'oceanic-va', vaName: 'Oceanic VA' }, { name: 'Oceanic VA', ownerName: '' });
    check('…as is one with no owner name at all', p.action === 'skip', p);
}
{
    const p = planRename({ username: 'oceanic-va', vaName: 'Oceanic VA' }, null);
    check('…and one whose ad has gone missing entirely', p.action === 'skip', p);
}

/* ------------------------------------------------------------- normalizing */
{
    const p = planRename({ username: 'afklm-virtual', vaName: 'AFKLM Virtual' },
        { name: 'AFKLM Virtual', ownerName: 'JPP.370' });
    check('the new name is normalized like every other username',
        p.action === 'rename' && p.to === 'jpp-370', p);
}
{
    // The ad was renamed after the account was made, so the account still holds
    // the OLD VA slug. `vaName` on the account is the denormalized copy that
    // moved with it, which is why the check consults both.
    const p = planRename({ username: 'ocean-air', vaName: 'Ocean Air' },
        { name: 'Oceanic Virtual', ownerName: 'robin' });
    check('a VA that has since rebranded still matches its old login',
        p.action === 'skip' && /by hand/.test(p.why), p);
    check('…which is the cautious answer when the two disagree', p.action !== 'rename', p);
}
{
    check('the slug helper matches uniqueUsernameFrom', slug('Oceanic VA!!') === 'oceanic-va', slug('Oceanic VA!!'));
}

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL  ' + f);
process.exit(fails.length ? 1 : 0);
