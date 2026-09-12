// test-crew-discord-routes.js
// The Discord sign-in flow, driven end to end through the real Express routes
// with a fake VA, a fake data store and Discord itself stubbed out.
//
// The unit tests next door prove what a state token says. This proves what the
// ROUTES do with one, which is where the properties that matter live:
//
//   * a sign-in can only ever FIND an account that is already linked. It never
//     creates one, never claims one, and never falls back to matching a name
//   * a link round trip cannot be spent as a sign-in
//   * the account that gets linked is the one in the signed state, not one the
//     browser names on the way back
//   * one Discord account opens one login per crew center
//   * a session never travels in a query string
//   * an account switched off between the callback and the exchange gets no
//     session out of a handoff that was issued a moment earlier
//
// Run:  node scripts/test-crew-discord-routes.js
process.env.JWT_SECRET = 'test-secret-for-crew-discord-routes';
process.env.DISCORD_CLIENT_ID = '1234567890';
process.env.DISCORD_CLIENT_SECRET = 'shh';
process.env.PUBLIC_BASE_URL = 'https://inflight.example';
process.env.CREW_PUBLIC_BASE_URL = 'https://crew.example';

const express = require('express');
const mongoose = require('mongoose');

const VA = {
    _id: 'va1', name: 'British Airways Virtual', slug: 'ba', callsign: 'BAW',
    status: 'approved', staffRoles: [], staffAssignments: [],
};

/* The VA's own data store, in memory. Only the handful of methods this flow
   touches — a fuller fake would be a second implementation to keep correct. */
let ACCOUNTS = [];
const freshAccounts = () => ([
    { _id: 'a1', username: 'rae', displayName: 'Rae', role: 'pilot', active: true,
      mustChangePassword: false, discordId: '', discordUsername: '', discordAvatar: '', discordLinkedAt: null },
    { _id: 'a2', username: 'sam', displayName: 'Sam', role: 'pilot', active: true,
      mustChangePassword: false, discordId: '', discordUsername: '', discordAvatar: '', discordLinkedAt: null },
]);

const store = {
    getAccount: async (id) => ACCOUNTS.find((a) => String(a._id) === String(id)) || null,
    getAccountByDiscord: async (did) => (/^[0-9]{5,32}$/.test(String(did || ''))
        ? ACCOUNTS.find((a) => a.discordId === String(did)) || null : null),
    updateAccount: async (id, patch) => {
        const a = ACCOUNTS.find((x) => String(x._id) === String(id));
        if (a) Object.assign(a, patch);
        return a || null;
    },
    // claimInvitation() calls into these fire-and-forget; a store that cannot
    // answer must never take a login down with it, so they throw on purpose.
    listApplications: async () => { throw new Error('no applications table in this fake'); },
};

const crewStore = require('../crewStore');
crewStore.forVa = async () => store;

mongoose.model = (name) => {
    if (name === 'VirtualAirlineAd') {
        return { findOne: (q) => ({ select: () => ({ lean: async () => (
            (q && (q.slug === 'ba' || q.callsign === 'BA')) ? VA : null) }) }) };
    }
    // The password cascade's two central models. Never reached by this flow.
    return { findOne: async () => null };
};

/* Discord itself. The two calls that touch the network are the only things in
   the module that are not decidable locally, so they are the only things
   stubbed — everything else under test is the real code. */
const crewDiscord = require('../crewDiscord');
let WHO = { id: '80351110224678912', username: 'rae', globalName: 'Rae M', avatar: 'abc' };
let EXCHANGE_FAILS = false;
crewDiscord.exchangeCode = async () => { if (EXCHANGE_FAILS) throw new Error('nope'); return 'access-token'; };
crewDiscord.fetchProfile = async () => WHO;

const crewAuth = require('../crewAuth');
const app = express();
app.use(express.json());
crewAuth.registerCrewAuthRoutes(app);

let pass = 0;
const fails = [];
const check = (what, ok, extra) => {
    if (ok) pass++;
    else fails.push(what + (extra === undefined ? '' : ` — ${JSON.stringify(extra).slice(0, 300)}`));
};

const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p, headers) => fetch(base + p, { redirect: 'manual', headers: headers || {} });
    const post = (p, body, headers) => fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(body || {}),
    });
    // A crew session for a pilot, signed the way the login route signs one.
    const jwt = require('jsonwebtoken');
    const sessionFor = (sub) => jwt.sign(
        { typ: 'crew', sub, kind: 'crew', role: 'pilot', view: 'pilot', slug: 'ba', vaId: 'va1', uname: 'rae' },
        process.env.JWT_SECRET, { expiresIn: '7d' });
    const reasonOf = (loc) => new URL(loc, 'https://x').searchParams.get('discord');
    const stateOf = (loc) => new URL(loc).searchParams.get('state');

    try {
        ACCOUNTS = freshAccounts();

        /* ---- leaving for Discord to sign in -------------------------------- */
        {
            const res = await get('/api/crew/ba/auth/discord');
            const loc = res.headers.get('location') || '';
            check('the sign-in button leaves for Discord', res.status === 302 && loc.startsWith('https://discord.com/'), loc.slice(0, 60));
            const st = crewDiscord.readState(stateOf(loc));
            check('…carrying which crew center, sealed', st && st.slug === 'ba', st);
            check('…as a sign-in and not a link', st && st.intent === 'login' && !st.sub, st);

            const miss = await get('/api/crew/nope/auth/discord');
            check('an unknown crew center is sent back, not to Discord',
                miss.status === 302 && !(miss.headers.get('location') || '').includes('discord.com'));
        }

        /* ---- a sign-in for a Discord account nobody has linked -------------- */
        {
            const before = JSON.stringify(ACCOUNTS);
            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const res = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            const loc = res.headers.get('location') || '';
            check('an unlinked Discord account signs nobody in', reasonOf(loc) === 'not_linked', loc);
            check('…and hands out no session', !loc.includes('#'), loc);
            /* THE PROPERTY THE WHOLE FEATURE RESTS ON. A roster is the VA's, and
               a login button does not get to add to it. */
            check('…and creates nothing', JSON.stringify(ACCOUNTS) === before);
        }

        /* ---- starting a link ------------------------------------------------ */
        {
            const anon = await post('/api/crew/ba/auth/discord/link');
            check('a link cannot be started without a session', anon.status === 401);

            const wrongVa = await post('/api/crew/other/auth/discord/link', {}, { Authorization: 'Bearer ' + sessionFor('a1') });
            check('…nor with a session for a different crew center', wrongVa.status === 403, wrongVa.status);

            const res = await post('/api/crew/ba/auth/discord/link', {}, { Authorization: 'Bearer ' + sessionFor('a1') });
            const body = await res.json();
            check('a signed-in pilot is given the address rather than redirected', res.status === 200 && !!body.url);
            /* It is ANSWERED rather than redirected to precisely so the session
               can travel in a header. A token in a query string would be in
               history, in a Referer and in every log in between. */
            /* Nothing in the address may be, or carry, a credential. Checked
               as parameter NAMES and VALUES rather than as a substring of the
               whole URL — "redirect_uri" contains a "t=" and a careless match
               on the raw query passes for the wrong reason. */
            const params = [...new URL(body.url).searchParams.entries()];
            const named = params.filter(([k]) => /^(t|token|access_token|authorization|bearer|session)$/i.test(k));
            const jwtish = params.filter(([k, v]) => k !== 'state' && /^ey[A-Za-z0-9_-]{10,}\./.test(v));
            check('…and the address carries no session, only a signed state',
                named.length === 0 && jwtish.length === 0, { named, jwtish });
            const st = crewDiscord.readState(stateOf(body.url));
            check('…naming the account that is linking, from the token', st && st.sub === 'a1' && st.intent === 'link', st);
        }

        /* ---- finishing the link --------------------------------------------- */
        let linkState = '';
        {
            linkState = crewDiscord.signState({ slug: 'ba', intent: 'link', sub: 'a1' });
            const res = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(linkState)}`);
            const loc = res.headers.get('location') || '';
            check('the link finishes', reasonOf(loc) === 'linked', loc);
            check('…writing the Discord id onto that account', ACCOUNTS[0].discordId === WHO.id, ACCOUNTS[0]);
            check('…with the display name to show, not to match on', ACCOUNTS[0].discordUsername === 'Rae M');
            check('…and onto that account only', ACCOUNTS[1].discordId === '');
            /* A LINK IS NOT A SIGN-IN. The callback establishes a Discord
               identity either way; what differs is what it is worth, and a link
               round trip must never come back holding a session. */
            check('…and hands out no session on the way back', !loc.includes('#'), loc);
        }

        /* ---- and now signing in with it ------------------------------------- */
        let handoff = '';
        {
            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const res = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            const loc = res.headers.get('location') || '';
            check('the linked pilot is signed in', reasonOf(loc) === 'ok', loc);
            check('…sent back to the crew center this deployment serves',
                loc.startsWith('https://crew.example/crew/ba?'), loc.slice(0, 60));
            /* IN THE FRAGMENT. A fragment is never sent to a server, so the
               handoff is in no access log, no Referer and no proxy's history. */
            check('…with the handoff in the fragment, where no server sees it', loc.includes('#discord='), loc);
            handoff = decodeURIComponent(loc.split('#discord=')[1] || '');
            const d = crewDiscord.readHandoff(handoff);
            check('…and the handoff names that account', d && d.sub === 'a1' && d.slug === 'ba', d);
        }

        /* ---- spending the handoff -------------------------------------------- */
        {
            const wrongVa = await post('/api/crew/other/auth/discord/exchange', { code: handoff });
            check('a handoff cannot be spent at another crew center', wrongVa.status === 401);

            const junk = await post('/api/crew/ba/auth/discord/exchange', { code: 'nope' });
            check('a forged handoff buys nothing', junk.status === 401);

            /* A LINK state's token is not a handoff, and vice versa — the two
               are typed so one can never be spent as the other. */
            const asHandoff = await post('/api/crew/ba/auth/discord/exchange', { code: linkState });
            check('a state cannot be spent as a handoff', asHandoff.status === 401);

            const res = await post('/api/crew/ba/auth/discord/exchange', { code: handoff });
            const body = await res.json();
            check('the handoff buys a session', res.status === 200 && !!body.token, body);
            check('…for the right pilot, on the right page', body.role === 'pilot' && body.view === 'pilot');
            /* The same shape the password door hands out — see crewSession().
               Two doors that establish the same thing must not differ in what
               they hand over. */
            check('…in the same shape a password sign-in produces',
                'caps' in body && 'capabilities' in body && 'va' in body && 'canChangePassword' in body,
                Object.keys(body));
        }

        /* ---- the ninety seconds in between ------------------------------------ */
        {
            ACCOUNTS[0].active = false;
            const res = await post('/api/crew/ba/auth/discord/exchange', { code: handoff });
            check('an account switched off after the callback gets no session', res.status === 401);
            ACCOUNTS[0].active = true;
        }

        /* ---- one Discord account, one login, per crew center ------------------ */
        {
            const state = crewDiscord.signState({ slug: 'ba', intent: 'link', sub: 'a2' });
            const res = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            check('a Discord account already linked here cannot be linked again',
                reasonOf(res.headers.get('location') || '') === 'link_taken');
            check('…and the second pilot is left alone', ACCOUNTS[1].discordId === '');
            check('…as is the first', ACCOUNTS[0].discordId === WHO.id);
        }

        /* ---- an account switched off cannot be signed in to ------------------- */
        {
            ACCOUNTS[0].active = false;
            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const res = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            const loc = res.headers.get('location') || '';
            check('a switched-off account is not signed in', reasonOf(loc) === 'not_linked', loc);
            /* And it says the SAME thing as "never linked". Telling the two
               apart would let somebody map a roster by trying Discord
               accounts. */
            check('…in the same words, so a roster cannot be mapped by guessing', !loc.includes('#'));
            ACCOUNTS[0].active = true;
        }

        /* ---- unlinking --------------------------------------------------------- */
        {
            const anon = await fetch(base + '/api/crew/ba/account/discord', { method: 'DELETE' });
            check('unlinking needs a session', anon.status === 401);

            const res = await fetch(base + '/api/crew/ba/account/discord', {
                method: 'DELETE', headers: { Authorization: 'Bearer ' + sessionFor('a1') } });
            check('a pilot can unlink their own', res.status === 200 && ACCOUNTS[0].discordId === '');

            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const after = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            check('…and Discord no longer signs them in',
                reasonOf(after.headers.get('location') || '') === 'not_linked');
        }

        /* ---- everything that can go wrong on the way back ---------------------- */
        {
            const noState = await get('/api/crew/auth/discord/callback?code=xyz');
            check('a callback with no readable state goes nowhere', noState.status === 400, noState.status);

            const forged = await get('/api/crew/auth/discord/callback?code=xyz&state=forged');
            check('…and neither does a forged one', forged.status === 400);

            const state = crewDiscord.signState({ slug: 'ba', intent: 'login' });
            const cancelled = await get(`/api/crew/auth/discord/callback?error=access_denied&state=${encodeURIComponent(state)}`);
            check('pressing Cancel is a decision, not a fault',
                reasonOf(cancelled.headers.get('location') || '') === 'cancelled');

            EXCHANGE_FAILS = true;
            const broke = await get(`/api/crew/auth/discord/callback?code=xyz&state=${encodeURIComponent(state)}`);
            check('Discord not answering sends the pilot back with a reason',
                reasonOf(broke.headers.get('location') || '') === 'failed');
            EXCHANGE_FAILS = false;
        }
    } catch (err) {
        fails.push('threw — ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
    }

    server.close();
    if (fails.length) {
        console.log(`${pass} passed, ${fails.length} failed`);
        fails.forEach((f) => console.log('  FAIL  ' + f));
        process.exit(1);
    }
    console.log(`${pass} passed, 0 failed`);
});
