// test-crew-discord.js
// Signing in to a crew center with Discord.
//
// Everything that decides anything in this flow is a pure function — what a
// state token says, what a handoff is worth, what a Discord profile normalises
// to, and whether the feature is offered at all. Only the two calls that talk
// to Discord are not, and they are not what goes wrong.
//
// The properties this file exists to hold:
//
//   * a login flow can only ever FIND an account. Nothing in the module can
//     create, claim or promote one
//   * a link round trip cannot be replayed as a sign-in, and vice versa
//   * nothing in the flow takes its destination from the caller
//   * the handoff is worth nothing to look at, and worth nothing for long
//   * the feature is off, silently and completely, without a client secret
//
// Run:  node scripts/test-crew-discord.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-crew-discord';

let pass = 0;
const fails = [];
const check = (what, ok, extra) => {
    if (ok) pass++;
    else fails.push(what + (extra === undefined ? '' : ` — ${JSON.stringify(extra)}`));
};

/* ------------------------------------------------------------ switched off */
{
    // Loaded with no client secret, which is how every deployment that has not
    // set this up runs.
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_OAUTH_REDIRECT_URI;
    process.env.DISCORD_CLIENT_ID = '1234567890';
    process.env.PUBLIC_BASE_URL = 'https://inflight.example';
    delete require.cache[require.resolve('../crewDiscord')];
    const d = require('../crewDiscord');
    check('with no client secret the feature reports itself off', d.configured() === false);
    // And the reason that matters: the sign-in page asks this before drawing a
    // button, so nobody is sent to Discord and told on the way back.
    check('…which is the question the page asks before it draws anything',
        typeof d.configured === 'function');
}

/* --------------------------------------------------------------- the setup */
process.env.DISCORD_CLIENT_SECRET = 'shh';
process.env.DISCORD_CLIENT_ID = '1234567890';
process.env.PUBLIC_BASE_URL = 'https://inflight.example';
delete process.env.DISCORD_OAUTH_REDIRECT_URI;
delete require.cache[require.resolve('../crewDiscord')];
const d = require('../crewDiscord');

{
    check('with an id and a secret it is offered', d.configured() === true);

    /* THE REDIRECT IS CONFIGURATION FIRST.
       It has to match what is registered on the Discord application character
       for character, and it has to be the same string in the authorize and in
       the token exchange. */
    process.env.DISCORD_OAUTH_REDIRECT_URI = 'https://api.example/api/crew/auth/discord/callback';
    check('an explicit redirect is used exactly as given',
        d.redirectUri() === 'https://api.example/api/crew/auth/discord/callback', d.redirectUri());
    check('…and a request cannot talk it out of that',
        d.redirectUri({ headers: { 'x-forwarded-host': 'evil.example' }, protocol: 'https', get: () => 'evil.example' })
        === 'https://api.example/api/crew/auth/discord/callback');

    /* WITHOUT ONE it falls back to the request's own host — NOT to
       PUBLIC_BASE_URL, which on this platform is the site rather than the API,
       and which built an address the callback route does not live at: Discord
       redirected the pilot to the site's catch-all, nothing errored, and the
       sign-in never completed. */
    delete process.env.DISCORD_OAUTH_REDIRECT_URI;
    const fromReq = d.redirectUri({ headers: {}, protocol: 'https', get: () => 'api.example' });
    check('with none set it falls back to the host the request arrived on',
        fromReq === 'https://api.example/api/crew/auth/discord/callback', fromReq);
    check('…and never to the public site, which does not serve this route',
        !d.redirectUri({ headers: {}, protocol: 'https', get: () => 'api.example' }).includes('inflight.example'));
    check('…and answers nothing at all rather than guessing with no request',
        d.redirectUri() === '');
    process.env.DISCORD_OAUTH_REDIRECT_URI = 'https://api.example/api/crew/auth/discord/callback';
}

/* ------------------------------------------------------------ the authorize */
{
    const url = new URL(d.authorizeUrl(d.signState({ slug: 'baw', intent: 'login' })));
    check('a pilot is sent to Discord itself', url.origin === 'https://discord.com', url.origin);
    check('…with our application', url.searchParams.get('client_id') === '1234567890');
    check('…and our fixed redirect', url.searchParams.get('redirect_uri') === d.redirectUri(), url.searchParams.get('redirect_uri'));

    /* IDENTIFY AND NOTHING ELSE. Not email, which we have no use for; not
       guilds, which would read every server a pilot is in to answer a question
       nobody asked. The consent screen is the shortest Discord can draw. */
    check('only the identify scope is asked for', url.searchParams.get('scope') === 'identify',
        url.searchParams.get('scope'));
    check('…and nothing in the address is a destination the caller chose',
        !/redirect|return|next|url/i.test([...url.searchParams.keys()].filter(k => k !== 'redirect_uri').join(',')));
}

/* ----------------------------------------------------------------- the state */
{
    const token = d.signState({ slug: 'BAW', intent: 'link', sub: 'acct-7' });
    const back = d.readState(token);
    check('the state carries which crew center the pilot was standing in', back.slug === 'baw', back);
    check('…lower-cased, like every other slug in the product', back.slug === 'baw');
    check('…what they were doing', back.intent === 'link');
    check('…and which account is linking', back.sub === 'acct-7');

    /* THE INTENTS ARE NOT INTERCHANGEABLE. A link flow returns an identity
       about to be ATTACHED to a signed-in account; a login flow returns one
       about to be TRUSTED AS an account. A callback that could not tell them
       apart would let a link round trip be spent as a sign-in. */
    check('an unknown intent is read as the harmless one',
        d.readState(d.signState({ slug: 'baw', intent: 'whatever' })).intent === 'login');
    check('a login state carries no account', !d.readState(d.signState({ slug: 'baw', intent: 'login' })).sub);

    check('a forged state is refused', d.readState('not.a.token') === null);
    check('an empty state is refused', d.readState('') === null && d.readState(undefined) === null);
    check('two states are never the same string',
        d.signState({ slug: 'baw', intent: 'login' }) !== d.signState({ slug: 'baw', intent: 'login' }));

    // Signed with OUR secret, so a token minted anywhere else is worthless.
    const jwt = require('jsonwebtoken');
    const foreign = jwt.sign({ typ: 'crew-discord-state', slug: 'baw', intent: 'login' }, 'a-different-secret');
    check('a state signed with somebody else’s secret is refused', d.readState(foreign) === null);

    // And a token of a DIFFERENT kind, signed with the right secret, must not
    // pass for a state — which is the whole reason every token here is typed.
    const wrongType = jwt.sign({ typ: 'crew', slug: 'baw' }, process.env.JWT_SECRET);
    check('a session token cannot be spent as a state', d.readState(wrongType) === null);
}

/* --------------------------------------------------------------- the handoff */
{
    const h = d.signHandoff({ slug: 'baw', sub: 'acct-7' });
    const back = d.readHandoff(h);
    check('the handoff names the account and the crew center', back.sub === 'acct-7' && back.slug === 'baw');

    const jwt = require('jsonwebtoken');
    /* It is worth NINETY SECONDS, because it exists for one redirect and one
       immediate POST. That is the property that makes it safe to put in a URL
       fragment at all. */
    const ttl = jwt.decode(h).exp - jwt.decode(h).iat;
    check('…and is worth a minute and a half, not a week', ttl > 0 && ttl <= 120, ttl);

    check('a forged handoff is refused', d.readHandoff('nope') === null);
    // A state and a handoff are both our own signed tokens. Neither may be
    // spent as the other.
    check('a state cannot be spent as a handoff',
        d.readHandoff(d.signState({ slug: 'baw', intent: 'login' })) === null);
    check('a handoff cannot be spent as a state', d.readState(h) === null);
    // The thing it is a stand-in for must never be the thing itself.
    const session = jwt.sign({ typ: 'crew', sub: 'acct-7' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    check('a session token is not a handoff', d.readHandoff(session) === null);
}

/* --------------------------------------------------------------- the profile */
{
    const p = d.profileFrom({ id: '80351110224678912', username: 'rae', global_name: 'Rae M', avatar: 'abc123' });
    check('a Discord user reads back as an id and some labels', p.id === '80351110224678912');
    check('…the handle and the display name both, because they answer different questions',
        p.username === 'rae' && p.globalName === 'Rae M');
    check('what the crew center shows is the display name', d.displayName(p) === 'Rae M');
    check('…falling back to the handle', d.displayName({ username: 'rae' }) === 'rae');

    /* THE ID IS THE IDENTITY. Everything else is a label Discord lets people
       change whenever they like, so it is stored to be shown and never matched
       on — which is why a profile with no usable id is no profile at all. */
    check('a profile with no id is refused outright', d.profileFrom({ username: 'rae' }) === null);
    check('…and so is one whose id is not a Discord id', d.profileFrom({ id: 'or 1=1' }) === null);
    check('…including one dressed up to look like one', d.profileFrom({ id: '123; drop' }) === null);
    check('nothing at all is refused', d.profileFrom(null) === null && d.profileFrom(undefined) === null);

    // Long junk in a label cannot become long junk in a database column.
    const long = d.profileFrom({ id: '80351110224678912', username: 'x'.repeat(500), avatar: 'y'.repeat(500) });
    check('a label is bounded before it is ever stored',
        long.username.length <= 40 && long.avatar.length <= 64);

    check('an avatar is a Discord CDN address',
        d.avatarUrl(p) === 'https://cdn.discordapp.com/avatars/80351110224678912/abc123.png?size=64', d.avatarUrl(p));
    check('…animated where it is animated',
        d.avatarUrl({ id: '80351110224678912', avatar: 'a_abc' }).endsWith('.gif?size=64'));
    check('a pilot with no avatar gets nothing rather than a broken image',
        d.avatarUrl({ id: '80351110224678912', avatar: '' }) === '' && d.avatarUrl(null) === '');
}

/* --------------------------------------------- what the module cannot do */
{
    /* The property this whole feature rests on: it is a second key to an
       existing door. There is no function here that writes an account, and
       nothing that turns a Discord identity into one. If a name like this ever
       appears, the review that added it needs to have been about exactly that. */
    const surface = Object.keys(d);
    const creates = surface.filter(k => /create|claim|provision|register|signup|upsert/i.test(k));
    check('nothing in the module can create or claim an account', creates.length === 0, creates);
}

/* -------------------------------------------------- the store's one lookup */
{
    const crewStore = require('../crewStore');
    check('the schema version moved for the Discord columns',
        crewStore.EXPECTED_SCHEMA_VERSION >= 16 && crewStore.DISCORD_SCHEMA_VERSION === 16);

    /* A Discord id reaches the store as a PostgREST filter value. The bound is
       here as well as at the edge because this is the last thing between a
       value and a query. A lookup that cannot be a Discord id must answer
       "nobody" without asking the database at all. */
    const store = Object.create(crewStore.SupabaseStore.prototype);
    let asked = false;
    store.accounts = (fn) => { asked = true; return fn(); };
    store.one = () => { asked = true; return Promise.resolve(null); };
    store.scope = {};
    Promise.resolve()
        .then(() => store.getAccountByDiscord('or 1=1'))
        .then((r) => {
            check('a lookup for something that is not a Discord id never reaches the database',
                r === null && asked === false);
            // …and the guard is a guard, not a wall: a real id does go through,
            // or the check above would pass on a function that never works.
            return store.getAccountByDiscord('80351110224678912');
        })
        .then(() => {
            check('a real Discord id is looked up', asked === true);
            done();
        })
        .catch((err) => { fails.push('store lookup threw — ' + err.message); done(); });
}

function done() {
    if (fails.length) {
        console.log(`${pass} passed, ${fails.length} failed`);
        fails.forEach((f) => console.log('  FAIL  ' + f));
        process.exit(1);
    }
    console.log(`${pass} passed, 0 failed`);
}
