// test-crew-quizzes.js
// Quizzes, the marking, and the door a VA can put in front of its crew centre —
// the decision module directly, because that is where every rule worth keeping
// actually lives.
//
// WHAT THIS FILE IS DEFENDING
//
// Three things, and they are the three that would be quietly catastrophic:
//
//   * THE ANSWER KEY NEVER LEAVES THE SERVER. A quiz dressed for a taker has no
//     `correct` on it anywhere, and a client cannot mark its own paper.
//   * THE DOOR FAILS OPEN. Pointed at a deleted quiz, an empty one, or asked
//     about a staff member, the gate is not locked. A crew centre shut because
//     a quiz was deleted is an outage nobody asked for.
//   * A QUESTION NOBODY CAN GET RIGHT IS NOT A QUESTION. One option, or a right
//     answer that is not among the options, and it is dropped rather than
//     failing every pilot on the airline's typo.
//
// Run:  node scripts/test-crew-quizzes.js

const assert = require('assert');
const Q = require('../crewQuizzes');

let passed = 0;
function ok(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const QUIZ = {
    id: 'sop', title: 'SOP induction', passMark: 60, maxAttempts: 2,
    questions: [
        { text: 'Cruise altitude is given in?', options: ['Feet', 'Metres', 'Miles'], correct: 0 },
        { text: 'Who files the PIREP?', options: ['The pilot', 'Nobody'], correct: 0 },
        { text: 'Callsign prefix?', options: ['BAW', 'AAL'], correct: 0 },
    ],
};

console.log('\nBuilding a quiz — what the airline may ask');

ok('a question with one option is dropped', () => {
    const [q] = Q.sanitizeQuizzes([{ title: 'x', questions: [
        { text: 'fine', options: ['a', 'b'], correct: 1 },
        { text: 'broken', options: ['only'], correct: 0 },
    ] }]);
    assert.strictEqual(q.questions.length, 1);
    assert.strictEqual(q.questions[0].text, 'fine');
});

ok('a right answer that is not one of the options is dropped', () => {
    const [q] = Q.sanitizeQuizzes([{ title: 'x', questions: [
        { text: 'pointing at nothing', options: ['a', 'b'], correct: 7 },
    ] }]);
    assert.strictEqual(q.questions.length, 0);
});

ok('ids survive a save, so results keep pointing at their quiz', () => {
    const [q] = Q.sanitizeQuizzes([{ id: 'sop', title: 'Renamed entirely', questions: [] }]);
    assert.strictEqual(q.id, 'sop');
});

ok('two quizzes called the same thing get different ids', () => {
    const out = Q.sanitizeQuizzes([{ title: 'Induction' }, { title: 'Induction' }]);
    assert.notStrictEqual(out[0].id, out[1].id);
});

ok('a pass mark of zero is not allowed to pass a blank paper', () => {
    const [q] = Q.sanitizeQuizzes([{ title: 'x', passMark: 0 }]);
    assert.ok(q.passMark >= 1, `pass mark was ${q.passMark}`);
});

ok('a banner has to be a real link', () => {
    const [q] = Q.sanitizeQuizzes([{ title: 'x', banner: 'javascript:alert(1)' }]);
    assert.strictEqual(q.banner, '');
    const [q2] = Q.sanitizeQuizzes([{ title: 'x', banner: 'https://cdn.example/b.png' }]);
    assert.strictEqual(q2.banner, 'https://cdn.example/b.png');
});

console.log('\nWhat a taker is handed');

ok('the answer key is not in it', () => {
    const [q] = Q.sanitizeQuizzes([QUIZ]);
    const shown = Q.publicQuiz(q);
    assert.ok(!JSON.stringify(shown).includes('correct'), JSON.stringify(shown));
});

ok('the builder does get it back, or it could not be edited', () => {
    const [q] = Q.sanitizeQuizzes([QUIZ]);
    const shown = Q.publicQuiz(q, { withAnswers: true });
    assert.strictEqual(shown.questions[0].correct, 0);
});

console.log('\nMarking');

ok('a full paper passes', () => {
    const [q] = Q.sanitizeQuizzes([QUIZ]);
    const r = Q.grade(q, [0, 0, 0]);
    assert.strictEqual(r.score, 3);
    assert.strictEqual(r.percent, 100);
    assert.ok(r.passed);
});

ok('an unanswered question is wrong, not skipped', () => {
    const [q] = Q.sanitizeQuizzes([QUIZ]);
    const r = Q.grade(q, [0]);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.score, 1);
    assert.strictEqual(r.percent, 33);
});

ok('the pass mark is a floor, not a rounding', () => {
    const [q] = Q.sanitizeQuizzes([{ ...QUIZ, passMark: 67 }]);
    const r = Q.grade(q, [0, 0, 1]);   // 2/3 = 66%
    assert.strictEqual(r.percent, 66);
    assert.ok(!r.passed);
});

ok('a quiz with no questions cannot be passed by handing in nothing', () => {
    const [q] = Q.sanitizeQuizzes([{ title: 'empty' }]);
    const r = Q.grade(q, []);
    assert.ok(!r.passed);
});

console.log('\nThe door');

const READY = Q.sanitizeQuizzes([QUIZ]);

ok('a gate pointing at a quiz that was deleted turns itself off', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'gone' }, READY);
    assert.strictEqual(g.enabled, false);
    assert.strictEqual(Q.gateState({ gate: g, quizzes: READY, attempts: [] }).locked, false);
});

ok('a gate pointing at a quiz with no questions turns itself off', () => {
    const empty = Q.sanitizeQuizzes([{ id: 'sop', title: 'SOP' }]);
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, empty);
    assert.strictEqual(g.enabled, false);
});

ok('a pilot who has been sent nothing is held, and told to wait', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [] });
    assert.ok(st.locked);
    assert.strictEqual(st.status, 'none');
    assert.strictEqual(st.canStart, false);
});

ok('with self-start on, they can begin it themselves', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop', allowSelfStart: true }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [] });
    assert.ok(st.locked);
    assert.ok(st.canStart);
});

ok('a pilot holding a live link can open it', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [
        { quizId: 'sop', status: 'issued', token: 'abc', maxAttempts: 2, attemptsUsed: 0, createdAt: '2026-01-01' },
    ] });
    assert.ok(st.locked);
    assert.strictEqual(st.token, 'abc');
    assert.ok(st.canStart);
});

ok('a pilot who passed is through it for good', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [
        { quizId: 'sop', status: 'passed', createdAt: '2026-01-01' },
    ] });
    assert.strictEqual(st.locked, false);
});

ok('a pilot out of attempts is held, and cannot start another', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [
        { quizId: 'sop', status: 'failed', maxAttempts: 2, attemptsUsed: 2, createdAt: '2026-01-01' },
    ] });
    assert.ok(st.locked);
    assert.strictEqual(st.canStart, false);
    assert.strictEqual(st.attemptsLeft, 0);
});

ok('a pass at a DIFFERENT quiz does not open this door', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [
        { quizId: 'something-else', status: 'passed', createdAt: '2026-01-01' },
    ] });
    assert.ok(st.locked);
});

ok('staff are never held at it', () => {
    const g = Q.sanitizeGate({ enabled: true, quizId: 'sop' }, READY);
    const st = Q.gateState({ gate: g, quizzes: READY, attempts: [], isStaff: true });
    assert.strictEqual(st.locked, false);
});

ok('no gate at all is not a locked crew centre', () => {
    assert.strictEqual(Q.gateState({}).locked, false);
    assert.strictEqual(Q.gateState({ gate: { enabled: false }, quizzes: READY, attempts: [] }).locked, false);
});

console.log('\nSitting one');

ok('a withdrawn link says so rather than opening', () => {
    assert.match(Q.takeFailure(READY[0], { status: 'revoked' }), /withdrawn/i);
});

ok('a link with no attempt behind it is refused', () => {
    assert.match(Q.takeFailure(READY[0], null), /not valid/i);
});

ok('unlimited attempts really are unlimited', () => {
    assert.strictEqual(Q.takeFailure(READY[0], { status: 'failed', maxAttempts: 0, attemptsUsed: 99 }), '');
});

ok('a pilot never sees which ones they got wrong', () => {
    const v = Q.myAttemptView({ _id: '1', quizId: 'sop', status: 'failed', token: 't', score: 1, total: 3 });
    assert.ok(!('marks' in v));
    assert.ok(!('answers' in v));
    assert.strictEqual(v.token, 't');
});

ok('staff never see somebody else’s token in the queue view', () => {
    const v = Q.attemptView({ _id: '1', quizId: 'sop', status: 'issued', token: 'secret' });
    assert.ok(!JSON.stringify(v).includes('secret'), JSON.stringify(v));
});

console.log('\nReminding staff');

ok('reminders are off until somebody asks for them', () => {
    assert.strictEqual(Q.sanitizeReminders({}).enabled, false);
});

ok('a digest cannot be asked for more often than hourly', () => {
    assert.strictEqual(Q.sanitizeReminders({ enabled: true, everyHours: 0 }).everyHours, 1);
    assert.strictEqual(Q.sanitizeReminders({ enabled: true, everyHours: 99999 }).everyHours, 168);
});

ok('a link is a secret worth guessing at', () => {
    const a = Q.attemptToken(); const b = Q.attemptToken();
    assert.strictEqual(a.length, 32);
    assert.notStrictEqual(a, b);
});

console.log(`\n${passed} checks passed.\n`);
