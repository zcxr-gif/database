'use strict';

/*
 * crewDiscord.js
 * Signing in to a crew center with Discord.
 *
 * WHY DISCORD AND NOT ANYTHING ELSE
 * ---------------------------------
 * A virtual airline already runs on Discord. Recruitment happens there, the
 * NOTAMs are posted there, and a pilot who has never opened the crew center
 * still knows exactly which account is theirs. What the crew center gives them
 * instead is a username they did not choose and a password somebody generated
 * and handed over in a DM — which is why `must_change_password` exists, and why
 * the single most common support message a VA gets is somebody who has lost it.
 *
 * WHAT THIS IS, AND THE ONE THING IT IS NOT
 * -----------------------------------------
 * It is a SECOND KEY TO AN EXISTING DOOR. A pilot signs in once with the
 * password they were given, links Discord from their own account page, and from
 * then on the button signs them in.
 *
 * It is NOT a way to get an account. Nothing here creates, claims or promotes
 * anything: the callback looks up an account that is ALREADY linked to that
 * Discord id and signs it in, or it does not sign anybody in. A VA's roster is
 * the VA's, and the list of people who may fly for them is not something a
 * login button gets to add to.
 *
 * That is worth being exact about, because the tempting version — "anybody in
 * the VA's Discord server can sign in" — hands the roster to whoever can join a
 * server, and a server invite is a link that gets pasted in public.
 *
 * WHY THE OAUTH APPLICATION IS OURS AND NOT EACH VA'S
 * ---------------------------------------------------
 * Every VA would otherwise have to register a Discord application, hold a client
 * secret, and keep a redirect URI in step with us. Most would not, the ones who
 * did would paste the secret into a support thread eventually, and a VA that
 * rotated it would break their own pilots' logins with no way to find out why.
 * So there is one Inflight application, the redirect comes back to us, and
 * `state` says which crew center the pilot was standing in.
 *
 * WHAT LIVES HERE
 * ---------------
 * The rules, and the two calls that have to touch the network. Everything that
 * can be decided without Discord — what a state token says, what a profile
 * normalises to, where a pilot is sent afterwards — is a plain function, so the
 * parts that are easy to get wrong are the parts that can be tested without a
 * browser or a client secret.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

const AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const ME = 'https://discord.com/api/v10/users/@me';
const CDN = 'https://cdn.discordapp.com';

/* IDENTIFY AND NOTHING ELSE.
 *
 * Not `email`, which we have no use for and would make this a data-collection
 * exercise; not `guilds`, which would let us read every server a pilot is in to
 * answer a question we are not asking. The consent screen a pilot sees is the
 * shortest one Discord can draw, and every extra line on it is a reason to
 * press Cancel. */
const SCOPE = 'identify';

/* HOW LONG EACH TOKEN IN THIS FLOW LIVES.
 *
 * The state has to survive a human reading a consent screen, being asked to log
 * in to Discord, and possibly a two-factor prompt. Ten minutes is generous for
 * that and still short enough that a state token copied out of a browser's
 * history is worthless by the time anybody finds it.
 *
 * The handoff is the opposite: it exists for one redirect and one immediate
 * POST, both of which happen in the same second. */
const STATE_TTL = '10m';
const HANDOFF_TTL = '90s';

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * Is this deployment able to offer the button at all?
 *
 * Checked before anything is drawn rather than when it is pressed. A button that
 * goes to Discord and comes back with "this deployment is not set up" is worse
 * than no button, because the pilot has already been sent somewhere else and
 * blamed themselves for it.
 */
function configured() {
    return !!(process.env.DISCORD_CLIENT_ID
        && process.env.DISCORD_CLIENT_SECRET
        && redirectUri());
}

/**
 * The address Discord sends the pilot back to.
 *
 * ONE fixed address, from configuration. It is deliberately not built from the
 * request, and there is no parameter anywhere in this flow that can influence
 * where a pilot lands: an OAuth redirect that takes its destination from the
 * caller is an open redirect with a login attached to it. Which crew center
 * they were standing in travels inside the signed state instead, where it
 * cannot be edited.
 */
function redirectUri() {
    const explicit = str(process.env.DISCORD_OAUTH_REDIRECT_URI, 300);
    if (explicit) return explicit;
    const base = str(process.env.PUBLIC_BASE_URL, 200).replace(/\/+$/, '');
    return base ? `${base}/api/crew/auth/discord/callback` : '';
}

/* ---------------------------------------------------------------------------
 * THE STATE
 *
 * A signed token rather than a row in a table or a value in a session, because
 * this deployment has no session store and the alternative — remembering a
 * nonce server-side — would tie a login to whichever instance started it.
 *
 * It carries everything the callback needs to know and cannot look up:
 *
 *   slug    which crew center the pilot pressed the button in
 *   intent  'login' or 'link'. These are NOT interchangeable, which is the
 *           whole reason it is in here: a link flow returns a Discord identity
 *           that is about to be attached to a signed-in account, and a login
 *           flow returns one that is about to be trusted to BE an account. A
 *           callback that could not tell them apart would let a link round trip
 *           be replayed as a sign-in.
 *   sub     on a link, the account doing the linking — taken from the caller's
 *           own bearer token at the start of the flow and never from anything
 *           the browser sends back afterwards.
 *   nonce   so two states are never the same string.
 * ------------------------------------------------------------------------ */
function signState({ slug, intent, sub }) {
    return jwt.sign({
        typ: 'crew-discord-state',
        slug: str(slug, 80).toLowerCase(),
        intent: intent === 'link' ? 'link' : 'login',
        sub: str(sub, 80) || undefined,
        nonce: crypto.randomBytes(9).toString('base64url'),
    }, JWT_SECRET, { expiresIn: STATE_TTL });
}

/** The state back, or null. Never throws: a bad state is a redirect, not a 500. */
function readState(token) {
    try {
        const d = jwt.verify(String(token || ''), JWT_SECRET);
        if (!d || d.typ !== 'crew-discord-state' || !d.slug) return null;
        return { slug: d.slug, intent: d.intent === 'link' ? 'link' : 'login', sub: d.sub || '' };
    } catch (err) { return null; }
}

/* ---------------------------------------------------------------------------
 * THE HANDOFF
 *
 * The problem this solves: the callback lands on the API, and the session it has
 * just established belongs to a page on a different origin. There is no shared
 * cookie — the crew center has never used one, which is the reason its CORS is
 * as simple as it is — so the session has to travel through the redirect.
 *
 * Putting the real bearer token in the URL would put a month-long credential
 * into browser history, into the Referer of the next request the page makes,
 * and into any log that records a URL. So what travels is a token that is
 * useless to look at: it is good for ninety seconds, it can only be spent at one
 * endpoint, and what it buys is the session.
 *
 * It rides in the URL FRAGMENT. A fragment is never sent to a server, so it is
 * not in our access logs, not in the crew center's, and not in any proxy's in
 * between.
 * ------------------------------------------------------------------------ */
function signHandoff(payload) {
    return jwt.sign({ ...payload, typ: 'crew-discord-handoff' }, JWT_SECRET, { expiresIn: HANDOFF_TTL });
}

function readHandoff(token) {
    try {
        const d = jwt.verify(String(token || ''), JWT_SECRET);
        if (!d || d.typ !== 'crew-discord-handoff') return null;
        return d;
    } catch (err) { return null; }
}

/**
 * Where Discord is asked to send the pilot.
 *
 * `prompt=none` deliberately omitted: a pilot who has already authorised us
 * still gets the consent screen the first time on a new device, and skipping it
 * is the sort of convenience that makes people unsure whether they just logged
 * in to something.
 */
function authorizeUrl(state) {
    const p = new URLSearchParams({
        client_id: str(process.env.DISCORD_CLIENT_ID, 60),
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: SCOPE,
        state: String(state || ''),
    });
    return `${AUTHORIZE}?${p.toString()}`;
}

/**
 * A Discord user, in the four fields this product has any use for.
 *
 * `global_name` is Discord's display name and `username` is the handle. Both are
 * kept because they answer different questions: the handle is what a pilot
 * recognises as their account, and the display name is what their VA's staff
 * see them called in the server.
 *
 * NONE OF THIS IS AN IDENTITY. The id is. Everything else is a label Discord
 * lets people change whenever they like, so it is stored to be shown and never
 * to be matched on.
 */
function profileFrom(raw) {
    const r = raw || {};
    const id = str(r.id, 32);
    if (!/^[0-9]{5,32}$/.test(id)) return null;
    return {
        id,
        username: str(r.username, 40),
        globalName: str(r.global_name, 40),
        avatar: str(r.avatar, 64),
    };
}

/** A pilot's avatar, or '' — the crew center draws its own initials otherwise. */
function avatarUrl(profile) {
    const p = profile || {};
    if (!p.id || !p.avatar) return '';
    const ext = String(p.avatar).startsWith('a_') ? 'gif' : 'png';
    return `${CDN}/avatars/${p.id}/${p.avatar}.${ext}?size=64`;
}

/** What the crew center shows beside "Linked": the display name, else the handle. */
const displayName = (profile) => (profile && (profile.globalName || profile.username)) || '';

/* ---------------------------------------------------------------------------
 * THE TWO CALLS THAT TOUCH DISCORD
 *
 * Everything above is decidable without a network. These two are not, so they
 * are the last thing in the file and the only thing a test has to stand in for.
 * Both fail by throwing an Error whose message is safe to log and useless to an
 * attacker — a failed exchange must never echo the code or the secret back out.
 * ------------------------------------------------------------------------ */

const TIMEOUT_MS = 10000;

async function post(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(body).toString(),
            signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`discord token exchange failed (${res.status})`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

/** A one-time code, for an access token. */
async function exchangeCode(code) {
    const data = await post(TOKEN, {
        client_id: str(process.env.DISCORD_CLIENT_ID, 60),
        client_secret: str(process.env.DISCORD_CLIENT_SECRET, 120),
        grant_type: 'authorization_code',
        code: String(code || ''),
        redirect_uri: redirectUri(),
    });
    const token = str(data && data.access_token, 300);
    if (!token) throw new Error('discord token exchange returned no token');
    return token;
}

/**
 * An access token, for who it belongs to.
 *
 * The token is used once, here, and never stored. We are not asking to act on a
 * pilot's behalf and have nothing to refresh — the only question this whole
 * round trip asks is "which Discord account is this", and once it is answered
 * the credential has no further purpose.
 */
async function fetchProfile(accessToken) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(ME, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`discord profile lookup failed (${res.status})`);
        const profile = profileFrom(await res.json());
        if (!profile) throw new Error('discord profile lookup returned no id');
        return profile;
    } finally { clearTimeout(timer); }
}

module.exports = {
    SCOPE, STATE_TTL, HANDOFF_TTL,
    configured, redirectUri, authorizeUrl,
    signState, readState, signHandoff, readHandoff,
    profileFrom, avatarUrl, displayName,
    exchangeCode, fetchProfile,
};
