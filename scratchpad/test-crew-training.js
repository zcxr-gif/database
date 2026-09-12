'use strict';
// Conformance test for check-rides — the v14 training queue, and the rank-ladder
// bug that had kept the whole feature inert since v7.
//
// THE BUG THIS EXISTS FOR. crewAuth.sanitizeRanks has produced `requiresCheck`
// and `checkNote` on every rung since v7, and crewRanks has read them ever
// since. In between sat the mongoose schema for VirtualAirlineAd.ranks, which
// declared name/minHours/color/icon/image and nothing else — and mongoose drops
// undeclared paths inside a subdocument array on save. So a VA who ticked
// "requires a check-ride" saved a ladder that came back without one, every rung
// resolved as ungated, awaitingCheck() never fired for anybody, and the sign-off
// column filled up with nothing. Nobody saw an error; the feature simply did not
// happen. The first two sections below are that path, asserted end to end.
//
// Then the ladder as the training panel reads it: a rung's requirements survive
// the round trip, `checkride` arrives as an explicit boolean (the panel's
// checkbox reads `!== false`, so an absent field would draw every rung as
// needing one), and minFlights rides along beside minHours.
//
// Pure module test — no network, no database, no server.

const path = require('path');
const mongoose = require('mongoose');
const ranksLib = require(path.join('..', 'crewRanks.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

// The ranks subdocument exactly as server.js declares it. Kept in step by hand:
// if that declaration loses a field again, this file is what says so.
const AdSchema = new mongoose.Schema({
    ranks: {
        type: [{
            _id: false, name: String, minHours: Number, color: String, icon: String, image: String,
            requiresCheck: Boolean, checkNote: String, minFlights: Number,
        }],
        default: [],
    },
});
const Ad = mongoose.model('TrainingTestAd', AdSchema);

// What a VA's settings screen hands the backend, after sanitizeRanks.
const LADDER = [
    { name: 'Cadet', minHours: 0, requiresCheck: false, checkNote: '', minFlights: 0 },
    { name: 'First Officer', minHours: 25, requiresCheck: false, checkNote: '', minFlights: 10 },
    { name: 'Captain', minHours: 100, requiresCheck: true, checkNote: 'one transatlantic sector', minFlights: 40 },
];
const saved = new Ad({ ranks: LADDER }).toObject().ranks;

console.log('\ncheck-rides — a rung’s requirements survive being saved');

T('a check-ride gate is still there after mongoose has had it',
    saved[2].requiresCheck, true);
T('  …and so is what the VA wrote about it',
    saved[2].checkNote, 'one transatlantic sector');
T('  …and the sectors it asks for',
    saved[2].minFlights, 40);
T('an ungated rung stays ungated', saved[0].requiresCheck, false);

console.log('\n…and the ladder then resolves against them');

const held = (hours, passed) => {
    const r = ranksLib.rankForHours(saved, hours, passed);
    return r ? r.name : null;
};

T('hours alone carry a pilot to the gate and no further',
    held(400, []), 'First Officer');
T('  …and the roster says what they are waiting for',
    (ranksLib.awaitingCheck(saved, 400, []) || {}).name, 'Captain');
T('  …in the VA’s own words',
    (ranksLib.awaitingCheck(saved, 400, []) || {}).checkNote, 'one transatlantic sector');
T('the sign-off is what opens it',
    held(400, ['Captain']), 'Captain');
T('  …and then nobody is waiting on anybody',
    ranksLib.awaitingCheck(saved, 400, ['Captain']), null);
T('signing off a pilot who has not got the hours promotes nobody',
    held(30, ['Captain']), 'First Officer');

// The regression itself, stated as a test rather than as a comment: the previous
// declaration is what the ladder used to pass through.
const Old = mongoose.model('TrainingTestOldAd', new mongoose.Schema({
    ranks: { type: [{ _id: false, name: String, minHours: Number, color: String, icon: String, image: String }], default: [] },
}));
const throughOldSchema = new Old({ ranks: LADDER }).toObject().ranks;
T('the pre-v14 declaration dropped the gate (this is the bug)',
    throughOldSchema[2].requiresCheck, undefined);
T('  …which is why every rung used to resolve as ungated',
    (ranksLib.rankForHours(throughOldSchema, 400, []) || {}).name, 'Captain');

console.log('\nminFlights rides beside minHours');

T('normalizeLadder carries it',
    ranksLib.normalizeLadder(saved).map((r) => r.minFlights), [0, 10, 40]);
T('a rung that never set one asks for none',
    ranksLib.normalizeLadder([{ name: 'Cadet', minHours: 0 }])[0].minFlights, 0);
T('junk is not a requirement',
    ranksLib.normalizeLadder([{ name: 'Cadet', minHours: 0, minFlights: -5 }])[0].minFlights, 0);

console.log('\nthe ladder as the training panel reads it');

// server.js's trainingLadder, which cannot be required without booting express.
// Mirrored here because its ONE job is emitting `checkride` as a real boolean.
const trainingLadder = (va) => ranksLib.normalizeLadder(va && va.ranks).map((r) => ({
    name: r.name, minHours: r.minHours, minFlights: r.minFlights || 0,
    checkride: !!r.requiresCheck, note: r.checkNote || '',
}));

const shown = trainingLadder({ ranks: saved });
T('an ungated rung is sent as an explicit false, never left off',
    Object.prototype.hasOwnProperty.call(shown[0], 'checkride') && shown[0].checkride, false);
T('a gated one is sent as true', shown[2].checkride, true);
T('the note comes with it', shown[2].note, 'one transatlantic sector');
T('a rung with nothing extra is still fully described',
    trainingLadder({ ranks: [{ name: 'Cadet', minHours: 0 }] })[0],
    { name: 'Cadet', minHours: 0, minFlights: 0, checkride: false, note: '' });

console.log(failures ? `\n${failures} check(s) failed ❌\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
