// test-crew-entrance-tests.js
// The recruiting road (crewRecruit.js), driven through the REAL server.js — its
// routes, its auth, its marking — with only Mongo and the VA's own database
// replaced by memory.
//
// WHAT THIS FILE IS DEFENDING
//
//   * ONE road: apply → [Discord ticket] → [entrance test] → accepted → the
//     pilot chooses their password. Every way in ends the same way.
//   * Accepting ALWAYS makes the login, and hands it over as a one-time link to
//     choose a password. No password exists anywhere — not in a reply, not on
//     the status page, not in the message staff paste.
//   * Open joining lets people straight in — on submit, or on passing the test
//     when one is required. Application mode waits for staff.
//   * A required entrance test goes out by itself the moment somebody applies,
//     is sat WITHOUT a login, and its paper has no answer key in it. A failed
//     test says when the next go is and hands over the study material.
//   * An airline that recruits in its Discord sends web applicants there with
//     an application code; the bot's ticket finds the application by it and
//     the test is sent there. One Discord account per application.
//   * Tests only ever go to applicants — nobody is tested who has not applied.
//   * Only an entrance test opens on the public route. A pilot's own quiz link
//     is refused, whoever holds it.
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
    crewEntranceQuizId: '', crewJoinViaDiscord: false, crewDiscordInvite: 'https://discord.gg/aeromexico',
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
    // v26: keeps setup links as invitations.
    health: async () => ({ ok: true, provisioned: true, version: 26, invites: true, quizzes: true }),
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
    getAccount: async (i) => DB.accounts.find((a) => a._id === i) || null,
    getAccountByUsername: async (u) => DB.accounts.find((a) => a.username === u) || null,
    getAccountByMember: async (m) => DB.accounts.find((a) => String(a.memberId) === String(m)) || null,
    getAccountByResetToken: async (h) => DB.accounts.find((a) => a.resetTokenHash === h) || null,
    updateAccount: async (i, p) => { const a = DB.accounts.find((x) => x._id === i); if (!a) return null; Object.assign(a, p); return a; },
    createQuizAttempt: async (d) => { const a = { _id: id(), attemptsUsed: 0, score: 0, total: 0, answers: [], createdAt: new Date(), ...d }; DB.attempts.unshift(a); return a; },
    getQuizAttempt: async (i) => DB.attempts.find((a) => a._id === i) || null,
    getQuizAttemptByToken: async (t) => DB.attempts.find((a) => a.token === t) || null,
    updateQuizAttempt: async (i, p) => { const a = DB.attempts.find((x) => x._id === i); Object.assign(a, p); return a; },
    listQuizAttempts: async ({ memberId = '', quizId = '', candidates = false, applicationId = '', status = '' } = {}) => DB.attempts.filter((a) => (
        (!memberId || a.memberId === memberId) && (!candidates || memberId || !a.memberId)
        && (!quizId || a.quizId === quizId) && (!applicationId || String(a.applicationId) === String(applicationId))
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

// What the Discord bot hears (vaBot.js), and the bot's own storage, faked:
// whether a server is linked, and which tickets hold which application.
const vaBot = require('../vaBot');
const hubSeen = [];
vaBot.hub.on('entranceTest', (p) => { hubSeen.push(p); });
let BOT_LINKED = false;
const TICKETS = [];
vaBot.models.VaBotGuild.findOne = () => query(BOT_LINKED ? { _id: 'g1' } : null);
vaBot.models.VaBotTicket.find = (f) => query(TICKETS.filter((t) => String(t.vaId) === String(f.vaId)
    && (!f.applicationId || !f.applicationId.$in || f.applicationId.$in.includes(String(t.applicationId)))));
vaBot.models.VaBotTicket.findOne = (f) => query(TICKETS.find((t) => String(t.applicationId) === String(f.applicationId)
    && (!f.userId || !f.userId.$ne || t.userId !== f.userId.$ne)) || null);

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
let NUM = 400;
const apply = (ifcName, extra = {}) => call('POST', '/api/crew/am/apply', {
    ifcName, callsignPrefix: 'AEROMEXICO', callsignNumber: String(++NUM), grade: 3, answers: [], ...extra,
});
const noPassword = (o) => !/"password":"[^"]+"|Temporary password/i.test(JSON.stringify(o || {}));
const cardOf = async (appId, status = 'pending') => {
    const r = await call('GET', `/api/crew/am/applications?status=${status}`, null, owner);
    return ((r.body && r.body.applications) || []).find((a) => String(a._id) === String(appId)) || null;
};

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/crew/am/invite-banner.png?kind=footer'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
}

(async () => {
    await waitForServer();

    /* ---- open joining, no test: straight in, with a link ---------------- */
    {
        const r = await apply('Jordan_Lee');
        check('open joining accepts on the spot', r.status === 200 && r.body.status === 'accepted' && r.body.stage === 'invited', r.body);
        check('…puts them on the roster with their callsign', DB.members.some((m) => m.name === 'Jordan_Lee' && /401/.test(m.callsign)), DB.members);
        const acct = DB.accounts.find((a) => a.displayName === 'Jordan_Lee');
        check('…ALWAYS makes their login', !!acct && acct.mustChangePassword === true, acct);
        check('…and hands it over as a link to choose a password', r.body.login && r.body.login.kind === 'link' && /reset=|token=|setup/i.test(r.body.login.link), r.body.login);
        check('…with no password anywhere in the reply', noPassword(r.body), r.body);
        check('…and says so as the next step', r.body.next && r.body.next.action && r.body.next.action.label === 'Choose my password', r.body.next);
        const st = await call('GET', `/api/crew/am/application-status/${r.body.statusToken}`);
        check('their status page has the same link', st.status === 200 && st.body.login && st.body.login.link === r.body.login.link && st.body.credentials === null, st.body);
    }

    /* ---- application mode, no test: staff accept ------------------------ */
    VA.joinMode = 'application';
    let ana;
    {
        const r = await apply('Ana_Ruiz');
        ana = r.body;
        check('an application waits for staff', r.body.status === 'pending' && r.body.stage === 'review', r.body);
        check('…with nothing to sign in with yet', r.body.login === null && !DB.accounts.some((a) => a.displayName === 'Ana_Ruiz'), r.body);
        const card = await cardOf(r.body.applicationId);
        check('the card says it is ready for review', card && card.stage === 'review', card);
        check('…with a message for the IFC that links their status page', card && /Track your application: http/.test(card.applicant.plainMessage), card && card.applicant);
        const ok = await call('PATCH', `/api/crew/am/applications/${r.body.applicationId}`, { action: 'accept', createAccount: false }, owner);
        check('accepting makes the login even when an old screen says not to', ok.status === 200 && DB.accounts.some((a) => a.displayName === 'Ana_Ruiz'), ok.body);
        const inv = ok.body.invite || {};
        check('…as a live link invitation', inv.state === 'live' && inv.kind === 'link' && !!inv.link, inv);
        check('…whose welcome carries the link and no password', /choose your password/.test(inv.plainMessage) && inv.plainMessage.includes(inv.link) && noPassword(ok.body), inv.plainMessage);
        check('…framed for the IFC', /^!\[Aeroméxico Virtual\]/.test(inv.message), inv.message);
        const st = await call('GET', `/api/crew/am/application-status/${r.body.statusToken}`);
        check('the applicant sees the link on their status page', st.body.stage === 'invited' && st.body.login && st.body.login.link === inv.link, st.body);

        const sent = await call('POST', `/api/crew/am/applications/${r.body.applicationId}/invite/sent`, { sent: true }, owner);
        check('copying it is recorded, with who', sent.status === 200 && !!sent.body.invite.sentAt && sent.body.invite.sentBy === 'Founder', sent.body);
        const fresh = await call('POST', `/api/crew/am/applications/${r.body.applicationId}/invite/regenerate`, null, owner);
        check('a new link replaces the old one', fresh.status === 200 && fresh.body.invite.link && fresh.body.invite.link !== inv.link && !fresh.body.invite.sentAt, fresh.body);
        const gone = await call('DELETE', `/api/crew/am/applications/${r.body.applicationId}/invite`, null, owner);
        check('throwing it away kills the link', gone.status === 200 && gone.body.invite.state !== 'live' && !gone.body.invite.link, gone.body);
        // They sign in: the invitation is spent, and cannot be reissued.
        const acct = DB.accounts.find((a) => a.displayName === 'Ana_Ruiz');
        acct.lastLoginAt = new Date();
        const joined = await cardOf(r.body.applicationId, 'accepted');
        check('once they sign in the card says joined', joined && joined.stage === 'joined' && joined.invite.state === 'claimed', joined);
        const again = await call('POST', `/api/crew/am/applications/${r.body.applicationId}/invite/regenerate`, null, owner);
        check('…and no new link is made over a used login', again.status === 409, again);
    }

    /* ---- a required test goes out by itself ------------------------------ */
    VA.crewEntranceQuizId = 'entrance';
    const applied = await apply('Rae_Okafor', { email: '' });
    const appId = applied.body.applicationId;
    check('with a required test, applying sends it', applied.body.status === 'pending' && applied.body.stage === 'test' && applied.body.test && /\/crew\/am\/test\?t=[a-f0-9]{32}$/.test(applied.body.test.link), applied.body);
    check('…tied to the application', !!DB.attempts[0] && String(DB.attempts[0].applicationId) === String(appId) && DB.attempts[0].memberId === null, DB.attempts[0]);
    const t = (await cardOf(appId)).test;
    check('the card carries it, with a message to paste', t && t.message.startsWith('![Aeroméxico Virtual](https://cdn.example/am.webp)') && /80% or higher/.test(t.plainMessage), t);
    if (!t) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }   // nothing below can run without it
    const again = await call('POST', '/api/crew/am/entrance-tests', { applicationId: appId }, owner);
    check('a second link while the first is live is refused, with the first one back', again.status === 409 && again.body.test && again.body.test.link === t.link, again);
    const anon = await call('POST', '/api/crew/am/entrance-tests', { applicationId: appId });
    check('only staff send tests', anon.status === 401, anon);
    const loose = await call('POST', '/api/crew/am/entrance-tests', { quizId: 'entrance', name: 'Sam', ifcName: '@sam_flies' }, owner);
    check('a test never goes to somebody who has not applied', loose.status === 400 && loose.body.code === 'needs_application', loose);
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
    const card = await cardOf(appId);
    check('staff see the result, still at the test step', card && card.test && card.test.status === 'failed' && card.stage === 'test', card);
    const mine = await call('GET', `/api/crew/am/application-status/${applied.body.statusToken}`);
    check('the applicant sees their test on their status page', mine.body.test && mine.body.test.status === 'failed' && !!mine.body.test.link && mine.body.stage === 'test', mine.body);

    // The wait passes.
    DB.attempts.find((a) => a.token === token).submittedAt = new Date(Date.now() - 25 * 3600 * 1000);
    const right = await call('POST', `/api/crew/am/test/${token}`, { answers: [0, 1] });
    check('after the wait, a passing paper passes', right.status === 200 && right.body.passed === true && right.body.percent === 100, right.body);
    check('…keeps the study material to itself', right.body.study === '');
    check('…and in application mode does not let them in by itself', right.body.accepted === false && right.body.login === null, right.body);
    const done = await call('POST', `/api/crew/am/test/${token}`, { answers: [0, 1] });
    check('a passed test cannot be sat again', done.status === 409, done);
    const card2 = await cardOf(appId);
    check('the card is ready for review — staff accept', card2.test.status === 'passed' && card2.status === 'pending' && card2.stage === 'review', card2);
    const heard = hubSeen.find((h) => String(h.applicationId) === String(appId) && h.passed);
    check('a marked test is told to the bot, with its application', !!heard && heard.percent === 100 && heard.accepted === false, hubSeen);

    /* ---- open joining with a test: a pass lets them in -------------------- */
    VA.joinMode = 'free';
    {
        const r = await apply('Lee_Park');
        check('open joining with a test waits for the test', r.body.status === 'pending' && r.body.stage === 'test' && !!r.body.test, r.body);
        const tk = r.body.test.link.split('t=')[1];
        const passed = await call('POST', `/api/crew/am/test/${tk}`, { answers: [0, 1] });
        check('…and the pass accepts them', passed.body.passed === true && passed.body.accepted === true, passed.body);
        check('…with the link to choose their password on the result', passed.body.login && passed.body.login.kind === 'link' && noPassword(passed.body), passed.body);
        check('…their login made and on the roster', DB.accounts.some((a) => a.displayName === 'Lee_Park') && DB.members.some((m) => m.name === 'Lee_Park'));
        await new Promise((ok) => setTimeout(ok, 50));   // the hub delivers on the next turn
        const h = hubSeen.find((x) => String(x.applicationId) === String(r.body.applicationId));
        check('…and the bot is told it was accepted', !!h && h.accepted === true, h);
    }
    VA.joinMode = 'application';

    /* ---- recruiting through Discord -------------------------------------- */
    VA.crewJoinViaDiscord = true;
    {
        const off = await apply('Mo_Tanaka');
        check('without a linked bot, nobody is sent to Discord', off.body.stage === 'test', off.body);
        BOT_LINKED = true;
        const r = await apply('Kai_Ross');
        check('with the bot linked, web applicants are sent to open a ticket', r.body.stage === 'discord' && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(r.body.code), r.body);
        check('…told where, with the code', r.body.next.action && r.body.next.action.url === VA.crewDiscordInvite && r.body.next.body.includes(r.body.code), r.body.next);
        check('…and the test waits for the ticket', !DB.attempts.some((a) => String(a.applicationId) === String(r.body.applicationId)));
        const kaiCard = await cardOf(r.body.applicationId);
        check('the IFC message carries the invite and the code', kaiCard && kaiCard.stage === 'discord' && kaiCard.applicant.plainMessage.includes(VA.crewDiscordInvite) && kaiCard.applicant.plainMessage.includes(r.body.code), kaiCard && kaiCard.applicant);

        const asBot = { asBot: true, slug: 'am', actor: 'Kai' };
        const bad = await vaBot.api('post', '/api/crew/am/discord-bot/ticket-application', { ...asBot, body: { code: 'FFFF-FFFF', discordId: '111111111111' } });
        check('a wrong code finds nothing', bad.status === 404, bad);
        const notBot = await call('POST', '/api/crew/am/discord-bot/ticket-application', { code: r.body.code });
        check('only the bot may look a code up', notBot.status === 401, notBot);
        const found = await vaBot.api('post', '/api/crew/am/discord-bot/ticket-application', { ...asBot, body: { code: r.body.code.toLowerCase(), discordId: '111111111111' } });
        check('the code finds their application', found.status === 200 && found.data.application.id === String(r.body.applicationId), found.data);
        check('…and sends the test into the ticket', found.data.test && /\/test\?t=/.test(found.data.test.link) && found.data.stage === 'test', found.data);
        TICKETS.push({ vaId: 'va1', applicationId: String(r.body.applicationId), userId: '111111111111' });
        const byLink = await vaBot.api('post', '/api/crew/am/discord-bot/ticket-application', { ...asBot, body: { code: `https://x/crew/am/status?id=${r.body.statusToken}`, discordId: '111111111111' } });
        check('their whole status link works as the code too, with the same test', byLink.status === 200 && byLink.data.test.link === found.data.test.link, byLink.data);
        const stolen = await vaBot.api('post', '/api/crew/am/discord-bot/ticket-application', { ...asBot, body: { code: r.body.code, discordId: '222222222222' } });
        check('another Discord account cannot take it', stolen.status === 409 && stolen.data.code === 'other_discord', stolen);
        const st = await call('GET', `/api/crew/am/application-status/${r.body.statusToken}`);
        check('their status page now says the test is in the ticket', st.body.stage === 'test' && /Discord ticket/.test(st.body.next.body), st.body.next);

        /* ---- the bot as a caller: recruitment, nothing else --------------- */
        const list = await vaBot.api('get', '/api/crew/am/entrance-tests', asBot);
        check('the bot may list entrance tests', list.status === 200 && Array.isArray(list.data.tests), list);
        const wrongVa = await vaBot.api('get', '/api/crew/am/entrance-tests', { ...asBot, slug: 'other' });
        check('…but not with another airline’s name on it', wrongVa.status === 401, wrongVa.status);
        const roster = await vaBot.api('post', '/api/crew/am/roster', { ...asBot, body: { name: 'Nope', callsign: '999' } });
        check('…and may not touch the roster', roster.status === 403, roster.status);
        const accept = await vaBot.api('patch', `/api/crew/am/applications/${r.body.applicationId}`, { ...asBot, body: { action: 'accept' } });
        check('staff can accept before the test is done (override)', accept.status === 200 && accept.data.status === 'accepted' && accept.data.invite.kind === 'link', accept.data);
        const inv = await vaBot.api('get', `/api/crew/am/applications/${r.body.applicationId}/invite`, asBot);
        check('the bot reads the link back for the pilot', inv.status === 200 && inv.data.invite.state === 'live' && !!inv.data.invite.link, inv.data);
    }

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
