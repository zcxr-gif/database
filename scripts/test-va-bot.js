// test-va-bot.js
// The bot inside each VA's own Discord server (vaBot.js).
//
// What this file holds the module to:
//
//   * a link code is typeable, single-shape, and compared by hash, however it
//     was typed back
//   * the bot principal exists ONLY on a loopback request carrying this
//     process's key and naming the route's own airline — and is held to
//     BOT_CAPS
//   * the application built in Discord is the body /apply already accepts
//   * nothing the bot keeps in memory can grow without bound
//   * a hub listener that throws never reaches the request that emitted
//
// Run:  node scripts/test-va-bot.js
const http = require('http');
const express = require('express');
const { PermissionsBitField } = require('discord.js');
const v = require('../vaBot');

let pass = 0;
const fails = [];
const check = (what, ok, extra) => {
    if (ok) pass++;
    else fails.push(what + (extra === undefined ? '' : ` — ${JSON.stringify(extra)}`));
};

/* ------------------------------------------------------------- link codes */
{
    const codes = new Set();
    for (let i = 0; i < 200; i++) codes.add(v.makeLinkCode());
    const one = [...codes][0];
    check('a code is XXXX-XXXX', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(one), one);
    check('…with no 0/O/1/I/L to misread', [...codes].every((c) => !/[01OIL]/.test(c)));
    check('200 codes are 200 different codes', codes.size === 200, codes.size);
    check('typed back lower-case with spaces, it is the same code',
        v.hashCode(one.toLowerCase().replace('-', ' ')) === v.hashCode(one));
    check('a different code hashes differently', v.hashCode('AAAA-BBBB') !== v.hashCode('AAAA-BBBC'));
    check('the hash is not the code', !v.hashCode(one).includes(v.normalizeCode(one)));
}

/* ---------------------------------------------------------- component ids */
{
    const id = v.cid('accept', '0123456789abcdef01234567');
    check('ids are namespaced vab:', id === 'vab:accept:0123456789abcdef01234567');
    const p = v.parseCid(id);
    check('…and parse back', p && p.action === 'accept' && p.args[0] === '0123456789abcdef01234567', p);
    check('an id that is not ours is not parsed', v.parseCid('ticket_open') === null && v.parseCid('') === null);
    check('an id never exceeds Discord’s 100', v.cid('x', 'y'.repeat(200)).length === 100);
}

/* ----------------------------------------------------------------- the form */
const join = {
    mode: 'application',
    minGrade: 2,
    form: [
        { label: 'Why do you want to join?', type: 'textarea', required: true },
        { label: 'Region', type: 'select', options: ['Europe', 'Americas', 'Asia'], required: true },
        { label: 'Q3', type: 'text' }, { label: 'Q4', type: 'text' }, { label: 'Q5', type: 'text' },
        { label: 'Q6', type: 'text' },
    ],
    requirements: [{ type: 'hours', value: 100 }, { type: 'agree', label: 'I have read the SOP', required: true }],
    callsign: { airlines: [{ base: 'AEROMEXICO', tag: 'MX', sample: 'AEROMEXICO 001MX' }, { base: 'CONNECT', tag: 'C', sample: 'CONNECT 001C' }] },
};
{
    check('no questions is one page', v.pageCount([]) === 1);
    check('six questions is our page plus two', v.pageCount(join.form) === 3);
    const p2 = v.pageQuestions(join.form, 2);
    check('page 2 holds question six, by its real index', p2.length === 1 && p2[0].index === 5, p2);
    check('page 0 holds none of the airline’s questions', v.pageQuestions(join.form, 0).length === 0);

    check('a select answer matches its option, whatever the case', v.matchOption(join.form[1], 'europe').value === 'Europe');
    check('…and an answer that is not an option is refused', v.matchOption(join.form[1], 'Mars').ok === false);
    check('a text answer is taken as typed', v.matchOption(join.form[0], ' hi ').value === 'hi');

    const airlines = join.callsign.airlines;
    check('one airline needs no choosing', v.pickAirline([airlines[0]], '') === 'AEROMEXICO');
    check('two airlines: by name', v.pickAirline(airlines, 'connect') === 'CONNECT');
    check('…or by tag', v.pickAirline(airlines, 'mx') === 'AEROMEXICO');
    check('…and a blank is not a guess', v.pickAirline(airlines, '') === null);

    const draft = { ifcName: '@Pilot_One', callsignNumber: '123', airline: 'mx', email: '', answers: ['Because', 'Europe'] };
    check('a complete draft has no problems', v.draftProblems(draft, join).length === 0, v.draftProblems(draft, join));
    const missing = v.draftProblems({ ...draft, answers: ['', 'Europe'] }, join);
    check('a missing required answer is named', missing.length === 1 && missing[0].includes('Why do you want'), missing);
    check('two airlines and none picked is a problem', v.draftProblems({ ...draft, airline: '' }, join).length === 1);

    const body = v.applyBody(draft, join);
    check('the IFC name loses its @', body.ifcName === 'Pilot_One');
    check('the airline is sent as its base', body.callsignPrefix === 'AEROMEXICO');
    check('every question goes, answered or not, in order', body.answers.length === 6 && body.answers[1].a === 'Europe' && body.answers[5].a === '');
    check('submitting under the terms ticks every agreement', body.agreed.length === 1 && body.agreed[0] === 'I have read the SOP');

    const reqs = v.describeRequirements(join);
    check('requirements read as words, minGrade folded in', reqs.includes('100+ flight hours') && reqs.includes('Grade 2+'), reqs);
    check('an agreement is not listed as a requirement', !reqs.some((r) => /SOP/.test(r)));
    check('a long question label fits Discord’s 45', v.shortLabel('x'.repeat(80)).length === 45);
}

/* ----------------------------------------------------------------- who is staff */
{
    const perms = (bits) => new PermissionsBitField(bits);
    const asMember = (roles, bits = []) => ({ memberPermissions: perms(bits), member: { roles } });
    const s = { staffRoleId: '111111' };
    check('the staff role is staff', v.isStaff(asMember(['111111']), s));
    check('…from a cached member too', v.isStaff({ memberPermissions: perms([]), member: { roles: { cache: new Map([['111111', {}]]) } } }, s));
    check('Manage Server is staff', v.isStaff(asMember([], [PermissionsBitField.Flags.ManageGuild]), s));
    check('anybody else is not', !v.isStaff(asMember(['222222']), s));
    check('no staff role set and no Manage Server: not staff', !v.isStaff(asMember(['111111']), {}));
}

/* ------------------------------------------------------------- bounded memory */
{
    const cd = v.makeCooldown(1000, 50);
    check('first hit passes', cd.hit('a', 0) === 0);
    check('second hit inside the window waits', cd.hit('a', 500) === 1);
    check('after the window it passes again', cd.hit('a', 1500) === 0);
    for (let i = 0; i < 500; i++) cd.hit(`k${i}`, 2000);
    check('a flood of keys never grows past the cap', cd.size() <= 50, cd.size());

    const c = v.makeCache(1000, 10);
    c.set('x', 1, 0);
    check('cached within the TTL', c.get('x', 500) === 1);
    check('gone after it', c.get('x', 1500) === undefined);
    for (let i = 0; i < 100; i++) c.set(`k${i}`, i, 0);
    check('the cache never grows past its cap', c.size() <= 10, c.size());
    c.set('n', null, 0);
    check('a remembered "no" is not a miss', c.get('n', 1) === null);
}

/* ------------------------------------------------------------------- misc */
{
    check('thread names are safe and prefixed', v.threadName('apply', 'Some User!!') === 'apply-some-user');
    check('support tickets are help-', v.threadName('support', '') === 'help-pilot');
    process.env.DISCORD_CLIENT_ID = '999';
    const url = v.inviteUrl();
    const perms = new PermissionsBitField(BigInt(new URL(url).searchParams.get('permissions')));
    check('the invite asks for private threads and roles',
        perms.has(PermissionsBitField.Flags.CreatePrivateThreads) && perms.has(PermissionsBitField.Flags.ManageRoles));
    check('…and never Administrator', !perms.has(PermissionsBitField.Flags.Administrator));
    const e = v.eventEmbed({ name: 'Test VA', slug: 'test', crewAccent: '#ff0000' },
        { title: 'Fly-in', origin: 'EGLL', destination: 'KJFK', startsAt: '2030-01-01T12:00:00Z', bannerUrl: 'javascript:alert(1)' }, 'published').toJSON();
    check('an event embed carries the leg and a Discord timestamp',
        e.fields.some((f) => f.value === 'EGLL → KJFK') && e.fields.some((f) => /<t:\d+:F>/.test(f.value)));
    check('…and drops a banner that is not https', !e.image);
}

/* ------------------------------------------------------ one at a time */
async function locksAndLimits() {
    const { makeLocks, makeLimiter } = v;
    const locks = makeLocks();
    const order = [];
    const slow = (tag, ms) => async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); };
    check('a free key is not busy', !locks.busy('t'));
    const a = locks.run('t', slow('a', 30));
    check('…and is busy the moment it is claimed', locks.busy('t'));
    const b = locks.run('t', slow('b', 5));
    const c = locks.run('other', slow('c', 5));
    await Promise.all([a, b, c]);
    check('the same key runs one after the other', order.indexOf('a-') < order.indexOf('b+'), order);
    check('a different key does not wait', order.indexOf('c+') < order.indexOf('a-'), order);
    check('a finished key is let go', !locks.busy('t') && locks.size() === 0);
    const boom = locks.run('t', async () => { throw new Error('x'); });
    let caught = false;
    await boom.catch(() => { caught = true; });
    check('a failure reaches its caller…', caught);
    let after = false;
    await locks.run('t', async () => { after = true; });
    check('…and does not jam the key for the next one', after && locks.size() === 0);

    const lim = makeLimiter(3, { queueMax: 5, waitMs: 200 });
    let now = 0; let peak = 0;
    const job = () => lim.run(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 20)); now--; return 'done'; }, 'busy');
    const out = await Promise.all(Array.from({ length: 8 }, job));
    check('the limiter never runs more than its max', peak === 3, peak);
    check('…and finishes everything it queued', out.every((x) => x === 'done'), out);
    const flood = await Promise.all(Array.from({ length: 20 }, job));
    check('past its queue it answers busy at once instead of growing', flood.filter((x) => x === 'busy').length === 12, flood.filter((x) => x === 'busy').length);
    const stuck = makeLimiter(1, { queueMax: 5, waitMs: 50 });
    const hold = stuck.run(() => new Promise((r) => setTimeout(r, 300)), 'busy');
    check('a wait that runs out is busy, not forever', (await stuck.run(async () => 'ran', 'busy')) === 'busy');
    await hold;
    check('…and leaves nothing queued behind it', stuck.stats().active === 0 && stuck.stats().queued === 0, stuck.stats());
}

/* ------------------------------------------------- the bot principal, for real */
async function principal() {
    const app = express();
    app.use(express.json());
    app.get('/api/crew/:slug/who', (req, res) => {
        const p = v.botCallerFrom(req, req.params.slug);
        res.json({ p, review: v.botMay('applications.review'), roster: v.botMay('roster.manage') });
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    v.configure({ apiBase: `http://127.0.0.1:${port}` });

    const asBot = await v.api('get', '/api/crew/my-va/who', { asBot: true, slug: 'My-VA', actor: 'Capt. Smith\r\n' });
    check('the bot on loopback with its key is the bot', asBot.ok && asBot.data.p && asBot.data.p.kind === 'discord-bot', asBot.data);
    check('…named for the person who pressed the button, newlines gone', asBot.data.p && asBot.data.p.name === 'Capt. Smith (Discord)', asBot.data.p);
    check('…allowed to review applications', asBot.data.review === true);
    check('…and nothing else', asBot.data.roster === false && v.BOT_CAPS.size === 1);

    const anon = await v.api('get', '/api/crew/my-va/who');
    check('without the key it is nobody', anon.ok && anon.data.p === null);

    const other = await v.api('get', '/api/crew/other-va/who', { asBot: true, slug: 'my-va' });
    check('the key for one airline does not open another', other.ok && other.data.p === null);

    const forged = await new Promise((resolve) => {
        const h = { ...v.callerHeaders('my-va', 'x') };
        h['x-inflight-bot-key'] = 'f'.repeat(64);
        http.get({ host: '127.0.0.1', port, path: '/api/crew/my-va/who', headers: h }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
        });
    });
    check('a guessed key of the right length is nobody', forged.p === null);

    const fakeReq = (ip) => ({ headers: v.callerHeaders('my-va', ''), socket: { remoteAddress: ip } });
    check('the pilot header rides only with a real Discord id', v.callerHeaders('my-va', '', '123456789')['x-inflight-bot-pilot'] === '123456789'
        && !('x-inflight-bot-pilot' in v.callerHeaders('my-va', '', 'nope')));
    check('…and is read back only when it is one', v.botPilotFrom({ headers: { 'x-inflight-bot-pilot': '123456789' } }) === '123456789'
        && v.botPilotFrom({ headers: { 'x-inflight-bot-pilot': '1 OR 1=1' } }) === '' && v.botPilotFrom({}) === '');
    check('the right key from off the box is nobody', v.botCallerFrom(fakeReq('203.0.113.9'), 'my-va') === null);
    check('…and from IPv6 loopback it is the bot', !!v.botCallerFrom(fakeReq('::1'), 'my-va'));

    // A redirect must not carry the key anywhere.
    let leaked = null;
    const elsewhere = http.createServer((req, res) => { leaked = req.headers['x-inflight-bot-key'] || ''; res.end('{}'); });
    await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
    app.get('/api/crew/:slug/bounce', (req, res) => res.redirect(`http://127.0.0.1:${elsewhere.address().port}/catch`));
    const bounced = await v.api('get', '/api/crew/my-va/bounce', { asBot: true, slug: 'my-va' });
    check('a redirect is not followed', bounced.status === 302 && leaked === null, { status: bounced.status, leaked });
    elsewhere.close();

    const down = await (v.configure({ apiBase: 'http://127.0.0.1:1' }), v.api('get', '/x'));
    check('a crew center that does not answer is an error, not a throw', down.ok === false && down.status === 0 && !!down.error);
    server.close();
}

/* --------------------------------------------------------------------- hub */
async function hubNeverThrows() {
    let reached = false;
    v.hub.on('t', () => { throw new Error('boom'); });
    v.hub.on('t', () => { reached = true; });
    const origError = console.error;
    console.error = () => {};
    let threw = false;
    try { v.hub.emit('t', {}); } catch { threw = true; }
    v.hub.emit('nobody-listens', {});
    await new Promise((r) => setTimeout(r, 20));
    console.error = origError;
    check('emit never throws into the caller', !threw);
    check('one listener failing does not stop the next', reached);
}

/* ------------------------------------------------------------- welcome */
{
    const t = v.renderWelcome('Hi {user} — welcome to {server}, home of {AIRLINE}. You are #{members}. {nope}', { userId: '123456', server: 'Test HQ', airline: 'Test Air', members: 1234 });
    check('placeholders are filled, case-insensitively', t === 'Hi <@123456> — welcome to Test HQ, home of Test Air. You are #1,234. {nope}', t);
    check('no message means the default, which names the airline', /Test Air/.test(v.renderWelcome('', { airline: 'Test Air' })));
    check('a welcome never exceeds Discord’s 2000', v.renderWelcome('{airline}'.repeat(200), { airline: 'x'.repeat(100) }).length <= 2000);
}

/* ---------------------------------------------------------- inactivity */
{
    const DAY = 24 * 3600 * 1000;
    const now = Date.parse('2026-10-01T00:00:00Z');
    const ago = (d) => new Date(now - d * DAY).toISOString();
    const P = (id, o = {}) => ({ discordId: String(100000 + id), memberId: `m${id}`, status: 'active', staff: false, lastFlightAt: null, joinedAt: ago(400), ...o });

    check('flew last week: active', !v.isDormant(P(1, { lastFlightAt: ago(7) }), now, 30));
    check('flew 31 days ago: quiet', v.isDormant(P(1, { lastFlightAt: ago(31) }), now, 30));
    check('never flew, joined 40 days ago: quiet', v.isDormant(P(1, { joinedAt: ago(40) }), now, 30));
    check('never flew, joined 10 days ago: not yet', !v.isDormant(P(1, { joinedAt: ago(10) }), now, 30));
    check('nothing to count from is not quiet', !v.isDormant(P(1, { joinedAt: null }), now, 30));
    check('leave of absence is never quiet', !v.isDormant(P(1, { status: 'loa', lastFlightAt: ago(300) }), now, 30));
    check('staff are never quiet', !v.isDormant(P(1, { staff: true, lastFlightAt: ago(300) }), now, 30));
    check('roster says inactive, nothing else to go on: quiet', v.isDormant(P(1, { status: 'inactive', joinedAt: null }), now, 30));
    check('…unless they flew yesterday — flying wins', !v.isDormant(P(1, { status: 'inactive', lastFlightAt: ago(1) }), now, 30));

    const pilots = [
        P(1, { lastFlightAt: ago(2) }),             // flying
        P(2, { lastFlightAt: ago(45) }),            // newly quiet
        P(3, { lastFlightAt: ago(90) }),            // flagged long ago, past kick
        P(4, { lastFlightAt: ago(60) }),            // flagged, a week left
        P(5, { lastFlightAt: ago(1) }),             // flagged, flew again
        P(6, { lastFlightAt: ago(200), staff: true }),
        P(7, { lastFlightAt: ago(35) }), P(7, { lastFlightAt: ago(35) }), // a duplicate row
        { discordId: 'not-a-snowflake', lastFlightAt: ago(99) },
    ];
    const rec = (id, o) => ({ userId: String(100000 + id), status: 'inactive', ...o });
    const flagged = [
        rec(3, { since: ago(40), kickAt: ago(10) }),
        rec(4, { since: ago(25), kickAt: new Date(now + 5 * DAY).toISOString() }),
        rec(5, { since: ago(10), kickAt: new Date(now + 20 * DAY).toISOString() }),
    ];
    const ids = (l) => l.map((x) => x.pilot.discordId.slice(-1)).sort().join('');
    let plan = v.activityPlan({ pilots, flagged, now, inactiveDays: 30, kickDays: 30 });
    check('newly quiet pilots are flagged, longest-quiet first, once each', ids(plan.flag) === '27' && plan.flag[0].pilot.discordId.endsWith('2'), ids(plan.flag));
    check('…each with a removal date a month out', plan.flag.every((f) => f.kickAt && f.kickAt.getTime() === now + 30 * DAY));
    check('past the deadline: removed', ids(plan.kick) === '3', ids(plan.kick));
    check('a week left: reminded', ids(plan.remind) === '4', ids(plan.remind));
    check('flew since being flagged: welcomed back', ids(plan.restore) === '5', ids(plan.restore));
    check('staff and bad ids are left alone', !JSON.stringify(plan).includes('100006') && !JSON.stringify(plan).includes('not-a-snowflake'));

    plan = v.activityPlan({ pilots, flagged, now, inactiveDays: 30, kickDays: 0 });
    check('with removal off, nobody is removed or reminded', !plan.kick.length && !plan.remind.length && plan.flag.every((f) => f.kickAt === null));
    plan = v.activityPlan({ pilots, flagged: [rec(4, { since: ago(25), kickAt: new Date(now + 5 * DAY).toISOString(), remindedAt: ago(1) })], now, inactiveDays: 30, kickDays: 30 });
    check('a reminder is sent once', !plan.remind.length);
    plan = v.activityPlan({ pilots: [P(9, { lastFlightAt: ago(100) })], flagged: [rec(9, { status: 'kicked', since: ago(80) })], now, inactiveDays: 30, kickDays: 30 });
    check('somebody already removed (and back) starts afresh', plan.flag.length === 1 && !plan.kick.length);
}

/* ----------------------------------------------------- who the bot sees */
{
    const now = Date.parse('2026-10-01T00:00:00Z');
    const members = [
        { _id: 'm1', name: 'Rae', callsign: 'TST001', status: 'active', createdAt: '2026-01-01' },
        { _id: 'm2', name: 'Kai', callsign: 'TST002', status: 'active', role: 'Events manager' },
        { _id: 'm3', name: 'Ola', callsign: 'TST003', status: 'loa', loaUntil: '2026-09-01' },
        { _id: 'm4', name: 'Bo', callsign: 'TST004' },
    ];
    const accounts = [
        { _id: 'a1', memberId: 'm1', discordId: '111111', role: 'pilot', active: true },
        { _id: 'a2', memberId: 'm2', discordId: '222222', role: 'pilot', active: true },
        { _id: 'a3', memberId: 'm3', discordId: '333333', role: 'pilot', active: true },
        { _id: 'a4', memberId: 'm4', discordId: '', role: 'pilot', active: true },
        { _id: 'a5', memberId: 'm1', discordId: '555555', role: 'pilot', active: false },
        { _id: 'a6', memberId: 'gone', discordId: '666666', role: 'pilot', active: true },
    ];
    const pireps = [
        { memberId: 'm1', status: 'approved', flownAt: '2026-09-20' },
        { memberId: 'm1', status: 'pending', flownAt: '2026-09-30' },
    ];
    const out = v.linkedPilots({ accounts, members, pireps, now });
    const by = Object.fromEntries(out.pilots.map((p) => [p.discordId, p]));
    check('only active, linked logins with a roster row', Object.keys(by).sort().join(',') === '111111,222222,333333', Object.keys(by));
    check('…and the unlinked are counted', out.unlinked === 1, out.unlinked);
    check('the last APPROVED flight is what counts', by['111111'].lastFlightAt === new Date('2026-09-20').toISOString(), by['111111'].lastFlightAt);
    check('a job title on the roster makes them staff', by['222222'].staff === true && by['111111'].staff === false);
    check('a leave that has ended is over', by['333333'].status === 'active', by['333333'].status);
}

/* ------------------------------------------------------------- burst */
{
    const b = v.makeBurst(3, 1000);
    const r = [0, 1, 2, 3].map((i) => b.over('g', 1000 + i));
    check('a burst limit lets the first few through', r.join() === 'false,false,false,true', r);
    check('…and resets once the window passes', b.over('g', 5000) === false);
}

/* ------------------------------------------------- the bot's own routes */
async function botRoutes() {
    const app = express();
    app.use(express.json());
    const updates = [];
    const store = {
        listAccounts: async () => [{ _id: 'a1', memberId: 'm1', discordId: '111111', active: true }],
        listMembers: async () => [{ _id: 'm1', name: 'Rae', callsign: 'TST001', status: 'active' }],
        listPireps: async () => [],
        getAccountByDiscord: async (id) => (id === '111111' ? { _id: 'a1', memberId: 'm1', discordId: '111111', active: true } : id === '999999' ? { _id: 'aX', discordId: '999999', active: true } : null),
        getMember: async () => ({ _id: 'm1', name: 'Rae', callsign: 'TST001', status: 'active' }),
        getApplication: async (id) => ({ app1: { status: 'accepted', inviteAccountId: 'a2' }, app2: { status: 'pending' } }[id] || null),
        getAccount: async (id) => (id === 'a2' ? { _id: 'a2', discordId: '', active: true } : null),
        getAccountByUsername: async () => null,
        updateAccount: async (id, patch) => { updates.push({ id, patch }); return {}; },
    };
    v.registerRoutes(app, {
        requireCap: async () => ({ error: 403 }), resolveCrewVa: async () => null,
        resolveCrewStore: async () => ({ va: {}, store }),
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    v.configure({ apiBase: `http://127.0.0.1:${server.address().port}` });
    const bot = { asBot: true, slug: 'my-va' };

    const anon = await v.api('get', '/api/crew/my-va/discord-bot/pilots');
    check('nobody but the bot reads who is which Discord account', anon.status === 401, anon.status);
    const wrong = await v.api('get', '/api/crew/my-va/discord-bot/pilots', { asBot: true, slug: 'other-va' });
    check('…and the bot only for the airline it names', wrong.status === 401, wrong.status);
    const list = await v.api('get', '/api/crew/my-va/discord-bot/pilots', bot);
    check('the bot gets the linked pilots', list.ok && list.data.pilots.length === 1 && list.data.pilots[0].callsign === 'TST001', list.data);

    const one = await v.api('get', '/api/crew/my-va/discord-bot/pilot/111111', bot);
    check('a pilot is found by Discord id', one.ok && one.data.pilot && one.data.pilot.name === 'Rae', one.data);
    const none = await v.api('get', '/api/crew/my-va/discord-bot/pilot/222222', bot);
    check('…and nobody is nobody', none.ok && none.data.pilot === null);

    const linked = await v.api('post', '/api/crew/my-va/discord-bot/link-pilot', { ...bot, body: { applicationId: 'app1', discordId: '123456', username: 'rae', avatar: 'a_' + 'b'.repeat(32) } });
    check('accepting links the applicant’s Discord to their new login', linked.ok && linked.data.linked === true
        && updates.length === 1 && updates[0].id === 'a2' && updates[0].patch.discordId === '123456', { data: linked.data, updates });
    const pending = await v.api('post', '/api/crew/my-va/discord-bot/link-pilot', { ...bot, body: { applicationId: 'app2', discordId: '123456' } });
    check('…never for an application that is not accepted', pending.ok && pending.data.linked === false && updates.length === 1);
    const taken = await v.api('post', '/api/crew/my-va/discord-bot/link-pilot', { ...bot, body: { applicationId: 'app1', discordId: '999999' } });
    check('…and never a Discord already on another login', taken.ok && taken.data.linked === false && taken.data.reason === 'taken' && updates.length === 1, taken.data);
    server.close();
}

(async () => {
    await locksAndLimits();
    await principal();
    await hubNeverThrows();
    await botRoutes();
    if (fails.length) {
        console.error(`✗ ${fails.length} failed, ${pass} passed`);
        fails.forEach((f) => console.error('  ✗ ' + f));
        process.exit(1);
    }
    console.log(`✓ va bot: ${pass} checks passed`);
    process.exit(0);
})();
