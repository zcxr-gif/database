'use strict';
// Conformance test for the pilot callsigns a crew center issues.
//
// The join form used to build a pilot's callsign by pasting the VA's prefix
// onto whatever number they typed: "AEROMEXICO" + "001" -> "AEROMEXICO001".
// That is not the shape the VA registered. A VA registers a MASK —
// "AEROMEXICO ###MX" — and the airline part, the number's width and the tag all
// come out of it, so the callsign should have been "AEROMEXICO 001MX".
//
// It mattered for more than tidiness. "AEROMEXICO001" carries no tag, so under
// 'exact' or 'strict' matching it is the real Aeromexico rather than a VA of
// it: the pilot's flights matched no registered callsign and were attributed to
// nobody. And nothing anywhere asked whether the number was already held, so
// two pilots could take 001 on the same afternoon and find out on the map.
//
// The cases below pin three things:
//
//   * the SHAPE — mask in, "<AIRLINE> <padded><TAG>" out, for tags that are not
//     "VA", masks with no tag at all, and legacy bare bases;
//   * the CONFLICT rule — which has to be looser than string equality, because
//     rosters are full of callsigns written by older code and by hand, and
//     "AEROMEXICO001", "Aeromexico 1" and "AEROMEXICO 001MX" are one pilot
//     number on frequency;
//   * the RESERVED range — low numbers are the VA's to hand out, so the join
//     form is refused them and staff are not.
//
// It also pins crewCallsign.parseMask against vaCallsignParts in server.js.
// Those two read the same mask for different consumers — one issues callsigns,
// the other matches live flights against them — and a VA whose pilots are
// issued callsigns its own matcher rejects is the bug this whole area started
// as. They are separate functions (vaCallsignParts sits in the middle of
// server.js's matching code and is lifted out of source by its own test), so
// this is where they are held together.
//
// Run:  node scratchpad/test-crew-callsign.js

const fs = require('fs');
const path = require('path');
const c = require('../crewCallsign');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Take `const <name> = ...;` and stop at the semicolon that actually ends the
// statement — tracking depth so a one-line arrow and a multi-line body are both
// read correctly. Same lift as test-va-callsign-tags.js, and deliberately loud:
// if the helper is renamed this fails with "could not find", which is the right
// outcome for a test that has stopped testing the real thing.
function lift(name) {
    const start = SRC.indexOf(`const ${name} = `);
    if (start === -1) throw new Error(`could not find ${name} in server.js`);
    let depth = 0;
    let inLine = false, inBlock = false, quote = '';
    for (let i = start; i < SRC.length; i++) {
        const ch = SRC[i], next = SRC[i + 1];
        if (inLine) { if (ch === '\n') inLine = false; continue; }
        if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { inLine = true; i++; continue; }
        if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        else if (ch === ';' && depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`could not find the end of ${name} in server.js`);
}
// eslint-disable-next-line no-new-func
const vaCallsignParts = new Function(`${lift('vaCallsignParts')}\nreturn vaCallsignParts;`)();

// The same trick for `function <name>(...) {...}`, which is how the handlers'
// own callsign helpers are declared. Balanced braces from the body's opening
// one, skipping strings, template literals, regex-ish slashes and comments.
function liftFn(name) {
    let start = SRC.indexOf(`\nfunction ${name}(`);
    if (start === -1) start = SRC.indexOf(`\nasync function ${name}(`);
    if (start === -1) throw new Error(`could not find function ${name} in server.js`);
    // Skip the parameter list before looking for the body's "{": a destructured
    // options argument opens a brace of its own, and taking that one as the body
    // lifts a function that ends halfway through its own signature.
    let p = SRC.indexOf('(', start), parens = 0;
    for (; p < SRC.length; p++) {
        if (SRC[p] === '(') parens++;
        else if (SRC[p] === ')' && !--parens) break;
    }
    const open = SRC.indexOf('{', p);
    let depth = 0;
    let inLine = false, inBlock = false, quote = '';
    for (let i = open; i < SRC.length; i++) {
        const ch = SRC[i], next = SRC[i + 1];
        if (inLine) { if (ch === '\n') inLine = false; continue; }
        if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { inLine = true; i++; continue; }
        if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (!depth) return SRC.slice(start + 1, i + 1); }
    }
    throw new Error(`could not find the end of function ${name} in server.js`);
}

// The handlers' helpers, evaluated with crewCallsign in scope exactly as
// server.js has it. Anything else they reach for would fail loudly here, which
// is the point: these are the functions /apply, the roster and the accept path
// actually run.
const FNS = ['callsignFormatFor', 'applicationCallsign', 'callsignHolder', 'normalizeStaffCallsign'];
// eslint-disable-next-line no-new-func
const S = new Function('crewCallsign', 'console',
    `${FNS.map(liftFn).join('\n')}\nreturn { ${FNS.join(', ')} };`)(c, { error() {} });

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

/* ===========================================================================
 * parseMask — the airline, the tag, and the width
 * ======================================================================== */
console.log('\nparseMask — reading a registered mask');
T('a three-digit mask with a tag', c.parseMask('AEROMEXICO ###MX'), { base: 'AEROMEXICO', tag: 'MX', digits: 3 });
T('a two-digit "VA" mask', c.parseMask('OCEAN ##VA'), { base: 'OCEAN', tag: 'VA', digits: 2 });
T('a tagless mask keeps its width and no tag', c.parseMask('BAW ###'), { base: 'BAW', tag: '', digits: 3 });
T('a multi-word airline keeps its spaces', c.parseMask('AIR CANADA ##VA'), { base: 'AIR CANADA', tag: 'VA', digits: 2 });
T('a bare base is the "VA" every display path promises it', c.parseMask('OCEAN'), { base: 'OCEAN', tag: 'VA', digits: 3 });
T('…and so is one with the tag glued on', c.parseMask('Ocean VA'), { base: 'OCEAN', tag: 'VA', digits: 3 });
T('a mask with no width to read falls back to three', c.parseMask('SHAMROCK').digits, 3);
T('an absurd width is clamped, not honoured', c.parseMask('X ##########Y').digits, 5);
T('nothing at all is nothing', c.parseMask('   '), null);

// The cross-check. Both read a mask; they must not disagree about what it says.
console.log('\nparseMask agrees with server.js vaCallsignParts on base and tag');
for (const mask of ['OCEAN ##VA', 'UPS ##UP', 'SHAMROCK ###EX', 'BAW ###', 'AIR CANADA ##VA', 'OCEAN', 'Ocean VA', 'AEROMEXICO ###MX']) {
    const mine = c.parseMask(mask);
    const theirs = vaCallsignParts(mask);
    T(`"${mask}"`, mine && { base: mine.base, tag: mine.tag }, theirs);
}

/* ===========================================================================
 * build — what a pilot is actually issued
 * ======================================================================== */
console.log('\nbuild — the mask, filled in');
const AEROMEXICO = c.parseMask('AEROMEXICO ###MX');
T('the reported bug: not "Aeromexico001"', c.build(AEROMEXICO, 1), 'AEROMEXICO 001MX');
T('the number is padded to the mask’s width', c.build(AEROMEXICO, 42), 'AEROMEXICO 042MX');
T('a number wider than the mask is NOT truncated', c.build(AEROMEXICO, 1174), 'AEROMEXICO 1174MX');
T('a tagless VA gets no tag invented for it', c.build(c.parseMask('BAW ###'), 7), 'BAW 007');
T('a two-digit VA pads to two', c.build(c.parseMask('OCEAN ##VA'), 7), 'OCEAN 07VA');
T('a multi-word airline keeps its space', c.build(c.parseMask('AIR CANADA ##VA'), 7), 'AIR CANADA 07VA');
T('the sample a form shows is the real shape', c.sample(AEROMEXICO), 'AEROMEXICO 001MX');

/* ===========================================================================
 * formatsFor — which airlines a VA issues under
 * ======================================================================== */
console.log('\nformatsFor — every callsign the VA registered');
T('a VA with sub-fleets issues under either',
    c.formatsFor({ callsigns: ['AEROMEXICO ###MX', 'CONNECT ##CX'] }).map((f) => f.base),
    ['AEROMEXICO', 'CONNECT']);
T('a legacy single callsign still works',
    c.formatsFor({ callsign: 'OCEAN ##VA' }).map((f) => f.base), ['OCEAN']);
T('a prefix naming a registered airline is that mask, not a fourth shape',
    c.formatsFor({ callsign: 'OCEAN ##VA', callsignPrefix: 'OCEAN' }),
    [{ base: 'OCEAN', tag: 'VA', digits: 2 }]);
T('a prefix naming a new airline inherits the primary’s tag and width',
    c.formatsFor({ callsign: 'OCEAN ##VA', callsignPrefix: 'JAZZ' })[0],
    { base: 'JAZZ', tag: 'VA', digits: 2 });
T('a prefix promotes its airline to primary',
    c.formatsFor({ callsigns: ['AEROMEXICO ###MX', 'CONNECT ##CX'], callsignPrefix: 'CONNECT' })[0].base,
    'CONNECT');
T('a VA that registered nothing has no shape to issue', c.formatsFor({}), []);

/* ===========================================================================
 * same — the conflict rule
 *
 * Looser than equality on purpose. Refusing a number that is only arguably
 * taken costs an applicant one keystroke; issuing it twice costs the VA a
 * callsign collision it finds out about on frequency.
 * ======================================================================== */
console.log('\nsame — is this number already held?');
T('a callsign issued by the OLD code collides with the new shape',
    c.same('AEROMEXICO001', 'AEROMEXICO 001MX'), true);
T('…so does one typed by hand, unpadded and untagged',
    c.same('Aeromexico 1', 'AEROMEXICO 001MX'), true);
T('…and one with the tag but no space', c.same('AEROMEXICO001MX', 'AEROMEXICO 001MX'), true);
T('a different number does not', c.same('AEROMEXICO 002MX', 'AEROMEXICO 001MX'), false);
T('the same number on a different airline does not',
    c.same('CONNECT 001CX', 'AEROMEXICO 001MX'), false);
T('a different TAG on the same number still collides — one number, one pilot',
    c.same('AEROMEXICO 001XX', 'AEROMEXICO 001MX'), true);
T('a numberless callsign compares whole', c.same('OPS', 'ops'), true);
T('…and does not collide with another one', c.same('OPS', 'DISPATCH'), false);
T('a numberless callsign does not collide with a numbered one',
    c.same('OPS', 'AEROMEXICO 001MX'), false);
T('empty collides with nothing', c.same('', ''), false);

console.log('\nsplit — reading a stored callsign back');
T('the new shape', c.split('AEROMEXICO 001MX'), { base: 'AEROMEXICO', n: 1 });
T('the old shape', c.split('AEROMEXICO001'), { base: 'AEROMEXICO', n: 1 });
T('hand-typed', c.split('Aeromexico 1'), { base: 'AEROMEXICO', n: 1 });
T('a multi-word airline compacts', c.split('Air Canada 001VA'), { base: 'AIRCANADA', n: 1 });
T('no number in it at all', c.split('OPS'), { base: 'OPS', n: null });

console.log('\nheldBy — finding the holder');
const ROSTER = [
    { _id: 'm1', name: 'Jordan', callsign: 'AEROMEXICO001' },
    { _id: 'm2', name: 'Sam', callsign: 'AEROMEXICO 042MX' },
];
T('finds the legacy holder of the number being asked for',
    (c.heldBy(ROSTER, 'AEROMEXICO 001MX') || {}).name, 'Jordan');
T('finds a holder in the current shape',
    (c.heldBy(ROSTER, 'Aeromexico 42') || {}).name, 'Sam');
T('a free number has no holder', c.heldBy(ROSTER, 'AEROMEXICO 999MX'), null);
T('a pilot does not collide with themselves on re-save',
    c.heldBy(ROSTER, 'AEROMEXICO 001MX', { exceptId: 'm1' }), null);

/* ===========================================================================
 * The reserved range — 001 is the founder's, not whoever filled the form in
 * first. Staff may issue one; the public join form may not ask for one.
 * ======================================================================== */
console.log('\nreserved numbers — staff-issue only');
T('the default range is 1–10', c.DEFAULT_RESERVED_MAX, 10);
T('1 is reserved', c.isReserved(1, 10), true);
T('10 is reserved — the range includes its top', c.isReserved(10, 10), true);
T('11 is not', c.isReserved(11, 10), false);
T('a VA can widen the range', c.isReserved(15, 20), true);
T('…or switch it off entirely', c.isReserved(1, 0), false);

console.log('\nvalidate — what the join form and the roster are each allowed');
T('the join form is refused a reserved number',
    c.validate(AEROMEXICO, '1', { reservedMax: 10, staff: false }).code, 'reserved');
T('…and told what to do instead',
    /1–10/.test(c.validate(AEROMEXICO, '1', { reservedMax: 10, staff: false }).error), true);
T('staff are not refused it',
    c.validate(AEROMEXICO, '1', { reservedMax: 10, staff: true }).callsign, 'AEROMEXICO 001MX');
T('the first number above the range is free',
    c.validate(AEROMEXICO, '11', { reservedMax: 10 }).callsign, 'AEROMEXICO 011MX');
T('a padded number is read as its value, not its digits',
    c.validate(AEROMEXICO, '0011', { reservedMax: 10 }).callsign, 'AEROMEXICO 011MX');
T('…including a padded RESERVED one, which cannot be smuggled past the gate',
    c.validate(AEROMEXICO, '001', { reservedMax: 10, staff: false }).code, 'reserved');
T('a non-numeric number is refused', c.validate(AEROMEXICO, 'abc', {}).code, 'bad_number');
T('zero is not a pilot number', c.validate(AEROMEXICO, '0', {}).code, 'bad_number');
T('an empty number is refused', c.validate(AEROMEXICO, '', {}).code, 'bad_number');
T('a VA with no callsign cannot issue one', c.validate(null, '11', {}).code, 'no_airline');

console.log('\nreservedMaxFrom — reading the setting');
T('unset means the default, not "nothing reserved"', c.reservedMaxFrom(undefined), 10);
T('an explicit 0 switches it off', c.reservedMaxFrom(0), 0);
T('a typo falls back rather than opening 001 up', c.reservedMaxFrom('twelve', 10), 10);
T('a negative is not a range', c.reservedMaxFrom(-5, 10), 10);
T('an absurd range is clamped', c.reservedMaxFrom(100000), 999);

/* ===========================================================================
 * The handlers' own helpers, lifted out of server.js.
 *
 * crewCallsign is the rules; these are what /apply, the roster editor and the
 * accept path actually call. The cases that matter here are the ones that only
 * appear once a store is involved: an application read back into the current
 * shape, an old roster row blocking a new applicant, and the accept path not
 * colliding with the very row it is accepting.
 * ======================================================================== */
const VA = { callsigns: ['AEROMEXICO ###MX', 'CONNECT ##CX'], callsignReservedMax: 10 };

console.log('\ncallsignFormatFor — which airline a request is asking for');
T('no airline named gets the VA’s primary', S.callsignFormatFor(VA, '').base, 'AEROMEXICO');
T('a named sub-fleet gets its own shape', S.callsignFormatFor(VA, 'CONNECT'), { base: 'CONNECT', tag: 'CX', digits: 2 });
T('case and spacing do not matter', S.callsignFormatFor(VA, 'connect').base, 'CONNECT');
T('an airline this VA never registered is REFUSED, not redirected',
    S.callsignFormatFor(VA, 'DELTA'), null);
T('a VA that registered nothing takes what was typed',
    S.callsignFormatFor({}, 'ACA'), { base: 'ACA', tag: 'VA', digits: 3 });
T('…and with nothing typed either, has nothing to issue', S.callsignFormatFor({}, ''), null);

console.log('\napplicationCallsign — the two stored halves, read back as one');
T('the shape is applied on the way out, not on the way in',
    S.applicationCallsign({ callsignPrefix: 'AEROMEXICO', callsignNumber: '1' }, VA), 'AEROMEXICO 001MX');
T('a sub-fleet application keeps its own tag and width',
    S.applicationCallsign({ callsignPrefix: 'CONNECT', callsignNumber: '7' }, VA), 'CONNECT 07CX');
T('a row stored before the VA registered anything still reads as itself',
    S.applicationCallsign({ callsignPrefix: 'ACA', callsignNumber: '1174' }, {}), 'ACA 1174VA');
T('a row with no number falls back rather than vanishing',
    S.applicationCallsign({ callsignPrefix: 'OPS', callsignNumber: '' }, VA), 'OPS');
T('no application at all is no callsign', S.applicationCallsign(null, VA), '');

console.log('\nnormalizeStaffCallsign — what the roster editor stores');
T('a bare number means "that number, on our airline"', S.normalizeStaffCallsign(VA, '1'), 'AEROMEXICO 001MX');
T('a callsign in the old shape is corrected', S.normalizeStaffCallsign(VA, 'AEROMEXICO001'), 'AEROMEXICO 001MX');
T('…as is one typed loosely', S.normalizeStaffCallsign(VA, 'aeromexico 1'), 'AEROMEXICO 001MX');
T('a sub-fleet callsign keeps its own shape', S.normalizeStaffCallsign(VA, 'connect 7'), 'CONNECT 07CX');
T('staff may issue a RESERVED number — that is what "selected" means',
    S.normalizeStaffCallsign(VA, '1'), 'AEROMEXICO 001MX');
T('something that is not a pilot number is left alone', S.normalizeStaffCallsign(VA, 'ops'), 'OPS');
T('…and so is a callsign on an airline the VA has not registered',
    S.normalizeStaffCallsign(VA, 'DELTA 12'), 'DELTA 12');
T('blank stays blank', S.normalizeStaffCallsign(VA, ''), '');

console.log('\ncallsignHolder — the check that was missing entirely');
// A store that answers with whatever the case needs.
const storeOf = (members, applications) => ({
    listMembers: async () => members,
    listApplications: async () => applications,
});
(async () => {
    const legacyRoster = storeOf([{ _id: 'm1', name: 'Jordan', callsign: 'AEROMEXICO001' }], []);
    T('a pilot issued 001 by the OLD code blocks an applicant asking for 001 now',
        (await S.callsignHolder(VA, legacyRoster, 'AEROMEXICO 001MX')), { kind: 'member', name: 'Jordan' });
    T('a free number has no holder',
        await S.callsignHolder(VA, legacyRoster, 'AEROMEXICO 999MX'), null);
    T('the same number on a sub-fleet is a different callsign',
        await S.callsignHolder(VA, legacyRoster, 'CONNECT 01CX'), null);
    T('staff re-saving a pilot do not collide with that pilot',
        await S.callsignHolder(VA, legacyRoster, 'AEROMEXICO 001MX', { exceptMemberId: 'm1' }), null);

    // The race the old code lost: two applicants, same number, both accepted.
    const contested = storeOf([], [{ _id: 'a1', callsignPrefix: 'AEROMEXICO', callsignNumber: '42' }]);
    T('an application under review has its number spoken for',
        await S.callsignHolder(VA, contested, 'AEROMEXICO 042MX'), { kind: 'application' });
    T('…and is reported WITHOUT a name — an applicant is not public',
        Object.prototype.hasOwnProperty.call(await S.callsignHolder(VA, contested, 'AEROMEXICO 042MX'), 'name'), false);
    T('the accept path does not collide with the row it is accepting',
        await S.callsignHolder(VA, contested, 'AEROMEXICO 042MX', { exceptApplicationId: 'a1' }), null);

    // A store that cannot serve applications must not take the roster down
    // with it: the roster half is the one that has to be right.
    const halfBroken = {
        listMembers: async () => [{ _id: 'm1', name: 'Sam', callsign: 'AEROMEXICO 005MX' }],
        listApplications: async () => { throw new Error('applications table missing'); },
    };
    T('a roster hit still lands when applications cannot be read',
        await S.callsignHolder(VA, halfBroken, 'AEROMEXICO 005MX'), { kind: 'member', name: 'Sam' });
    T('…and an unreadable applications table is not read as "taken"',
        await S.callsignHolder(VA, halfBroken, 'AEROMEXICO 006MX'), null);
    T('nothing asked about is nobody’s', await S.callsignHolder(VA, legacyRoster, ''), null);

    console.log(failures ? `\n${failures} failing\n` : '\nall green\n');
    process.exit(failures ? 1 : 0);
})();
