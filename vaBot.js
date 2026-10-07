'use strict';

/*
 * vaBot.js
 * The Inflight bot inside every virtual airline's own Discord server.
 *
 * WHAT THIS IS FOR
 * ----------------
 * bot.js runs ONE server — Inflight's — and is built out of that server's
 * channel and role ids. This module is the other half: the same bot, invited
 * into any VA's server, doing the airline's work there. A VA links its server
 * to its crew center once, and from then on:
 *
 *   * a recruitment panel opens a private ticket thread per applicant;
 *   * the application is filled in inside the ticket and lands in the crew
 *     center exactly as if it had come through the join page;
 *   * staff send the entrance test from the ticket, the result comes back to
 *     the ticket, and on a pass the crew center login is issued from there;
 *   * the pilot reads their login from a button only they can open;
 *   * the airline's links, stats, events and roster answer slash commands;
 *   * published events get a post and a discussion thread of their own;
 *   * newcomers are welcomed, and a pilot who rejoins gets their role back;
 *   * any member can open a help ticket (not only applicants), and a ticket
 *     can be closed with a reason and reopened;
 *   * a pilot whose Discord is linked to their crew center login is moved to
 *     an inactive role when they stop flying, reminded kindly, and — only if
 *     the airline switched it on — removed from the server a month later;
 *   * a pilot accepted through a ticket has their Discord linked to their new
 *     login automatically, and anyone else links with `/crew link`.
 *
 * THE ONE RULE: THE BOT IS A CLIENT OF THE CREW CENTER, NOT A COPY OF IT
 * ---------------------------------------------------------------------
 * Every decision — does this applicant meet the requirements, is that callsign
 * free, may a test be sent twice, what does accepting create — already lives in
 * the crew center's HTTP handlers, with years of edge cases in them. The bot
 * does not reimplement any of it. It calls those same routes over loopback, so
 * a pilot who joins through Discord and one who joins through the website are
 * treated identically, and a rule changed in one place changes for both.
 *
 * Staff routes need a caller. That caller is `botCallerFrom`: a per-process key
 * sent on a loopback request, accepted by server.js's requireCap for the short
 * list of capabilities in BOT_CAPS and nothing else. The key is made when this
 * module loads and never leaves the process, so it is worthless outside it and
 * dies with every restart.
 *
 * WHO MAY DO WHAT, IN DISCORD
 * ---------------------------
 * Linking a server takes BOTH halves: a one-time code from the crew center
 * (proves you run the airline) typed into the server by someone with Manage
 * Server (proves you run the server). Either alone links nothing — a server
 * invite gets pasted in public, and so does a screenshot of a dashboard.
 *
 * Inside a linked server, staff actions (send test, accept, decline) take the
 * staff role the airline chose, or Manage Server. The applicant's own buttons
 * (fill in the form, read my login) answer only the person the ticket is for.
 *
 * NOT CRASHING
 * ------------
 * One process serves every airline, so one airline's bad afternoon must not be
 * everybody's. Every handler is caught; every map is bounded; every call to the
 * crew center has a timeout; a hub event from server.js can never throw back
 * into the request that raised it; and nothing here fetches a whole guild's
 * member list, which on a large server is the fastest way to run out of heap.
 */

const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const crewRetention = require('./crewRetention');
const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
    ChannelType, PermissionsBitField, MessageFlags,
} = require('discord.js');

/* ===========================================================================
 * CONFIGURATION — set by server.js before the bot starts
 * ======================================================================== */

const config = {
    apiBase: `http://127.0.0.1:${process.env.PORT || 5000}`,
    siteOrigin: (process.env.CREW_SITE_ORIGIN || 'https://inflight.info').replace(/\/+$/, ''),
};
function configure(opts = {}) {
    if (opts.apiBase) config.apiBase = String(opts.apiBase).replace(/\/+$/, '');
    if (opts.siteOrigin) config.siteOrigin = String(opts.siteOrigin).replace(/\/+$/, '');
}

const API_TIMEOUT_MS = 15000;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const TICKET_COOLDOWN_MS = 20 * 1000;
const MAX_OPEN_TICKETS_PER_GUILD = 250;
const THREAD_ARCHIVE_MIN = 10080; // a week: an application can sit over a weekend
const EPHEMERAL = MessageFlags.Ephemeral;
const DAY_MS = 24 * 3600 * 1000;

/* Inactivity. A day count is a setting; these are the guard rails around it.
 * The caps per sweep are what stop a bad afternoon in the crew center (a
 * flight log that came back empty, say) from becoming a server-wide purge:
 * the worst one sweep can do is a handful, and staff hear about each. */
const INACTIVE_DAYS_DEFAULT = 30;
const KICK_DAYS_DEFAULT = 30;
const REMIND_BEFORE_DAYS = 7;
const MAX_FLAG_PER_SWEEP = 25;
const MAX_KICK_PER_SWEEP = 10;
const SWEEP_EVERY_MS = 6 * 3600 * 1000;
const SWEEP_FIRST_MS = 10 * 60 * 1000;

/* Welcome. Past this many joins a minute in one server it is a raid or a
 * mass import, not a crowd of people to greet one by one: roles are still
 * given, the posts stop until it calms down. */
const WELCOME_BURST = 8;
const WELCOME_WINDOW_MS = 60 * 1000;
const DEFAULT_WELCOME = 'Welcome aboard, {user}! 👋 We’re really glad you’re here at **{airline}**.\n\n'
    + 'Want to fly with us? Press **Apply** below. Got a question about anything at all? **Contact staff** opens a private chat with the team.';

/* ===========================================================================
 * THE BOT AS A CALLER OF THE CREW CENTER
 * ======================================================================== */

const BOT_CALLER_KEY = crypto.randomBytes(32).toString('hex');

/* The whole of what the bot may do on a VA's behalf. Recruitment, and nothing
 * else: it can review applications and send entrance tests because that is the
 * job it was given. Adding a capability here is a decision about every linked
 * server at once, so it is a list in one place rather than a check per route. */
const BOT_CAPS = new Set(['applications.review']);

const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));

/**
 * The bot principal on a request, or null.
 *
 * Three things must all hold: the request arrived on the loopback interface,
 * it carries this process's key, and the slug it names is the route's slug. The
 * last one is not a security boundary (the bot is trusted to name the right
 * airline) — it is what stops a bug in here from acting on the wrong VA.
 */
function botCallerFrom(req, slug) {
    const h = (req && req.headers) || {};
    const key = String(h['x-inflight-bot-key'] || '');
    if (!key || key.length !== BOT_CALLER_KEY.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(key), Buffer.from(BOT_CALLER_KEY))) return null;
    if (!isLoopback(req.socket && req.socket.remoteAddress)) return null;
    const claimed = String(h['x-inflight-bot-slug'] || '').toLowerCase();
    if (!claimed || claimed !== String(slug || '').trim().toLowerCase()) return null;
    let actor = '';
    try { actor = decodeURIComponent(String(h['x-inflight-bot-actor'] || '')); } catch { actor = ''; }
    actor = actor.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    return { kind: 'discord-bot', slug: claimed, name: actor ? `${actor} (Discord)` : 'Discord bot', uname: '' };
}

/**
 * The Discord user a bot request is acting for, or ''. Only ever read after
 * botCallerFrom has accepted the request (server.js's botPilot): on its own
 * a header is just a claim.
 */
function botPilotFrom(req) {
    const id = String(((req && req.headers) || {})['x-inflight-bot-pilot'] || '');
    return /^[0-9]{5,25}$/.test(id) ? id : '';
}

/** requireCap's answer for the bot: allowed only what BOT_CAPS lists. */
const botMay = (capability) => BOT_CAPS.has(capability);

/* ===========================================================================
 * THE HUB — server.js tells the bot that something happened
 *
 * Not an EventEmitter: a listener that throws inside emit() throws into the
 * HTTP handler that called it, which would turn "the bot could not post" into
 * "your test could not be marked". Here emit() schedules and returns, always.
 * ======================================================================== */

const hubListeners = new Map();
const hub = {
    on(name, fn) {
        if (!hubListeners.has(name)) hubListeners.set(name, []);
        hubListeners.get(name).push(fn);
    },
    emit(name, payload) {
        const list = hubListeners.get(name);
        if (!list || !list.length) return;
        setImmediate(() => {
            for (const fn of list) {
                Promise.resolve().then(() => fn(payload)).catch((err) => {
                    console.error(`🤖 vaBot hub "${name}" listener failed:`, err && err.message ? err.message : err);
                });
            }
        });
    },
};

/* ===========================================================================
 * STORAGE — what Inflight keeps about a linked server
 *
 * Which server belongs to which airline, the channels and roles it chose, and
 * which ticket thread belongs to which application. No applicant answers live
 * here beyond the draft of a form being filled in, and that is cleared the
 * moment the application reaches the crew center.
 * ======================================================================== */

const { Schema } = mongoose;

const VaBotGuildSchema = new Schema({
    guildId: { type: String, required: true, unique: true },
    vaId: { type: Schema.Types.ObjectId, required: true, index: true },
    guildName: { type: String, default: '' },
    linkedBy: { id: String, tag: String },
    linkedAt: { type: Date, default: Date.now },
    settings: {
        staffRoleId: { type: String, default: '' },
        pilotRoleId: { type: String, default: '' },
        ticketChannelId: { type: String, default: '' },
        logChannelId: { type: String, default: '' },
        eventsChannelId: { type: String, default: '' },
        autoInvite: { type: Boolean, default: false },
        // Welcome. A channel to greet people in, a role everyone gets on
        // joining, the airline's own words, and whether to DM it too.
        welcomeChannelId: { type: String, default: '' },
        welcomeRoleId: { type: String, default: '' },
        welcomeMessage: { type: String, default: '' },
        welcomeDm: { type: Boolean, default: false },
        // Inactivity. Off while inactiveRoleId is empty. kickDays 0 = never.
        inactiveRoleId: { type: String, default: '' },
        inactiveChannelId: { type: String, default: '' },
        inactiveDays: { type: Number, default: INACTIVE_DAYS_DEFAULT },
        kickDays: { type: Number, default: 0 },
    },
    // When the Apply panel was last posted — the setup guide's "done".
    panelAt: { type: Date, default: null },
}, { timestamps: true });

const VaBotLinkCodeSchema = new Schema({
    codeHash: { type: String, required: true, unique: true },
    vaId: { type: Schema.Types.ObjectId, required: true, index: true },
    createdBy: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
});
// Mongo removes a code it has outlived; findOne also checks, because the TTL
// monitor runs once a minute and a code must not work for that minute.
VaBotLinkCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const VaBotTicketSchema = new Schema({
    guildId: { type: String, required: true },
    vaId: { type: Schema.Types.ObjectId, required: true },
    threadId: { type: String, required: true },
    userId: { type: String, required: true },
    userTag: { type: String, default: '' },
    kind: { type: String, enum: ['apply', 'support'], default: 'apply' },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    stage: { type: String, default: 'form' }, // form | submitted | testing | accepted | declined
    applicationId: { type: String, default: '' },
    // What a help ticket is about, as the member typed it.
    topic: { type: String, default: '' },
    closedBy: { type: String, default: '' },
    closeReason: { type: String, default: '' },
    draft: {
        ifcName: { type: String, default: '' },
        callsignNumber: { type: String, default: '' },
        airline: { type: String, default: '' },
        email: { type: String, default: '' },
        answers: { type: [String], default: [] },
    },
    closedAt: { type: Date, default: null },
}, { timestamps: true });
VaBotTicketSchema.index({ guildId: 1, userId: 1, kind: 1, status: 1 });
VaBotTicketSchema.index({ vaId: 1, applicationId: 1 });

const VaBotEventPostSchema = new Schema({
    guildId: { type: String, required: true },
    vaId: { type: Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true },
    channelId: String,
    messageId: String,
    threadId: String,
    // For the one-hour reminder: when it starts, and whether it has been sent.
    startsAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
}, { timestamps: true });
VaBotEventPostSchema.index({ guildId: 1, eventId: 1 }, { unique: true });
VaBotEventPostSchema.index({ remindedAt: 1, startsAt: 1 });

/* A pilot the bot has moved to the inactive role, and when it will act next.
 * One per person per server. Deleted the moment they fly again. */
const VaBotInactiveSchema = new Schema({
    guildId: { type: String, required: true },
    vaId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    memberId: { type: String, default: '' },
    status: { type: String, enum: ['inactive', 'kicked'], default: 'inactive' },
    since: { type: Date, default: Date.now },
    kickAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
    // Whether they held the pilot role when it was taken, so it is only ever
    // given back to somebody who had it.
    hadPilotRole: { type: Boolean, default: false },
}, { timestamps: true });
VaBotInactiveSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
const VaBotGuild = model('VaBotGuild', VaBotGuildSchema);
const VaBotLinkCode = model('VaBotLinkCode', VaBotLinkCodeSchema);
const VaBotTicket = model('VaBotTicket', VaBotTicketSchema);
const VaBotEventPost = model('VaBotEventPost', VaBotEventPostSchema);
const VaBotInactive = model('VaBotInactive', VaBotInactiveSchema);

/* ===========================================================================
 * PURE HELPERS — everything that decides something without Discord
 * ======================================================================== */

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// No 0/O or 1/I/L: the code is read off a dashboard and typed into Discord.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeLinkCode() {
    const bytes = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return `${out.slice(0, 4)}-${out.slice(4)}`;
}
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (s) => crypto.createHash('sha256').update(normalizeCode(s)).digest('hex');

/** Component ids: `vab:<action>:<arg>…`, never more than Discord's 100. */
const cid = (...parts) => ['vab', ...parts.map((p) => String(p))].join(':').slice(0, 100);
function parseCid(id) {
    const s = String(id || '');
    if (!s.startsWith('vab:')) return null;
    const [, action, ...args] = s.split(':');
    return action ? { action, args } : null;
}

const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(String(s || ''));
const isSnowflake = (s) => /^[0-9]{5,25}$/.test(String(s || ''));
const isHttpsUrl = (s) => /^https:\/\/\S+$/i.test(String(s || ''));
const isHttpUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ''));

/** Discord labels are 45 characters; a question can be 120. */
const shortLabel = (s) => {
    const t = clean(s, 200) || 'Question';
    return t.length <= 45 ? t : `${t.slice(0, 44)}…`;
};

const QUESTIONS_PER_PAGE = 5;

/**
 * How many modals the form takes. Page 0 is always ours (who you are and your
 * callsign); every page after it is up to five of the airline's questions,
 * because five inputs is all a Discord modal holds.
 */
function pageCount(form) {
    const n = Array.isArray(form) ? form.length : 0;
    return 1 + Math.ceil(n / QUESTIONS_PER_PAGE);
}
function pageQuestions(form, page) {
    if (!Array.isArray(form) || page < 1) return [];
    const start = (page - 1) * QUESTIONS_PER_PAGE;
    return form.slice(start, start + QUESTIONS_PER_PAGE).map((q, i) => ({ ...q, index: start + i }));
}

/** A select question answered in a text box: match it to one of its options. */
function matchOption(q, value) {
    const v = clean(value, 2000);
    if (!q || q.type !== 'select' || !Array.isArray(q.options) || !q.options.length || !v) return { ok: true, value: v };
    const hit = q.options.find((o) => o.toLowerCase() === v.toLowerCase());
    return hit ? { ok: true, value: hit } : { ok: false, value: v };
}

/** Which callsign airline the applicant meant, from what they typed. */
function pickAirline(airlines, typed) {
    const list = Array.isArray(airlines) ? airlines : [];
    if (list.length <= 1) return list[0] ? list[0].base : '';
    const t = String(typed || '').trim().toLowerCase();
    if (!t) return null;
    const hit = list.find((a) => String(a.base || '').toLowerCase() === t
        || String(a.tag || '').toLowerCase() === t
        || String(a.sample || '').toLowerCase().startsWith(t));
    return hit ? hit.base : null;
}

const agreeLabels = (reqs) => (Array.isArray(reqs) ? reqs : [])
    .filter((r) => r && r.type === 'agree' && r.label).map((r) => String(r.label).slice(0, 200));

const REQ_WORDS = {
    grade: (v) => `Grade ${v}+`, hours: (v) => `${v}+ flight hours`, landings: (v) => `${v}+ landings`,
    xp: (v) => `${v}+ XP`, flights: (v) => `${v}+ online flights`, violations: (v) => `at most ${v} violations`,
};
/** The requirements as a line or two for the panel and the ticket. */
function describeRequirements(join) {
    const reqs = Array.isArray(join && join.requirements) ? join.requirements.slice() : [];
    if (join && join.minGrade > 0 && !reqs.some((r) => r.type === 'grade')) reqs.push({ type: 'grade', value: join.minGrade });
    return reqs.filter((r) => r && REQ_WORDS[r.type] && Number(r.value) >= 0 && !(r.type !== 'violations' && !Number(r.value)))
        .map((r) => REQ_WORDS[r.type](r.value));
}

/** Everything still missing before the draft can be sent. */
function draftProblems(draft, join) {
    const d = draft || {};
    const out = [];
    if (!clean(d.ifcName, 60)) out.push('your Infinite Flight Community name');
    if (!clean(d.callsignNumber, 10)) out.push('a callsign number');
    const airlines = (join && join.callsign && join.callsign.airlines) || [];
    if (airlines.length > 1 && pickAirline(airlines, d.airline) == null) out.push('which airline your callsign is on');
    const form = Array.isArray(join && join.form) ? join.form : [];
    form.forEach((q, i) => {
        if (q && q.required && !clean((d.answers || [])[i], 2000)) out.push(`“${clean(q.label, 60)}”`);
    });
    return out;
}

/** The body /apply expects, built from the draft and the airline's config. */
function applyBody(draft, join) {
    const d = draft || {};
    const form = Array.isArray(join && join.form) ? join.form : [];
    const airlines = (join && join.callsign && join.callsign.airlines) || [];
    return {
        ifcName: clean(d.ifcName, 60).replace(/^@/, ''),
        callsignPrefix: pickAirline(airlines, d.airline) || '',
        callsignNumber: clean(d.callsignNumber, 10),
        email: clean(d.email, 120),
        // Every question, answered or not, in the airline's order — the review
        // screen reads them back as a list and a gap is information too.
        answers: form.map((q, i) => ({ q: clean(q.label, 120), a: clean((d.answers || [])[i], 2000) })),
        // Pressing "I agree & submit" under the listed terms is the tick.
        agreed: agreeLabels(join && join.requirements),
    };
}

/** Staff here: the airline's staff role, or anybody who can manage the server. */
function memberRoleIds(member) {
    if (!member) return [];
    if (member.roles && member.roles.cache) return [...member.roles.cache.keys()];
    return Array.isArray(member.roles) ? member.roles : [];
}
function isStaff(interaction, settings) {
    const perms = interaction.memberPermissions;
    if (perms && perms.has(PermissionsBitField.Flags.ManageGuild)) return true;
    const roleId = settings && settings.staffRoleId;
    return !!(roleId && memberRoleIds(interaction.member).includes(roleId));
}

/** A thread name Discord will accept and a human can scan in a list. */
function threadName(kind, username) {
    const who = String(username || 'pilot').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pilot';
    return `${kind === 'support' ? 'help' : 'apply'}-${who}`.slice(0, 90);
}

/**
 * The airline's welcome text with its placeholders filled in.
 * {user} mentions the newcomer, {name} is their display name, {server},
 * {airline} and {members} are what they say. Anything else is left alone.
 */
function renderWelcome(template, vars = {}) {
    const t = clean(template, 1500) || DEFAULT_WELCOME;
    const map = {
        user: vars.userId ? `<@${vars.userId}>` : clean(vars.name, 80) || 'there',
        name: clean(vars.name, 80) || 'there',
        server: clean(vars.server, 100) || 'the server',
        airline: clean(vars.airline, 100) || 'the airline',
        members: Number(vars.members) > 0 ? Number(vars.members).toLocaleString('en-US') : '',
    };
    return t.replace(/\{(user|name|server|airline|members)\}/gi, (_, k) => map[k.toLowerCase()]).slice(0, 2000);
}

const toTime = (d) => {
    const t = d ? new Date(d).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
};
const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/**
 * Has this pilot gone quiet, by this server's rule?
 *
 * Flying recently always wins — over a stale 'inactive' status on the roster
 * too, or the bot would restore somebody and flag them again on the next
 * sweep. Leave of absence and staff are never quiet: LOA is the roster saying
 * "they told us they would be away", and the person running the events
 * calendar may go a month without flying it.
 */
function isDormant(p, now, inactiveDays) {
    if (!p || p.status === 'loa' || p.staff) return false;
    const window = Math.max(1, inactiveDays) * DAY_MS;
    const last = toTime(p.lastFlightAt);
    if (last && now - last < window) return false;
    if (p.status === 'inactive') return true;
    const anchor = last || toTime(p.joinedAt);
    // Nothing to count from is not a reason to call somebody inactive.
    return !!anchor && now - anchor >= window;
}

/**
 * Who to move to the inactive role, remind, remove, or welcome back.
 *
 * Pure: hand it the linked pilots (from the crew center) and the people
 * already flagged in this server, and it answers four lists. Nothing is
 * applied here, which is what lets the same function power both the sweep
 * and the preview an owner reads before switching this on.
 */
function activityPlan({ pilots = [], flagged = [], now = Date.now(), inactiveDays = INACTIVE_DAYS_DEFAULT, kickDays = 0, remindDays = REMIND_BEFORE_DAYS } = {}) {
    const out = { flag: [], remind: [], kick: [], restore: [] };
    const records = new Map((flagged || []).filter((f) => f && f.status !== 'kicked').map((f) => [String(f.userId), f]));
    const seen = new Set();
    for (const p of pilots || []) {
        const id = String((p && p.discordId) || '');
        if (!isSnowflake(id) || seen.has(id)) continue;
        seen.add(id);
        const rec = records.get(id);
        const dormant = isDormant(p, now, inactiveDays);
        const last = toTime(p.lastFlightAt);
        if (rec) {
            const flewSince = last && last > toTime(rec.since);
            if (!dormant || flewSince) { out.restore.push({ pilot: p, record: rec }); continue; }
            const kickAt = toTime(rec.kickAt);
            if (kickDays > 0 && kickAt) {
                if (now >= kickAt) out.kick.push({ pilot: p, record: rec });
                else if (!rec.remindedAt && kickAt - now <= remindDays * DAY_MS) out.remind.push({ pilot: p, record: rec, kickAt: new Date(kickAt) });
            }
            continue;
        }
        if (!dormant) continue;
        const anchor = last || toTime(p.joinedAt);
        out.flag.push({
            pilot: p,
            days: anchor ? Math.floor((now - anchor) / DAY_MS) : null,
            neverFlown: !last,
            kickAt: kickDays > 0 ? new Date(now + kickDays * DAY_MS) : null,
        });
    }
    // Longest quiet first, so a capped sweep starts with the clearest cases.
    out.flag.sort((a, b) => (b.days || 0) - (a.days || 0));
    return out;
}

/** At most `limit` hits per key in `windowMs`. True once over the limit. */
function makeBurst(limit, windowMs, max = 2000) {
    const hits = new Map();
    return {
        over(key, now = Date.now()) {
            const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
            list.push(now);
            if (!hits.has(key) && hits.size >= max) hits.delete(hits.keys().next().value);
            hits.set(key, list.slice(-limit - 1));
            return list.length > limit;
        },
        size: () => hits.size,
    };
}

/** Bounded per-key cooldowns. Swept, so a raid of clicks cannot grow it forever. */
function makeCooldown(ms, max = 5000) {
    const seen = new Map();
    return {
        hit(key, now = Date.now()) {
            const last = seen.get(key);
            if (last !== undefined && now - last < ms) return Math.ceil((ms - (now - last)) / 1000);
            if (seen.size >= max) {
                for (const [k, t] of seen) if (now - t >= ms) seen.delete(k);
                if (seen.size >= max) seen.delete(seen.keys().next().value);
            }
            seen.set(key, now);
            return 0;
        },
        size: () => seen.size,
    };
}

/** A small TTL cache with a size cap. */
function makeCache(ttl, max = 2000) {
    const m = new Map();
    return {
        get(k, now = Date.now()) {
            const hit = m.get(k);
            if (!hit) return undefined;
            if (now - hit.at > ttl) { m.delete(k); return undefined; }
            return hit.v;
        },
        set(k, v, now = Date.now()) {
            if (m.size >= max && !m.has(k)) m.delete(m.keys().next().value);
            m.set(k, { at: now, v });
        },
        del(k) { m.delete(k); },
        size: () => m.size,
    };
}

/**
 * One thing at a time per key.
 *
 * `busy(key)` and `run(key, fn)` are both synchronous up to the point fn
 * starts, so "check, then claim" cannot be split by another interaction —
 * this process is single-threaded and there is no await between them. A
 * button pressed while the same ticket is mid-change is told to wait rather
 * than queued, because Discord gives an interaction three seconds to answer
 * and a queue could outlast that. Background work (the hub) queues instead.
 */
function makeLocks() {
    const tails = new Map();
    return {
        busy: (key) => tails.has(key),
        run(key, fn) {
            const prev = tails.get(key) || Promise.resolve();
            // Let go before the caller resumes, so the key is free the moment
            // its work is done — not a tick later.
            const work = prev.then(() => fn()).finally(() => { if (tails.get(key) === tail) tails.delete(key); });
            const tail = work.then(() => {}, () => {});
            tails.set(key, tail);
            return work;
        },
        size: () => tails.size,
    };
}

/**
 * At most `max` calls in flight; the rest wait their turn, up to `queueMax`
 * of them and for up to `waitMs`. Past either, the caller is told "busy"
 * straight away — a crowd of slash commands must not become a crowd of
 * requests against the crew center, nor an unbounded queue in memory.
 */
function makeLimiter(max, { queueMax = 500, waitMs = 10000 } = {}) {
    let active = 0;
    const queue = [];
    const next = () => {
        while (active < max && queue.length) {
            const w = queue.shift();
            if (w.done) continue;
            w.done = true;
            clearTimeout(w.timer);
            active++;
            w.resolve(true);
        }
    };
    return {
        async run(fn, busyValue) {
            if (active >= max) {
                if (queue.length >= queueMax) return busyValue;
                const got = await new Promise((resolve) => {
                    const w = { resolve, done: false };
                    w.timer = setTimeout(() => { if (!w.done) { w.done = true; resolve(false); } }, waitMs);
                    queue.push(w);
                });
                if (!got) return busyValue;
            } else active++;
            try { return await fn(); } finally { active--; next(); }
        },
        stats: () => ({ active, queued: queue.filter((w) => !w.done).length }),
    };
}

/** The permissions the bot asks for when it is invited. */
const INVITE_PERMISSIONS = [
    'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory',
    'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads', 'ManageThreads',
    // Giving an accepted pilot the airline's pilot role, a newcomer the
    // welcome role, and a quiet pilot the inactive one.
    'ManageRoles',
    // Removing a pilot who stayed inactive — only ever when the airline set
    // kick_after_days, and never more than a handful in one sweep.
    'KickMembers',
    // Pinging a staff role that is not set to "anyone can mention". Every
    // message the bot sends restricts mentions to the one role and the one
    // applicant it means, so this never reaches @everyone.
    'MentionEveryone',
];
function inviteUrl() {
    const id = process.env.DISCORD_CLIENT_ID;
    if (!id) return '';
    const perms = new PermissionsBitField(INVITE_PERMISSIONS.map((p) => PermissionsBitField.Flags[p])).bitfield;
    return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(id)}&scope=bot%20applications.commands&permissions=${perms}`;
}

/* Which airline each server is linked to. Module-level rather than per bot so
 * that unlinking from the dashboard (registerRoutes) takes effect at once
 * instead of a minute later. */
const guildCache = makeCache(CACHE_TTL_MS);

/** The owner's setup manual (tracker: discord-bot.html). */
const GUIDE_URL = () => `${config.siteOrigin}/discord-bot`;

const crewUrl = (slug) => `${config.siteOrigin}/crew/${encodeURIComponent(String(slug || '').toLowerCase())}`;

/* Where a pilot links Discord to their login. Their own pilot page: it signs
 * them in first if it has to, then starts the same Discord consent screen the
 * Link button on that page does — the identity comes from Discord itself, so
 * a link pasted to somebody else links nothing of the sender's. */
const linkUrl = (slug) => `${config.siteOrigin}/crew-pilot.html?va=${encodeURIComponent(String(slug || '').toLowerCase())}&link=discord`;

/* ===========================================================================
 * THE CREW CENTER, OVER LOOPBACK
 * ======================================================================== */

/** The headers that make a loopback request the bot's. Never sent anywhere else. */
const callerHeaders = (slug, actor, pilot = '') => ({
    'x-inflight-bot-key': BOT_CALLER_KEY,
    'x-inflight-bot-slug': String(slug || '').toLowerCase(),
    'x-inflight-bot-actor': encodeURIComponent(String(actor || '').slice(0, 80)),
    // The member who pressed the button, for the pilot endpoints. Their own
    // Discord id, straight from the interaction — never typed by anyone.
    ...(/^[0-9]{5,25}$/.test(String(pilot || '')) ? { 'x-inflight-bot-pilot': String(pilot) } : {}),
});

/* Every server's bot traffic shares one crew center process: eight requests
 * at a time between them, whatever is happening in Discord. */
const API_CONCURRENCY = 8;
const apiLimiter = makeLimiter(API_CONCURRENCY, { queueMax: 500, waitMs: 10000 });
const BUSY = { ok: false, status: 503, data: {}, error: 'The crew center is busy right now. Try again in a moment.' };

function api(method, path, opts = {}) {
    return apiLimiter.run(() => apiNow(method, path, opts), BUSY);
}

async function apiNow(method, path, { body, slug, actor, asBot = false, pilot = '' } = {}) {
    const headers = { Accept: 'application/json', ...(asBot || pilot ? callerHeaders(slug, actor, pilot) : {}) };
    try {
        const res = await axios({
            method, url: `${config.apiBase}${path}`, data: body, headers,
            timeout: API_TIMEOUT_MS, validateStatus: () => true,
            // Loopback is plain http; never send the key through a proxy, and
            // never follow a redirect — it would carry the key to wherever it
            // pointed.
            proxy: false, maxRedirects: 0,
        });
        const data = res.data && typeof res.data === 'object' ? res.data : {};
        const ok = res.status >= 200 && res.status < 300;
        return { ok, status: res.status, data, error: ok ? '' : (data.error || data.message || `The crew center answered ${res.status}.`) };
    } catch (err) {
        return { ok: false, status: 0, data: {}, error: 'The crew center did not answer in time. Try again in a moment.' };
    }
}
const crewPath = (slug, rest = '') => `/api/crew/${encodeURIComponent(String(slug || '').toLowerCase())}${rest}`;

/* ===========================================================================
 * EMBEDS
 * ======================================================================== */

const accentOf = (va) => {
    const hex = String((va && va.crewAccent) || '').replace('#', '');
    return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : 0x2563EB;
};
function vaEmbed(va) {
    const e = new EmbedBuilder().setColor(accentOf(va));
    if (va && va.name) e.setAuthor({ name: clean(va.name, 250), ...(isHttpsUrl(va.logoUrl) ? { iconURL: va.logoUrl } : {}) });
    return e;
}
const stamp = (d, style = 'F') => {
    const t = d ? new Date(d).getTime() : NaN;
    return Number.isFinite(t) ? `<t:${Math.floor(t / 1000)}:${style}>` : '';
};

function eventEmbed(va, event, action) {
    const leg = [event.origin, event.destination].filter(Boolean).join(' → ');
    const title = clean(event.title, 200) || leg || 'Event';
    const head = { cancelled: '⚠️ Cancelled — ', removed: '🗑️ Removed — ' }[action] || '';
    const e = vaEmbed(va).setTitle(`${head}${title}`.slice(0, 256)).setURL(crewUrl(va.slug));
    if (event.description) e.setDescription(clean(event.description, 1500));
    const fields = [
        stamp(event.startsAt) ? { name: 'Departs', value: `${stamp(event.startsAt)} (${stamp(event.startsAt, 'R')})`, inline: false } : null,
        leg ? { name: 'Route', value: leg, inline: true } : null,
        event.aircraft ? { name: 'Aircraft', value: clean(event.aircraft, 60), inline: true } : null,
        event.server ? { name: 'Server', value: clean(event.server, 30), inline: true } : null,
        event.slots ? { name: 'Slots', value: String(event.slots), inline: true } : null,
        event.minRank ? { name: 'Opens at', value: clean(event.minRank, 40), inline: true } : null,
        Number.isFinite(Number(event.going)) && event.going !== null
            ? { name: 'Going', value: `✈️ ${Number(event.going)}${event.slots ? ` of ${event.slots}` : ''}${Number(event.waitlisted) ? ` · ${Number(event.waitlisted)} waiting` : ''}`, inline: true }
            : null,
    ].filter(Boolean);
    if (fields.length) e.addFields(fields);
    if (isHttpsUrl(event.bannerUrl) && action !== 'removed') e.setImage(event.bannerUrl);
    if (action === 'cancelled' || action === 'removed') e.setColor(0xDC2626);
    return e;
}

/** "I'm in" / "Can't make it" under an event post — none once it is off. */
function eventButtons(va, eventId, action) {
    if (action === 'cancelled' || action === 'removed') return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(cid('rsvp', eventId)).setLabel('I’m in').setStyle(ButtonStyle.Success).setEmoji('✈️'),
        new ButtonBuilder().setCustomId(cid('unrsvp', eventId)).setLabel('Can’t make it').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link),
    )];
}

const EVENT_REMIND_BEFORE_MS = 60 * 60 * 1000;
const EVENT_REMIND_EVERY_MS = 5 * 60 * 1000;

/* ===========================================================================
 * THE BOT
 * ======================================================================== */

/**
 * @param {object} deps
 *   client            the discord.js Client bot.js already logged in
 *   VirtualAirlineAd  the VA model, for name/slug/branding
 *   isHomeGuild       (guildId) => true for Inflight's own server
 */
function createVaBot({ client, VirtualAirlineAd, isHomeGuild = () => false }) {
    const vaCache = makeCache(CACHE_TTL_MS);
    const joinCache = makeCache(CACHE_TTL_MS, 500);
    const ticketCooldown = makeCooldown(TICKET_COOLDOWN_MS);
    const commandCooldown = makeCooldown(3000);
    const setupCooldown = makeCooldown(5000);
    // One change at a time per ticket — see makeLocks.
    const ticketLocks = makeLocks();
    const eventLocks = makeLocks();
    const sweepLocks = makeLocks();
    const joinBurst = makeBurst(WELCOME_BURST, WELCOME_WINDOW_MS);
    const MUTATING = new Set(['formsub', 'submit', 'test', 'testpick', 'accept', 'declinesub', 'close', 'reopen']);

    /* ---- lookups ------------------------------------------------------- */

    async function guildLink(guildId) {
        if (!guildId) return null;
        const hit = guildCache.get(guildId);
        if (hit !== undefined) return hit;
        const doc = await VaBotGuild.findOne({ guildId }).lean().catch(() => null);
        guildCache.set(guildId, doc || null);
        return doc || null;
    }

    async function vaById(vaId) {
        const k = String(vaId);
        const hit = vaCache.get(k);
        if (hit !== undefined) return hit;
        const va = await VirtualAirlineAd.findById(vaId)
            .select('name slug callsign logoUrl bannerUrl tagline crewAccent status crewDiscordInvite').lean().catch(() => null);
        const ok = va && va.status === 'approved' && va.slug ? va : null;
        vaCache.set(k, ok);
        return ok;
    }

    /** The server's link and its airline, or a reply saying why there is none. */
    async function context(interaction) {
        const link = await guildLink(interaction.guildId);
        if (!link) return { error: `This server is not linked to a crew center yet. A server admin runs \`/crew-admin setup\` with the code from the crew center (Alerts → Discord bot). Setup guide: ${GUIDE_URL()}` };
        const va = await vaById(link.vaId);
        if (!va) return { error: 'The crew center this server was linked to is no longer available.' };
        return { link, va, settings: link.settings || {} };
    }

    async function joinConfig(va) {
        const hit = joinCache.get(va.slug);
        if (hit) return hit;
        const r = await api('get', `/api/va-ads/by-slug/${encodeURIComponent(va.slug)}`);
        if (!r.ok) return null;
        const join = r.data.join || {};
        joinCache.set(va.slug, join);
        return join;
    }

    async function loadTicket(interaction, ticketId) {
        if (!isObjectId(ticketId)) return null;
        return VaBotTicket.findOne({ _id: ticketId, guildId: interaction.guildId }).catch(() => null);
    }

    const actorOf = (interaction) => (interaction.user && (interaction.user.globalName || interaction.user.username)) || 'Discord';

    async function fetchChannel(id) {
        if (!isSnowflake(id)) return null;
        return client.channels.fetch(id).catch(() => null);
    }

    /* ---- small reply helpers ------------------------------------------- */

    async function say(interaction, content, extra = {}) {
        const payload = { content: String(content).slice(0, 1900), ...extra };
        try {
            if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
            return await interaction.reply({ ...payload, flags: EPHEMERAL });
        } catch (err) {
            // An expired interaction is not worth a stack trace.
            if (!(err && (err.code === 10062 || err.code === 40060))) console.error('🤖 vaBot reply failed:', err && err.message ? err.message : err);
            return null;
        }
    }

    async function send(channel, payload) {
        if (!channel) return null;
        try { return await channel.send(payload); }
        catch (err) { console.warn('🤖 vaBot send failed:', err && err.message ? err.message : err); return null; }
    }

    /** A direct message, best-effort: plenty of people keep DMs closed. */
    async function dm(userId, payload) {
        if (!isSnowflake(userId) || !client.users) return null;
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return null;
        try { return await user.send({ allowedMentions: { parse: [] }, ...payload }); } catch { return null; }
    }

    /** One of the airline's pilots, by Discord id, from the crew center. */
    async function pilotByDiscord(va, userId) {
        if (!isSnowflake(userId)) return null;
        const r = await api('get', crewPath(va.slug, `/discord-bot/pilot/${userId}`), { asBot: true, slug: va.slug, actor: 'Discord bot' });
        return r.ok && r.data.pilot ? r.data.pilot : null;
    }

    async function logToStaff(settings, text) {
        const ch = await fetchChannel(settings && settings.logChannelId);
        if (ch) await send(ch, { content: String(text).slice(0, 1900), allowedMentions: { parse: [] } });
    }

    /* ===================================================================
     * COMMANDS
     * ================================================================ */

    function commands() {
        const crew = new SlashCommandBuilder().setName('crew').setDescription('Your virtual airline')
            .setDMPermission(false)
            .addSubcommand((s) => s.setName('apply').setDescription('Apply to join — opens a private ticket with the staff'))
            .addSubcommand((s) => s.setName('ticket').setDescription('Open a private help ticket with the staff'))
            .addSubcommand((s) => s.setName('close').setDescription('Close the ticket you are in')
                .addStringOption((o) => o.setName('reason').setDescription('Why (shown to the member)').setMaxLength(300)))
            .addSubcommand((s) => s.setName('add').setDescription('Staff: add someone to the ticket you are in')
                .addUserOption((o) => o.setName('member').setDescription('Who to add').setRequired(true)))
            .addSubcommand((s) => s.setName('link').setDescription('Link your Discord to your crew center login'))
            .addSubcommand((s) => s.setName('me').setDescription('Your hours, rank, next rank and recent flying')
                .addBooleanOption((o) => o.setName('share').setDescription('Show it to the channel instead of only you')))
            .addSubcommand((s) => s.setName('leaderboard').setDescription('Top pilots by hours')
                .addStringOption((o) => o.setName('window').setDescription('Which period (default: last 30 days)')
                    .addChoices({ name: 'Last 30 days', value: '30' }, { name: 'Last 90 days', value: '90' }, { name: 'All time', value: '0' })))
            .addSubcommand((s) => s.setName('route').setDescription('Suggest a route to fly')
                .addStringOption((o) => o.setName('from').setDescription('Departure ICAO, e.g. EGLL').setMaxLength(4))
                .addStringOption((o) => o.setName('aircraft').setDescription('Aircraft, e.g. A320').setMaxLength(30)))
            .addSubcommand((s) => s.setName('links').setDescription('The airline’s links'))
            .addSubcommand((s) => s.setName('stats').setDescription('Pilots, hours and flights'))
            .addSubcommand((s) => s.setName('events').setDescription('Upcoming events — and sign up for one'))
            .addSubcommand((s) => s.setName('pilot').setDescription('Look a pilot up on the roster')
                .addStringOption((o) => o.setName('who').setDescription('Callsign or name').setRequired(true).setMaxLength(60)));

        const admin = new SlashCommandBuilder().setName('crew-admin').setDescription('Set up the crew center bot in this server')
            .setDMPermission(false)
            .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
            .addSubcommand((s) => s.setName('setup').setDescription('Link this server to your crew center')
                .addStringOption((o) => o.setName('code').setDescription('The code from Crew Center → Alerts → Discord bot').setRequired(true).setMaxLength(20)))
            .addSubcommand((s) => s.setName('settings').setDescription('Choose the roles and channels the bot uses')
                .addRoleOption((o) => o.setName('staff_role').setDescription('Who handles tickets and recruitment'))
                .addRoleOption((o) => o.setName('pilot_role').setDescription('Given to a pilot when they are accepted'))
                .addChannelOption((o) => o.setName('ticket_channel').setDescription('Where ticket threads are opened').addChannelTypes(ChannelType.GuildText))
                .addChannelOption((o) => o.setName('log_channel').setDescription('Where staff hear about tickets').addChannelTypes(ChannelType.GuildText))
                .addChannelOption((o) => o.setName('events_channel').setDescription('Where events are posted, each with a thread').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addBooleanOption((o) => o.setName('auto_invite').setDescription('Accept and send the crew center login as soon as the entrance test is passed')))
            .addSubcommand((s) => s.setName('welcome').setDescription('Greet people who join the server')
                .addChannelOption((o) => o.setName('channel').setDescription('Where to post the welcome').addChannelTypes(ChannelType.GuildText))
                .addRoleOption((o) => o.setName('role').setDescription('A role everyone gets on joining'))
                .addStringOption((o) => o.setName('message').setDescription('Your words. {user} {name} {server} {airline} {members}').setMaxLength(1500))
                .addBooleanOption((o) => o.setName('dm').setDescription('Also send the welcome by DM'))
                .addBooleanOption((o) => o.setName('test').setDescription('Post a sample welcome for you now'))
                .addBooleanOption((o) => o.setName('off').setDescription('Turn the welcome off')))
            .addSubcommand((s) => s.setName('inactivity').setDescription('Move pilots who stop flying to an inactive role')
                .addRoleOption((o) => o.setName('role').setDescription('The inactive role'))
                .addChannelOption((o) => o.setName('channel').setDescription('Where inactive pilots are told how to stay').addChannelTypes(ChannelType.GuildText))
                .addIntegerOption((o) => o.setName('after_days').setDescription('Days without a flight before a pilot is inactive (default 30)').setMinValue(7).setMaxValue(365))
                .addIntegerOption((o) => o.setName('kick_after_days').setDescription('Days in the inactive role before removal (0 = never)').setMinValue(0).setMaxValue(180))
                .addBooleanOption((o) => o.setName('off').setDescription('Turn inactivity tracking off')))
            .addSubcommand((s) => s.setName('sweep').setDescription('See who is inactive now — or apply it straight away')
                .addBooleanOption((o) => o.setName('apply').setDescription('Make the changes now instead of only showing them')))
            .addSubcommand((s) => s.setName('panel').setDescription('Post the recruitment or help panel')
                .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText))
                .addStringOption((o) => o.setName('type').setDescription('Which panel (default: recruitment)')
                    .addChoices({ name: 'Recruitment — apply and contact staff', value: 'apply' }, { name: 'Help — open a support ticket', value: 'support' })))
            .addSubcommand((s) => s.setName('check').setDescription('Check the bot has everything it needs'))
            .addSubcommand((s) => s.setName('unlink').setDescription('Disconnect this server from the crew center'));

        return [crew.toJSON(), admin.toJSON()];
    }

    /* ===================================================================
     * ADMIN
     * ================================================================ */

    async function adminSetup(interaction) {
        const code = interaction.options.getString('code', true);
        await interaction.deferReply({ flags: EPHEMERAL });
        if (normalizeCode(code).length !== 8) return say(interaction, 'That is not a link code. It looks like `ABCD-2345` — get one from Crew Center → Alerts → Discord bot.');
        const codeHash = hashCode(code);
        const found = await VaBotLinkCode.findOne({ codeHash, expiresAt: { $gt: new Date() } }).lean().catch(() => null);
        if (!found) return say(interaction, 'That code is wrong or has expired. Codes last 15 minutes and work once — make a new one in the crew center.');
        const va = await VirtualAirlineAd.findById(found.vaId).select('name slug status').lean().catch(() => null);
        if (!va || va.status !== 'approved') return say(interaction, 'That crew center is not active.');

        // Refused here, the code is left unspent: the owner unlinks and tries
        // the same one again rather than going back for another.
        const existing = await VaBotGuild.findOne({ guildId: interaction.guildId }).lean();
        if (existing && String(existing.vaId) !== String(va._id)) {
            return say(interaction, 'This server is already linked to another crew center. Run `/crew-admin unlink` first.');
        }
        // Spent now. Two servers racing the same code: one delete wins.
        const spent = await VaBotLinkCode.deleteOne({ _id: found._id }).catch(() => null);
        if (!spent || !spent.deletedCount) return say(interaction, 'That code was just used. Make a new one in the crew center.');
        await VaBotGuild.updateOne(
            { guildId: interaction.guildId },
            {
                $set: {
                    vaId: va._id, guildName: clean(interaction.guild && interaction.guild.name, 100),
                    linkedBy: { id: interaction.user.id, tag: interaction.user.tag || interaction.user.username },
                    linkedAt: new Date(),
                },
            },
            { upsert: true },
        );
        guildCache.del(interaction.guildId);
        return say(interaction, [
            `✅ Linked to **${va.name}**.`,
            '',
            'Next:',
            '1. `/crew-admin settings` — pick your staff role, pilot role, ticket channel and events channel.',
            '2. `/crew-admin panel` in your recruitment channel (and `type: Help` wherever members ask for help).',
            '3. `/crew-admin welcome` — greet newcomers. `/crew-admin inactivity` — look after pilots who stop flying.',
            '4. `/crew-admin check` to make sure the bot has the permissions it needs.',
            '',
            `The full setup guide: ${GUIDE_URL()}`,
        ].join('\n'));
    }

    async function adminSettings(interaction, ctx) {
        const set = {};
        const role = (n) => interaction.options.getRole(n);
        const chan = (n) => interaction.options.getChannel(n);
        if (role('staff_role')) set['settings.staffRoleId'] = role('staff_role').id;
        if (role('pilot_role')) {
            const r = role('pilot_role');
            if (r.managed || r.id === interaction.guildId) return say(interaction, 'That role cannot be given out by a bot. Pick an ordinary role.');
            set['settings.pilotRoleId'] = r.id;
        }
        if (chan('ticket_channel')) set['settings.ticketChannelId'] = chan('ticket_channel').id;
        if (chan('log_channel')) set['settings.logChannelId'] = chan('log_channel').id;
        if (chan('events_channel')) set['settings.eventsChannelId'] = chan('events_channel').id;
        const auto = interaction.options.getBoolean('auto_invite');
        if (auto !== null) set['settings.autoInvite'] = auto;

        let s = ctx.settings;
        if (Object.keys(set).length) {
            const doc = await VaBotGuild.findOneAndUpdate({ guildId: interaction.guildId }, { $set: set }, { new: true }).lean();
            guildCache.del(interaction.guildId);
            s = (doc && doc.settings) || s;
        }
        const show = (id, kind) => (id ? (kind === 'role' ? `<@&${id}>` : `<#${id}>`) : '_not set_');
        const e = vaEmbed(ctx.va).setTitle('Crew center bot — settings').addFields(
            { name: 'Staff role', value: show(s.staffRoleId, 'role'), inline: true },
            { name: 'Pilot role', value: show(s.pilotRoleId, 'role'), inline: true },
            { name: 'Auto-invite on pass', value: s.autoInvite ? 'On' : 'Off — staff press Accept', inline: true },
            { name: 'Ticket channel', value: show(s.ticketChannelId), inline: true },
            { name: 'Log channel', value: show(s.logChannelId), inline: true },
            { name: 'Events channel', value: show(s.eventsChannelId), inline: true },
            { name: 'Welcome', value: welcomeSummary(s), inline: false },
            { name: 'Inactivity', value: inactivitySummary(s), inline: false },
        );
        return interaction.reply({ embeds: [e], flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }

    async function adminPanel(interaction, ctx) {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) return say(interaction, 'Post the panel in an ordinary text channel.');
        await interaction.deferReply({ flags: EPHEMERAL });
        if (interaction.options.getString('type') === 'support') return postHelpPanel(interaction, ctx, channel);
        const join = await joinConfig(ctx.va) || {};
        const reqs = describeRequirements(join);
        const e = vaEmbed(ctx.va)
            .setTitle(`Fly with ${clean(ctx.va.name, 200)}`)
            .setDescription([
                ctx.va.tagline ? clean(ctx.va.tagline, 300) : '',
                join.mode === 'free'
                    ? 'Press **Apply** to join. A private ticket opens where you fill in your details, and staff send your crew center login.'
                    : 'Press **Apply** to open a private ticket with the recruitment team. You fill in the application there, and the team takes it from there — entrance test, decision and your crew center login.',
                reqs.length ? `**Requirements:** ${reqs.join(' · ')}` : '',
            ].filter(Boolean).join('\n\n'));
        if (isHttpsUrl(join.banner || ctx.va.bannerUrl)) e.setImage(join.banner || ctx.va.bannerUrl);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(cid('open', 'apply')).setLabel('Apply').setStyle(ButtonStyle.Success).setEmoji('✈️'),
            new ButtonBuilder().setCustomId(cid('open', 'support')).setLabel('Contact staff').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
            new ButtonBuilder().setCustomId(cid('links')).setLabel('Links').setStyle(ButtonStyle.Secondary).setEmoji('🔗'),
            new ButtonBuilder().setURL(crewUrl(ctx.va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link),
        );
        const posted = await send(channel, { embeds: [e], components: [row] });
        if (!posted) return say(interaction, `I could not post in ${channel}. Give me **View Channel**, **Send Messages** and **Embed Links** there.`);
        await VaBotGuild.updateOne({ guildId: interaction.guildId }, { $set: { panelAt: new Date() } }).catch(() => {});
        return say(interaction, `Panel posted in ${channel}.${ctx.settings.ticketChannelId ? '' : ' Tickets will open as threads in that channel — set a different one with `/crew-admin settings ticket_channel`.'}`);
    }

    /** The help panel: a ticket for anything, not only joining. */
    async function postHelpPanel(interaction, ctx, channel) {
        const e = vaEmbed(ctx.va)
            .setTitle('Need a hand? 🎫')
            .setDescription([
                `Questions about ${clean(ctx.va.name, 100)}, the crew center, a flight, an event — or anything else?`,
                'Press **Open a ticket**. A private thread opens that only you and the staff can see, and someone will be with you shortly.',
            ].join('\n\n'));
        const posted = await send(channel, {
            embeds: [e],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(cid('open', 'support')).setLabel('Open a ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
                new ButtonBuilder().setCustomId(cid('link')).setLabel('Link my account').setStyle(ButtonStyle.Secondary).setEmoji('🔗'),
                new ButtonBuilder().setURL(crewUrl(ctx.va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link),
            )],
        });
        if (!posted) return say(interaction, `I could not post in ${channel}. Give me **View Channel**, **Send Messages** and **Embed Links** there.`);
        return say(interaction, `Help panel posted in ${channel}.`);
    }

    const welcomeSummary = (s) => (s.welcomeChannelId || s.welcomeRoleId || s.welcomeDm
        ? [s.welcomeChannelId ? `posts in <#${s.welcomeChannelId}>` : '', s.welcomeRoleId ? `gives <@&${s.welcomeRoleId}>` : '',
            s.welcomeDm ? 'sends a DM' : '', s.welcomeMessage ? 'your own message' : 'the default message'].filter(Boolean).join(' · ')
        : 'Off — `/crew-admin welcome`');
    const inactivitySummary = (s) => (s.inactiveRoleId
        ? [`<@&${s.inactiveRoleId}> after ${s.inactiveDays || INACTIVE_DAYS_DEFAULT} days without a flight`,
            s.inactiveChannelId ? `told how to stay in <#${s.inactiveChannelId}>` : 'told by DM',
            s.kickDays > 0 ? `removed after ${s.kickDays} more days` : 'never removed'].join(' · ')
        : 'Off — `/crew-admin inactivity`');

    /** A role the bot is about to hand out: one it is allowed to. */
    function roleRefusal(role, guildId) {
        if (!role) return '';
        if (role.managed || role.id === guildId) return `${role} belongs to an integration or is @everyone — pick an ordinary role.`;
        return '';
    }

    async function adminWelcome(interaction, ctx) {
        const set = {};
        if (interaction.options.getBoolean('off')) {
            Object.assign(set, { 'settings.welcomeChannelId': '', 'settings.welcomeRoleId': '', 'settings.welcomeDm': false });
        } else {
            const ch = interaction.options.getChannel('channel');
            const role = interaction.options.getRole('role');
            const msg = interaction.options.getString('message');
            const dm = interaction.options.getBoolean('dm');
            const refused = roleRefusal(role, interaction.guildId);
            if (refused) return say(interaction, refused);
            if (ch) set['settings.welcomeChannelId'] = ch.id;
            if (role) set['settings.welcomeRoleId'] = role.id;
            if (msg !== null) set['settings.welcomeMessage'] = clean(msg, 1500).replace(/\\n/g, '\n');
            if (dm !== null) set['settings.welcomeDm'] = dm;
        }
        let s = ctx.settings;
        if (Object.keys(set).length) {
            const doc = await VaBotGuild.findOneAndUpdate({ guildId: interaction.guildId }, { $set: set }, { new: true }).lean();
            guildCache.del(interaction.guildId);
            s = (doc && doc.settings) || s;
        }
        if (interaction.options.getBoolean('test')) {
            await interaction.deferReply({ flags: EPHEMERAL });
            const member = interaction.member && interaction.member.user ? interaction.member : { user: interaction.user, guild: interaction.guild };
            const where = await fetchChannel(s.welcomeChannelId);
            const payload = welcomePayload(ctx.va, s, { member, guild: interaction.guild, pilot: null });
            const posted = where ? await send(where, payload) : null;
            return say(interaction, posted ? `Sample posted in ${where}. ${welcomeSummary(s)}` : `${where ? `I could not post in ${where} — check my permissions there.` : 'Pick a channel first: `/crew-admin welcome channel:`.'}`,
                { allowedMentions: { parse: [] } });
        }
        return say(interaction, `**Welcome:** ${welcomeSummary(s)}\n\nPreview of your message:\n>>> ${renderWelcome(s.welcomeMessage, { name: interaction.user.username, server: interaction.guild && interaction.guild.name, airline: ctx.va.name })}`,
            { allowedMentions: { parse: [] } });
    }

    async function adminInactivity(interaction, ctx) {
        const set = {};
        if (interaction.options.getBoolean('off')) {
            set['settings.inactiveRoleId'] = '';
        } else {
            const role = interaction.options.getRole('role');
            const ch = interaction.options.getChannel('channel');
            const after = interaction.options.getInteger ? interaction.options.getInteger('after_days') : null;
            const kick = interaction.options.getInteger ? interaction.options.getInteger('kick_after_days') : null;
            const refused = roleRefusal(role, interaction.guildId);
            if (refused) return say(interaction, refused);
            if (role && (role.id === ctx.settings.pilotRoleId || role.id === ctx.settings.staffRoleId)) {
                return say(interaction, 'The inactive role has to be its own role — not the pilot role or the staff role.');
            }
            if (role) set['settings.inactiveRoleId'] = role.id;
            if (ch) set['settings.inactiveChannelId'] = ch.id;
            if (after !== null && after !== undefined) set['settings.inactiveDays'] = clampInt(after, 7, 365, INACTIVE_DAYS_DEFAULT);
            if (kick !== null && kick !== undefined) set['settings.kickDays'] = clampInt(kick, 0, 180, 0);
        }
        let s = ctx.settings;
        if (Object.keys(set).length) {
            const doc = await VaBotGuild.findOneAndUpdate({ guildId: interaction.guildId }, { $set: set }, { new: true }).lean();
            guildCache.del(interaction.guildId);
            s = (doc && doc.settings) || s;
        }
        // A new removal deadline applies to people already inactive too — but
        // never sooner than a reminder's worth of notice from today, so
        // switching removal on can never remove anybody without warning.
        if ('settings.kickDays' in set) {
            const now = Date.now();
            const days = set['settings.kickDays'];
            const recs = await VaBotInactive.find({ guildId: interaction.guildId, status: 'inactive' }).limit(2000).lean().catch(() => []);
            for (const r of recs) {
                const kickAt = days > 0 ? new Date(Math.max(toTime(r.since) + days * DAY_MS, now + (REMIND_BEFORE_DAYS + 1) * DAY_MS)) : null;
                await VaBotInactive.updateOne({ _id: r._id }, { $set: { kickAt, remindedAt: null } }).catch(() => {});
            }
        }
        const lines = [`**Inactivity:** ${inactivitySummary(s)}`];
        if (!s.inactiveRoleId && set['settings.inactiveRoleId'] === '') {
            lines.push('', 'Anyone already in the inactive role keeps it until you remove it — turn this back on and they’ll be restored as soon as they fly.');
        }
        if (s.inactiveRoleId) {
            lines.push('',
                'How it works:',
                `• Every few hours I check the crew center. A pilot whose Discord is linked and who has not flown for ${s.inactiveDays || INACTIVE_DAYS_DEFAULT} days gets <@&${s.inactiveRoleId}>${s.pilotRoleId ? ` instead of <@&${s.pilotRoleId}>` : ''}, and a friendly note on how to stay.`,
                '• The moment they fly a route and it is approved, the role is swapped back and they get a welcome-back message.',
                s.kickDays > 0 ? `• If they still have not flown ${s.kickDays} days later, they get a kind goodbye and are removed from the server (a reminder goes out ${REMIND_BEFORE_DAYS} days before).` : '• Nobody is ever removed. Set `kick_after_days` to change that.',
                '• Pilots on leave of absence and staff are never touched.',
                '',
                'Run `/crew-admin sweep` to see who that is right now before anything happens.');
        }
        return say(interaction, lines.join('\n'), { allowedMentions: { parse: [] } });
    }

    async function adminSweep(interaction, ctx) {
        if (!ctx.settings.inactiveRoleId) return say(interaction, 'Inactivity is off. Turn it on with `/crew-admin inactivity role:`.');
        await interaction.deferReply({ flags: EPHEMERAL });
        const apply = interaction.options.getBoolean('apply') === true;
        if (sweepLocks.busy(interaction.guildId)) return say(interaction, 'A sweep is already running here — give it a moment.');
        const out = await sweepLocks.run(interaction.guildId, () => sweepGuild(ctx.link, { apply }));
        if (out.skipped) return say(interaction, `Nothing done: ${out.skipped}`);
        const names = (list) => list.slice(0, 15).map((x) => `<@${x.pilot.discordId}>${x.pilot.callsign ? ` (${clean(x.pilot.callsign, 20)})` : ''}`).join(', ') + (list.length > 15 ? ` and ${list.length - 15} more` : '');
        const p = out.plan;
        const lines = [apply ? '**Sweep done.**' : '**Preview — nothing has changed yet.** Run `/crew-admin sweep apply:True` to do it now, or wait: it runs by itself every few hours.',
            `Checked ${out.checked} pilot${out.checked === 1 ? '' : 's'} with a linked Discord.`, ''];
        lines.push(p.flag.length ? `💤 Moved to inactive: ${names(p.flag)}` : '💤 Nobody new is inactive.');
        if (p.remind.length) lines.push(`⏰ Reminded: ${names(p.remind)}`);
        if (p.kick.length) lines.push(`👋 Removed from the server: ${names(p.kick)}`);
        if (p.restore.length) lines.push(`✈️ Welcomed back: ${names(p.restore)}`);
        if (out.capped) lines.push('', `Only the first ${MAX_FLAG_PER_SWEEP} new and ${MAX_KICK_PER_SWEEP} removals happen per sweep — the rest follow on the next one.`);
        if (out.unlinked) lines.push('', `${out.unlinked} pilot${out.unlinked === 1 ? ' has' : 's have'} not linked Discord yet, so I cannot tell who they are here. \`/crew link\` takes them ten seconds.`);
        if (out.errors && out.errors.length) lines.push('', `⚠️ ${out.errors.slice(0, 5).join('\n⚠️ ')}`);
        return say(interaction, lines.join('\n'), { allowedMentions: { parse: [] } });
    }

    /** What the bot can and cannot do here, in words an owner can act on. */
    async function adminCheck(interaction, ctx) {
        await interaction.deferReply({ flags: EPHEMERAL });
        const guild = interaction.guild;
        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!me) return say(interaction, 'I could not read my own permissions here. Try again in a moment.');
        const s = ctx.settings;
        const lines = [];
        const need = (channel, perms, label) => {
            if (!channel) { lines.push(`⚪ ${label}: not set`); return; }
            const have = channel.permissionsFor(me);
            const missing = perms.filter((p) => !(have && have.has(PermissionsBitField.Flags[p])));
            lines.push(missing.length ? `❌ ${label} ${channel}: missing ${missing.join(', ')}` : `✅ ${label} ${channel}`);
        };
        const ticketCh = await fetchChannel(s.ticketChannelId);
        need(ticketCh, ['ViewChannel', 'SendMessages', 'CreatePrivateThreads', 'SendMessagesInThreads', 'ManageThreads', 'EmbedLinks'], 'Ticket channel');
        need(await fetchChannel(s.logChannelId), ['ViewChannel', 'SendMessages'], 'Log channel');
        need(await fetchChannel(s.eventsChannelId), ['ViewChannel', 'SendMessages', 'EmbedLinks', 'CreatePublicThreads', 'SendMessagesInThreads', 'ManageThreads'], 'Events channel');

        if (s.staffRoleId) {
            const role = await guild.roles.fetch(s.staffRoleId).catch(() => null);
            if (!role) lines.push('❌ Staff role: deleted — pick another');
            else if (ticketCh && !ticketCh.permissionsFor(role).has(PermissionsBitField.Flags.ManageThreads)) {
                lines.push(`⚠️ Staff role ${role}: give it **Manage Threads** in ${ticketCh} so staff can see every ticket, not only the ones they are pinged into.`);
            } else lines.push(`✅ Staff role ${role}`);
        } else lines.push('⚪ Staff role: not set — only people with Manage Server can handle tickets');

        if (s.pilotRoleId) {
            const role = await guild.roles.fetch(s.pilotRoleId).catch(() => null);
            if (!role) lines.push('❌ Pilot role: deleted — pick another');
            else if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) lines.push('❌ Pilot role: I need **Manage Roles** to give it out');
            else if (me.roles.highest.comparePositionTo(role) <= 0) lines.push(`❌ Pilot role ${role}: drag my role above it in Server Settings → Roles`);
            else lines.push(`✅ Pilot role ${role}`);
        } else lines.push('⚪ Pilot role: not set — accepted pilots get no role');

        const giveable = async (id, label) => {
            const role = await guild.roles.fetch(id).catch(() => null);
            if (!role) return `❌ ${label}: deleted — pick another`;
            if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return `❌ ${label}: I need **Manage Roles** to give it out`;
            if (me.roles.highest.comparePositionTo(role) <= 0) return `❌ ${label} ${role}: drag my role above it in Server Settings → Roles`;
            return `✅ ${label} ${role}`;
        };
        if (s.welcomeChannelId) need(await fetchChannel(s.welcomeChannelId), ['ViewChannel', 'SendMessages', 'EmbedLinks'], 'Welcome channel');
        if (s.welcomeRoleId) lines.push(await giveable(s.welcomeRoleId, 'Welcome role'));
        if (!s.welcomeChannelId && !s.welcomeRoleId && !s.welcomeDm) lines.push('⚪ Welcome: off — `/crew-admin welcome`');
        if (s.inactiveRoleId) {
            lines.push(await giveable(s.inactiveRoleId, 'Inactive role'));
            if (s.inactiveChannelId) need(await fetchChannel(s.inactiveChannelId), ['ViewChannel', 'SendMessages', 'EmbedLinks'], 'Inactive channel');
            if (s.kickDays > 0) {
                lines.push(me.permissions.has(PermissionsBitField.Flags.KickMembers)
                    ? `✅ Removing pilots inactive for ${s.kickDays} more days`
                    : '❌ Removal is on, but I need **Kick Members** — or set `kick_after_days:0`');
            }
        } else lines.push('⚪ Inactivity: off — `/crew-admin inactivity`');

        const join = await joinConfig(ctx.va);
        lines.push(join ? `✅ Crew center **${ctx.va.name}** is answering` : '❌ The crew center did not answer');
        lines.push('', `Stuck on one of these? ${GUIDE_URL()}#troubleshooting`);
        return say(interaction, lines.join('\n'), { allowedMentions: { parse: [] } });
    }

    async function adminUnlink(interaction) {
        await VaBotGuild.deleteOne({ guildId: interaction.guildId });
        guildCache.del(interaction.guildId);
        return say(interaction, 'Unlinked. Open tickets stay where they are; nothing new will be posted. Run `/crew-admin setup` with a new code to link again.');
    }

    /* ===================================================================
     * PUBLIC COMMANDS
     * ================================================================ */

    async function showLinks(interaction, ctx) {
        await interaction.deferReply({ flags: EPHEMERAL });
        const r = await api('get', crewPath(ctx.va.slug, '/links'));
        const links = r.ok && Array.isArray(r.data.links) ? r.data.links : [];
        const usable = links.filter((l) => !l.locked && isHttpUrl(l.url)).slice(0, 25);
        const e = vaEmbed(ctx.va).setTitle('Links');
        const lines = [`🧭 [Crew center](${crewUrl(ctx.va.slug)})`];
        if (ctx.va.crewDiscordInvite && isHttpsUrl(ctx.va.crewDiscordInvite)) lines.push(`💬 [Discord invite](${ctx.va.crewDiscordInvite})`);
        for (const l of usable) {
            const title = clean(l.title, 80).replace(/[[\]]/g, '') || l.host || 'Link';
            lines.push(`• [${title}](${l.url})${l.description ? ` — ${clean(l.description, 100)}` : ''}`);
        }
        e.setDescription(lines.join('\n').slice(0, 4000));
        if (!r.ok) e.setFooter({ text: 'The airline’s own links could not be loaded right now.' });
        return interaction.editReply({ embeds: [e] });
    }

    async function showStats(interaction, ctx) {
        await interaction.deferReply();
        const r = await api('get', crewPath(ctx.va.slug, '/stats'));
        const st = r.ok && r.data.stats;
        if (!st) return say(interaction, r.ok ? 'This airline has no figures to show yet.' : r.error);
        const n = (v) => Number(v || 0).toLocaleString('en-US');
        const e = vaEmbed(ctx.va).setTitle(`${clean(ctx.va.name, 200)} in numbers`).setURL(crewUrl(ctx.va.slug)).addFields(
            { name: 'Pilots', value: `${n(st.pilotsActive)} active of ${n(st.pilots)}`, inline: true },
            { name: 'Flight hours', value: n(st.flightHours || st.hours), inline: true },
            { name: 'Flights', value: n(st.pirepsApproved), inline: true },
            { name: 'Last 30 days', value: `${n(st.flights30d)} flights · ${n(st.flightHours30d)} h`, inline: true },
            { name: 'Routes', value: `${n(st.routesActive)} to ${n(st.destinations)} destinations`, inline: true },
        );
        const top = Array.isArray(st.topPilots) ? st.topPilots.slice(0, 5) : [];
        if (top.length) {
            e.addFields({ name: 'Top pilots', value: top.map((p, i) => `${i + 1}. ${clean(p.callsign, 20) || ''} ${clean(p.name, 40)} — ${n(p.hours)} h`).join('\n') });
        }
        return interaction.editReply({ embeds: [e] });
    }

    async function showEvents(interaction, ctx) {
        await interaction.deferReply();
        const r = await api('get', crewPath(ctx.va.slug, '/events?upcoming=1'));
        const events = (r.ok && Array.isArray(r.data.events) ? r.data.events : [])
            .filter((e) => e.status !== 'cancelled').slice(0, 8);
        if (!r.ok) return say(interaction, r.error);
        const e = vaEmbed(ctx.va).setTitle('Upcoming events').setURL(crewUrl(ctx.va.slug));
        e.setDescription(events.length
            ? events.map((ev) => {
                const leg = [ev.origin, ev.destination].filter(Boolean).join(' → ');
                const going = Number(ev.going ?? ev.attending ?? ev.signupCount ?? 0);
                return `**${clean(ev.title, 100) || leg || 'Event'}**${leg && ev.title ? ` · ${leg}` : ''}\n${stamp(ev.startsAt) || 'Time to be announced'}${going ? ` · ${going} going` : ''}${ev.full ? ' · full (waitlist open)' : ''}`;
            }).join('\n\n').slice(0, 4000)
            : 'Nothing on the calendar right now.');
        // Anyone can use the menu: it signs up whoever picks, as themselves.
        const components = events.length ? [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(cid('rsvpick')).setPlaceholder('✈️ Sign me up for…')
                .addOptions(events.map((ev) => ({
                    label: (clean(ev.title, 100) || [ev.origin, ev.destination].filter(Boolean).join(' → ') || 'Event').slice(0, 100),
                    value: String(ev.id || ev._id).slice(0, 100),
                    description: (toTime(ev.startsAt) ? new Date(ev.startsAt).toUTCString().replace(/:\d\d GMT$/, 'Z') : 'Time to be announced').slice(0, 100),
                }))),
        )] : [];
        return interaction.editReply({ embeds: [e], components });
    }

    async function showPilot(interaction, ctx) {
        const who = clean(interaction.options.getString('who', true), 60).toLowerCase();
        await interaction.deferReply();
        const r = await api('get', crewPath(ctx.va.slug, '/roster'));
        if (!r.ok) return say(interaction, r.error);
        const roster = Array.isArray(r.data.roster) ? r.data.roster : [];
        const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
        const pilot = roster.find((m) => squash(m.callsign) === squash(who))
            || roster.find((m) => String(m.name || '').toLowerCase() === who)
            || roster.find((m) => squash(m.callsign).includes(squash(who)) || String(m.name || '').toLowerCase().includes(who));
        if (!pilot) return say(interaction, `Nobody on the ${clean(ctx.va.name, 100)} roster matches “${who}”.`);
        const e = vaEmbed(ctx.va).setTitle(`${clean(pilot.callsign, 40)} ${clean(pilot.name, 80)}`.trim()).addFields(
            { name: 'Rank', value: clean(pilot.rank && pilot.rank.name, 40) || '—', inline: true },
            { name: 'Hours', value: String(Math.round((Number(pilot.hours) || 0) * 10) / 10), inline: true },
            { name: 'Status', value: clean(pilot.status, 20) || '—', inline: true },
        );
        if (pilot.role) e.addFields({ name: 'Role', value: clean(pilot.role, 60), inline: true });
        if (pilot.rank && isHttpsUrl(pilot.rank.image)) e.setThumbnail(pilot.rank.image);
        return interaction.editReply({ embeds: [e] });
    }

    /* ===================================================================
     * TICKETS
     * ================================================================ */

    /** The open ticket of this kind for this person, if its thread is still there. */
    async function openTicketOf(interaction, kind) {
        const prior = await VaBotTicket.findOne({ guildId: interaction.guildId, userId: interaction.user.id, kind, status: 'open' });
        if (!prior) return null;
        const thread = await fetchChannel(prior.threadId);
        if (thread) return { ticket: prior, thread };
        prior.status = 'closed'; prior.closedAt = new Date();
        await prior.save().catch(() => {});
        return null;
    }

    /**
     * A help ticket starts with two questions — what about, and anything
     * else — so the staff who pick it up know where to start without a round
     * of "hi, what's up?". A modal has to be the first answer to the click,
     * so the checks before it are the cheap ones.
     */
    async function askSupport(interaction, ctx, preset) {
        const open = await openTicketOf(interaction, 'support');
        if (open) return say(interaction, `You already have a ticket open: ${open.thread}`);
        const subject = new TextInputBuilder().setCustomId('topic').setLabel('What do you need help with?')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
            .setPlaceholder('e.g. Can’t sign in, question about a route, event idea…');
        if (preset === 'loa') subject.setValue('Leave of absence');
        const details = new TextInputBuilder().setCustomId('details').setLabel('Anything the staff should know? (optional)')
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500);
        if (preset === 'loa') details.setPlaceholder('How long you’ll be away, and anything else you’d like the team to know.');
        const modal = new ModalBuilder().setCustomId(cid('opensub', 'support'))
            .setTitle(`Contact ${clean(ctx.va.name, 30)} staff`.slice(0, 45))
            .addComponents(new ActionRowBuilder().addComponents(subject), new ActionRowBuilder().addComponents(details));
        return interaction.showModal(modal);
    }

    async function openTicket(interaction, ctx, kind, { topic = '', details = '' } = {}) {
        const wait = ticketCooldown.hit(`${interaction.guildId}:${interaction.user.id}`);
        if (wait) return say(interaction, `Give it ${wait}s before opening another ticket.`);
        await interaction.deferReply({ flags: EPHEMERAL });

        // One open ticket of each kind per person. A second click points at the
        // first, unless that thread has gone, in which case the record is closed.
        const prior = await openTicketOf(interaction, kind);
        if (prior) return say(interaction, `You already have a ticket open: ${prior.thread}`);
        const open = await VaBotTicket.countDocuments({ guildId: interaction.guildId, status: 'open' });
        if (open >= MAX_OPEN_TICKETS_PER_GUILD) return say(interaction, 'The staff have a lot of tickets open right now. Try again later.');

        let join = null;
        if (kind === 'apply') {
            join = await joinConfig(ctx.va);
            if (!join) return say(interaction, 'The crew center is not answering right now. Try again in a minute.');
        }

        const parent = (await fetchChannel(ctx.settings.ticketChannelId)) || interaction.channel;
        if (!parent || parent.type !== ChannelType.GuildText || !parent.threads) {
            return say(interaction, 'Tickets are not set up here. Ask an admin to run `/crew-admin settings ticket_channel`.');
        }
        let thread;
        try {
            thread = await parent.threads.create({
                name: threadName(kind, interaction.user.username),
                type: ChannelType.PrivateThread,
                invitable: false,
                autoArchiveDuration: THREAD_ARCHIVE_MIN,
                reason: `${kind === 'apply' ? 'Application' : 'Support'} ticket for ${interaction.user.tag || interaction.user.username}`,
            });
            await thread.members.add(interaction.user.id);
        } catch (err) {
            console.warn('🤖 vaBot ticket thread failed:', err && err.message ? err.message : err);
            if (thread) await thread.delete().catch(() => {});
            return say(interaction, 'I could not open a private thread. An admin should run `/crew-admin check`.');
        }

        const ticket = await VaBotTicket.create({
            guildId: interaction.guildId, vaId: ctx.va._id, threadId: thread.id,
            userId: interaction.user.id, userTag: interaction.user.tag || interaction.user.username, kind,
            stage: kind === 'apply' ? 'form' : 'support',
            topic: clean(topic, 100),
        });

        const staff = ctx.settings.staffRoleId;
        if (kind === 'apply') {
            const pages = pageCount(join.form);
            const reqs = describeRequirements(join);
            const e = vaEmbed(ctx.va).setTitle(`Application — ${clean(ctx.va.name, 200)}`).setDescription([
                `Welcome, ${interaction.user}! This thread is private: only you and the ${clean(ctx.va.name, 100)} staff can see it.`,
                `Press **Start application**. It takes ${pages === 1 ? 'one short form' : `${pages} short forms`}.`,
                reqs.length ? `**Requirements:** ${reqs.join(' · ')}` : '',
                'Your Infinite Flight Community name is checked against Infinite Flight, so use the exact spelling.',
            ].filter(Boolean).join('\n\n'));
            await send(thread, {
                content: `${interaction.user}`,
                embeds: [e],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('form', ticket._id, 0)).setLabel('Start application').setStyle(ButtonStyle.Primary).setEmoji('📝'),
                    new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close').setStyle(ButtonStyle.Secondary),
                )],
                allowedMentions: { users: [interaction.user.id] },
            });
        } else {
            const e = vaEmbed(ctx.va).setTitle(`🎫 ${clean(topic, 100) || 'Help'}`.slice(0, 256)).setDescription([
                `Hi ${interaction.user}, thanks for reaching out! This thread is private — only you and the ${clean(ctx.va.name, 100)} staff can see it.`,
                'Someone from the team will be with you shortly. While you wait, add anything that helps: screenshots, your callsign, a link.',
            ].join('\n\n'));
            if (clean(details, 1500)) e.addFields({ name: 'Details', value: clean(details, 1024) });
            e.setFooter({ text: 'Sorted? Press Close ticket — you can reopen it if you need to.' });
            await send(thread, {
                content: `${interaction.user}${staff ? ` <@&${staff}>` : ''}`,
                embeds: [e],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
                )],
                allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
            });
        }
        logToStaff(ctx.settings, `🎫 ${kind === 'apply' ? 'Application' : `Help ticket “${clean(topic, 100) || 'Help'}”`} opened by <@${interaction.user.id}>: ${thread}`).catch(() => {});
        return say(interaction, `Your ticket is open: ${thread}`);
    }

    /** Only the person the ticket is for — the applicant's own buttons. */
    const isOwner = (interaction, ticket) => ticket && ticket.userId === interaction.user.id;

    /* ---- the form ------------------------------------------------------ */

    async function showFormPage(interaction, ctx, ticket, page) {
        if (!isOwner(interaction, ticket)) return say(interaction, 'Only the applicant can fill this in.');
        if (ticket.stage !== 'form') return say(interaction, 'This application has already been sent.');
        const join = await joinConfig(ctx.va);
        if (!join) return say(interaction, 'The crew center is not answering right now. Try again in a minute.');
        const pages = pageCount(join.form);
        const p = Math.max(0, Math.min(pages - 1, Number(page) || 0));
        const d = ticket.draft || {};
        const modal = new ModalBuilder().setCustomId(cid('formsub', ticket._id, p))
            .setTitle(`Application${pages > 1 ? ` (${p + 1}/${pages})` : ''}`.slice(0, 45));
        const input = (id, label, { style = TextInputStyle.Short, required = false, max = 100, placeholder = '', value = '' } = {}) => {
            const t = new TextInputBuilder().setCustomId(id).setLabel(shortLabel(label)).setStyle(style).setRequired(required).setMaxLength(max);
            if (placeholder) t.setPlaceholder(String(placeholder).slice(0, 100));
            if (value) t.setValue(String(value).slice(0, max));
            return new ActionRowBuilder().addComponents(t);
        };
        if (p === 0) {
            const airlines = (join.callsign && join.callsign.airlines) || [];
            const sample = airlines[0] && airlines[0].sample;
            modal.addComponents(
                input('ifc', 'Infinite Flight Community name', { required: true, max: 60, placeholder: 'Exactly as on community.infiniteflight.com', value: d.ifcName }),
                input('num', 'Callsign number you would like', { required: true, max: 10, placeholder: sample ? `e.g. ${sample}` : 'e.g. 123', value: d.callsignNumber }),
            );
            if (airlines.length > 1) {
                modal.addComponents(input('air', 'Which airline?', {
                    required: true, max: 40, value: d.airline,
                    placeholder: `One of: ${airlines.map((a) => a.base).join(', ')}`,
                }));
            }
            modal.addComponents(input('email', 'Email (optional)', { max: 120, placeholder: 'For decision emails — leave blank if you prefer Discord', value: d.email }));
        } else {
            for (const q of pageQuestions(join.form, p)) {
                const opts = q.type === 'select' && q.options && q.options.length ? `One of: ${q.options.join(' / ')}` : clean(q.label, 100);
                modal.addComponents(input(`q${q.index}`, q.label, {
                    style: q.type === 'textarea' ? TextInputStyle.Paragraph : TextInputStyle.Short,
                    required: !!q.required, max: q.type === 'textarea' ? 2000 : 300,
                    placeholder: opts, value: (d.answers || [])[q.index] || '',
                }));
            }
        }
        return interaction.showModal(modal);
    }

    async function saveFormPage(interaction, ctx, ticket, page) {
        if (!isOwner(interaction, ticket) || ticket.stage !== 'form') return say(interaction, 'This application can no longer be edited.');
        const join = await joinConfig(ctx.va);
        if (!join) return say(interaction, 'The crew center is not answering right now. Try again in a minute.');
        const p = Number(page) || 0;
        const get = (id) => { try { return interaction.fields.getTextInputValue(id); } catch { return ''; } };
        const problems = [];
        if (p === 0) {
            ticket.draft.ifcName = clean(get('ifc'), 60).replace(/^@/, '');
            ticket.draft.callsignNumber = clean(get('num'), 10).replace(/[^0-9]/g, '');
            ticket.draft.email = clean(get('email'), 120);
            const airlines = (join.callsign && join.callsign.airlines) || [];
            if (airlines.length > 1) {
                ticket.draft.airline = clean(get('air'), 40);
                if (pickAirline(airlines, ticket.draft.airline) == null) problems.push(`Airline must be one of: ${airlines.map((a) => a.base).join(', ')}.`);
            }
            if (!ticket.draft.callsignNumber) problems.push('The callsign number should be digits only.');
        } else {
            const answers = Array.isArray(ticket.draft.answers) ? ticket.draft.answers.slice() : [];
            for (const q of pageQuestions(join.form, p)) {
                const m = matchOption(q, get(`q${q.index}`));
                if (!m.ok) problems.push(`“${clean(q.label, 60)}” must be one of: ${q.options.join(' / ')}.`);
                answers[q.index] = m.value;
            }
            ticket.draft.answers = answers;
            ticket.markModified('draft.answers');
        }
        await ticket.save();

        const pages = pageCount(join.form);
        const next = problems.length ? p : p + 1;
        if (next < pages) {
            return interaction.reply({
                content: problems.length ? `⚠️ ${problems.join('\n')}` : `Saved. Part ${next + 1} of ${pages} next.`,
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('form', ticket._id, next)).setLabel(problems.length ? 'Fix it' : 'Continue').setStyle(ButtonStyle.Primary),
                )],
                flags: EPHEMERAL,
            });
        }
        return showReview(interaction, ctx, ticket, join);
    }

    async function showReview(interaction, ctx, ticket, join) {
        const d = ticket.draft;
        const missing = draftProblems(d, join);
        const form = Array.isArray(join.form) ? join.form : [];
        const e = vaEmbed(ctx.va).setTitle('Check your application').addFields(
            { name: 'IFC name', value: clean(d.ifcName, 60) || '—', inline: true },
            { name: 'Callsign number', value: clean(d.callsignNumber, 10) || '—', inline: true },
            ...(d.airline ? [{ name: 'Airline', value: clean(d.airline, 40), inline: true }] : []),
            { name: 'Email', value: clean(d.email, 120) || '_none_', inline: true },
            ...form.slice(0, 18).map((q, i) => ({ name: shortLabel(q.label), value: clean((d.answers || [])[i], 1000) || '_no answer_' })),
        );
        const agree = agreeLabels(join.requirements);
        if (agree.length) e.setDescription(`By submitting you agree to:\n${agree.map((a) => `• ${a}`).join('\n')}`.slice(0, 4000));
        if (missing.length) e.setFooter({ text: `Still needed: ${missing.join(', ')}`.slice(0, 2000) });
        const pages = pageCount(join.form);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(cid('submit', ticket._id)).setLabel(agree.length ? 'I agree & submit' : 'Submit application')
                .setStyle(ButtonStyle.Success).setDisabled(missing.length > 0),
            ...Array.from({ length: Math.min(pages, 4) }, (_, i) => new ButtonBuilder().setCustomId(cid('form', ticket._id, i))
                .setLabel(pages === 1 ? 'Edit' : `Edit part ${i + 1}`).setStyle(ButtonStyle.Secondary)),
        );
        const payload = { embeds: [e], components: [row], flags: EPHEMERAL };
        return interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
    }

    async function submitApplication(interaction, ctx, ticket) {
        if (!isOwner(interaction, ticket) || ticket.stage !== 'form') return say(interaction, 'This application has already been sent.');
        await interaction.deferUpdate();
        const join = await joinConfig(ctx.va);
        if (!join) return interaction.followUp({ content: 'The crew center is not answering right now. Try again in a minute.', flags: EPHEMERAL });
        const missing = draftProblems(ticket.draft, join);
        if (missing.length) return interaction.followUp({ content: `Still needed: ${missing.join(', ')}.`, flags: EPHEMERAL });

        const r = await api('post', crewPath(ctx.va.slug, '/apply'), { body: applyBody(ticket.draft, join) });
        if (!r.ok) {
            const fixPage = /callsign/i.test(r.data.code || r.error) || r.status === 404 ? 0 : null;
            return interaction.followUp({
                content: `⚠️ ${r.error}`,
                components: fixPage == null ? [] : [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('form', ticket._id, fixPage)).setLabel('Change it').setStyle(ButtonStyle.Primary),
                )],
                flags: EPHEMERAL,
            });
        }

        const thread = await fetchChannel(ticket.threadId);
        ticket.applicationId = String(r.data.applicationId || '');
        ticket.stage = r.data.status === 'accepted' ? 'joined' : 'submitted';
        // The answers are in the airline's own database now; this copy is done.
        ticket.draft = { ifcName: ticket.draft.ifcName, callsignNumber: '', airline: '', email: '', answers: [] };
        await ticket.save();

        const staff = ctx.settings.staffRoleId;
        const joined = r.data.status === 'accepted';
        const e = vaEmbed(ctx.va)
            .setTitle(joined ? `🎉 ${clean(ticket.draft.ifcName, 60)} joined the roster` : `📝 Application from ${clean(ticket.draft.ifcName, 60)}`)
            .setDescription(joined
                ? 'This airline accepts pilots straight away. Staff: press **Accept & send login** to issue the crew center login.'
                : 'Sent to the crew center. Staff can send the entrance test, accept or decline from here — or from Roster → Applications.')
            .addFields(
                { name: 'Callsign', value: clean(r.data.callsign, 40) || '—', inline: true },
                { name: 'Grade', value: r.data.grade ? `Grade ${r.data.grade}` : '—', inline: true },
                { name: 'IF verified', value: r.data.ifVerified ? '✓ yes' : 'no', inline: true },
                { name: 'Discord', value: `<@${ticket.userId}>`, inline: true },
            );
        await send(thread, {
            content: staff ? `<@&${staff}>` : undefined,
            embeds: [e],
            components: [staffRow(ticket, { test: !joined, decline: !joined })],
            allowedMentions: { roles: staff ? [staff] : [] },
        });
        logToStaff(ctx.settings, `📝 New application from **${clean(ticket.draft.ifcName, 60)}** (<@${ticket.userId}>): ${thread || ''}`).catch(() => {});
        return interaction.followUp({ content: '✅ Application sent. The staff will reply in this thread.', flags: EPHEMERAL });
    }

    function staffRow(ticket, { test = true, accept = true, decline = true } = {}) {
        const b = [];
        if (test) b.push(new ButtonBuilder().setCustomId(cid('test', ticket._id)).setLabel('Send entrance test').setStyle(ButtonStyle.Primary).setEmoji('📝'));
        if (accept) b.push(new ButtonBuilder().setCustomId(cid('accept', ticket._id)).setLabel('Accept & send login').setStyle(ButtonStyle.Success).setEmoji('✅'));
        if (decline) b.push(new ButtonBuilder().setCustomId(cid('decline', ticket._id)).setLabel('Decline').setStyle(ButtonStyle.Danger));
        b.push(new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close').setStyle(ButtonStyle.Secondary));
        return new ActionRowBuilder().addComponents(b);
    }

    /* ---- staff: entrance test ----------------------------------------- */

    async function sendTest(interaction, ctx, ticket, quizId) {
        if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can send the entrance test.');
        if (!ticket.applicationId) return say(interaction, 'There is no application on this ticket yet.');
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: EPHEMERAL });
        const asBot = { asBot: true, slug: ctx.va.slug, actor: actorOf(interaction) };

        if (!quizId) {
            const list = await api('get', crewPath(ctx.va.slug, '/entrance-tests'), asBot);
            if (!list.ok) return say(interaction, list.error);
            const quizzes = Array.isArray(list.data.quizzes) ? list.data.quizzes : [];
            if (!quizzes.length) return say(interaction, 'This airline has no entrance test ready. Build one in Crew Center → Recruitment → Quizzes.');
            if (quizzes.length > 1) {
                const menu = new StringSelectMenuBuilder().setCustomId(cid('testpick', ticket._id)).setPlaceholder('Which test?')
                    .addOptions(quizzes.slice(0, 25).map((q) => ({ label: clean(q.title, 100) || 'Test', value: String(q.id).slice(0, 100), description: `Pass mark ${q.passMark}%`.slice(0, 100) })));
                return say(interaction, 'Pick the test to send:', { components: [new ActionRowBuilder().addComponents(menu)] });
            }
            quizId = quizzes[0].id;
        }

        const r = await api('post', crewPath(ctx.va.slug, '/entrance-tests'), { ...asBot, body: { quizId, applicationId: ticket.applicationId } });
        const test = r.data.test;
        if (!r.ok && !(r.data.code === 'already_issued' && test)) return say(interaction, r.error);
        if (!test || !isHttpUrl(test.link)) return say(interaction, 'The test was created but has no link to send. Open it in the crew center.');

        ticket.stage = 'testing';
        await ticket.save();
        const thread = await fetchChannel(ticket.threadId);
        const e = vaEmbed(ctx.va).setTitle(`📝 Entrance test — ${clean(test.quizTitle || '', 200) || 'your test'}`).setDescription([
            `<@${ticket.userId}>, the staff have sent you the entrance test.`,
            test.passMark ? `You need **${test.passMark}%** to pass.` : '',
            'Your result comes back to this thread as soon as you finish.',
        ].filter(Boolean).join('\n\n'));
        await send(thread, {
            content: `<@${ticket.userId}>`,
            embeds: [e],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(test.link).setLabel('Take the test').setStyle(ButtonStyle.Link))],
            allowedMentions: { users: [ticket.userId] },
        });
        return say(interaction, r.ok ? 'Test sent.' : 'They already had a link for that test — I posted it again.', { components: [] });
    }

    /* ---- staff: accept ------------------------------------------------- */

    /**
     * Accept the application and issue the crew center login. Shared by the
     * staff button and auto-invite; `interaction` is null for the latter.
     */
    async function acceptTicket({ interaction, ctx, ticket, actor }) {
        const r = await api('patch', crewPath(ctx.va.slug, `/applications/${encodeURIComponent(ticket.applicationId)}`), {
            asBot: true, slug: ctx.va.slug, actor, body: { action: 'accept', createAccount: true },
        });
        if (!r.ok) return { error: r.error };
        return finishAcceptance({ interaction, ctx, ticket, actor, data: r.data });
    }

    const LINK_FAILED = {
        taken: 'that Discord account is already linked to another login at this airline',
        other_discord: 'their new login is already linked to a different Discord account',
        no_login: 'no crew center login was made for them yet',
        not_accepted: 'the crew center does not show the application as accepted',
    };

    /**
     * Everything that follows an acceptance, wherever it was pressed: the
     * pilot role, their Discord linked to the login it made, and the welcome
     * in the ticket. `data` is the crew center's answer to the accept — or,
     * when staff accepted from the dashboard, the invitation read back.
     *
     * The link is the step that makes the rest work: the inactive role, the
     * event buttons and /crew me all find a pilot by it. So it is never left
     * silent — linked, or the pilot is handed the one button that does it and
     * the staff are told why it could not be done for them.
     */
    async function finishAcceptance({ interaction, ctx, ticket, actor, data = {} }) {
        ticket.stage = 'accepted';
        await ticket.save();

        // The pilot role, best-effort: a role the bot cannot give is reported to
        // staff, not a reason the acceptance did not happen.
        let roleNote = '';
        const guild = client.guilds.cache.get(ticket.guildId);
        const member = guild ? await guild.members.fetch(ticket.userId).catch(() => null) : null;
        if (ctx.settings.pilotRoleId && member) {
            await member.roles.add(ctx.settings.pilotRoleId, `Accepted into ${ctx.va.name}`)
                .catch(() => { roleNote = ' I could not give them the pilot role — run `/crew-admin check`.'; });
        }
        if (member && ctx.settings.welcomeRoleId && ctx.settings.welcomeRoleId !== ctx.settings.pilotRoleId) {
            // A visitor no longer: the join role was for people who had not joined yet.
            await member.roles.remove(ctx.settings.welcomeRoleId, 'Now a pilot').catch(() => {});
        }

        // Their Discord, linked to the login just made for them. The bot is the
        // one party that knows both halves for certain: the application came
        // from this Discord account, and the crew center just said which login
        // it produced. So a pilot who joined here never has to link anything —
        // "Sign in with Discord" simply works the first time they try it.
        const user = (member && member.user) || (interaction && interaction.user && interaction.user.id === ticket.userId ? interaction.user : null);
        const linked = await api('post', crewPath(ctx.va.slug, '/discord-bot/link-pilot'), {
            asBot: true, slug: ctx.va.slug, actor,
            body: {
                applicationId: ticket.applicationId, discordId: ticket.userId,
                username: clean((user && (user.globalName || user.username)) || ticket.userTag, 40),
                avatar: clean(user && user.avatar, 64),
            },
        });
        const discordLinked = !!(linked.ok && linked.data.linked);
        const linkWhy = discordLinked ? '' : (LINK_FAILED[linked.data && linked.data.reason] || linked.error || 'the crew center did not answer');

        const account = data.account || null;
        const invite = data.invite || null;
        const thread = await fetchChannel(ticket.threadId);
        const hasLogin = !!(invite && invite.state === 'live') || !!(account && account.password);
        const e = vaEmbed(ctx.va).setColor(0x16A34A).setTitle(`🎉 Welcome to ${clean(ctx.va.name, 200)}!`).setDescription([
            `<@${ticket.userId}>, you’re in${invite && invite.username ? ` — your username is \`${clean(invite.username, 60)}\`` : ''}.`,
            hasLogin
                ? 'Press **Show my login** — only you can see it. You’ll choose your own password the first time you sign in.'
                : (account && account.error) || (invite && invite.state === 'claimed' ? 'You’ve already signed in to the crew center — you’re all set.' : 'Your crew center login will follow from the staff.'),
            discordLinked
                ? '🔗 Your Discord is linked to your crew center account, so next time you can just press **Sign in with Discord**.'
                : '🔗 **One last step:** press **Link my account** and approve it on Discord. Then you can sign in with Discord, sign up for events right here, and use `/crew me`.',
        ].filter(Boolean).join('\n\n'));
        const buttons = [];
        if (hasLogin) buttons.push(new ButtonBuilder().setCustomId(cid('login', ticket._id)).setLabel('Show my login').setStyle(ButtonStyle.Success).setEmoji('🔑'));
        if (!discordLinked) buttons.push(new ButtonBuilder().setURL(linkUrl(ctx.va.slug)).setLabel('Link my account').setStyle(ButtonStyle.Link).setEmoji('🔗'));
        const signIn = (data.signInUrl && isHttpUrl(data.signInUrl) && data.signInUrl) || (invite && isHttpUrl(invite.signInUrl) && invite.signInUrl) || crewUrl(ctx.va.slug);
        buttons.push(new ButtonBuilder().setURL(signIn).setLabel('Crew center').setStyle(ButtonStyle.Link));
        buttons.push(new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary));
        await send(thread, {
            content: `<@${ticket.userId}>`, embeds: [e],
            components: [new ActionRowBuilder().addComponents(buttons)],
            allowedMentions: { users: [ticket.userId] },
        });
        const linkNote = discordLinked ? ' Discord linked ✓' : ` ⚠️ Their Discord could not be linked automatically (${linkWhy}) — they have a **Link my account** button.`;
        logToStaff(ctx.settings, `✅ <@${ticket.userId}> accepted by ${actor}.${roleNote}${linkNote}`).catch(() => {});
        return { ok: true, note: roleNote, loginError: account && account.error, linked: discordLinked, linkWhy };
    }

    async function acceptButton(interaction, ctx, ticket) {
        if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can accept an application.');
        if (!ticket.applicationId) return say(interaction, 'There is no application on this ticket yet.');
        // A second press (or a press after auto-invite) would post a second
        // welcome. Reissuing a lost login is the crew center's job.
        if (ticket.stage === 'accepted') return say(interaction, 'Already accepted. To reissue their login, use Roster → Applications in the crew center.');
        await interaction.deferReply({ flags: EPHEMERAL });
        const out = await acceptTicket({ interaction, ctx, ticket, actor: actorOf(interaction) });
        if (out.error) return say(interaction, `⚠️ ${out.error}`);
        return say(interaction, `Accepted.${out.loginError ? ` ${out.loginError}` : ''}${out.note}${out.linked ? ' Their Discord is linked.' : ` Their Discord could not be linked automatically (${out.linkWhy}); they’ve been given a Link button.`}`);
    }

    /* ---- the pilot's login -------------------------------------------- */

    async function showLogin(interaction, ctx, ticket) {
        if (!isOwner(interaction, ticket)) return say(interaction, 'Only the pilot this ticket is for can open their login.');
        await interaction.deferReply({ flags: EPHEMERAL });
        const r = await api('get', crewPath(ctx.va.slug, `/applications/${encodeURIComponent(ticket.applicationId)}/invite`), {
            asBot: true, slug: ctx.va.slug, actor: actorOf(interaction),
        });
        if (!r.ok) return say(interaction, r.error);
        const inv = r.data.invite || {};
        const signIn = isHttpUrl(inv.signInUrl) ? inv.signInUrl : crewUrl(ctx.va.slug);
        if (inv.state === 'live' && inv.password) {
            return say(interaction, [
                `**Your ${clean(ctx.va.name, 100)} crew center login**`,
                `Username: \`${inv.username}\``,
                `Temporary password: \`${inv.password}\``,
                `Sign in: ${signIn}`,
                '',
                'You’ll be asked to choose your own password the first time you sign in, and this one stops working when you do.',
                inv.expiresAt ? `It expires ${stamp(inv.expiresAt, 'R')} if unused.` : '',
            ].filter((l) => l !== null).join('\n'));
        }
        if (inv.state === 'claimed') return say(interaction, `You’ve already signed in, so this one-time password is gone. Lost your password? Use **Forgot password** at ${signIn}`);
        return say(interaction, 'There is no login waiting for you right now — ask the staff in this thread to reissue it.');
    }

    /* ---- staff: decline ----------------------------------------------- */

    async function declineButton(interaction, ctx, ticket) {
        if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can decline an application.');
        if (!ticket.applicationId) return say(interaction, 'There is no application on this ticket yet.');
        const modal = new ModalBuilder().setCustomId(cid('declinesub', ticket._id)).setTitle('Decline application').addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('msg').setLabel('Message to the applicant (optional)')
                .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500)),
        );
        return interaction.showModal(modal);
    }

    async function declineSubmit(interaction, ctx, ticket) {
        if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can decline an application.');
        await interaction.deferReply({ flags: EPHEMERAL });
        let message = '';
        try { message = clean(interaction.fields.getTextInputValue('msg'), 1500); } catch { message = ''; }
        const r = await api('patch', crewPath(ctx.va.slug, `/applications/${encodeURIComponent(ticket.applicationId)}`), {
            asBot: true, slug: ctx.va.slug, actor: actorOf(interaction), body: { action: 'decline', message },
        });
        if (!r.ok) return say(interaction, `⚠️ ${r.error}`);
        ticket.stage = 'declined';
        await ticket.save();
        const thread = await fetchChannel(ticket.threadId);
        await send(thread, {
            content: `<@${ticket.userId}>`,
            embeds: [vaEmbed(ctx.va).setColor(0x6E685D).setTitle('Application update').setDescription([
                `Thanks for applying to ${clean(ctx.va.name, 100)}. The team weren’t able to accept your application this time.`,
                message ? `**Message from the team:**\n${message}` : '',
            ].filter(Boolean).join('\n\n'))],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { users: [ticket.userId] },
        });
        logToStaff(ctx.settings, `🚫 <@${ticket.userId}> declined by ${actorOf(interaction)}.`).catch(() => {});
        return say(interaction, 'Declined.');
    }

    /* ---- close --------------------------------------------------------- */

    async function closeTicket(interaction, ctx, ticket, reason = '') {
        if (!isOwner(interaction, ticket) && !isStaff(interaction, ctx.settings)) return say(interaction, 'Only the ticket’s owner or staff can close it.');
        if (ticket.status === 'closed') return say(interaction, 'This ticket is already closed.');
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: EPHEMERAL });
        const why = clean(reason, 300);
        ticket.status = 'closed';
        ticket.closedAt = new Date();
        ticket.closedBy = interaction.user.id;
        ticket.closeReason = why;
        await ticket.save();
        const thread = await fetchChannel(ticket.threadId);
        if (thread) {
            const e = vaEmbed(ctx.va).setColor(0x6E685D).setTitle('🔒 Ticket closed').setDescription([
                `Closed by ${interaction.user}.${why ? `\n**Reason:** ${why}` : ''}`,
                'Thanks for getting in touch! If there’s anything else, press **Reopen** — or open a new ticket any time.',
            ].join('\n\n'));
            await send(thread, {
                embeds: [e],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('reopen', ticket._id)).setLabel('Reopen').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
                )],
                allowedMentions: { parse: [] },
            });
            await thread.setLocked(true).catch(() => {});
            await thread.setArchived(true).catch(() => {});
        }
        // Closed by somebody else: a short, kind note, so a ticket never just
        // vanishes from their list without a word.
        if (!isOwner(interaction, ticket)) {
            dm(ticket.userId, {
                embeds: [vaEmbed(ctx.va).setTitle('Your ticket was closed').setDescription([
                    `Your ${ticket.kind === 'apply' ? 'application' : 'help'} ticket${ticket.topic ? ` “${clean(ticket.topic, 100)}”` : ''} in **${clean(interaction.guild && interaction.guild.name, 100) || ctx.va.name}** was closed by the staff.`,
                    why ? `**Reason:** ${why}` : '',
                    'Thanks for reaching out — if you still need a hand, you can reopen it from the thread or open a new one any time.',
                ].filter(Boolean).join('\n\n'))],
            }).catch(() => {});
        }
        logToStaff(ctx.settings, `🔒 Ticket for <@${ticket.userId}> closed by ${interaction.user}${why ? ` — ${why}` : ''}.`).catch(() => {});
        return say(interaction, 'Closed.');
    }

    async function reopenTicket(interaction, ctx, ticket) {
        if (!isOwner(interaction, ticket) && !isStaff(interaction, ctx.settings)) return say(interaction, 'Only the ticket’s owner or staff can reopen it.');
        if (ticket.status !== 'closed') return say(interaction, 'This ticket is already open.');
        await interaction.deferReply({ flags: EPHEMERAL });
        const thread = await fetchChannel(ticket.threadId);
        if (!thread) return say(interaction, 'That thread is gone — open a new ticket instead.');
        const other = await VaBotTicket.findOne({ guildId: ticket.guildId, userId: ticket.userId, kind: ticket.kind, status: 'open' });
        if (other && String(other._id) !== String(ticket._id)) return say(interaction, `There is already another ticket open for them: <#${other.threadId}>`);
        await thread.setArchived(false).catch(() => {});
        await thread.setLocked(false).catch(() => {});
        ticket.status = 'open';
        ticket.closedAt = null;
        await ticket.save();
        const staff = ctx.settings.staffRoleId;
        const byOwner = isOwner(interaction, ticket);
        await send(thread, {
            content: `🔓 Reopened by ${interaction.user}.${byOwner && staff ? ` <@&${staff}>` : ''}`,
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
            )],
            allowedMentions: { roles: byOwner && staff ? [staff] : [] },
        });
        logToStaff(ctx.settings, `🔓 Ticket for <@${ticket.userId}> reopened by ${interaction.user}: ${thread}`).catch(() => {});
        return say(interaction, 'Reopened.');
    }

    /** The ticket whose thread this command was typed in. */
    async function ticketHere(interaction) {
        if (!isSnowflake(interaction.channelId)) return null;
        return VaBotTicket.findOne({ guildId: interaction.guildId, threadId: interaction.channelId });
    }

    async function closeCommand(interaction, ctx) {
        const ticket = await ticketHere(interaction);
        if (!ticket || String(ticket.vaId) !== String(ctx.va._id)) return say(interaction, 'Run this inside the ticket thread you want to close.');
        const key = String(ticket._id);
        if (ticketLocks.busy(key)) return say(interaction, 'Still working on the last press — one moment.');
        return ticketLocks.run(key, async () => {
            const fresh = await loadTicket(interaction, key);
            return closeTicket(interaction, ctx, fresh || ticket, interaction.options.getString('reason') || '');
        });
    }

    async function addToTicket(interaction, ctx) {
        if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can add people to a ticket.');
        const ticket = await ticketHere(interaction);
        if (!ticket || ticket.status !== 'open') return say(interaction, 'Run this inside an open ticket thread.');
        const user = interaction.options.getUser('member', true);
        if (user.bot) return say(interaction, 'Bots don’t need adding.');
        const thread = await fetchChannel(ticket.threadId);
        const added = thread && await thread.members.add(user.id).then(() => true).catch(() => false);
        if (!added) return say(interaction, 'I could not add them. Are they in this server?');
        await send(thread, { content: `👋 <@${user.id}> was added to this ticket by ${interaction.user}.`, allowedMentions: { users: [user.id] } });
        return say(interaction, 'Added.');
    }

    /* ===================================================================
     * EVENTS FROM THE CREW CENTER
     * ================================================================ */

    /** An entrance test was marked. Post the result where the applicant is. */
    hub.on('entranceTest', async ({ vaId, applicationId, passed, score, total, percent, quizTitle }) => {
        if (!vaId || !applicationId) return;
        const found = await VaBotTicket.find({ vaId, applicationId: String(applicationId), status: 'open' }).limit(5);
        for (const t of found) {
            // Behind any staff press on the same ticket, and read again once
            // it is our turn: a staff Accept that just finished means there is
            // nothing left for auto-invite to do.
            await ticketLocks.run(String(t._id), () => postTestResult(String(t._id), { vaId, passed, score, total, percent, quizTitle }))
                .catch((err) => console.error('🤖 vaBot test result failed:', err && err.message ? err.message : err));
        }
    });

    async function postTestResult(ticketId, { vaId, passed, score, total, percent, quizTitle }) {
        const ticket = await VaBotTicket.findOne({ _id: ticketId, status: 'open' });
        if (!ticket) return;
        const link = await guildLink(ticket.guildId);
        if (!link || String(link.vaId) !== String(vaId)) return;
        const va = await vaById(vaId);
        if (!va) return;
        const ctx = { link, va, settings: link.settings || {} };
        const thread = await fetchChannel(ticket.threadId);
        const staff = ctx.settings.staffRoleId;
        const auto = passed && ctx.settings.autoInvite && ticket.stage !== 'accepted';
        const e = vaEmbed(va).setColor(passed ? 0x16A34A : 0xD97706)
            .setTitle(passed ? '✅ Entrance test passed' : '📝 Entrance test not passed')
            .setDescription(`<@${ticket.userId}> scored **${score}/${total}** (${percent}%) on **${clean(quizTitle, 120)}**.`
                + (passed
                    ? `\n\n🎉 Well done, <@${ticket.userId}>! ${auto ? 'Your crew center login is on its way' : 'The staff will accept you shortly'} — and your Discord will be linked to your new crew center account at the same moment, so there’s nothing else to set up.`
                        + (auto ? '' : '\n\nStaff: accept to send the crew center login.')
                    : '\n\nThe test page says when they can try again and what to read meanwhile.'));
        await send(thread, {
            content: !auto && staff ? `<@&${staff}>` : undefined,
            embeds: [e],
            components: auto ? [] : [staffRow(ticket, { test: !passed, accept: passed })],
            allowedMentions: { roles: !auto && staff ? [staff] : [] },
        });
        if (auto) {
            const out = await acceptTicket({ interaction: null, ctx, ticket, actor: 'Auto-invite' });
            if (out.error) {
                await send(thread, {
                    content: `⚠️ Auto-invite could not accept this application: ${out.error}${staff ? ` <@&${staff}>` : ''}`,
                    components: [staffRow(ticket, { test: false })],
                    allowedMentions: { roles: staff ? [staff] : [] },
                });
            }
        }
    }

    /**
     * Staff accepted from the crew center (Roster → Applications) while the
     * applicant is waiting in a Discord ticket. The ticket finishes the job:
     * role, Discord linked to the login, welcome with their login button.
     */
    hub.on('applicationAccepted', async ({ vaId, applicationId }) => {
        if (!vaId || !applicationId) return;
        const found = await VaBotTicket.find({ vaId, applicationId: String(applicationId), status: 'open' }).limit(5);
        for (const t of found) {
            await ticketLocks.run(String(t._id), () => acceptedElsewhere(String(t._id), vaId))
                .catch((err) => console.error('🤖 vaBot accepted-elsewhere failed:', err && err.message ? err.message : err));
        }
    });

    async function acceptedElsewhere(ticketId, vaId) {
        const ticket = await VaBotTicket.findOne({ _id: ticketId, status: 'open' });
        // Accepted from Discord a moment ago: the welcome is already there.
        if (!ticket || ticket.stage === 'accepted') return;
        const link = await guildLink(ticket.guildId);
        if (!link || String(link.vaId) !== String(vaId)) return;
        const va = await vaById(vaId);
        if (!va) return;
        const ctx = { link, va, settings: link.settings || {} };
        const inv = await api('get', crewPath(va.slug, `/applications/${encodeURIComponent(ticket.applicationId)}/invite`), {
            asBot: true, slug: va.slug, actor: 'Crew center',
        });
        await finishAcceptance({ interaction: null, ctx, ticket, actor: 'the staff in the crew center', data: inv.ok ? { invite: inv.data.invite } : {} });
    }

    /** An event was published, changed, cancelled or removed. */
    hub.on('event', async ({ va: rawVa, action, event }) => {
        if (!rawVa || !event || !event._id) return;
        const links = await VaBotGuild.find({ vaId: rawVa._id, 'settings.eventsChannelId': { $ne: '' } }).lean();
        if (!links.length) return;
        const va = await vaById(rawVa._id);
        if (!va) return;
        const eventId = String(event._id);
        for (const link of links) {
            // Publish-then-edit in quick succession must not make two posts:
            // each server's post for an event changes one step at a time.
            await eventLocks.run(`${link.guildId}:${eventId}`, () => postEvent(link, va, event, eventId, action))
                .catch((err) => console.error('🤖 vaBot event post failed:', err && err.message ? err.message : err));
        }
    });

    async function postEvent(link, va, event, eventId, action) {
        const post = await VaBotEventPost.findOne({ guildId: link.guildId, eventId });
        const embed = eventEmbed(va, event, action);
        if (!post) {
            if (action !== 'published' && action !== 'updated') return;
            const ch = await fetchChannel(link.settings.eventsChannelId);
            const msg = await send(ch, { embeds: [embed], components: eventButtons(va, eventId, action), allowedMentions: { parse: [] } });
            if (!msg) return;
            const thread = await msg.startThread({ name: (clean(event.title, 90) || 'Event chat'), autoArchiveDuration: THREAD_ARCHIVE_MIN }).catch(() => null);
            await VaBotEventPost.create({
                guildId: link.guildId, vaId: va._id, eventId, channelId: ch.id, messageId: msg.id, threadId: thread ? thread.id : '',
                startsAt: toTime(event.startsAt) ? new Date(event.startsAt) : null,
            }).catch(() => {});
            return;
        }
        const ch = await fetchChannel(post.channelId);
        const msg = ch && ch.messages ? await ch.messages.fetch(post.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ embeds: [embed], components: eventButtons(va, eventId, action) }).catch(() => {});
        // A moved start time gets a fresh reminder; a cancelled event none.
        const startsAt = toTime(event.startsAt) ? new Date(event.startsAt) : null;
        const moved = toTime(startsAt) !== toTime(post.startsAt);
        const off = action === 'cancelled' || action === 'removed';
        if (moved || off) {
            await VaBotEventPost.updateOne({ _id: post._id }, { $set: { startsAt, ...(off ? { remindedAt: new Date() } : moved ? { remindedAt: null } : {}) } }).catch(() => {});
        }
        const thread = await fetchChannel(post.threadId);
        if (thread) {
            const note = { updated: '✏️ The event details were updated.', cancelled: '⚠️ This event has been cancelled.', removed: '🗑️ This event was removed.' }[action];
            if (note) await send(thread, { content: note, allowedMentions: { parse: [] } });
            if (action === 'cancelled' || action === 'removed') {
                await thread.setLocked(true).catch(() => {});
                await thread.setArchived(true).catch(() => {});
            }
        }
    }

    /* ===================================================================
     * ACTING AS THE PILOT WHO PRESSED
     *
     * Event sign-ups and the pilot commands go through the crew center's own
     * pilot endpoints, as whoever's login this Discord account is linked to
     * (server.js botPilot). Every rule those endpoints apply — rank locks,
     * waitlists, what counts as a flight — applies here unchanged.
     * ================================================================ */

    const asPilot = (interaction, ctx) => ({ pilot: interaction.user.id, slug: ctx.va.slug, actor: actorOf(interaction) });

    /** The answer for somebody whose Discord is linked to no login here. */
    function notLinked(interaction, ctx, what) {
        const e = vaEmbed(ctx.va).setTitle('🔗 Link your crew center account first').setDescription([
            `To ${what} from Discord, I need to know which ${clean(ctx.va.name, 100)} pilot you are.`,
            'Press **Link my account**, sign in if it asks, and approve it on Discord — about ten seconds, and only once.',
            'Not a pilot yet? Press **Apply** on the recruitment panel.',
        ].join('\n\n'));
        return interaction.editReply({
            embeds: [e],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setURL(linkUrl(ctx.va.slug)).setLabel('Link my account').setStyle(ButtonStyle.Link).setEmoji('🔗'),
            )],
        });
    }

    const hoursOf = (v) => Math.round((Number(v) || 0) * 10) / 10;
    const rsvpCooldown = makeCooldown(3000);

    /* ---- events -------------------------------------------------------- */

    async function rsvp(interaction, ctx, eventId, going) {
        const wait = rsvpCooldown.hit(`${interaction.user.id}:${eventId}:${going ? 1 : 0}`);
        if (wait) return say(interaction, 'One moment — still working on your last press.');
        await interaction.deferReply({ flags: EPHEMERAL });
        const path = crewPath(ctx.va.slug, `/events/${encodeURIComponent(eventId)}/signup`);
        const r = going
            ? await api('post', path, { ...asPilot(interaction, ctx), body: {} })
            : await api('delete', path, asPilot(interaction, ctx));
        if (r.status === 401) return notLinked(interaction, ctx, going ? 'sign up for events' : 'change your event sign-ups');
        if (!r.ok) {
            // Pressing "I'm in" twice is not a failure.
            if (going && r.status === 409 && (r.data.code === 'already_signed_up' || /already signed up/i.test(r.error))) return say(interaction, '✅ You’re already signed up for this one. See you there!');
            return say(interaction, `⚠️ ${r.error}`);
        }
        const ev = await refreshEventPost(interaction.guildId, ctx.va, eventId);
        const title = clean(ev && ev.title, 100) || 'the event';
        if (!going) return say(interaction, `No problem — you’re off the list for **${title}**. Hope to see you at the next one! 👋`);
        const when = ev && stamp(ev.startsAt) ? ` on ${stamp(ev.startsAt)} (${stamp(ev.startsAt, 'R')})` : '';
        return say(interaction, r.data.waitlisted
            ? `📋 **${title}** is full, so you’re on the waitlist. If a place opens up it’s yours automatically — I’ll still remind you an hour before.`
            : `✈️ You’re in for **${title}**${when}! I’ll ping you in the event thread an hour before. Pick your stand and aircraft any time in the crew center.`,
        { components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(crewUrl(ctx.va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link))] });
    }

    /** Re-read the event and redraw its post with the new head count. */
    async function refreshEventPost(guildId, va, eventId) {
        const r = await api('get', crewPath(va.slug, `/events/${encodeURIComponent(eventId)}`));
        const ev = r.ok ? r.data.event : null;
        if (!ev) return null;
        await eventLocks.run(`${guildId}:${eventId}`, async () => {
            const post = await VaBotEventPost.findOne({ guildId, eventId: String(eventId) });
            if (!post) return;
            const ch = await fetchChannel(post.channelId);
            const msg = ch && ch.messages ? await ch.messages.fetch(post.messageId).catch(() => null) : null;
            if (msg) await msg.edit({ embeds: [eventEmbed(va, ev, ev.status === 'cancelled' ? 'cancelled' : '')], components: eventButtons(va, eventId, ev.status) }).catch(() => {});
        }).catch(() => {});
        return ev;
    }

    /** An hour before each posted event: ping the people going, in its thread. */
    async function remindEvents({ now = Date.now() } = {}) {
        const due = await VaBotEventPost.find({
            remindedAt: null,
            startsAt: { $gt: new Date(now), $lte: new Date(now + EVENT_REMIND_BEFORE_MS + EVENT_REMIND_EVERY_MS) },
        }).limit(50).lean().catch(() => []);
        for (const post of due) {
            // Marked first: a reminder sent twice is worse than one that failed.
            await VaBotEventPost.updateOne({ _id: post._id }, { $set: { remindedAt: new Date(now) } }).catch(() => {});
            try {
                const link = await guildLink(post.guildId);
                if (!link || String(link.vaId) !== String(post.vaId)) continue;
                const va = await vaById(post.vaId);
                if (!va) continue;
                const r = await api('get', crewPath(va.slug, `/discord-bot/events/${encodeURIComponent(post.eventId)}/attendees`), { asBot: true, slug: va.slug, actor: 'Event reminder' });
                if (!r.ok || !r.data.event || r.data.event.status === 'cancelled') continue;
                const ids = (Array.isArray(r.data.discordIds) ? r.data.discordIds : []).filter(isSnowflake).slice(0, 200);
                const where = (await fetchChannel(post.threadId)) || (await fetchChannel(post.channelId));
                const ev = r.data.event;
                const head = `⏰ **${clean(ev.title, 100) || 'The event'}** starts ${stamp(ev.startsAt, 'R')}! Time to load up, pick your stand and get ready. See you on frequency ✈️`;
                if (!ids.length) { await send(where, { content: head, allowedMentions: { parse: [] } }); continue; }
                for (let i = 0; i < ids.length; i += 50) {
                    const chunk = ids.slice(i, i + 50);
                    await send(where, { content: `${i ? '' : `${head}\n\n`}${chunk.map((id) => `<@${id}>`).join(' ')}`, allowedMentions: { users: chunk } });
                }
            } catch (err) { console.warn('🤖 vaBot event reminder failed:', err && err.message ? err.message : err); }
        }
    }

    /* ---- pilot commands ----------------------------------------------- */

    async function showMe(interaction, ctx) {
        const share = interaction.options.getBoolean('share') === true;
        await interaction.deferReply(share ? {} : { flags: EPHEMERAL });
        const [r, board] = await Promise.all([
            api('get', crewPath(ctx.va.slug, '/me/flying'), asPilot(interaction, ctx)),
            api('get', crewPath(ctx.va.slug, '/standings?window=30'), asPilot(interaction, ctx)),
        ]);
        if (!r.ok) return say(interaction, r.error);
        if (!r.data.pilot) return notLinked(interaction, ctx, 'see your flying');
        const p = r.data.pilot;
        const rank = r.data.rank || null;
        const t = r.data.totals || {};
        const streak = r.data.streak || null;
        const me = board.ok ? board.data.me : null;
        const e = vaEmbed(ctx.va).setTitle(`${clean(p.callsign, 20)} ${clean(p.name, 80)}`.trim() || 'Your flying').setURL(crewUrl(ctx.va.slug));
        e.addFields(
            { name: 'Rank', value: clean(rank && rank.name, 40) || '—', inline: true },
            { name: 'Hours', value: String(hoursOf(p.hours)), inline: true },
            { name: 'Flights', value: String(Number(t.flights) || 0), inline: true },
            {
                name: 'Next rank',
                value: rank && rank.next
                    ? `${clean(rank.next.name, 40)} — ${hoursOf(rank.next.hoursAway)} h to go${rank.next.requiresCheck ? ' + a check ride' : ''}`
                    : rank ? 'Top of the ladder 🏆' : '—',
                inline: false,
            },
            { name: 'Last 30 days', value: `${Number(t.flights30d) || 0} flights · ${hoursOf((Number(t.minutes30d) || 0) / 60)} h`, inline: true },
            { name: 'Last flight', value: t.lastFlightAt && stamp(t.lastFlightAt, 'R') ? stamp(t.lastFlightAt, 'R') : 'None yet — `/crew route` has an idea', inline: true },
        );
        if (streak && streak.weeks > 0) e.addFields({ name: 'Streak', value: `🔥 ${streak.weeks} week${streak.weeks === 1 ? '' : 's'} in a row`, inline: true });
        if (me) e.addFields({ name: 'This month', value: me.rank ? `#${me.rank} of ${me.of} on the board` : 'Not on the board yet — one flight gets you there', inline: true });
        if (Number(t.pending)) e.setFooter({ text: `${t.pending} flight${t.pending === 1 ? '' : 's'} waiting for staff approval` });
        if (rank && isHttpsUrl(rank.image)) e.setThumbnail(rank.image);
        if (p.status === 'inactive') e.setFooter({ text: 'Marked inactive — fly any route to become active again.' });
        return interaction.editReply({ embeds: [e] });
    }

    const MEDALS = ['🥇', '🥈', '🥉'];
    async function showLeaderboard(interaction, ctx) {
        const win = ['30', '90', '0'].includes(interaction.options.getString('window')) ? interaction.options.getString('window') : '30';
        await interaction.deferReply();
        const r = await api('get', crewPath(ctx.va.slug, `/standings?window=${win}`), asPilot(interaction, ctx));
        if (!r.ok) return say(interaction, r.error);
        const board = Array.isArray(r.data.board) ? r.data.board.slice(0, 10) : [];
        const label = { 30: 'the last 30 days', 90: 'the last 90 days', 0: 'all time' }[win];
        const e = vaEmbed(ctx.va).setTitle(`🏆 Top pilots — ${label}`).setURL(crewUrl(ctx.va.slug));
        e.setDescription(board.length
            ? board.map((b, i) => `${MEDALS[i] || `**${i + 1}.**`} ${b.callsign ? `**${clean(b.callsign, 20)}** ` : ''}${clean(b.name, 50)} — ${hoursOf(b.hours)} h · ${Number(b.flights) || 0} flight${Number(b.flights) === 1 ? '' : 's'}`).join('\n')
            : 'Nobody has flown in this window yet. Be the first! ✈️');
        const me = r.data.me;
        if (me) e.addFields({ name: 'You', value: me.rank ? `#${me.rank} of ${me.of} · ${hoursOf(me.hours)} h` : 'Not on the board yet — one flight and you’re on it. Try `/crew route`.' });
        return interaction.editReply({ embeds: [e] });
    }

    const cleanIcao = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const cleanType = (v) => String(v || '').replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, 30);

    async function suggestRoute(interaction, ctx, fromArg, typeArg) {
        const from = cleanIcao(fromArg);
        const type = cleanType(typeArg);
        await interaction.deferReply({ flags: EPHEMERAL });
        const r = await api('get', crewPath(ctx.va.slug, '/routes'), asPilot(interaction, ctx));
        if (!r.ok) return say(interaction, r.error);
        const all = (Array.isArray(r.data.routes) ? r.data.routes : []).filter((x) => x && x.active !== false && !x.locked && x.origin && x.destination);
        let pool = all;
        if (from) pool = pool.filter((x) => String(x.origin).toUpperCase() === from);
        if (type) pool = pool.filter((x) => String(x.aircraft || '').toLowerCase().includes(type.toLowerCase()));
        if (!pool.length) {
            return say(interaction, all.length
                ? `No open route matches${from ? ` from **${from}**` : ''}${type ? ` on **${type}**` : ''}. Try \`/crew route\` with fewer filters.`
                : 'This airline has no open routes to suggest yet.');
        }
        // Featured legs first, half the time: they are the ones the airline is
        // pointing everyone at this week.
        const featured = pool.filter((x) => x.featured);
        const pickFrom = featured.length && Math.random() < 0.5 ? featured : pool;
        const leg = pickFrom[Math.floor(Math.random() * pickFrom.length)];
        const e = vaEmbed(ctx.va).setTitle(`${leg.flightNumber ? `${clean(leg.flightNumber, 12)} · ` : ''}${clean(leg.origin, 4)} → ${clean(leg.destination, 4)}`).setURL(crewUrl(ctx.va.slug));
        e.setDescription(leg.featured ? `⭐ Featured this ${leg.featured === 'day' ? 'day' : 'week'}${Number(leg.featuredBonus) ? ` — bonus ×${Number(leg.featuredBonus)}` : ''}` : 'How about this one? ✈️');
        e.addFields(
            { name: 'Aircraft', value: clean(leg.aircraft, 60) || 'Any in the fleet', inline: true },
            { name: 'Distance', value: Number(leg.distanceNm) ? `${Math.round(Number(leg.distanceNm)).toLocaleString('en-US')} nm` : '—', inline: true },
            ...(leg.kind === 'codeshare' && leg.partnerName ? [{ name: 'Codeshare', value: clean(leg.partnerName, 60), inline: true }] : []),
            ...(leg.departureGate ? [{ name: 'Stand', value: clean(leg.departureGate, 12), inline: true }] : []),
        );
        if (leg.notes) e.setFooter({ text: clean(leg.notes, 200) });
        return interaction.editReply({
            embeds: [e],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(cid('route', from || '-', type || '-')).setLabel('Another one').setStyle(ButtonStyle.Secondary).setEmoji('🎲'),
                new ButtonBuilder().setURL(crewUrl(ctx.va.slug)).setLabel('Book it in the crew center').setStyle(ButtonStyle.Link),
            )],
        });
    }

    /* ===================================================================
     * LINKING DISCORD TO A CREW CENTER LOGIN
     * ================================================================ */

    async function linkAccount(interaction, ctx) {
        await interaction.deferReply({ flags: EPHEMERAL });
        const pilot = await pilotByDiscord(ctx.va, interaction.user.id);
        if (pilot) {
            let note = '';
            const s = ctx.settings;
            const member = interaction.member && interaction.member.roles && interaction.member.roles.add ? interaction.member : null;
            const active = pilot.status !== 'inactive';
            if (member && active && s.pilotRoleId && !memberRoleIds(member).includes(s.pilotRoleId)
                && !memberRoleIds(member).includes(s.inactiveRoleId || '-')) {
                const ok = await member.roles.add(s.pilotRoleId, 'Linked pilot').then(() => true).catch(() => false);
                if (ok) note = `\nI’ve given you <@&${s.pilotRoleId}> too.`;
            }
            return say(interaction, `✅ You’re linked to **${clean(pilot.name, 60)}${pilot.callsign ? ` (${clean(pilot.callsign, 20)})` : ''}** at ${clean(ctx.va.name, 100)}. You can sign in to the crew center with Discord any time.${note}`,
                { components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(crewUrl(ctx.va.slug)).setLabel('Open the crew center').setStyle(ButtonStyle.Link))], allowedMentions: { parse: [] } });
        }
        const e = vaEmbed(ctx.va).setTitle('🔗 Link your crew center account').setDescription([
            'Takes about ten seconds, and then:',
            '• you can sign in to the crew center with Discord — no more lost passwords;',
            '• your pilot role here follows your roster status automatically.',
            '',
            '**1.** Press **Link my account** below.',
            '**2.** Sign in to the crew center if it asks.',
            '**3.** Press **Authorize** on the Discord screen. Done!',
            '',
            'Not a pilot yet? Press **Apply** on the recruitment panel instead.',
        ].join('\n'));
        return interaction.editReply({
            embeds: [e],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setURL(linkUrl(ctx.va.slug)).setLabel('Link my account').setStyle(ButtonStyle.Link).setEmoji('🔗'),
            )],
        });
    }

    /** Somebody linked Discord on the crew center: give them their role here. */
    hub.on('discordLinked', async ({ vaId, discordId }) => {
        if (!vaId || !isSnowflake(discordId)) return;
        const links = await VaBotGuild.find({ vaId }).lean();
        if (!links.length) return;
        const va = await vaById(vaId);
        if (!va) return;
        const pilot = await pilotByDiscord(va, discordId);
        let told = false;
        for (const link of links.slice(0, 5)) {
            const guild = client.guilds.cache.get(link.guildId);
            const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
            if (!member) continue;
            const s = link.settings || {};
            if (pilot && pilot.status !== 'inactive' && s.pilotRoleId && !memberRoleIds(member).includes(s.inactiveRoleId || '-')) {
                await member.roles.add(s.pilotRoleId, 'Linked their crew center account').catch(() => {});
            }
            if (!told) {
                told = true;
                await dm(discordId, {
                    embeds: [vaEmbed(va).setColor(0x16A34A).setTitle('🔗 Linked!').setDescription(
                        `Your Discord is now linked to your **${clean(va.name, 100)}** crew center account${pilot && pilot.callsign ? ` (${clean(pilot.callsign, 20)})` : ''}. From now on you can sign in with Discord — and your roles in **${clean(guild.name, 100)}** keep themselves up to date.`)],
                });
            }
        }
    });

    /* ===================================================================
     * WELCOME
     * ================================================================ */

    function welcomePayload(va, s, { member, guild, pilot }) {
        const user = member.user || {};
        const name = member.displayName || user.globalName || user.username || 'there';
        const back = pilot && pilot.status !== 'inactive';
        const text = back
            ? `Welcome back, <@${user.id}>! ✈️ Great to see you again — you’re on the **${clean(va.name, 100)}** roster${pilot.callsign ? ` as **${clean(pilot.callsign, 20)}**` : ''}${s.pilotRoleId ? ', and your pilot role is back' : ''}.`
            : renderWelcome(s.welcomeMessage, { userId: user.id, name, server: guild && guild.name, airline: va.name, members: guild && guild.memberCount });
        const e = vaEmbed(va).setTitle(`Welcome to ${clean((guild && guild.name) || va.name, 200)}!`.slice(0, 256)).setDescription(text);
        const avatar = typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL() : '';
        if (isHttpsUrl(avatar)) e.setThumbnail(avatar);
        if (guild && guild.memberCount) e.setFooter({ text: `You’re member #${Number(guild.memberCount).toLocaleString('en-US')}` });
        const buttons = back
            ? [new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link)]
            : [
                new ButtonBuilder().setCustomId(cid('open', 'apply')).setLabel('Apply').setStyle(ButtonStyle.Success).setEmoji('✈️'),
                new ButtonBuilder().setCustomId(cid('open', 'support')).setLabel('Contact staff').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
                new ButtonBuilder().setCustomId(cid('link')).setLabel('Already a pilot? Link').setStyle(ButtonStyle.Secondary).setEmoji('🔗'),
                new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link),
            ];
        return { content: `<@${user.id}>`, embeds: [e], components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { users: [user.id] } };
    }

    /** Somebody joined a linked server. */
    async function onMemberJoin(member) {
        if (!member || !member.guild || !member.user || member.user.bot) return;
        const guild = member.guild;
        if (isHomeGuild(guild.id)) return;
        try {
            const link = await guildLink(guild.id);
            if (!link) return;
            const s = link.settings || {};
            if (!s.welcomeChannelId && !s.welcomeRoleId && !s.welcomeDm && !s.pilotRoleId) return;
            const va = await vaById(link.vaId);
            if (!va) return;
            if (s.welcomeRoleId) await member.roles.add(s.welcomeRoleId, 'Welcome role').catch(() => {});
            // A raid, or a mass import: roles yes, a wall of greetings no.
            if (joinBurst.over(guild.id)) return;

            // Somebody coming back. A pilot who left (or was removed for
            // being quiet) and is still on the roster gets their role again;
            // the sweep is what decides whether they are still flying.
            const pilot = s.pilotRoleId || s.welcomeChannelId ? await pilotByDiscord(va, member.user.id) : null;
            if (pilot) {
                await VaBotInactive.deleteOne({ guildId: guild.id, userId: member.user.id }).catch(() => {});
                if (pilot.status !== 'inactive' && s.pilotRoleId) await member.roles.add(s.pilotRoleId, 'Returning pilot').catch(() => {});
            }
            if (!s.welcomeChannelId && !s.welcomeDm) return;
            const payload = welcomePayload(va, s, { member, guild, pilot });
            if (s.welcomeChannelId) await send(await fetchChannel(s.welcomeChannelId), payload);
            if (s.welcomeDm) {
                // Guild buttons do nothing in a DM, so the DM gets the links only.
                await dm(member.user.id, {
                    embeds: payload.embeds,
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link),
                    )],
                });
            }
        } catch (err) {
            console.warn('🤖 vaBot welcome failed:', err && err.message ? err.message : err);
        }
    }

    /* ===================================================================
     * INACTIVITY
     *
     * Kind first, firm only when the airline asks for it. The bot never
     * decides who has flown — the crew center's approved flight log does —
     * and it only ever acts on people whose Discord is linked to their login,
     * so it is never guessing who somebody is.
     * ================================================================ */

    const stayButtons = (va) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Open the crew center').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setCustomId(cid('route', '-', '-')).setLabel('Suggest a route').setStyle(ButtonStyle.Primary).setEmoji('🎲'),
        new ButtonBuilder().setCustomId(cid('open', 'support', 'loa')).setLabel('Request leave').setStyle(ButtonStyle.Secondary).setEmoji('🌴'),
        new ButtonBuilder().setCustomId(cid('open', 'support')).setLabel('I need help').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
    );

    /** Post in the inactive channel, or DM when there is none (or it failed). */
    async function tellInactive(s, userId, payload) {
        const ch = await fetchChannel(s.inactiveChannelId);
        const posted = ch ? await send(ch, { content: `<@${userId}>`, ...payload, allowedMentions: { users: [userId] } }) : null;
        if (!posted) await dm(userId, { embeds: payload.embeds, components: [] });
        return posted;
    }

    function inactiveEmbed(va, guild, { days, neverFlown, kickAt }) {
        const quiet = neverFlown
            ? `you joined **${clean(va.name, 100)}**${days ? ` ${days} days ago` : ''} and we haven’t seen your first flight yet`
            : `it’s been **${days} days** since your last flight with **${clean(va.name, 100)}**`;
        return vaEmbed(va).setColor(0xD97706).setTitle('We miss you in the skies ✈️').setDescription([
            `Hey there! Just a friendly heads-up — ${quiet}, so you’ve been moved to the inactive role for now.`,
            '**Staying is easy:** fly any route and file your PIREP in the crew center. As soon as it’s approved, your pilot role comes straight back — no need to ask anyone.',
            kickAt
                ? `If we don’t see a flight by ${stamp(kickAt, 'D')} (${stamp(kickAt, 'R')}), you’ll be removed from the server to keep the roster up to date. No hard feelings at all — you’re always welcome back.`
                : '',
            'Away for a while — exams, holiday, life? Press **Request leave** and the staff will sort it out. 💙',
        ].filter(Boolean).join('\n\n'));
    }

    /**
     * One server's sweep. `apply: false` is the preview: the same plan, with
     * nothing written and nobody told.
     */
    async function sweepGuild(link, { apply = true, now = Date.now() } = {}) {
        const s = (link && link.settings) || {};
        if (!s.inactiveRoleId) return { skipped: 'inactivity is off.' };
        const va = await vaById(link.vaId);
        if (!va) return { skipped: 'the crew center is not available.' };
        const guild = client.guilds.cache.get(link.guildId);
        if (!guild) return { skipped: 'I am not in that server any more.' };
        const r = await api('get', crewPath(va.slug, '/discord-bot/pilots'), { asBot: true, slug: va.slug, actor: 'Activity check' });
        // Everything or nothing: acting on half a roster is how the pilots
        // whose flights did not come back get flagged.
        if (!r.ok || !Array.isArray(r.data.pilots)) return { skipped: r.error || 'the crew center did not answer.' };
        const pilots = r.data.pilots;
        const flagged = await VaBotInactive.find({ guildId: link.guildId }).lean();
        const kickDays = clampInt(s.kickDays, 0, 180, 0);
        const plan = activityPlan({ pilots, flagged, now, inactiveDays: clampInt(s.inactiveDays, 7, 365, INACTIVE_DAYS_DEFAULT), kickDays });
        const out = { plan, checked: pilots.length, unlinked: Number(r.data.unlinked) || 0, errors: [], capped: false };
        if (plan.flag.length > MAX_FLAG_PER_SWEEP || plan.kick.length > MAX_KICK_PER_SWEEP) {
            out.capped = true;
            plan.flag = plan.flag.slice(0, MAX_FLAG_PER_SWEEP);
            plan.kick = plan.kick.slice(0, MAX_KICK_PER_SWEEP);
        }
        if (!apply) return out;

        const fetchMember = (id) => guild.members.fetch(id).catch(() => null);
        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);

        for (const { pilot } of plan.restore) {
            const member = await fetchMember(pilot.discordId);
            const rec = flagged.find((f) => f.userId === pilot.discordId);
            await VaBotInactive.deleteOne({ guildId: link.guildId, userId: pilot.discordId }).catch(() => {});
            if (!member) continue;
            await member.roles.remove(s.inactiveRoleId, 'Flying again').catch(() => {});
            if (s.pilotRoleId && (!rec || rec.hadPilotRole !== false)) await member.roles.add(s.pilotRoleId, 'Flying again').catch(() => {});
            await dm(pilot.discordId, {
                embeds: [vaEmbed(va).setColor(0x16A34A).setTitle('Welcome back to the flight deck! ✈️').setDescription(
                    `Great to see you flying again, ${clean(member.displayName || pilot.name, 60)}! Your pilot role in **${clean(guild.name, 100)}** is back. Thanks for flying with ${clean(va.name, 100)} 💙`)],
            });
            logToStaff(s, `✈️ <@${pilot.discordId}>${pilot.callsign ? ` (${clean(pilot.callsign, 20)})` : ''} is flying again — inactive role removed.`).catch(() => {});
        }

        for (const f of plan.flag) {
            const { pilot } = f;
            const member = await fetchMember(pilot.discordId);
            if (!member) continue; // not in this server: nothing to do here
            const added = await member.roles.add(s.inactiveRoleId, `No flight in ${s.inactiveDays || INACTIVE_DAYS_DEFAULT} days`).then(() => true).catch(() => false);
            if (!added) { out.errors.push(`I could not give <@${pilot.discordId}> the inactive role — run \`/crew-admin check\`.`); continue; }
            const hadPilotRole = !!(s.pilotRoleId && memberRoleIds(member).includes(s.pilotRoleId));
            if (hadPilotRole) await member.roles.remove(s.pilotRoleId, 'Inactive').catch(() => {});
            await VaBotInactive.updateOne(
                { guildId: link.guildId, userId: pilot.discordId },
                { $set: { vaId: va._id, memberId: String(pilot.memberId || ''), status: 'inactive', since: new Date(now), kickAt: f.kickAt, remindedAt: null, hadPilotRole } },
                { upsert: true },
            ).catch(() => {});
            await tellInactive(s, pilot.discordId, { embeds: [inactiveEmbed(va, guild, f)], components: [stayButtons(va)] });
            logToStaff(s, `💤 <@${pilot.discordId}>${pilot.callsign ? ` (${clean(pilot.callsign, 20)})` : ''} moved to inactive — ${f.neverFlown ? 'no first flight yet' : `no flight in ${f.days} days`}.`).catch(() => {});
        }

        for (const { pilot, kickAt } of plan.remind) {
            await VaBotInactive.updateOne({ guildId: link.guildId, userId: pilot.discordId }, { $set: { remindedAt: new Date(now) } }).catch(() => {});
            if (!await fetchMember(pilot.discordId)) continue;
            const e = vaEmbed(va).setColor(0xD97706).setTitle('A friendly reminder ⏰').setDescription([
                `There’s still time! Fly any route with **${clean(va.name, 100)}** before ${stamp(kickAt, 'D')} (${stamp(kickAt, 'R')}) and you’ll keep your place here — your pilot role comes right back.`,
                'Need a break instead? Press **Request leave** and the staff will pause this for you.',
            ].join('\n\n'));
            // In the channel and by DM: this is the one message that matters.
            const posted = await tellInactive(s, pilot.discordId, { embeds: [e], components: [stayButtons(va)] });
            if (posted) await dm(pilot.discordId, { embeds: [e], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Open the crew center').setStyle(ButtonStyle.Link))] });
        }

        const canKick = !!(me && me.permissions && me.permissions.has(PermissionsBitField.Flags.KickMembers));
        for (const { pilot } of plan.kick) {
            const member = await fetchMember(pilot.discordId);
            if (!member) {
                await VaBotInactive.updateOne({ guildId: link.guildId, userId: pilot.discordId }, { $set: { status: 'kicked' } }).catch(() => {});
                continue;
            }
            if (!canKick || member.kickable === false) { out.errors.push(`I could not remove <@${pilot.discordId}> — I need **Kick Members** and a role above theirs.`); continue; }
            const invite = isHttpsUrl(va.crewDiscordInvite) ? va.crewDiscordInvite : '';
            await dm(pilot.discordId, {
                embeds: [vaEmbed(va).setTitle(`Thanks for flying with ${clean(va.name, 100)} 💙`).setDescription([
                    `We’ve removed you from **${clean(guild.name, 100)}** after a long stretch without a flight — it’s only to keep the roster up to date.`,
                    'Your logbook is safe in the crew center, and you’re welcome back any time: rejoin, fly a route, and you’re straight back in.',
                    invite ? `Server invite for when you’re ready: ${invite}` : '',
                ].filter(Boolean).join('\n\n'))],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(crewUrl(va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link))],
            });
            const kicked = await member.kick(`Inactive: no flight for ${s.kickDays} days after being marked inactive`).then(() => true).catch(() => false);
            if (!kicked) { out.errors.push(`Removing <@${pilot.discordId}> failed — check my role is above theirs.`); continue; }
            await VaBotInactive.updateOne({ guildId: link.guildId, userId: pilot.discordId }, { $set: { status: 'kicked' } }).catch(() => {});
            logToStaff(s, `👋 <@${pilot.discordId}>${pilot.callsign ? ` (${clean(pilot.callsign, 20)})` : ''} removed from the server after ${s.kickDays} days inactive. They were sent a kind goodbye and can rejoin any time.`).catch(() => {});
        }
        return out;
    }

    /** Every server with inactivity on, one at a time. */
    async function sweepAll({ now = Date.now() } = {}) {
        const links = await VaBotGuild.find({ 'settings.inactiveRoleId': { $ne: '' } }).lean().catch(() => []);
        for (const link of links) {
            if (!client.guilds.cache.get(link.guildId)) continue;
            if (sweepLocks.busy(link.guildId)) continue;
            await sweepLocks.run(link.guildId, () => sweepGuild(link, { apply: true, now }))
                .catch((err) => console.error('🤖 vaBot sweep failed:', err && err.message ? err.message : err));
        }
    }

    let sweepTimer = null;
    let firstSweep = null;
    let remindTimer = null;
    /** Called once the client is ready. Timers are unref'd: they never hold the process open. */
    function startSchedules() {
        if (sweepTimer) return;
        firstSweep = setTimeout(() => { sweepAll().catch(() => {}); }, SWEEP_FIRST_MS);
        sweepTimer = setInterval(() => { sweepAll().catch(() => {}); }, SWEEP_EVERY_MS);
        remindTimer = setInterval(() => { remindEvents().catch(() => {}); }, EVENT_REMIND_EVERY_MS);
        for (const t of [firstSweep, sweepTimer, remindTimer]) if (t.unref) t.unref();
    }
    function stopSchedules() {
        clearTimeout(firstSweep); clearInterval(sweepTimer); clearInterval(remindTimer);
        firstSweep = null; sweepTimer = null; remindTimer = null;
    }

    /* ===================================================================
     * DISPATCH
     * ================================================================ */

    /** True when the interaction was ours, whether or not it went well. */
    async function handleInteraction(interaction) {
        const isCmd = interaction.isChatInputCommand && interaction.isChatInputCommand()
            && (interaction.commandName === 'crew' || interaction.commandName === 'crew-admin');
        const parsed = !isCmd && interaction.customId ? parseCid(interaction.customId) : null;
        if (!isCmd && !parsed) return false;
        try {
            if (!interaction.inGuild()) { await say(interaction, 'Use this inside your airline’s server.'); return true; }
            if (isCmd) await routeCommand(interaction);
            else await routeComponent(interaction, parsed);
        } catch (err) {
            // Unknown / already-acknowledged interaction: Discord gave up on it
            // (three seconds passed, or a second tab answered). Nothing to say.
            if (err && (err.code === 10062 || err.code === 40060)) return true;
            console.error('🤖 vaBot interaction error:', err && err.stack ? err.stack : err);
            await say(interaction, 'Something went wrong on our side. Try again in a moment.');
        }
        return true;
    }

    async function routeCommand(interaction) {
        const sub = interaction.options.getSubcommand();
        if (interaction.commandName === 'crew-admin') {
            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return say(interaction, 'You need **Manage Server** for this.');
            }
            if (sub === 'setup') {
                if (isHomeGuild(interaction.guildId)) return say(interaction, 'This is Inflight’s own server — it is not linked to an airline.');
                // One try per server every few seconds: a code is short, and
                // this is the only place one can be guessed at.
                const wait = setupCooldown.hit(interaction.guildId);
                if (wait) return say(interaction, `One moment — try again in ${wait}s.`);
                return adminSetup(interaction);
            }
            const ctx = await context(interaction);
            if (ctx.error) return say(interaction, ctx.error);
            if (sub === 'settings') return adminSettings(interaction, ctx);
            if (sub === 'panel') return adminPanel(interaction, ctx);
            if (sub === 'welcome') return adminWelcome(interaction, ctx);
            if (sub === 'inactivity') return adminInactivity(interaction, ctx);
            if (sub === 'sweep') return adminSweep(interaction, ctx);
            if (sub === 'check') return adminCheck(interaction, ctx);
            if (sub === 'unlink') return adminUnlink(interaction);
            return say(interaction, 'Unknown command.');
        }
        const wait = commandCooldown.hit(`${interaction.user.id}:${sub}`);
        if (wait) return say(interaction, `One moment — try again in ${wait}s.`);
        const ctx = await context(interaction);
        if (ctx.error) return say(interaction, ctx.error);
        if (sub === 'apply') return openTicket(interaction, ctx, 'apply');
        if (sub === 'ticket') return askSupport(interaction, ctx);
        if (sub === 'close') return closeCommand(interaction, ctx);
        if (sub === 'add') return addToTicket(interaction, ctx);
        if (sub === 'link') return linkAccount(interaction, ctx);
        if (sub === 'me') return showMe(interaction, ctx);
        if (sub === 'leaderboard') return showLeaderboard(interaction, ctx);
        if (sub === 'route') return suggestRoute(interaction, ctx, interaction.options.getString('from'), interaction.options.getString('aircraft'));
        if (sub === 'links') return showLinks(interaction, ctx);
        if (sub === 'stats') return showStats(interaction, ctx);
        if (sub === 'events') return showEvents(interaction, ctx);
        if (sub === 'pilot') return showPilot(interaction, ctx);
        return say(interaction, 'Unknown command.');
    }

    async function routeComponent(interaction, { action, args }) {
        const ctx = await context(interaction);
        if (ctx.error) return say(interaction, ctx.error);
        if (action === 'open') return args[0] === 'support' ? askSupport(interaction, ctx, args[1]) : openTicket(interaction, ctx, 'apply');
        if (action === 'opensub') {
            const get = (id) => { try { return interaction.fields.getTextInputValue(id); } catch { return ''; } };
            return openTicket(interaction, ctx, 'support', { topic: get('topic'), details: get('details') });
        }
        if (action === 'links') return showLinks(interaction, ctx);
        if (action === 'link') return linkAccount(interaction, ctx);
        if (action === 'rsvp' || action === 'unrsvp') return args[0] ? rsvp(interaction, ctx, args[0], action === 'rsvp') : say(interaction, 'That event is gone.');
        if (action === 'rsvpick') {
            const id = interaction.values && interaction.values[0];
            return id ? rsvp(interaction, ctx, id, true) : say(interaction, 'Pick an event.');
        }
        if (action === 'route') return suggestRoute(interaction, ctx, args[0] === '-' ? '' : args[0], args[1] === '-' ? '' : args[1]);

        // A change to a ticket claims it first and only then reads it, so two
        // presses cannot both see "not sent yet" and both send.
        if (MUTATING.has(action)) {
            const key = String(args[0] || '');
            if (ticketLocks.busy(key)) return say(interaction, 'Still working on the last press — one moment.');
            return ticketLocks.run(key, () => ticketAction(interaction, ctx, action, args));
        }
        return ticketAction(interaction, ctx, action, args);
    }

    async function ticketAction(interaction, ctx, action, args) {
        const ticket = await loadTicket(interaction, args[0]);
        if (!ticket) return say(interaction, 'That ticket no longer exists.');
        if (String(ticket.vaId) !== String(ctx.va._id)) return say(interaction, 'That ticket belongs to a different crew center.');
        if (ticket.status === 'closed' && action !== 'login' && action !== 'reopen') return say(interaction, 'This ticket is closed.');

        switch (action) {
        case 'form': return showFormPage(interaction, ctx, ticket, args[1]);
        case 'formsub': return saveFormPage(interaction, ctx, ticket, args[1]);
        case 'submit': return submitApplication(interaction, ctx, ticket);
        case 'test': return sendTest(interaction, ctx, ticket, null);
        case 'testpick': {
            if (!isStaff(interaction, ctx.settings)) return say(interaction, 'Only staff can send the entrance test.');
            await interaction.deferUpdate();
            return sendTest(interaction, ctx, ticket, interaction.values && interaction.values[0]);
        }
        case 'accept': return acceptButton(interaction, ctx, ticket);
        case 'decline': return declineButton(interaction, ctx, ticket);
        case 'declinesub': return declineSubmit(interaction, ctx, ticket);
        case 'login': return showLogin(interaction, ctx, ticket);
        case 'close': return closeTicket(interaction, ctx, ticket);
        case 'reopen': return reopenTicket(interaction, ctx, ticket);
        default: return say(interaction, 'That button is from an older version of the bot. Open a new ticket.');
        }
    }

    /** The bot was removed from a server: forget the link, close its tickets. */
    async function onGuildDelete(guild) {
        if (!guild || !guild.id) return;
        try {
            await VaBotGuild.deleteOne({ guildId: guild.id });
            await VaBotTicket.updateMany({ guildId: guild.id, status: 'open' }, { $set: { status: 'closed', closedAt: new Date() } });
            await VaBotEventPost.deleteMany({ guildId: guild.id });
            await VaBotInactive.deleteMany({ guildId: guild.id });
            guildCache.del(guild.id);
        } catch (err) { console.warn('🤖 vaBot guildDelete cleanup failed:', err && err.message ? err.message : err); }
    }

    /** For diagnostics: what this module holds in memory. */
    const stats = () => ({
        guildCache: guildCache.size(), vaCache: vaCache.size(), joinCache: joinCache.size(),
        cooldowns: ticketCooldown.size() + commandCooldown.size() + setupCooldown.size() + joinBurst.size() + rsvpCooldown.size(),
        locks: ticketLocks.size() + eventLocks.size() + sweepLocks.size(), api: apiLimiter.stats(),
    });

    return { commands, handleInteraction, onGuildDelete, onMemberJoin, sweepGuild, sweepAll, remindEvents, startSchedules, stopSchedules, stats };
}

/* ===========================================================================
 * WHAT THE CREW CENTER IS TOLD ABOUT A LINKED SERVER
 *
 * Yes/no per setting, never the ids: the dashboard and the setup guide need
 * to know what is missing, not which channel it is.
 * ======================================================================== */

const botAvailable = () => !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);

function guildSummary(g) {
    const s = (g && g.settings) || {};
    return {
        staffRole: !!s.staffRoleId, pilotRole: !!s.pilotRoleId,
        ticketChannel: !!s.ticketChannelId, eventsChannel: !!s.eventsChannelId,
        autoInvite: !!s.autoInvite, panel: !!(g && g.panelAt),
    };
}

/** The setup guide's input: is there a bot, and how far along is each server. */
async function guideState(vaId) {
    if (!botAvailable()) return { available: false, guilds: [] };
    const guilds = await VaBotGuild.find({ vaId }).sort({ linkedAt: -1 }).limit(20).lean();
    return { available: true, guilds: guilds.map((g) => ({ name: g.guildName || '', ...guildSummary(g) })) };
}

/* ===========================================================================
 * CREW CENTER ROUTES — the dashboard's "Discord bot" card
 * ======================================================================== */

/* ===========================================================================
 * WHAT THE BOT ASKS THE CREW CENTER ABOUT PILOTS
 *
 * Pure, so the rules are tested without a database: which roster rows the
 * bot may act on, and what it is told about each.
 * ======================================================================== */

/**
 * The bot's view of one linked pilot. Staff are marked so the sweep leaves
 * them alone: an account role of staff/owner, a staff member's own pilot
 * side, or a job title on the roster row (crewRetention.isStaff).
 */
function pilotRow(account, member, index, now = Date.now()) {
    const m = member || {};
    let status = String(m.status || 'active');
    // A leave with an end date that has passed is over.
    if (status === 'loa' && m.loaUntil && new Date(m.loaUntil).getTime() <= now) status = 'active';
    const last = index ? crewRetention.lastFlightFor(m, index) : null;
    return {
        discordId: String(account.discordId || ''),
        memberId: String(m._id || ''),
        name: clean(m.name || account.displayName || account.username, 80),
        callsign: clean(m.callsign, 20),
        status,
        staff: account.role === 'staff' || account.role === 'owner' || !!account.portalAccountId || crewRetention.isStaff(m),
        lastFlightAt: last ? new Date(last).toISOString() : null,
        joinedAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
    };
}

/** Every active login with a linked Discord and a roster row, and how many have no Discord. */
function linkedPilots({ accounts = [], members = [], pireps = [], now = Date.now() } = {}) {
    const index = crewRetention.lastFlightIndex(pireps);
    const byId = new Map(members.map((m) => [String(m._id), m]));
    const pilots = [];
    const seen = new Set();
    let unlinked = 0;
    for (const a of accounts) {
        if (!a || a.active === false || !a.memberId) continue;
        const m = byId.get(String(a.memberId));
        if (!m) continue;
        if (!isSnowflake(a.discordId)) { unlinked++; continue; }
        if (seen.has(a.discordId)) continue;
        seen.add(a.discordId);
        pilots.push(pilotRow(a, m, index, now));
    }
    return { pilots, unlinked };
}

/**
 * @param deps.requireCap       server.js's capability gate
 * @param deps.resolveCrewVa    slug -> VA
 * @param deps.resolveCrewStore slug -> { va, store }, for the bot's own routes
 */
function registerRoutes(app, { requireCap, resolveCrewVa, resolveCrewStore }) {
    const gateFor = async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'integrations.manage');
        if (gate.error) {
            res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : 'Only the owner can connect the Discord bot.' });
            return null;
        }
        const va = await resolveCrewVa(req.params.slug);
        if (!va) { res.status(404).json({ error: 'Crew center not found.' }); return null; }
        return { gate, va };
    };

    const publicGuild = (g) => ({
        guildId: g.guildId, name: g.guildName || '', linkedAt: g.linkedAt,
        linkedBy: (g.linkedBy && g.linkedBy.tag) || '',
        settings: guildSummary(g),
    });

    app.get('/api/crew/:slug/discord-bot', async (req, res) => {
        try {
            const ctx = await gateFor(req, res);
            if (!ctx) return;
            const guilds = await VaBotGuild.find({ vaId: ctx.va._id }).sort({ linkedAt: -1 }).limit(20).lean();
            res.set('Cache-Control', 'no-store');
            res.json({
                available: botAvailable(),
                inviteUrl: inviteUrl(),
                guideUrl: GUIDE_URL(),
                guilds: guilds.map(publicGuild),
            });
        } catch (err) { console.error('discord bot status error:', err); res.status(500).json({ error: 'Could not load the Discord bot status.' }); }
    });

    // A fresh one-time code. Any earlier unused code for this VA stops working:
    // there is only ever one live, so a code left on a shared screen is dead
    // the moment somebody makes the next one.
    app.post('/api/crew/:slug/discord-bot/code', async (req, res) => {
        try {
            const ctx = await gateFor(req, res);
            if (!ctx) return;
            await VaBotLinkCode.deleteMany({ vaId: ctx.va._id });
            const code = makeLinkCode();
            const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
            await VaBotLinkCode.create({
                codeHash: hashCode(code), vaId: ctx.va._id, expiresAt,
                createdBy: clean(ctx.gate.p && (ctx.gate.p.name || ctx.gate.p.uname), 80),
            });
            res.set('Cache-Control', 'no-store');
            res.status(201).json({ code, expiresAt, inviteUrl: inviteUrl() });
        } catch (err) { console.error('discord bot code error:', err); res.status(500).json({ error: 'Could not make a link code.' }); }
    });

    app.delete('/api/crew/:slug/discord-bot/guilds/:guildId', async (req, res) => {
        try {
            const ctx = await gateFor(req, res);
            if (!ctx) return;
            const guildId = String(req.params.guildId || '');
            const r = await VaBotGuild.deleteOne({ vaId: ctx.va._id, guildId });
            if (!r.deletedCount) return res.status(404).json({ error: 'That server is not linked.' });
            guildCache.del(guildId);
            res.json({ ok: true });
        } catch (err) { console.error('discord bot unlink error:', err); res.status(500).json({ error: 'Could not unlink that server.' }); }
    });

    /* ---- the bot's own routes -------------------------------------------
     *
     * Answered to the bot and nobody else: the loopback key, not a capability,
     * because no person — staff included — needs a list of who is which
     * Discord account. Each one reads the VA's own store, the same as every
     * crew route, and fails whole rather than answering with part of it. */
    const botOnly = (req, res) => {
        if (botCallerFrom(req, req.params.slug)) return true;
        res.status(401).json({ error: 'Not authenticated.' });
        return false;
    };
    const storeFail = (res, err, what) => {
        const status = err && Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
        if (status >= 500) console.error(`discord bot ${what} error:`, err && err.message ? err.message : err);
        res.status(status).json({ error: (err && err.status && err.message) || `Could not read ${what}.`, code: (err && err.code) || '' });
    };

    app.get('/api/crew/:slug/discord-bot/pilots', async (req, res) => {
        if (!botOnly(req, res)) return;
        try {
            const { store } = await resolveCrewStore(req.params.slug);
            const [accounts, members, pireps] = await Promise.all([
                store.listAccounts({ limit: 5000 }),
                store.listMembers({ limit: 5000 }),
                store.listPireps({ status: 'approved', limit: 20000 }),
            ]);
            res.set('Cache-Control', 'no-store');
            res.json(linkedPilots({ accounts, members, pireps }));
        } catch (err) { storeFail(res, err, 'the roster'); }
    });

    app.get('/api/crew/:slug/discord-bot/pilot/:discordId', async (req, res) => {
        if (!botOnly(req, res)) return;
        const discordId = String(req.params.discordId || '');
        if (!isSnowflake(discordId)) return res.status(400).json({ error: 'Not a Discord id.' });
        try {
            const { store } = await resolveCrewStore(req.params.slug);
            const account = await store.getAccountByDiscord(discordId);
            const member = account && account.active !== false && account.memberId ? await store.getMember(account.memberId) : null;
            res.set('Cache-Control', 'no-store');
            res.json({ pilot: member ? pilotRow(account, member, null) : null });
        } catch (err) { storeFail(res, err, 'that pilot'); }
    });

    // An hour before an event: the Discord ids of the pilots going, so the
    // reminder can ping them. Only people whose login is linked appear.
    app.get('/api/crew/:slug/discord-bot/events/:eventId/attendees', async (req, res) => {
        if (!botOnly(req, res)) return;
        try {
            const { store } = await resolveCrewStore(req.params.slug);
            const event = await store.getEvent(req.params.eventId);
            if (!event || event.status === 'draft') return res.status(404).json({ error: 'Event not found.' });
            const [signups, accounts] = await Promise.all([store.listSignups(event._id), store.listAccounts({ limit: 5000 })]);
            const byAccount = new Map();
            const byMember = new Map();
            for (const a of accounts) {
                if (!a || a.active === false || !isSnowflake(a.discordId)) continue;
                byAccount.set(String(a._id), a.discordId);
                if (a.memberId) byMember.set(String(a.memberId), a.discordId);
            }
            const ids = new Set();
            for (const sgn of signups) {
                if (!sgn || sgn.status !== 'going') continue;
                const id = (sgn.accountId && byAccount.get(String(sgn.accountId))) || (sgn.memberId && byMember.get(String(sgn.memberId)));
                if (id) ids.add(id);
            }
            res.set('Cache-Control', 'no-store');
            res.json({ event: { title: event.title || '', startsAt: event.startsAt || null, status: event.status || '' }, discordIds: [...ids] });
        } catch (err) { storeFail(res, err, 'that event'); }
    });

    // Right after the bot accepted an application from a ticket: write the
    // applicant's Discord onto the login that acceptance made. Never over a
    // different Discord already on it, and never onto a second login.
    app.post('/api/crew/:slug/discord-bot/link-pilot', async (req, res) => {
        if (!botOnly(req, res)) return;
        const b = req.body || {};
        const discordId = String(b.discordId || '');
        const applicationId = String(b.applicationId || '');
        if (!isSnowflake(discordId) || !applicationId) return res.status(400).json({ error: 'Missing the application or the Discord id.' });
        try {
            const { store } = await resolveCrewStore(req.params.slug);
            const appDoc = await store.getApplication(applicationId);
            if (!appDoc || appDoc.status !== 'accepted') return res.json({ linked: false, reason: 'not_accepted' });
            let account = appDoc.inviteAccountId ? await store.getAccount(appDoc.inviteAccountId) : null;
            if (!account && appDoc.inviteUsername) account = await store.getAccountByUsername(appDoc.inviteUsername);
            if (!account || account.active === false) return res.json({ linked: false, reason: 'no_login' });
            if (account.discordId === discordId) return res.json({ linked: true });
            if (account.discordId) return res.json({ linked: false, reason: 'other_discord' });
            const taken = await store.getAccountByDiscord(discordId);
            if (taken && String(taken._id) !== String(account._id)) return res.json({ linked: false, reason: 'taken' });
            await store.updateAccount(account._id, {
                discordId,
                discordUsername: clean(b.username, 40),
                discordAvatar: /^(a_)?[a-f0-9]{32}$/.test(String(b.avatar || '')) ? String(b.avatar) : '',
                discordLinkedAt: new Date(),
            });
            res.json({ linked: true });
        } catch (err) {
            // The unique index firing on a race is "taken", not a failure.
            if (err && err.code === 'store_conflict') return res.json({ linked: false, reason: 'taken' });
            storeFail(res, err, 'that login');
        }
    });
}

module.exports = {
    configure, createVaBot, registerRoutes, hub, api, callerHeaders, guideState, guildSummary, GUIDE_URL,
    botCallerFrom, botPilotFrom, botMay, BOT_CAPS,
    // Pure, for the tests.
    makeLinkCode, normalizeCode, hashCode, cid, parseCid, pageCount, pageQuestions,
    matchOption, pickAirline, agreeLabels, describeRequirements, draftProblems, applyBody,
    isStaff, threadName, makeCooldown, makeCache, makeLocks, makeLimiter, inviteUrl, eventEmbed, shortLabel,
    renderWelcome, isDormant, activityPlan, makeBurst, pilotRow, linkedPilots, linkUrl,
    models: { VaBotGuild, VaBotLinkCode, VaBotTicket, VaBotEventPost, VaBotInactive },
};
