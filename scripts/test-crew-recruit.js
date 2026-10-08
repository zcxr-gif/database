// test-crew-recruit.js
// The recruiting rules on their own (crewRecruit.js): which settings make which
// road, where an applicant stands, the application code, and the words.
//
// Run:  node scripts/test-crew-recruit.js
'use strict';

const r = require('../crewRecruit');

let pass = 0;
const fails = [];
const T = (what, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++;
    else fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const QUIZ = { id: 'entrance', title: 'Entrance Test', passMark: 80, active: true, questions: [{ id: 'q', text: '?', options: ['a', 'b'], correct: 0 }] };
const EMPTY = { id: 'empty', title: 'Nothing yet', passMark: 80, questions: [] };
const INVITE = 'https://discord.gg/abc';

/* ---- the rules ------------------------------------------------------- */
{
    const plain = r.rulesFor({ joinMode: 'application' }, { quizzes: [QUIZ] });
    T('no test chosen is no test', [plain.auto, plain.test, plain.viaDiscord], [false, null, false]);
    T('open joining accepts by itself', r.rulesFor({ joinMode: 'free' }).auto, true);
    T('the chosen quiz is the test', r.rulesFor({ crewEntranceQuizId: 'entrance' }, { quizzes: [QUIZ] }).test.id, 'entrance');
    T('a deleted quiz is no test', r.rulesFor({ crewEntranceQuizId: 'gone' }, { quizzes: [QUIZ] }).test, null);
    T('an empty quiz is no test', r.rulesFor({ crewEntranceQuizId: 'empty' }, { quizzes: [EMPTY] }).test, null);
    const want = { crewJoinViaDiscord: true, crewDiscordInvite: INVITE };
    T('Discord needs the bot linked', r.rulesFor(want, { botLinked: false }).viaDiscord, false);
    T('…and an invite to send', r.rulesFor({ crewJoinViaDiscord: true }, { botLinked: true }).viaDiscord, false);
    T('…and then it is on', r.rulesFor(want, { botLinked: true }).viaDiscord, true);
    T('what was asked for is still known when it cannot be honoured', r.rulesFor(want, { botLinked: false }).viaDiscordWanted, true);
}

/* ---- the application code ------------------------------------------- */
{
    const token = '3fa9c01b'.padEnd(32, '7');
    T('the code is the front of the status token', r.applicationCode(token), '3FA9-C01B');
    T('no token, no code', r.applicationCode(''), '');
    T('typed as given', r.readCode('3FA9-C01B'), { prefix: '3fa9c01b' });
    T('lower case, spaces, no dash', r.readCode(' 3fa9 c01b '), { prefix: '3fa9c01b' });
    T('the whole status link works too', r.readCode(`https://x/crew/am/status?id=${token}`), { token });
    T('nonsense is nothing', r.readCode('hello'), null);
    T('a code matches its application', r.codeMatches({ statusToken: token }, r.readCode('3FA9-C01B')), true);
    T('…and no other', r.codeMatches({ statusToken: 'f'.repeat(32) }, r.readCode('3FA9-C01B')), false);
}

/* ---- where they stand ------------------------------------------------ */
{
    const rules = r.rulesFor({ crewEntranceQuizId: 'entrance', crewJoinViaDiscord: true, crewDiscordInvite: INVITE }, { quizzes: [QUIZ], botLinked: true });
    const pending = { status: 'pending' };
    T('applied on the web, recruiting in Discord: open a ticket', r.stageOf({ app: pending, rules }), 'discord');
    T('in the ticket, test not out yet: test', r.stageOf({ app: pending, rules, inTicket: true }), 'test');
    T('test out: test', r.stageOf({ app: pending, rules, test: { status: 'issued' } }), 'test');
    T('failed with a go left: still test', r.stageOf({ app: pending, rules, test: { status: 'failed', live: true } }), 'test');
    T('failed with none left: the team decides', r.stageOf({ app: pending, rules, test: { status: 'failed', live: false } }), 'review');
    T('passed: the team decides', r.stageOf({ app: pending, rules, test: { status: 'passed' } }), 'review');
    T('no test, no Discord: review', r.stageOf({ app: pending, rules: r.rulesFor({}) }), 'review');
    T('accepted, not signed in: invited', r.stageOf({ app: { status: 'accepted' }, rules, invite: { state: 'live' } }), 'invited');
    T('accepted and signed in: joined', r.stageOf({ app: { status: 'accepted' }, rules, invite: { state: 'claimed' } }), 'joined');
    T('declined', r.stageOf({ app: { status: 'declined' }, rules }), 'declined');
}

/* ---- the words ------------------------------------------------------- */
{
    const d = r.nextStep({ stage: 'discord', vaName: 'Test Air', code: 'ABCD-1234', discordInvite: INVITE });
    T('the Discord step names the code and links the server', [d.body.includes('ABCD-1234'), d.action.url], [true, INVITE]);
    const t = r.nextStep({ stage: 'test', test: { title: 'SOP', passMark: 80, link: 'https://t' } });
    T('the test step links the test', [t.action.label, t.action.url, /80%/.test(t.body)], ['Take the test', 'https://t', true]);
    const i = r.nextStep({ stage: 'invited', invite: { link: 'https://set', username: 'jo' } });
    T('an invitation is a link to choose a password', [i.action.label, i.action.url, /jo/.test(i.body)], ['Choose my password', 'https://set', true]);
    const msg = r.applicantMessage({ stage: 'discord', vaName: 'Test Air', ifcName: 'Jo', statusUrl: 'https://s', code: 'ABCD-1234', discordInvite: INVITE });
    T('the IFC message for the Discord step has the invite, the code and the status link',
        [msg.includes(INVITE), msg.includes('ABCD-1234'), msg.includes('Track your application: https://s')], [true, true, true]);
    const framed = r.applicantMessage({ stage: 'review', vaName: 'Test Air', bannerUrl: 'https://b.example/x.png', format: 'ifc' });
    T('…framed for the IFC with the banner', framed.startsWith('![Test Air](https://b.example/x.png)'), true);
    const no = r.applicantMessage({ stage: 'declined', vaName: 'Test Air', staffMessage: 'Try again in a month.' });
    T('a decline carries the team’s words and no status link', [no.includes('Try again in a month.'), no.includes('Track')], [true, false]);
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
