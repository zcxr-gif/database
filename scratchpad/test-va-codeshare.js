'use strict';
/*
 * Conformance test for the CODESHARE claim on the VA flight-event feed.
 *
 * The report this exists for: "our codeshares never show up". A VA's member
 * flying partner metal files "Shamrock 214NV" — the airline belongs to Aer
 * Lingus and the only thing on the callsign that says Norwegian Virtual is the
 * "NV" on the end. Every attribution path resolved ONE listing and stopped, so
 * whoever owned SHAMROCK received the flight and the VA whose member it actually
 * was received nothing.
 *
 * The fix has two halves, and this file pins the pure one:
 *
 *   isVaCodeshareClaim — the callsign carries the VA's tag as a REAL tag,
 *     whatever airline is in front of it, and (in the caller) the pilot is on
 *     that VA's roster. Both signals, or neither: the tag alone hands a VA every
 *     callsign that happens to end in its letters, and the roster alone posts a
 *     member's every flight to every VA they have ever joined.
 *
 * The other half — delivering to EVERY claimant rather than the first — lives in
 * handleVaEvent and is a database path, not something this can reach.
 *
 * Run:  node scratchpad/test-va-codeshare.js
 */

const path = require('path');
const fs = require('fs');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Same lifting trick as test-va-callsign-tags.js: server.js opens a database and
// a port, so the helpers under test are read out of its source and evaluated on
// their own. If one is renamed this fails with "could not find", which is the
// right outcome for a test that has stopped testing the real thing.
function lift(name) {
    const start = SRC.indexOf(`const ${name} = `);
    if (start === -1) throw new Error(`could not find ${name} in server.js`);
    let depth = 0;
    let inLine = false, inBlock = false, quote = '';
    for (let i = start; i < SRC.length; i++) {
        const c = SRC[i], next = SRC[i + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = '';
            continue;
        }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (c === ';' && depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`could not find the end of ${name} in server.js`);
}

// Order matters: the later helpers close over the earlier ones.
const NAMES = [
    'VA_CALLSIGN_MATCH_MODES',
    'VA_ROSTER_TRUST_MODES',
    'VA_ROSTER_WATCH_TRUST_MODES',
    'vaCallsignParts',
    'normalizeCallsignBase',
    'compactCallsign',
    'VA_WEIGHT_WORDS',
    'liveCallsignTokens',
    'tokenHasSuffixTag',
    'callsignTailHasTag',
    'vaCallsignBases',
    'callsignCarriesVaTag',
    'callsignSharesVaBase',
    'isDistinctiveVaTag',
    'vaDistinctiveTags',
    'vaCallsignMode',
    'vaRosterTrust',
    'callsignFitsVaMode',
    'callsignFitsVa',
    'isVaCodeshareClaim',
];
const source = NAMES.map(lift).join('\n');
// eslint-disable-next-line no-new-func
const H = new Function(`${source}\nreturn { ${NAMES.join(', ')} };`)();

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// A listing, as the flight-event resolver reads one.
const va = (callsigns, extra = {}) => ({ callsigns: [].concat(callsigns), ...extra });

const NORWEGIAN = va(['RED NOSE ##NV'], { name: 'Norwegian Virtual' });

console.log('\nisVaCodeshareClaim — the leg on partner metal');
T('the VA tag on a partner airline is a claim',
    H.isVaCodeshareClaim('Shamrock 214NV', NORWEGIAN), true);
T('so is the same tag on the VA\'s own airline',
    H.isVaCodeshareClaim('Red Nose 12NV', NORWEGIAN), true);
T('a second trailing tag does not hide the VA one',
    H.isVaCodeshareClaim('Shamrock 214NV Cargo', NORWEGIAN), true);
T('nor does a spoken weight-class word',
    H.isVaCodeshareClaim('Shamrock 214NV Heavy', NORWEGIAN), true);
T('the tag written as its own token still counts',
    H.isVaCodeshareClaim('Shamrock 214 NV', NORWEGIAN), true);

console.log('\n…and what is NOT a claim');
T('the partner\'s own untagged flight is not theirs',
    H.isVaCodeshareClaim('Shamrock 214', NORWEGIAN), false);
T('another VA\'s tag is not theirs',
    H.isVaCodeshareClaim('Shamrock 214EX', NORWEGIAN), false);
T('trailing letters that merely END in the tag are not the tag',
    H.isVaCodeshareClaim('Moskva 12', va(['OCEAN ##VA'])), false);
T('a listing with no callsign on file claims nothing',
    H.isVaCodeshareClaim('Shamrock 214NV', va([])), false);
T('an empty callsign claims nothing',
    H.isVaCodeshareClaim('', NORWEGIAN), false);
T('a tagless VA cannot claim a codeshare — it has no tag to claim with',
    H.isVaCodeshareClaim('Shamrock 214', va(['BAW ###'])), false);

console.log('\nrosterTrust still governs — half of this claim is the roster');
T('"off" means the roster never delivers, codeshare included',
    H.isVaCodeshareClaim('Shamrock 214NV', va(['RED NOSE ##NV'], { rosterTrust: 'off' })), false);
for (const trust of ['tagged', 'airline', 'any']) {
    T(`"${trust}" still claims the leg`,
        H.isVaCodeshareClaim('Shamrock 214NV', va(['RED NOSE ##NV'], { rosterTrust: trust })), true);
}
T('a listing saved before rosterTrust existed reads as the default, not as "off"',
    H.isVaCodeshareClaim('Shamrock 214NV', va(['RED NOSE ##NV'], { rosterTrust: undefined })), true);

console.log('\nthe generic "VA" tag — refused alone, accepted with a roster behind it');
const OCEAN = va(['OCEAN ##VA'], { name: 'Ocean Virtual' });
T('"VA" names no VA on its own, so the tag-only path refuses it',
    H.isDistinctiveVaTag('VA'), false);
T('a tag-mode listing therefore cannot claim a partner callsign on "VA" alone',
    H.callsignFitsVaMode('Shamrock 12VA', OCEAN, 'tag'), false);
T('but the codeshare claim — tag PLUS roster — does identify it',
    H.isVaCodeshareClaim('Shamrock 12VA', OCEAN), true);
T('and a single letter is still a tag when the roster vouches for the pilot',
    H.isVaCodeshareClaim('Shamrock 12X', va(['OCEAN ##X'])), true);

console.log('\nthe claim is additive — it never redirects a flight away from its airline');
// Both listings claim "Shamrock 214NV" for different, correct reasons. The
// delivery path posts to both; neither answer is meant to displace the other.
const AERLINGUS = va(['SHAMROCK ###'], { name: 'Aer Lingus Virtual' });
T('the operating airline still matches on its own callsign',
    H.callsignFitsVa('Shamrock 214NV', AERLINGUS), true);
T('and the tag owner claims the same leg',
    H.isVaCodeshareClaim('Shamrock 214NV', NORWEGIAN), true);

console.log('\nevery rostered pilot of an opted-in VA is watched by the sender');
// The event has to REACH this backend before any of the above can run, and it
// only does when the callsign matches some VA or the pilot is on the watch list.
T('no trust level except "off" is excluded from the watch list',
    H.VA_ROSTER_WATCH_TRUST_MODES.slice().sort(), ['airline', 'any', 'tagged']);

console.log('\n' + (failures === 0 ? '=== ALL CHECKS PASSED ✅ ===' : `=== ${failures} CHECK(S) FAILED ❌ ===`));
process.exit(failures === 0 ? 0 : 1);
