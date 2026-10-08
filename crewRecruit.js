'use strict';

/*
 * crewRecruit.js
 * The one road from "somebody wants to fly with us" to "they can sign in".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Recruiting had grown five overlapping ways in: an application that might or
 * might not make a login depending on a switch (in three places), an open-join
 * mode that made a roster row and no login, an entrance test that could be sent
 * to somebody who never applied, a quiz "door" that locked the crew center
 * after a login had already been handed out, and two different kinds of
 * invitation (a temporary password on the application, a setup link on the
 * account). Every one of them was reasonable on its own; together nobody could
 * say what happens to a new pilot.
 *
 * So there is now one pipeline, and every channel — the join page, the status
 * page, the email, the "Copy for IFC" button and the Discord bot — reads where
 * an applicant stands from here:
 *
 *   discord   applied on the web; the airline recruits through its Discord, so
 *             the next step is joining the server and opening a ticket (with
 *             the application code that ties the ticket to this application)
 *   test      an entrance test is out — sent automatically when the airline
 *             requires one, or by staff from the card or the ticket
 *   review    waiting on staff: no test, a pass, or a test with no goes left
 *   invited   accepted. Accepting ALWAYS makes the roster row, the login and a
 *             one-time "choose your password" link. There is no switch.
 *   joined    they have signed in
 *   declined
 *
 * Two airline settings decide the path, and staff can step in at any point —
 * send a test, accept without one, decline:
 *
 *   joinMode      'application' (staff accept) or 'free' (accepted on submit,
 *                 or on passing the test when one is required)
 *   entrance test the quiz every applicant sits, or none
 *   via Discord   send web applicants to the Discord to open a ticket — only
 *                 when the bot is linked and there is an invite to send
 *
 * Pure: nothing here reads a database or sends anything.
 */

const crewInvite = require('./crewInvite');
const crewQuizzes = require('./crewQuizzes');

const STAGES = ['discord', 'test', 'review', 'invited', 'joined', 'declined'];

/**
 * The recruiting rules an airline runs, from its record.
 *
 * @param {Object} va                  the VirtualAirlineAd (joinMode,
 *                                     crewEntranceQuizId, crewJoinViaDiscord,
 *                                     crewDiscordInvite)
 * @param {Object} opts
 * @param {Array}  [opts.quizzes]      the airline's quizzes, sanitised
 * @param {boolean} [opts.botLinked]   a Discord server is linked to the bot
 */
function rulesFor(va, { quizzes = [], botLinked = false } = {}) {
    const v = va || {};
    const wanted = String(v.crewEntranceQuizId || '');
    const quiz = wanted ? (Array.isArray(quizzes) ? quizzes : []).find((q) => q && q.id === wanted) : null;
    const discordInvite = String(v.crewDiscordInvite || '');
    return {
        auto: v.joinMode === 'free',
        // A quiz that has been deleted or emptied since it was picked is no
        // test at all — nobody is held at a step they cannot complete.
        test: quiz && crewQuizzes.isReady(quiz) ? quiz : null,
        // Sending people to a Discord needs a bot there to meet them and an
        // invite to get them in. Without either it would be a dead end.
        viaDiscord: !!(v.crewJoinViaDiscord && botLinked && discordInvite),
        viaDiscordWanted: !!v.crewJoinViaDiscord,
        discordInvite,
    };
}

/* ---------------------------------------------------------------------------
 * The application code
 *
 * What ties a Discord ticket to an application made on the website. It is the
 * front of the applicant's status token, so it travels in exactly the places
 * the status link already does (their email, their status page, the message
 * staff paste to them on the IFC) and nowhere new. Eight hex characters: a
 * guess has to land on a pending application of this one airline, through a
 * Discord modal, which is not a game anybody wins.
 * ------------------------------------------------------------------------ */

function applicationCode(statusToken) {
    const t = String(statusToken || '').toLowerCase();
    if (!/^[a-f0-9]{8}/.test(t)) return '';
    return `${t.slice(0, 4)}-${t.slice(4, 8)}`.toUpperCase();
}

/**
 * What somebody typed into the bot: the code, or their whole status link (or
 * token), which is what they are as likely to paste.
 *
 * @returns {{token: string}|{prefix: string}|null}
 */
function readCode(input) {
    const s = String(input || '').trim();
    const whole = s.match(/[a-f0-9]{32}/i);
    if (whole) return { token: whole[0].toLowerCase() };
    const hex = s.replace(/[\s-]/g, '').toLowerCase();
    if (/^[a-f0-9]{8}$/.test(hex)) return { prefix: hex };
    return null;
}

/** Does this application answer to what was typed? */
function codeMatches(appDoc, read) {
    const t = String((appDoc && appDoc.statusToken) || '').toLowerCase();
    if (!t || !read) return false;
    if (read.token) return t === read.token;
    return !!read.prefix && t.slice(0, 8) === read.prefix;
}

/* ---------------------------------------------------------------------------
 * Where an applicant stands
 * ------------------------------------------------------------------------ */

/**
 * @param {Object} p
 * @param {Object} p.app        the application
 * @param {Object} [p.test]     their latest entrance test, staff-shaped
 *                              ({status, live}) — or null
 * @param {Object} [p.invite]   their login invitation ({state}) — or null
 * @param {Object} p.rules      rulesFor(...)
 * @param {boolean} [p.inTicket] a Discord ticket is tied to the application
 * @returns {string} one of STAGES
 */
function stageOf({ app, test = null, invite = null, rules = {}, inTicket = false } = {}) {
    const status = app && app.status;
    if (status === 'declined') return 'declined';
    if (status === 'accepted') return invite && invite.state === 'claimed' ? 'joined' : 'invited';
    if (test && test.status === 'passed') return 'review';
    // Out of goes: nothing more the applicant can do, so it is the team's call.
    if (test && test.status === 'failed' && test.live === false) return 'review';
    if (test && test.status !== 'revoked') return 'test';
    if (rules.viaDiscord && !inTicket) return 'discord';
    // Required and not out yet — the card offers to send it.
    if (rules.test) return 'test';
    return 'review';
}

/**
 * What the applicant is told to do next, on their own screens: the join page
 * after submitting, the status page, the bot's ticket. One set of words.
 *
 * @returns {{stage: string, title: string, body: string,
 *            action: ({label: string, url: string}|null), code?: string}}
 */
function nextStep({
    stage, vaName = '', code = '', discordInvite = '', inTicket = false,
    test = null, invite = null, signInUrl = '', emailed = false, staffMessage = '',
} = {}) {
    const va = String(vaName || '').trim() || 'the team';
    const out = { stage, title: '', body: '', action: null };
    if (stage === 'discord') {
        out.title = 'Next: open a ticket in our Discord';
        out.body = `Join the ${va} Discord, press Apply in the recruitment channel and choose “I applied on the website”. `
            + (code ? `Your application code is ${code}.` : 'Have your status link ready.');
        if (discordInvite) out.action = { label: 'Join the Discord', url: discordInvite };
        if (code) out.code = code;
    } else if (stage === 'test') {
        const title = (test && test.title) || 'the entrance test';
        out.title = 'Next: take the entrance test';
        if (test && test.link) {
            out.body = `${title}${test.passMark ? ` — you need ${test.passMark}% to pass` : ''}. No account needed: just open the link.`
                + (inTicket ? ' It’s in your Discord ticket too, and your result goes there.' : '');
            out.action = { label: test.status === 'failed' ? 'Try again' : 'Take the test', url: test.link };
        } else if (test && test.status === 'failed') {
            out.title = 'Entrance test not passed';
            out.body = 'You’ve used every attempt. The team will be in touch.';
        } else {
            out.body = inTicket ? 'The team will post it in your Discord ticket.' : `The ${va} team will send it to you.`;
        }
    } else if (stage === 'review') {
        out.title = 'With the team';
        out.body = (test && test.status === 'passed' ? 'You passed the entrance test. ' : '')
            + `Your application is with the ${va} staff. `
            + (inTicket ? 'You’ll hear back in your Discord ticket.' : emailed ? 'We’ll email you as soon as there’s a decision.' : 'Check back here for the decision.');
    } else if (stage === 'invited') {
        out.title = 'You’re in — set up your login';
        if (invite && invite.link) {
            out.body = `Your username is ${invite.username || '—'}. Choose your password to sign in.`;
            out.action = { label: 'Choose my password', url: invite.link };
        } else if (invite && invite.password) {
            out.body = 'Your login is below. You’ll choose your own password the first time you sign in.';
            if (signInUrl) out.action = { label: 'Sign in', url: signInUrl };
        } else {
            out.body = `The ${va} team will send your crew center login.`;
        }
    } else if (stage === 'joined') {
        out.title = 'You’re all set';
        out.body = 'You’ve signed in to the crew center. Welcome aboard!';
        if (signInUrl) out.action = { label: 'Open the crew center', url: signInUrl };
    } else if (stage === 'declined') {
        out.title = 'Application not accepted';
        out.body = String(staffMessage || '').trim() || `The ${va} team weren’t able to accept your application this time.`;
    }
    return out;
}

/**
 * The message staff paste to an applicant on the IFC (or Discord) for the step
 * they are on. Accepted applicants get the welcome with their login instead —
 * that one lives with the invitation (crewInvite.buildInviteMessage).
 *
 * Plain text; `format: 'ifc'` frames it with the airline's banners exactly as
 * the welcome is framed.
 */
function applicantMessage({
    stage, vaName = '', ifcName = '', statusUrl = '', code = '', discordInvite = '',
    quiz = null, testLink = '', passed = false, staffMessage = '',
    format = 'plain', bannerUrl = '', footerUrl = '',
} = {}) {
    const va = String(vaName || '').trim() || 'the crew';
    const who = String(ifcName || '').trim();
    const lines = [];
    if (stage === 'test' && quiz && testLink) {
        lines.push(crewQuizzes.buildTestMessage({ vaName, name: who, quiz, link: testLink }));
    } else if (stage === 'declined') {
        lines.push(`Thanks for applying to ${va}${who ? `, ${who}` : ''}. The team weren't able to accept your application this time.`);
        if (String(staffMessage || '').trim()) lines.push('', 'Message from the team:', String(staffMessage).trim());
    } else {
        lines.push(who ? `Thanks for applying to ${va}, ${who}!` : `Thanks for applying to ${va}!`);
        if (stage === 'discord') {
            lines.push('', 'Next step: join our Discord and open a ticket — press Apply in the recruitment channel, then "I applied on the website".');
            if (discordInvite) lines.push(`  ${discordInvite}`);
            if (code) lines.push('', `When the bot asks, your application code is: ${code}`);
        } else if (stage === 'test') {
            lines.push('', 'Next step: the entrance test. The team will send you the link.');
        } else {
            lines.push('', `${passed ? 'You passed the entrance test, and your' : 'Your'} application is with the team now. You'll hear back soon.`);
        }
    }
    if (statusUrl && stage !== 'declined') lines.push('', `Track your application: ${statusUrl}`);
    const body = lines.join('\n');
    return format === 'ifc' ? crewInvite.forIfc(body, { vaName, bannerUrl, footerUrl }) : body;
}

module.exports = {
    STAGES,
    rulesFor,
    applicationCode,
    readCode,
    codeMatches,
    stageOf,
    nextStep,
    applicantMessage,
};
