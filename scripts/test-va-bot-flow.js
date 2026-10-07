// test-va-bot-flow.js
// One applicant, start to finish, through the VA bot — with Discord and the
// crew center both faked, and nothing else.
//
// Discord is a handful of objects that record what was sent to them. The crew
// center is a small express app on loopback that answers the five routes the
// bot calls, and checks on every staff route that the caller really is the
// bot (vaBot.botCallerFrom), exactly as server.js's requireCap does. Mongo is
// replaced by in-memory statics on the real models, so documents are real
// mongoose documents and only their persistence is pretend.
//
// The path held:
//   link the server → settings → open a ticket → two pages of form → submit
//   → staff send the test (an applicant may not) → the result arrives → auto-
//   invite accepts → the pilot role is given → only the pilot can read the
//   login → close.
//
// Run:  node scripts/test-va-bot-flow.js
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { PermissionsBitField } = require('discord.js');
const v = require('../vaBot');

let pass = 0;
const fails = [];
const check = (what, ok, extra) => {
    if (ok) pass++;
    else fails.push(what + (extra === undefined ? '' : ` — ${JSON.stringify(extra)}`));
};

/* ------------------------------------------------------------ in-memory Mongo */
const { VaBotGuild, VaBotLinkCode, VaBotTicket, VaBotEventPost, VaBotInactive } = v.models;
const plain = (d) => (d && d.toObject ? d.toObject() : d ? JSON.parse(JSON.stringify(d)) : d);
const q = (val) => {
    const p = Promise.resolve(val);
    return Object.assign(p, { lean: () => Promise.resolve(Array.isArray(val) ? val.map(plain) : plain(val)), limit: () => q(val), sort: () => q(val) });
};
const matches = (doc, f) => Object.entries(f).every(([k, want]) => {
    const have = k.split('.').reduce((o, p) => (o == null ? o : o[p]), doc);
    if (want && typeof want === 'object' && '$ne' in want) return have !== want.$ne;
    if (want && typeof want === 'object' && '$gt' in want) return have > want.$gt;
    return String(have) === String(want);
});

const guilds = [];
VaBotGuild.findOne = (f) => q(guilds.find((g) => matches(g, f)) || null);
VaBotGuild.find = (f) => q(guilds.filter((g) => matches(g, f)));
VaBotGuild.updateOne = async (f, { $set }) => {
    let g = guilds.find((x) => matches(x, f));
    if (!g) { g = { guildId: f.guildId, settings: { staffRoleId: '', pilotRoleId: '', ticketChannelId: '', logChannelId: '', eventsChannelId: '', autoInvite: false } }; guilds.push(g); }
    Object.assign(g, $set);
    return { acknowledged: true };
};
VaBotGuild.findOneAndUpdate = (f, { $set }) => {
    const g = guilds.find((x) => matches(x, f));
    for (const [k, val] of Object.entries($set)) { const [a, b] = k.split('.'); g[a][b] = val; }
    return q(g);
};

let liveCode = null;
VaBotLinkCode.findOne = (f) => q(liveCode && f.codeHash === liveCode.codeHash ? liveCode : null);
VaBotLinkCode.deleteOne = async (f) => {
    const hit = liveCode && String(f._id) === String(liveCode._id);
    if (hit) liveCode = null;
    return { deletedCount: hit ? 1 : 0 };
};

const tickets = [];
VaBotTicket.prototype.save = async function save() { if (!tickets.includes(this)) tickets.push(this); return this; };
VaBotTicket.create = async (data) => { const t = new VaBotTicket(data); await t.save(); return t; };
VaBotTicket.findOne = (f) => q(tickets.find((t) => matches(t, f)) || null);
VaBotTicket.find = (f) => q(tickets.filter((t) => matches(t, f)));
VaBotTicket.countDocuments = async (f) => tickets.filter((t) => matches(t, f)).length;

const inactive = [];
VaBotInactive.find = (f) => q(inactive.filter((r) => matches(r, f)));
VaBotInactive.deleteOne = async (f) => { const i = inactive.findIndex((r) => matches(r, f)); if (i >= 0) inactive.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
VaBotInactive.deleteMany = async (f) => { for (let i = inactive.length - 1; i >= 0; i--) if (matches(inactive[i], f)) inactive.splice(i, 1); return {}; };
VaBotInactive.updateOne = async (f, { $set }, opts = {}) => {
    let r = inactive.find((x) => matches(x, f));
    if (!r && opts.upsert) { r = { _id: new mongoose.Types.ObjectId(), ...f }; inactive.push(r); }
    if (r) Object.assign(r, $set);
    return {};
};

const eventPosts = [];
VaBotEventPost.findOne = (f) => q(eventPosts.find((e) => matches(e, f)) || null);
VaBotEventPost.create = async (d) => { eventPosts.push(d); return d; };

const vaId = new mongoose.Types.ObjectId();
const VA = { _id: vaId, name: 'Test Air', slug: 'test-air', status: 'approved', crewAccent: '#112233' };
const VirtualAirlineAd = { findById: () => ({ select: () => q(VA) }) };

/* ---------------------------------------------------------- fake crew center */
const calls = [];
let invite = null;
let rosterPilots = [];
let rosterDown = false;
// How slow the crew center is, and how many requests it is serving at once —
// the concurrency phase widens the window so races actually overlap.
const load = { delayMs: 0, inflight: 0, maxInflight: 0 };
function crewCenter() {
    const app = express();
    app.use(express.json());
    app.use(async (req, res, next) => {
        load.inflight++;
        load.maxInflight = Math.max(load.maxInflight, load.inflight);
        res.on('finish', () => { load.inflight--; });
        if (load.delayMs) await new Promise((r) => setTimeout(r, load.delayMs));
        next();
    });
    const staffOnly = (req, res, next) => {
        const p = v.botCallerFrom(req, req.params.slug);
        if (!p || !v.botMay('applications.review')) return res.status(401).json({ error: 'Not authenticated.' });
        req.actor = p.name;
        next();
    };
    app.get('/api/va-ads/by-slug/:slug', (req, res) => res.json({
        join: {
            mode: 'application', form: [{ label: 'Why us?', type: 'text', required: true }],
            requirements: [{ type: 'agree', label: 'I read the SOP' }],
            callsign: { airlines: [{ base: 'TEST', tag: 'T', sample: 'TEST 001T' }] },
        },
    }));
    app.post('/api/crew/:slug/apply', (req, res) => {
        calls.push({ path: 'apply', body: req.body });
        res.json({ status: 'pending', callsign: 'TEST 123T', applicationId: req.body.ifcName === 'Pilot_One' ? 'app1' : `app-${req.body.ifcName}`, ifVerified: true, grade: 3 });
    });
    app.get('/api/crew/:slug/entrance-tests', staffOnly, (req, res) => res.json({ quizzes: [{ id: 'q1', title: 'SOP test', passMark: 80 }] }));
    app.post('/api/crew/:slug/entrance-tests', staffOnly, (req, res) => {
        calls.push({ path: 'test', body: req.body, actor: req.actor });
        res.status(201).json({ test: { link: 'https://inflight.example/crew/test-air/test?t=abc', quizTitle: 'SOP test', passMark: 80 } });
    });
    app.patch('/api/crew/:slug/applications/:id', staffOnly, (req, res) => {
        calls.push({ path: 'review', id: req.params.id, body: req.body, actor: req.actor });
        invite = { state: 'live', username: 'pilot.one', password: 'Temp-Pass-123', signInUrl: 'https://inflight.example/crew/test-air' };
        res.json({ status: 'accepted', account: { username: 'pilot.one', password: 'Temp-Pass-123', created: true }, invite, signInUrl: invite.signInUrl });
    });
    app.get('/api/crew/:slug/applications/:id/invite', staffOnly, (req, res) => res.json({ invite }));
    app.get('/api/crew/:slug/discord-bot/pilots', staffOnly, (req, res) => (rosterDown ? res.status(503).json({ error: 'store down' }) : res.json({ pilots: rosterPilots, unlinked: 2 })));
    app.get('/api/crew/:slug/discord-bot/pilot/:id', staffOnly, (req, res) => res.json({ pilot: rosterPilots.find((p) => p.discordId === req.params.id) || null }));
    app.post('/api/crew/:slug/discord-bot/link-pilot', staffOnly, (req, res) => { calls.push({ path: 'link', body: req.body }); res.json({ linked: true }); });
    return http.createServer(app);
}

/* ------------------------------------------------------------- fake Discord */
const channels = new Map();
let nextId = 900000000000;
const roleAdds = [];
function fakeThread(parent) {
    const t = {
        id: String(nextId++), parentId: parent.id, sent: [], members: { add: async () => {} },
        locked: false, archived: false,
        send: async (m) => { t.sent.push(m); return { id: String(nextId++) }; },
        setLocked: async (x) => { t.locked = x; }, setArchived: async (x) => { t.archived = x; },
        toString: () => `<#${t.id}>`,
    };
    channels.set(t.id, t);
    return t;
}
const ticketChannel = {
    id: '500000000000', type: 0, sent: [],
    threads: { create: async () => fakeThread(ticketChannel) },
    send: async (m) => { ticketChannel.sent.push(m); return { id: String(nextId++) }; },
    toString: () => '<#500000000000>',
};
channels.set(ticketChannel.id, ticketChannel);
const logChannel = { id: '500000000001', type: 0, sent: [], send: async (m) => { logChannel.sent.push(m); return {}; } };
channels.set(logChannel.id, logChannel);

const GUILD = '7000';
// Members with real role sets, so a swap can be seen; `absent` are not in the server.
const memberState = new Map();
const absent = new Set();
const dms = [];
const stateOf = (id) => { if (!memberState.has(id)) memberState.set(id, { roles: new Set(), kicked: false }); return memberState.get(id); };
const guild = {
    id: GUILD, name: 'Test Air Discord', memberCount: 42,
    members: {
        me: { permissions: new PermissionsBitField([PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.ManageRoles]) },
        fetch: async (id) => {
            const st = stateOf(id);
            if (absent.has(id) || st.kicked) throw new Error('Unknown Member');
            return memberObj(id);
        },
    },
};
function memberObj(id) {
    const st = stateOf(id);
    return {
        id, guild, displayName: `u${id}`, kickable: true,
        user: { id, username: `u${id}`, bot: false, avatar: '', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        roles: {
            cache: { keys: () => st.roles.keys() },
            add: async (r) => { roleAdds.push({ id, r }); st.roles.add(r); },
            remove: async (r) => { st.roles.delete(r); },
        },
        kick: async () => { st.kicked = true; },
    };
}
const client = {
    channels: { fetch: async (id) => channels.get(id) || null },
    guilds: { cache: new Map([[GUILD, guild]]) },
    users: { fetch: async (id) => ({ send: async (p) => { dms.push({ id, p }); return {}; } }) },
};

const APPLICANT = { id: '111', username: 'pilot_one', tag: 'pilot_one' };
const STAFF = { id: '222', username: 'boss', tag: 'boss' };
const STAFF_ROLE = '3001';
const PILOT_ROLE = '3002';

function interaction(kind, { user = APPLICANT, roles = [], perms = [], customId, command, sub, options = {}, fields = {}, values } = {}) {
    const out = { replies: [], modal: null, deferred: false, replied: false };
    const it = {
        out, user, guildId: GUILD, customId, values, channelId: options.channelId,
        guild: { name: 'Test Air Discord' },
        channel: ticketChannel,
        member: { roles },
        memberPermissions: new PermissionsBitField(perms),
        inGuild: () => true,
        isChatInputCommand: () => kind === 'command',
        commandName: command,
        options: {
            getSubcommand: () => sub,
            getString: (n) => options[n] ?? null,
            getRole: (n) => options[n] ?? null,
            getChannel: (n) => options[n] ?? null,
            getBoolean: (n) => (n in options ? options[n] : null),
            getInteger: (n) => (n in options ? options[n] : null),
            getUser: (n) => options[n] ?? null,
        },
        fields: { getTextInputValue: (id) => { if (!(id in fields)) throw new Error('no field'); return fields[id]; } },
        reply: async (p) => { it.replied = true; out.replies.push(p); return p; },
        deferReply: async () => { it.deferred = true; },
        deferUpdate: async () => { it.deferred = true; },
        editReply: async (p) => { out.replies.push(typeof p === 'string' ? { content: p } : p); return p; },
        followUp: async (p) => { out.replies.push(p); return p; },
        showModal: async (m) => { out.modal = m.toJSON(); it.replied = true; },
    };
    return it;
}
const lastText = (it) => {
    const r = it.out.replies[it.out.replies.length - 1] || {};
    return String(r.content || '') + JSON.stringify(r.embeds || []);
};
const buttonIds = (msg) => (msg.components || []).flatMap((row) => (row.toJSON ? row.toJSON() : row).components).map((c) => c.custom_id || c.url);

/* --------------------------------------------------------------------- run */
(async () => {
    const server = crewCenter();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    v.configure({ apiBase: `http://127.0.0.1:${server.address().port}`, siteOrigin: 'https://inflight.example' });
    const bot = v.createVaBot({ client, VirtualAirlineAd, isHomeGuild: (id) => id === 'HOME' });
    const run = (it) => bot.handleInteraction(it);

    // Not linked yet: everything says how to link.
    let it = interaction('command', { command: 'crew', sub: 'links' });
    await run(it);
    check('an unlinked server is told to run setup', /crew-admin setup/.test(lastText(it)), lastText(it));
    check('…and where the setup guide is', lastText(it).includes('https://inflight.example/discord-bot'), lastText(it));

    // Setup without Manage Server is refused before the code is even read.
    const code = v.makeLinkCode();
    liveCode = { _id: 'code1', codeHash: v.hashCode(code), vaId };
    it = interaction('command', { command: 'crew-admin', sub: 'setup', options: { code } });
    await run(it);
    check('setup needs Manage Server', /Manage Server/.test(lastText(it)));

    it = interaction('command', { user: STAFF, perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'setup', options: { code: code.toLowerCase() } });
    await run(it);
    check('the right code links the server', /Linked to \*\*Test Air\*\*/.test(lastText(it)), lastText(it));
    check('…and the code is spent', liveCode === null);

    it = interaction('command', { user: STAFF, perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'settings', options: {
        staff_role: { id: STAFF_ROLE }, pilot_role: { id: PILOT_ROLE }, ticket_channel: ticketChannel, log_channel: logChannel, auto_invite: true,
    } });
    await run(it);
    check('settings are saved', guilds[0].settings.staffRoleId === STAFF_ROLE && guilds[0].settings.autoInvite === true, guilds[0].settings);

    it = interaction('command', { user: STAFF, perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'panel', options: {} });
    await run(it);
    const panel = ticketChannel.sent[ticketChannel.sent.length - 1];
    check('the panel is posted with Apply', panel && buttonIds(panel).includes('vab:open:apply'), lastText(it));
    check('…and remembered, for the setup guide', !!guilds[0].panelAt && v.guildSummary(guilds[0]).panel === true);

    // The applicant opens a ticket from the panel.
    it = interaction('button', { customId: 'vab:open:apply' });
    await run(it);
    const ticket = tickets[0];
    const thread = ticket && channels.get(ticket.threadId);
    check('a ticket thread opens', !!thread && /ticket is open/.test(lastText(it)), lastText(it));
    check('…with a Start button for the applicant', thread && buttonIds(thread.sent[0]).includes(`vab:form:${ticket._id}:0`));

    it = interaction('button', { customId: 'vab:open:apply' });
    await run(it);
    check('a second click inside the cooldown waits', /Give it/.test(lastText(it)), lastText(it));

    // Page 1 of 2.
    it = interaction('button', { customId: `vab:form:${ticket._id}:0` });
    await run(it);
    check('page one is a modal with name, callsign and email (one airline: no airline box)',
        it.out.modal && it.out.modal.components.length === 3, it.out.modal && it.out.modal.components.length);

    it = interaction('button', { user: STAFF, customId: `vab:form:${ticket._id}:0` });
    await run(it);
    check('nobody else can fill the form in', /Only the applicant/.test(lastText(it)));

    it = interaction('modal', { customId: `vab:formsub:${ticket._id}:0`, fields: { ifc: '@Pilot_One', num: '12a3', email: '' } });
    await run(it);
    check('page one saved, page two next', /Part 2 of 2/.test(lastText(it)), lastText(it));
    check('…the callsign kept to digits', ticket.draft.callsignNumber === '123', ticket.draft.callsignNumber);

    it = interaction('modal', { customId: `vab:formsub:${ticket._id}:1`, fields: { q0: 'Great airline' } });
    await run(it);
    const review = it.out.replies[0];
    check('the review lists the agreement', /I read the SOP/.test(JSON.stringify(review.embeds)), review);
    check('…and offers submit', buttonIds(review).includes(`vab:submit:${ticket._id}`));

    it = interaction('button', { customId: `vab:submit:${ticket._id}` });
    await run(it);
    const applied = calls.find((c) => c.path === 'apply');
    check('the application reached /apply', !!applied);
    check('…as the body /apply expects', applied && applied.body.ifcName === 'Pilot_One' && applied.body.callsignPrefix === 'TEST'
        && applied.body.callsignNumber === '123' && applied.body.answers[0].a === 'Great airline' && applied.body.agreed[0] === 'I read the SOP', applied && applied.body);
    check('the ticket now carries the application', ticket.applicationId === 'app1' && ticket.stage === 'submitted');
    check('…and the draft answers are gone', ticket.draft.answers.length === 0);
    const staffMsg = thread.sent[thread.sent.length - 1];
    check('staff are pinged with the controls', staffMsg.content === `<@&${STAFF_ROLE}>` && buttonIds(staffMsg).includes(`vab:test:${ticket._id}`));

    // The applicant cannot send themselves the test or accept themselves.
    it = interaction('button', { customId: `vab:test:${ticket._id}` });
    await run(it);
    check('an applicant cannot send the test', /Only staff/.test(lastText(it)));
    it = interaction('button', { customId: `vab:accept:${ticket._id}` });
    await run(it);
    check('…or accept themselves', /Only staff/.test(lastText(it)));

    it = interaction('button', { user: STAFF, roles: [STAFF_ROLE], customId: `vab:test:${ticket._id}` });
    await run(it);
    const sentTest = calls.find((c) => c.path === 'test');
    check('staff send the test through the crew center, as the bot', sentTest && sentTest.body.applicationId === 'app1' && sentTest.actor === 'boss (Discord)', sentTest);
    const testMsg = thread.sent[thread.sent.length - 1];
    check('…and the applicant gets a link button', buttonIds(testMsg).includes('https://inflight.example/crew/test-air/test?t=abc'));

    // The result comes back; auto-invite is on.
    v.hub.emit('entranceTest', { vaId, applicationId: 'app1', passed: true, score: 9, total: 10, percent: 90, quizTitle: 'SOP test' });
    await new Promise((r) => setTimeout(r, 300));
    const review2 = calls.find((c) => c.path === 'review');
    check('a pass with auto-invite accepts with a login', review2 && review2.body.action === 'accept' && review2.body.createAccount === true, review2);
    check('…recorded as auto-invite', review2 && review2.actor === 'Auto-invite (Discord)', review2 && review2.actor);
    check('the pilot role is given', roleAdds.some((x) => x.id === APPLICANT.id && x.r === PILOT_ROLE), roleAdds);
    const linkCall = calls.find((c) => c.path === 'link');
    check('…and their Discord is linked to the new login', linkCall && linkCall.body.discordId === APPLICANT.id && linkCall.body.applicationId === 'app1', linkCall);
    const welcome = thread.sent[thread.sent.length - 1];
    check('the welcome offers Show my login', buttonIds(welcome).includes(`vab:login:${ticket._id}`), buttonIds(welcome));
    check('…and never prints the password in the thread', !thread.sent.some((m) => JSON.stringify(m).includes('Temp-Pass-123')));
    check('…and tells them Discord sign-in already works', /already linked/.test(JSON.stringify(welcome.embeds)));

    it = interaction('button', { user: STAFF, roles: [STAFF_ROLE], customId: `vab:login:${ticket._id}` });
    await run(it);
    check('staff cannot open the pilot’s login', /Only the pilot/.test(lastText(it)) && !lastText(it).includes('Temp-Pass'));
    it = interaction('button', { customId: `vab:login:${ticket._id}` });
    await run(it);
    check('the pilot reads their login', lastText(it).includes('pilot.one') && lastText(it).includes('Temp-Pass-123'), lastText(it));

    const reviews = calls.filter((c) => c.path === 'review').length;
    it = interaction('button', { user: STAFF, roles: [STAFF_ROLE], customId: `vab:accept:${ticket._id}` });
    await run(it);
    check('a second Accept after auto-invite does nothing', /Already accepted/.test(lastText(it)) && calls.filter((c) => c.path === 'review').length === reviews, lastText(it));

    it = interaction('button', { customId: `vab:close:${ticket._id}` });
    await run(it);
    check('closing locks and archives the thread', ticket.status === 'closed' && thread.locked && thread.archived);
    it = interaction('button', { customId: `vab:accept:${ticket._id}` });
    await run(it);
    check('a closed ticket takes no more actions', /closed/.test(lastText(it)));

    // A ticket id from another server is not found.
    it = interaction('button', { customId: `vab:close:${ticket._id}` });
    it.guildId = 'OTHER';
    guilds.push({ guildId: 'OTHER', vaId, settings: {} });
    await run(it);
    check('a ticket is only reachable from its own server', /no longer exists/.test(lastText(it)), lastText(it));

    // A server already linked to another airline is refused, and the code
    // survives for the owner to use after unlinking.
    const otherVa = new mongoose.Types.ObjectId();
    guilds.push({ guildId: 'TAKEN', vaId: otherVa, settings: {} });
    const code2 = v.makeLinkCode();
    liveCode = { _id: 'code2', codeHash: v.hashCode(code2), vaId };
    it = interaction('command', { perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'setup', options: { code: code2 } });
    it.guildId = 'TAKEN';
    await run(it);
    check('a server linked to another airline is refused', /already linked to another/.test(lastText(it)), lastText(it));
    check('…and the code is not spent', liveCode && liveCode._id === 'code2');
    it = interaction('command', { perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'setup', options: { code: code2 } });
    it.guildId = 'TAKEN';
    await run(it);
    check('a second try straight away waits', /try again in/.test(lastText(it)), lastText(it));

    // Inflight's own server cannot be linked to an airline.
    it = interaction('command', { perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin', sub: 'setup', options: { code: 'AAAA-BBBB' } });
    it.guildId = 'HOME';
    await run(it);
    check('the home server refuses setup', /Inflight’s own server/.test(lastText(it)));

    /* ---- a help ticket: open, close with a reason, reopen ---------------- */
    const ADMIN = { user: STAFF, perms: [PermissionsBitField.Flags.ManageGuild], command: 'crew-admin' };
    const HELP = { id: '555000000', username: 'needs_help', tag: 'needs_help' };
    it = interaction('button', { user: HELP, customId: 'vab:open:support' });
    await run(it);
    check('Contact staff asks what it is about first', it.out.modal && it.out.modal.custom_id === 'vab:opensub:support', it.out.modal);
    it = interaction('modal', { user: HELP, customId: 'vab:opensub:support', fields: { topic: 'Can’t sign in', details: 'It says wrong password' } });
    await run(it);
    const help = tickets.find((t) => t.userId === HELP.id);
    const helpThread = help && channels.get(help.threadId);
    check('a help ticket opens with its topic', help && help.kind === 'support' && help.topic === 'Can’t sign in' && /ticket is open/.test(lastText(it)), lastText(it));
    check('…the staff are pinged with the details', helpThread && helpThread.sent[0].content.includes(`<@&${STAFF_ROLE}>`)
        && JSON.stringify(helpThread.sent[0].embeds).includes('wrong password'));
    it = interaction('button', { user: HELP, customId: 'vab:open:support' });
    await run(it);
    check('one open help ticket per person', /already have a ticket open/.test(lastText(it)), lastText(it));

    it = interaction('command', { user: HELP, command: 'crew', sub: 'add', options: { member: { id: '556000000', bot: false }, channelId: help.threadId } });
    await run(it);
    check('only staff add people to a ticket', /Only staff/.test(lastText(it)));
    it = interaction('command', { user: STAFF, roles: [STAFF_ROLE], command: 'crew', sub: 'close', options: { reason: 'Password reset sent', channelId: help.threadId } });
    await run(it);
    check('/crew close in the thread closes it with the reason', help.status === 'closed' && help.closeReason === 'Password reset sent' && helpThread.locked, lastText(it));
    check('…offers Reopen', buttonIds(helpThread.sent[helpThread.sent.length - 1]).includes(`vab:reopen:${help._id}`));
    check('…and the member hears why, kindly, by DM', dms.some((d) => d.id === HELP.id && /Password reset sent/.test(JSON.stringify(d.p))));
    it = interaction('button', { user: HELP, customId: `vab:reopen:${help._id}` });
    await run(it);
    check('the member can reopen it', help.status === 'open' && !helpThread.locked && !helpThread.archived, lastText(it));

    it = interaction('button', { user: { id: '557000000', username: 'away' }, customId: 'vab:open:support:loa' });
    await run(it);
    check('Request leave opens a ticket already titled for it', JSON.stringify(it.out.modal || {}).includes('Leave of absence'));

    /* ---- welcome ------------------------------------------------------- */
    const welcomeChannel = { id: '500000000003', type: 0, sent: [], send: async (m) => { welcomeChannel.sent.push(m); return {}; } };
    channels.set(welcomeChannel.id, welcomeChannel);
    it = interaction('command', { ...ADMIN, sub: 'welcome', options: { channel: welcomeChannel, role: { id: '3003' }, message: 'Hi {user}, welcome to {airline}!' } });
    await run(it);
    check('welcome settings are saved', guilds[0].settings.welcomeChannelId === welcomeChannel.id && guilds[0].settings.welcomeRoleId === '3003', guilds[0].settings);
    await bot.onMemberJoin(memberObj('666000000'));
    const greeting = welcomeChannel.sent[welcomeChannel.sent.length - 1];
    check('a newcomer is greeted in their words', greeting && JSON.stringify(greeting.embeds).includes('Hi <@666000000>, welcome to Test Air!'), greeting);
    check('…with Apply and Contact staff', greeting && buttonIds(greeting).includes('vab:open:apply') && buttonIds(greeting).includes('vab:open:support'));
    check('…and the welcome role', stateOf('666000000').roles.has('3003'));
    rosterPilots = [{ discordId: '777000000', name: 'Back Again', callsign: 'TEST 777T', status: 'active' }];
    await bot.onMemberJoin(memberObj('777000000'));
    check('a pilot who rejoins is welcomed back with their role', /Welcome back/.test(JSON.stringify(welcomeChannel.sent[welcomeChannel.sent.length - 1].embeds))
        && stateOf('777000000').roles.has(PILOT_ROLE));

    it = interaction('command', { user: { id: '777000000', username: 'u777000000' }, command: 'crew', sub: 'link' });
    await run(it);
    check('/crew link says who a linked pilot is', /linked to \*\*Back Again/.test(lastText(it)), lastText(it));
    it = interaction('command', { user: { id: '778000000', username: 'u778000000' }, command: 'crew', sub: 'link' });
    await run(it);
    check('…and gives everyone else the one-button link', lastText(it).includes('Link your crew center account')
        && buttonIds(it.out.replies[it.out.replies.length - 1]).includes('https://inflight.example/crew-pilot.html?va=test-air&link=discord'));

    /* ---- inactivity ---------------------------------------------------- */
    const inactiveChannel = { id: '500000000004', type: 0, sent: [], send: async (m) => { inactiveChannel.sent.push(m); return {}; } };
    channels.set(inactiveChannel.id, inactiveChannel);
    const INACTIVE_ROLE = '3004';
    it = interaction('command', { ...ADMIN, sub: 'inactivity', options: { role: { id: PILOT_ROLE } } });
    await run(it);
    check('the pilot role cannot double as the inactive role', /its own role/.test(lastText(it)));
    it = interaction('command', { ...ADMIN, sub: 'inactivity', options: { role: { id: INACTIVE_ROLE }, channel: inactiveChannel, after_days: 30, kick_after_days: 30 } });
    await run(it);
    check('inactivity settings are saved', guilds[0].settings.inactiveRoleId === INACTIVE_ROLE && guilds[0].settings.kickDays === 30, guilds[0].settings);

    const DAY = 24 * 3600 * 1000;
    const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();
    stateOf('801000000').roles.add(PILOT_ROLE);
    absent.add('803000000');
    rosterPilots = [
        { discordId: '801000000', name: 'Quiet', callsign: 'TEST 801T', status: 'active', lastFlightAt: daysAgo(45) },
        { discordId: '802000000', name: 'Busy', callsign: 'TEST 802T', status: 'active', lastFlightAt: daysAgo(2) },
        { discordId: '803000000', name: 'Gone', callsign: 'TEST 803T', status: 'active', lastFlightAt: daysAgo(90) },
        { discordId: '804000000', name: 'Staff', callsign: 'TEST 804T', status: 'active', staff: true, lastFlightAt: daysAgo(90) },
    ];
    it = interaction('command', { ...ADMIN, sub: 'sweep', options: {} });
    await run(it);
    check('the preview names who would be moved', /Preview/.test(lastText(it)) && lastText(it).includes('<@801000000>') && !lastText(it).includes('<@802000000>'), lastText(it));
    check('…and changes nothing', !stateOf('801000000').roles.has(INACTIVE_ROLE) && !inactive.length);

    rosterDown = true;
    it = interaction('command', { ...ADMIN, sub: 'sweep', options: { apply: true } });
    await run(it);
    check('a crew center that cannot answer means no sweep at all', /Nothing done/.test(lastText(it)) && !inactive.length, lastText(it));
    rosterDown = false;

    it = interaction('command', { ...ADMIN, sub: 'sweep', options: { apply: true } });
    await run(it);
    check('a quiet pilot gets the inactive role instead of the pilot role', stateOf('801000000').roles.has(INACTIVE_ROLE) && !stateOf('801000000').roles.has(PILOT_ROLE));
    check('…is told kindly how to stay, in the inactive channel', inactiveChannel.sent.some((m) => m.content === '<@801000000>' && /We miss you/.test(JSON.stringify(m.embeds))
        && buttonIds(m).includes('vab:open:support:loa')));
    check('…with a removal date a month out', inactive.length === 1 && inactive[0].userId === '801000000' && new Date(inactive[0].kickAt).getTime() > Date.now() + 29 * DAY, inactive);
    check('somebody not in the server, staff, and the busy are left alone', !stateOf('802000000').roles.has(INACTIVE_ROLE) && !stateOf('804000000').roles.has(INACTIVE_ROLE) && !inactive.some((r) => r.userId === '803000000'));

    rosterPilots[0].lastFlightAt = new Date().toISOString();
    await bot.sweepGuild(guilds[0]);
    check('flying again swaps the roles back', !stateOf('801000000').roles.has(INACTIVE_ROLE) && stateOf('801000000').roles.has(PILOT_ROLE) && !inactive.length);
    check('…with a welcome back', dms.some((d) => d.id === '801000000' && /Welcome back/.test(JSON.stringify(d.p))));

    rosterPilots[0].lastFlightAt = daysAgo(45);
    await bot.sweepGuild(guilds[0]);
    inactive[0].kickAt = new Date(Date.now() + 3 * DAY);
    await bot.sweepGuild(guilds[0]);
    await bot.sweepGuild(guilds[0]);
    check('a week before removal: one reminder, not one per sweep', dms.filter((d) => d.id === '801000000' && /friendly reminder/i.test(JSON.stringify(d.p))).length === 1);
    inactive[0].kickAt = new Date(Date.now() - 1000);
    await bot.sweepGuild(guilds[0]);
    check('past the deadline: a kind goodbye, then removed', stateOf('801000000').kicked && inactive[0].status === 'kicked'
        && dms.some((d) => d.id === '801000000' && /Thanks for flying with Test Air/.test(JSON.stringify(d.p))));

    it = interaction('command', { ...ADMIN, sub: 'inactivity', options: { kick_after_days: 0 } });
    await run(it);
    check('removal can be switched off', guilds[0].settings.kickDays === 0 && /never removed/.test(lastText(it)), lastText(it));

    /* ---- many things at once ------------------------------------------- */
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled++; });
    load.delayMs = 150;
    const settled = (its) => Promise.allSettled(its.map((x) => run(x)));
    const answered = (x) => x.out.replies.length > 0 || !!x.out.modal;

    // A second applicant, form filled in.
    const TWO = { id: '444', username: 'pilot_two', tag: 'pilot_two' };
    it = interaction('button', { user: TWO, customId: 'vab:open:apply' });
    await run(it);
    const t2 = tickets.find((t) => t.userId === TWO.id);
    const thread2 = channels.get(t2.threadId);
    await run(interaction('modal', { user: TWO, customId: `vab:formsub:${t2._id}:0`, fields: { ifc: 'Pilot_Two', num: '222', email: '' } }));
    await run(interaction('modal', { user: TWO, customId: `vab:formsub:${t2._id}:1`, fields: { q0: 'Yes' } }));

    // Ten presses of Submit in the same instant.
    const presses = Array.from({ length: 10 }, () => interaction('button', { user: TWO, customId: `vab:submit:${t2._id}` }));
    let results = await settled(presses);
    const applies = calls.filter((c) => c.path === 'apply' && c.body.ifcName === 'Pilot_Two').length;
    check('ten Submits at once send ONE application', applies === 1, applies);
    check('…none of them throws', results.every((r) => r.status === 'fulfilled'), results.filter((r) => r.status === 'rejected').map((r) => String(r.reason)));
    check('…and every press gets an answer', presses.every(answered), presses.map((x) => x.out.replies.length));
    check('…one staff card in the thread, not ten', thread2.sent.filter((m) => buttonIds(m).includes(`vab:test:${t2._id}`)).length === 1);

    // Five staff press Accept while auto-invite fires for the same pass.
    const accepts = Array.from({ length: 5 }, () => interaction('button', { user: STAFF, roles: [STAFF_ROLE], customId: `vab:accept:${t2._id}` }));
    const before = calls.filter((c) => c.path === 'review').length;
    v.hub.emit('entranceTest', { vaId, applicationId: 'app-Pilot_Two', passed: true, score: 9, total: 10, percent: 90, quizTitle: 'SOP test' });
    results = await settled(accepts);
    await new Promise((r) => setTimeout(r, 1500));
    const accepted = calls.filter((c) => c.path === 'review').length - before;
    check('five Accepts and an auto-invite accept ONCE', accepted === 1, accepted);
    check('…one welcome in the thread', thread2.sent.filter((m) => buttonIds(m).includes(`vab:login:${t2._id}`)).length === 1,
        thread2.sent.filter((m) => buttonIds(m).includes(`vab:login:${t2._id}`)).length);
    check('…and every staff press gets an answer', accepts.every(answered));

    // Two hundred people ask for the links at once.
    const crowd = Array.from({ length: 200 }, (_, i) => interaction('command', { user: { id: String(10000 + i), username: `u${i}` }, command: 'crew', sub: 'links' }));
    load.maxInflight = 0;
    results = await settled(crowd);
    check('two hundred commands at once: none throws', results.every((r) => r.status === 'fulfilled'));
    check('…every one is answered', crowd.every(answered), crowd.filter((x) => !answered(x)).length);
    check('…and the crew center is never hit by all of them at once', load.maxInflight <= 8, load.maxInflight);

    // Discord failing under the bot is not the bot failing.
    thread2.send = async () => { throw new Error('Missing Access'); };
    thread2.setLocked = async () => { throw new Error('Missing Access'); };
    it = interaction('button', { user: STAFF, roles: [STAFF_ROLE], customId: `vab:close:${t2._id}` });
    await run(it);
    check('a thread Discord will not let us touch still closes cleanly', /Closed/.test(lastText(it)), lastText(it));
    const broken = interaction('command', { command: 'crew', sub: 'stats' });
    broken.deferReply = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
    broken.reply = broken.deferReply;
    check('an interaction that expired mid-way does not throw', (await run(broken)) === true);

    // An event published and edited in the same breath: one post, one thread.
    const eventsChannel = {
        id: '500000000002', type: 0, sent: [],
        send: async (m) => { await new Promise((r) => setTimeout(r, 100)); eventsChannel.sent.push(m); return { id: String(nextId++), startThread: async () => fakeThread(eventsChannel) }; },
        messages: { fetch: async () => ({ edit: async () => {} }) },
    };
    channels.set(eventsChannel.id, eventsChannel);
    guilds[0].settings.eventsChannelId = eventsChannel.id;
    const ev = { _id: 'ev1', title: 'Fly-in', origin: 'EGLL', destination: 'KJFK', startsAt: '2030-01-01T12:00:00Z' };
    v.hub.emit('event', { va: VA, action: 'published', event: ev });
    v.hub.emit('event', { va: VA, action: 'updated', event: { ...ev, title: 'Fly-in (moved)' } });
    v.hub.emit('event', { va: VA, action: 'updated', event: { ...ev, title: 'Fly-in (moved again)' } });
    await new Promise((r) => setTimeout(r, 800));
    check('publish + two quick edits make ONE event post', eventsChannel.sent.length === 1 && eventPosts.length === 1, { posts: eventsChannel.sent.length, rows: eventPosts.length });

    await new Promise((r) => setTimeout(r, 300));
    check('nothing rejected unhandled through all of it', unhandled === 0, unhandled);
    load.delayMs = 0;

    // Not ours at all.
    check('other interactions are left for bot.js', (await bot.handleInteraction({ isChatInputCommand: () => true, commandName: 'lookup' })) === false);

    server.close();
    if (fails.length) {
        console.error(`✗ ${fails.length} failed, ${pass} passed`);
        fails.forEach((f) => console.error('  ✗ ' + f));
        process.exit(1);
    }
    console.log(`✓ va bot flow: ${pass} checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
