// test-crew-roles-and-tests.js
// The three permissions split out in v26 (training, tests, shop), the role
// presets that use them, and the staff view of what somebody answered on a
// quiz or entrance test.
//
// WHAT THIS FILE IS DEFENDING
//
//   * nobody loses a power they had: a role with roster.manage can still run
//     check-rides, one with settings.branding can still run the shop
//   * the new jobs can be handed out on their own: an Examiner can mark tests
//     and do nothing else at all
//   * every preset names only permissions that exist, and none quietly carries
//     an owner-grade power except the ones that say so
//   * staff can read a finished paper question by question — including one
//     sat by somebody with no account — and a question deleted since is still
//     counted rather than vanishing from under the score
//
// Run:  node scripts/test-crew-roles-and-tests.js
process.env.JWT_SECRET = 'test-secret-for-crew-roles';
const assert = require('assert');
const crewAuth = require('../crewAuth');
const crewQuizzes = require('../crewQuizzes');

const { effectiveCaps, CREW_CAP_IDS, CREW_ROLE_PRESETS } = crewAuth;

let passed = 0;
let failed = 0;
function ok(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const staff = (uname) => ({ kind: 'va', role: 'staff', uname });
const vaWith = (permissions) => ({
    staffRoles: [{ id: 'r', name: 'R', permissions }],
    staffAssignments: [{ username: 'jo', roleId: 'r' }],
});
const caps = (permissions) => effectiveCaps(vaWith(permissions), staff('jo'));

console.log('\nThe new permissions');

ok('they exist', () => {
    for (const c of ['training.manage', 'tests.manage', 'shop.manage']) assert.ok(CREW_CAP_IDS.includes(c), c);
});

ok('a role that could run the roster can still run check-rides', () => {
    assert.ok(caps(['roster.manage']).includes('training.manage'));
});

ok('a role that could change the appearance can still run the shop', () => {
    assert.ok(caps(['settings.branding']).includes('shop.manage'));
});

ok('training can be handed out without the roster', () => {
    const c = caps(['training.manage']);
    assert.ok(c.includes('training.manage'));
    assert.ok(!c.includes('roster.manage'));
});

ok('the shop can be handed out without the airline’s colours', () => {
    const c = caps(['shop.manage']);
    assert.ok(c.includes('shop.manage'));
    assert.ok(!c.includes('settings.branding'));
});

ok('staff with no role assigned get the new day-to-day permissions', () => {
    const c = effectiveCaps({ staffRoles: [], staffAssignments: [] }, staff('nobody'));
    for (const x of ['training.manage', 'tests.manage', 'shop.manage']) assert.ok(c.includes(x), x);
    // …and still none of the owner-grade ones.
    for (const x of ['integrations.manage', 'team.manage', 'retention.manage', 'site.manage']) assert.ok(!c.includes(x), x);
});

ok('a pilot gets none of them', () => {
    assert.deepStrictEqual(effectiveCaps(vaWith(['tests.manage']), { kind: 'crew', role: 'pilot' }), []);
});

console.log('\nRole presets');

ok('every preset names only permissions that exist', () => {
    for (const p of CREW_ROLE_PRESETS) {
        for (const c of p.permissions) assert.ok(CREW_CAP_IDS.includes(c), `${p.id}: ${c}`);
    }
});

ok('preset ids are unique', () => {
    const ids = CREW_ROLE_PRESETS.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});

ok('the new jobs are there', () => {
    const ids = CREW_ROLE_PRESETS.map((p) => p.id);
    for (const id of ['training-captain', 'examiner', 'community-manager', 'shop-manager', 'web-editor']) assert.ok(ids.includes(id), id);
});

ok('an Examiner can mark tests and nothing else', () => {
    const ex = CREW_ROLE_PRESETS.find((p) => p.id === 'examiner');
    assert.deepStrictEqual(ex.permissions, ['tests.manage']);
    assert.deepStrictEqual(caps(ex.permissions), ['tests.manage']);
});

ok('a Recruiter can send entrance tests', () => {
    assert.ok(CREW_ROLE_PRESETS.find((p) => p.id === 'recruiter').permissions.includes('tests.manage'));
});

ok('no preset has every permission ticked', () => {
    for (const p of CREW_ROLE_PRESETS) assert.ok(p.permissions.length < CREW_CAP_IDS.length, p.id);
});

console.log('\nWhat somebody answered');

const QUIZ = {
    id: 'qz', title: 'Entrance test', passMark: 50,
    questions: [
        { id: 'a', text: 'What does QNH set?', options: ['Altitude', 'Height', 'Flight level'], correct: 0 },
        { id: 'b', text: 'Squawk for radio failure?', options: ['7500', '7600', '7700'], correct: 1 },
    ],
};

ok('each question comes back with what was picked and what was right', () => {
    const graded = crewQuizzes.grade(QUIZ, [0, 2]);
    const attempt = { answers: graded.marks.map((m) => ({ id: m.id, chosen: m.chosen, right: m.right })) };
    const out = crewQuizzes.answerReview(QUIZ, attempt);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(
        out.map((r) => [r.question, r.chosenText, r.correctText, r.right]),
        [['What does QNH set?', 'Altitude', 'Altitude', true], ['Squawk for radio failure?', '7700', '7600', false]],
    );
    assert.deepStrictEqual(out[1].options, ['7500', '7600', '7700']);
});

ok('an unanswered question reads as unanswered, not as the first option', () => {
    const out = crewQuizzes.answerReview(QUIZ, { answers: [{ id: 'a', chosen: -1, right: false }] });
    assert.strictEqual(out[0].chosen, -1);
    assert.strictEqual(out[0].chosenText, '');
});

ok('a question deleted since is still listed, with the mark it got', () => {
    const out = crewQuizzes.answerReview(QUIZ, { answers: [{ id: 'gone', chosen: 1, right: true }, { id: 'a', chosen: 0, right: true }] });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].gone, true);
    assert.strictEqual(out[0].right, true);
    assert.strictEqual(out[1].gone, false);
});

ok('a whole quiz deleted since still lists the marks', () => {
    const out = crewQuizzes.answerReview(null, { answers: [{ id: 'a', chosen: 0, right: true }] });
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].gone);
});

ok('nothing sat yet is an empty list, not an error', () => {
    assert.deepStrictEqual(crewQuizzes.answerReview(QUIZ, { answers: [] }), []);
    assert.deepStrictEqual(crewQuizzes.answerReview(QUIZ, {}), []);
});

ok('the taker’s own view still never carries the marks', () => {
    const graded = crewQuizzes.grade(QUIZ, [0, 2]);
    const mine = crewQuizzes.myAttemptView({ _id: 'x', answers: graded.marks, status: 'failed' });
    assert.ok(!JSON.stringify(mine).includes('7600'), 'the right answer leaked to the taker');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
