'use strict';
// Staff inviting a pilot directly: the pieces the invite form leans on.
//
//   * the next free callsign skips the reserved range and anything held,
//     and ignores another airline shape's numbers
//   * the airline's welcome note goes into the invitation, both versions
//   * "hours and rank carried over" is said only to somebody who has some
//
// Pure: no network, no database.
const path = require('path');
const C = require(path.join('..', 'crewCallsign.js'));
const R = require(path.join('..', 'crewPasswordReset.js'));

let failures = 0;
const T = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(ok ? '  ✓' : '  ✗', label, ok ? '' : `\n      got: ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    if (!ok) failures++;
};

console.log('\n next free callsign');
const fmt = C.parseMask('AURORA ###AU');
T('first number above the reserved range', C.nextFree(fmt, [], { reservedMax: 10 }).callsign, 'AURORA 011AU');
T('skips numbers already held', C.nextFree(fmt, [{ callsign: 'AURORA 011AU' }, { callsign: 'AURORA 12AU' }], { reservedMax: 10 }).callsign, 'AURORA 013AU');
T('another airline’s 011 does not block ours', C.nextFree(fmt, [{ callsign: 'BOREALIS 011BR' }], { reservedMax: 10 }).callsign, 'AURORA 011AU');
T('no reserved range starts at 1', C.nextFree(fmt, [], { reservedMax: 0 }).callsign, 'AURORA 001AU');
T('no callsign shape, no suggestion', C.nextFree(null, []), null);

console.log('\n the invitation');
const words = { vaName: 'Aurora', name: 'Sky', username: 'sky', link: 'https://x/reset' };
const withNote = R.buildSetupMessage({ ...words, note: 'Read the SOP in Documents before your first flight.' });
T('the welcome note is in it', withNote.includes('Read the SOP in Documents before your first flight.'), true);
T('…straight after the greeting', withNote.split('\n').slice(0, 3).join('|'), 'Sky — your Aurora crew center login is ready.||Read the SOP in Documents before your first flight.');
T('…and in the IFC version too', R.buildSetupMessage({ ...words, note: 'Hello!', format: 'ifc', footerUrl: 'https://x/f.png' }).includes('Hello!'), true);
T('no note, no blank paragraph for it', R.buildSetupMessage(words).split('\n')[1], '');
T('a new recruit is not told their hours were carried over', /carried over/.test(R.buildSetupMessage({ ...words, carried: false })), false);
T('a pilot moved across still is', /carried over/.test(R.buildSetupMessage({ ...words, carried: true })), true);
T('the temporary-password version follows the same rule', /carried over/.test(R.buildSetupMessage({ name: 'Sky', username: 'sky', password: 'p', carried: false })), false);

console.log(failures ? `\n${failures} failed\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
