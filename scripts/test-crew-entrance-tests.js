// test-crew-entrance-tests.js
// Entrance tests and the join form, driven through the REAL server.js — its
// routes, its auth, its marking — with only Mongo and the VA's own database
// replaced by memory.
//
// WHAT THIS FILE IS DEFENDING
//
//   * Signing up never puts a login on the screen. A free-join VA puts the
//     pilot on the roster and stops there: no password in the reply, none
//     minted, none emailed. Staff hand sign-ins out.
//   * An entrance test is sat WITHOUT a login — the link is the key — and the
//     paper the taker is handed has no answer key in it.
//   * Only an entrance test opens that way. A pilot's own quiz link is refused
//     on the public route, whoever holds it.
//   * A failed test says when the next go is, hands over the study material,
//     and refuses a retake before then. A pass is recorded for staff, who send
//     the invitation themselves.
//   * Staff see the result on the application card, and the applicant sees
//     their link on their own status page.
//
// Run:  node scripts/test-crew-entrance-tests.js
'use strict';

process.env.JWT_SECRET = 'test-secret-entrance';
process.env.PORT = String(41000 + Math.floor(Math.random() * 2000));
delete process.env.MONGODB_URI;
delete process.env.MONGO_URI;

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

/* ---------------------------------------------------------------- the VA */
const QUIZ = {
    id: 'entrance', title: 'Entrance Test', blurb: 'We are thrilled to have you join our flight deck.',
    banner: '', passMark: 80, maxAttempts: 0, open: false, active: true,
    retakeHours: 24, study: 'Read the SOP before your next go: https://example.com/sop',
    questions: [
        { id: 'q1', text: 'Who files the PIREP?', options: ['The pilot', 'Nobody'], correct: 0 },
        { id: 'q2', text: 'Cruise altitude is given in?', options: ['Metres', 'Feet'], correct: 1 },
    ],
};
const VA = {
    _id: 'va1', slug: 'am', name: 'Aeroméxico Virtual', callsign: 'AEROMEXICO ###AM', status: 'approved',
    joinMode: 'free', minGrade: 0, crewQuizzes: [QUIZ], crewQuizGate: {}, crewBanners: {},
    supabaseUrl: 'https://x.supabase.co', supabaseServiceKey: 'k', bannerUrl: 'https://cdn.example/am.webp',
};

// Every Mongo read of the listing answers with the VA above; everything else
// answers "nothing". A query is a chain that resolves at the end, like mongoose's.
const query = (v) => {
    const q = {
        select: () => q, lean: () => Promise.resolve(v), sort: () => q, limit: () => q,
        then: (a, b) => Promise.resolve(v).then(a, b), catch: (b) => Promise.resolve(v).catch(b),
        exec: () => Promise.resolve(v),
    };
    return q;
};
const isVa = (m) => m && m.modelName === 'VirtualAirlineAd';
mongoose.Model.findOne = function () { return query(isVa(this) ? { ...VA } : null); };
mongoose.Model.findById = function () { return query(isVa(this) ? { ...VA } : null); };
mongoose.Model.find = function () { return query([]); };
mongoose.Model.countDocuments = function () { return query(0); };
mongoose.Model.exists = function () { return query(null); };
mongoose.Model.updateOne = function () { return query({}); };
mongoose.Model.findOneAndUpdate = function () { return query(null); };
mongoose.Model.findByIdAndUpdate = function () { return query(null); };
mongoose.Model.create = async function (d) { return d; };
mongoose.connect = async () => {};

/* ---------------------------------------------------- the VA's own database */
let SEQ = 0;
const DB = { applications: [], attempts: [], members: [], accounts: [] };
const id = () => `00000000-0000-4000-8000-${String(++SEQ).padStart(12, '0')}`;
const store = {
    drift: () => [],
    health: async () => ({ ok: true, provisioned: true, version: 25 }),
    createApplication: async (d) => { const a = { _id: id(), createdAt: new Date(), ...d }; DB.applications.push(a); return a; },
    getApplication: async (i) => DB.applications.find((a) => a._id === i) || null,
    getApplicationByToken: async (t) => DB.applications.find((a) => a.statusToken === t) || null,
    listApplications: async ({ status } = {}) => DB.applications.filter((a) => !status || a.status === status),
    updateApplication: async (i, p) => { const a = DB.applications.find((x) => x._id === i); Object.assign(a, p); return a; },
    createMember: async (d) => { const m = { _id: id(), ...d }; DB.members.push(m); return m; },
    listMembers: async () => DB.members.slice(),
    getMember: async (i) => DB.members.find((m) => m._id === i) || null,
    createAccount: async (d) => { const a = { _id: id(), ...d }; DB.accounts.push(a); return a; },
    listAccounts: async () => DB.accounts.slice(),
    createQuizAttempt: async (d) => { const a = { _id: id(), attemptsUsed: 0, score: 0, total: 0, answers: [], createdAt: new Date(), ...d }; DB.attempts.unshift(a); return a; },
    getQuizAttempt: async (i) => DB.attempts.find((a) => a._id === i) || null,
    getQuizAttemptByToken: async (t) => DB.attempts.find((a) => a.token === t) || null,
    updateQuizAttempt: async (i, p) => { const a = DB.attempts.find((x) => x._id === i); Object.assign(a, p); return a; },
    listQuizAttempts: async ({ memberId = '', quizId = '', candidates = false, applicationId = '', status = '' } = {}) => DB.attempts.filter((a) => (
        (!memberId || a.memberId === memberId) && (!candidates || memberId || !a.memberId)
        && (!quizId || a.quizId === quizId) && (!applicationId || a.applicationId === applicationId)
        && (!status || a.status === status))),
};
const crewStore = require('../crewStore');
crewStore.forVa = async () => store;
crewStore.forVaOrNull = async () => store;

// Nothing leaves the building. The Infinite Flight lookup the join form runs
// answers "yes, that account exists" for anybody.
const axios = require('axios');
axios.post = async (url, body) => (/\/users$/.test(String(url))
    ? { status: 200, data: { users: [{ userId: `if-${(body.discourseNames || [''])[0]}`, discourseUsername: (body.discourseNames || [''])[0], grade: 3 }] } }
    : { status: 204, data: {} });
axios.get = async () => ({ status: 200, data: { stats: { flightTime: 6000, violations: 0 } } });

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw).slice(0, 400)})`));
};

require('../server.js');

const base = `http://127.0.0.1:${process.env.PORT}`;
const owner = jwt.sign({ typ: 'crew', sub: 'aaaaaaaaaaaaaaaaaaaaaaa1', kind: 'va', role: 'owner', view: 'owner', slug: 'am', vaId: 'va1', name: 'Founder' },
    process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
};

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/crew/am/invite-banner.png?kind=footer'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
}

(async () => {
    await waitForServer();

    /* ---- signing up shows no login -------------------------------------- */
    {
        const r = await call('POST', '/api/crew/am/apply', {
            ifcName: 'Jordan_Lee', callsignPrefix: 'AEROMEXICO', callsignNumber: '412', grade: 3, answers: [],
        });
        check('a free-join sign-up is accepted', r.status === 200 && r.body.status === 'accepted', r);
        check('…with no login anywhere in the reply', r.body && r.body.account === null && !JSON.stringify(r.body).includes('password'), r.body);
        check('…and none is made behind the scenes', DB.accounts.length === 0, DB.accounts);
        check('…but they are on the roster, with their callsign', DB.members.some((m) => m.name === 'Jordan_Lee' && /412/.test(m.callsign)), DB.members);
        check('…and they are told staff send the sign-in', r.body.signInFromStaff === true);
        const st = await call('GET', `/api/crew/am/application-status/${r.body.statusToken}`);
        check('their status page has no credentials either', st.status === 200 && st.body.credentials === null, st.body);
    }

    VA.joinMode = 'application';
    const applied = await call('POST', '/api/crew/am/apply', {
        ifcName: 'Rae_Okafor', callsignPrefix: 'AEROMEXICO', callsignNumber: '413', grade: 3, answers: [],
    });
    const appId = applied.body.applicationId;
    check('an application is pending', applied.body.status === 'pending', applied.body);

    /* ---- sending a test --------------------------------------------------- */
    const anon = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', applicationId: appId });
    check('only staff send tests', anon.status === 401, anon);
    const sent = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', applicationId: appId }, owner);
    const t = sent.body && sent.body.test;
    check('staff send an applicant a test', sent.status === 201 && t && /\/crew\/am\/test\?t=[a-f0-9]{32}$/.test(t.link), sent);
    check('…with a message to paste, framed for the IFC', t && t.message.startsWith('![Aeroméxico Virtual](https://cdn.example/am.webp)') && /\|600x100\]/.test(t.message), t && t.message);
    check('…that states the pass mark and the retake wait', t && /80% or higher/.test(t.plainMessage) && /1 day \(24 hours\)/.test(t.plainMessage), t && t.plainMessage);
    check('…and is tied to the application', !!DB.attempts[0] && DB.attempts[0].applicationId === appId && DB.attempts[0].memberId === null, DB.attempts[0]);
    if (!t) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }   // nothing below can run without it
    const again = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', applicationId: appId }, owner);
    check('a second link while the first is live is refused, with the first one back', again.status === 409 && again.body.test && again.body.test.link === t.link, again);
    const token = t.link.split('t=')[1];

    /* ---- sitting it, with no login --------------------------------------- */
    const paper = await call('GET', `/api/crew/am/test/${token}`);
    check('the test opens with no login', paper.status === 200 && paper.body.quiz && paper.body.quiz.questions.length === 2, paper);
    check('…and the paper has no answer key in it', !JSON.stringify(paper.body).includes('"correct"'), paper.body);
    check('…nor the study material, before they have tried', paper.body.study === '');
    check('…and says whose test it is', paper.body.attempt.name === 'Rae_Okafor');

    const wrong = await call('POST', `/api/crew/am/test/${token}`, { answers: [1, 0] });
    check('a failing paper is marked', wrong.status === 200 && wrong.body.passed === false && wrong.body.percent === 0, wrong.body);
    check('…hands over the study material', /SOP/.test(wrong.body.study || ''), wrong.body);
    check('…and says when the next go is', !!wrong.body.retryAt && /in 2[34] hours/.test(wrong.body.refusal), wrong.body);
    const tooSoon = await call('POST', `/api/crew/am/test/${token}`, { answers: [0, 1] });
    check('a retake before the wait is up is refused', tooSoon.status === 409, tooSoon);

    const list = await call('GET', '/api/crew/am/applications?status=pending', null, owner);
    const card = list.body && (list.body.applications || []).find((a) => String(a._id) === String(appId));
    check('staff see the result on the application', card && card.test && card.test.status === 'failed' && card.test.percent === 0, card);
    const mine = await call('GET', `/api/crew/am/application-status/${applied.body.statusToken}`);
    check('the applicant sees their test on their status page', mine.body.test && mine.body.test.status === 'failed' && !!mine.body.test.link, mine.body.test);

    // The wait passes.
    DB.attempts[0].submittedAt = new Date(Date.now() - 25 * 3600 * 1000);
    const right = await call('POST', `/api/crew/am/test/${token}`, { answers: [0, 1] });
    check('after the wait, a passing paper passes', right.status === 200 && right.body.passed === true && right.body.percent === 100, right.body);
    check('…and keeps the study material to itself', right.body.study === '');
    const done = await call('POST', `/api/crew/am/test/${token}`, { answers: [0, 1] });
    check('a passed test cannot be sat again', done.status === 409, done);
    const after = await call('GET', '/api/crew/am/applications?status=pending', null, owner);
    const card2 = (after.body.applications || []).find((a) => String(a._id) === String(appId));
    check('the card now says they passed — the invite is staff’s to send', card2.test.status === 'passed' && card2.status === 'pending', card2);

    /* ---- somebody who never applied ------------------------------------- */
    const loose = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', name: 'Sam', ifcName: '@sam_flies' }, owner);
    check('a test can go to somebody who never applied', loose.status === 201 && loose.body.test.ifcName === 'sam_flies', loose);
    const all = await call('GET', '/api/crew/am/entrance-tests', null, owner);
    check('staff list every test', all.status === 200 && all.body.tests.length === 2 && all.body.quizzes.length === 1, all.body);

    /* ---- a test handed out by hand shows up under Applications ------------ */
    // No email, so the link went over the IFC: no application behind it. A
    // pass from them is somebody waiting to be let in all the same.
    const samToken = loose.body.test.link.split('t=')[1];
    await call('POST', `/api/crew/am/test/${samToken}`, { answers: [0, 1] });
    const withSam = await call('GET', '/api/crew/am/applications?status=pending', null, owner);
    const samWaiting = (withSam.body.waitingTests || []).find((x) => x.ifcName === 'sam_flies');
    check('a hand-sent pass is listed with the applications', !!samWaiting && samWaiting.status === 'passed' && samWaiting.onRoster === false, withSam.body.waitingTests);
    check('…but an applicant’s pass is not listed twice', !(withSam.body.waitingTests || []).some((x) => x.ifcName === 'Rae_Okafor'), withSam.body.waitingTests);
    DB.members.push({ _id: id(), name: 'Sam', ifcName: 'sam_flies' });
    const samAdded = await call('GET', '/api/crew/am/applications?status=pending', null, owner);
    check('…and leaves once they are on the roster', !(samAdded.body.waitingTests || []).some((x) => x.ifcName === 'sam_flies'), samAdded.body.waitingTests);
    const panel = await call('GET', '/api/crew/am/entrance-tests', null, owner);
    check('the panel knows they are on the roster too', (panel.body.tests || []).some((x) => x.ifcName === 'sam_flies' && x.onRoster === true), panel.body.tests);

    // Sent by hand to somebody who HAS applied: it is their application's test.
    const kai = await call('POST', '/api/crew/am/apply', {
        ifcName: 'Kai_Ross', callsignPrefix: 'AEROMEXICO', callsignNumber: '414', grade: 3, answers: [],
    });
    const byHand = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', name: 'Kai', ifcName: 'kai_ross' }, owner);
    check('a test typed in for an applicant is tied to their application', byHand.status === 201
        && DB.attempts[0].applicationId === kai.body.applicationId, DB.attempts[0]);
    // …and one sent that way before this existed is found by IFC username.
    DB.attempts[0].applicationId = null;
    const kaiCards = await call('GET', '/api/crew/am/applications?status=pending', null, owner);
    const kaiCard = (kaiCards.body.applications || []).find((a) => String(a._id) === String(kai.body.applicationId));
    check('…and an older one is matched to the card by IFC username', kaiCard && kaiCard.test && /^kai_ross$/i.test(kaiCard.test.ifcName), kaiCard && kaiCard.test);

    /* ---- a pilot's own quiz is not opened by the public route ------------- */
    DB.attempts.unshift({ _id: id(), quizId: 'entrance', token: 'b'.repeat(32), memberId: 'm-pilot', status: 'issued', attemptsUsed: 0, maxAttempts: 0, passMark: 80 });
    const pilotPaper = await call('GET', `/api/crew/am/test/${'b'.repeat(32)}`);
    check('a pilot’s quiz link is refused on the public route', pilotPaper.status === 404, pilotPaper);
    const junk = await call('GET', '/api/crew/am/test/not-a-token');
    check('a malformed link is refused', junk.status === 404);

    console.log(`${pass} passed, ${fails.length} failed`);
    if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
