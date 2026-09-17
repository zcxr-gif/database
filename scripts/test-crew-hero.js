// test-crew-hero.js
// The hero's settings, without a page.
//
// crewHero is pure by design (see its header): handed a VA's saved choices it
// returns a bounded set that cannot produce a broken hero. That is exactly the
// kind of thing worth asserting here rather than by loading a crew centre and
// looking at it — every one of these is a rule that has to hold for three
// hundred airlines, including the ones who have never opened the screen.
//
// Run:  node scripts/test-crew-hero.js
'use strict';

const crewHero = require('../crewHero');

let pass = 0;
const fails = [];
const check = (what, ok) => { if (ok) pass++; else fails.push(what); };

/* ------------------------------------------------- the rule that matters most
 *
 * A VA that has never opened this screen must get exactly the hero they had
 * before the file existed. Every default is the shipped hero; if one of these
 * ever changes, three hundred crew centres change with it. */
{
    const d = crewHero.fromRecord(null);
    check('a VA that has never set a hero gets the one that shipped',
        d.backdrop === 'banner' && d.height === 'standard' && d.align === 'left'
        && d.actions === 'both' && d.brand === true && d.crest === true
        && d.badges === true && d.line === '' && d.dim === 55);
    check('…and an empty record is the same as no record',
        JSON.stringify(crewHero.fromRecord({})) === JSON.stringify(d));
}

/* ------------------------------------------------------------------- bounds */
{
    const junk = crewHero.normalize({
        backdrop: 'fireworks', height: 'enormous', align: 'diagonal', actions: 'seven',
    });
    check('a value we do not recognise falls back rather than reaching the page',
        junk.backdrop === 'banner' && junk.height === 'standard'
        && junk.align === 'left' && junk.actions === 'both');

    check('a backdrop we do recognise is kept, whatever case it arrives in',
        crewHero.normalize({ backdrop: 'MAP' }).backdrop === 'map');

    // The scrim. 0 is unreadable over most photographs and 100 is a black
    // rectangle with no picture in it, so neither end is reachable.
    check('the scrim cannot be turned off or turned into a black rectangle',
        crewHero.normalize({ dim: 0 }).dim === 10
        && crewHero.normalize({ dim: 1000 }).dim === 90
        && crewHero.normalize({ dim: -5 }).dim === 10);
    check('…and a scrim that is not a number keeps the default',
        crewHero.normalize({ dim: 'dark' }).dim === 55);

    const long = crewHero.normalize({ line: 'x'.repeat(500) });
    check('the airline’s own line is cut to something a hero can hold',
        long.line.length === 120);
    check('…and whitespace is not a line',
        crewHero.normalize({ line: '   ' }).line === '');

    check('the three switches are booleans, whatever was sent',
        crewHero.normalize({ brand: 0, crest: 'yes', badges: null }).brand === false
        && crewHero.normalize({ brand: 0, crest: 'yes', badges: null }).crest === true
        // null means "not said", which keeps the default rather than clearing it.
        && crewHero.normalize({ brand: 0, crest: 'yes', badges: null }).badges === true);
}

/* -------------------------------------------------------------- the merge
 *
 * The panel saves one switch as it is flipped. A replace would have "turn the
 * crest off" quietly reset the backdrop, the height and the VA's own line —
 * which is the bug the shop's settings were written to avoid, one screen along. */
{
    const saved = crewHero.toRecord({ backdrop: 'map', height: 'tall', line: 'Fly the line.' }, null);
    const after = crewHero.toRecord({ crest: false }, saved);
    check('turning one thing off keeps everything else',
        after.backdrop === 'map' && after.height === 'tall'
        && after.line === 'Fly the line.' && after.crest === false);
    check('…and a patch of nothing changes nothing',
        JSON.stringify(crewHero.toRecord({}, saved)) === JSON.stringify(saved));
    check('…and a bad value in a patch does not take the saved one down with it',
        crewHero.toRecord({ backdrop: 'fireworks' }, saved).backdrop === 'banner'
        && crewHero.toRecord({ backdrop: 'fireworks' }, saved).height === 'tall');
}

/* --------------------------------------------------------------- the wire */
{
    const pub = crewHero.publicHero({ backdrop: 'none', brand: false, dim: 70 });
    check('what the page is sent is the bounded record, not the stored one',
        pub.backdrop === 'none' && pub.brand === false && pub.dim === 70
        && pub.height === 'standard');
    check('every key the page reads is always present',
        ['backdrop', 'height', 'align', 'brand', 'crest', 'badges', 'actions', 'line', 'dim']
            .every((k) => k in pub));
}

console.log('');
if (fails.length) {
    fails.forEach((f) => console.log('  FAIL ', f));
    console.log(`\n${pass} passed, ${fails.length} failed`);
    process.exit(1);
}
console.log(`${pass} passed`);
