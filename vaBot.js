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
 *   * published events get a post and a discussion thread of their own.
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
    },
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
}, { timestamps: true });
VaBotEventPostSchema.index({ guildId: 1, eventId: 1 }, { unique: true });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
const VaBotGuild = model('VaBotGuild', VaBotGuildSchema);
const VaBotLinkCode = model('VaBotLinkCode', VaBotLinkCodeSchema);
const VaBotTicket = model('VaBotTicket', VaBotTicketSchema);
const VaBotEventPost = model('VaBotEventPost', VaBotEventPostSchema);

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
    // Giving an accepted pilot the airline's pilot role.
    'ManageRoles',
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

const crewUrl = (slug) => `${config.siteOrigin}/crew/${encodeURIComponent(String(slug || '').toLowerCase())}`;

/* ===========================================================================
 * THE CREW CENTER, OVER LOOPBACK
 * ======================================================================== */

/** The headers that make a loopback request the bot's. Never sent anywhere else. */
const callerHeaders = (slug, actor) => ({
    'x-inflight-bot-key': BOT_CALLER_KEY,
    'x-inflight-bot-slug': String(slug || '').toLowerCase(),
    'x-inflight-bot-actor': encodeURIComponent(String(actor || '').slice(0, 80)),
});

/* Every server's bot traffic shares one crew center process: eight requests
 * at a time between them, whatever is happening in Discord. */
const API_CONCURRENCY = 8;
const apiLimiter = makeLimiter(API_CONCURRENCY, { queueMax: 500, waitMs: 10000 });
const BUSY = { ok: false, status: 503, data: {}, error: 'The crew center is busy right now. Try again in a moment.' };

function api(method, path, opts = {}) {
    return apiLimiter.run(() => apiNow(method, path, opts), BUSY);
}

async function apiNow(method, path, { body, slug, actor, asBot = false } = {}) {
    const headers = { Accept: 'application/json', ...(asBot ? callerHeaders(slug, actor) : {}) };
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
    ].filter(Boolean);
    if (fields.length) e.addFields(fields);
    if (isHttpsUrl(event.bannerUrl) && action !== 'removed') e.setImage(event.bannerUrl);
    if (action === 'cancelled' || action === 'removed') e.setColor(0xDC2626);
    return e;
}

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
    const MUTATING = new Set(['formsub', 'submit', 'test', 'testpick', 'accept', 'declinesub', 'close']);

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
        if (!link) return { error: 'This server is not linked to a crew center yet. A server admin runs `/crew-admin setup` with the code from the crew center (Alerts → Discord bot).' };
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
            .addSubcommand((s) => s.setName('ticket').setDescription('Open a private ticket with the staff'))
            .addSubcommand((s) => s.setName('links').setDescription('The airline’s links'))
            .addSubcommand((s) => s.setName('stats').setDescription('Pilots, hours and flights'))
            .addSubcommand((s) => s.setName('events').setDescription('Upcoming events'))
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
            .addSubcommand((s) => s.setName('panel').setDescription('Post the recruitment panel')
                .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText)))
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
            '2. `/crew-admin panel` in your recruitment channel.',
            '3. `/crew-admin check` to make sure the bot has the permissions it needs.',
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
        );
        return interaction.reply({ embeds: [e], flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }

    async function adminPanel(interaction, ctx) {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) return say(interaction, 'Post the panel in an ordinary text channel.');
        await interaction.deferReply({ flags: EPHEMERAL });
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
        return say(interaction, `Panel posted in ${channel}.${ctx.settings.ticketChannelId ? '' : ' Tickets will open as threads in that channel — set a different one with `/crew-admin settings ticket_channel`.'}`);
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

        const join = await joinConfig(ctx.va);
        lines.push(join ? `✅ Crew center **${ctx.va.name}** is answering` : '❌ The crew center did not answer');
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
                const going = Number(ev.attending || ev.signupCount || 0);
                return `**${clean(ev.title, 100) || leg || 'Event'}**${leg && ev.title ? ` · ${leg}` : ''}\n${stamp(ev.startsAt) || 'Time to be announced'}${going ? ` · ${going} going` : ''}`;
            }).join('\n\n').slice(0, 4000)
            : 'Nothing on the calendar right now.');
        return interaction.editReply({ embeds: [e] });
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

    async function openTicket(interaction, ctx, kind) {
        const wait = ticketCooldown.hit(`${interaction.guildId}:${interaction.user.id}`);
        if (wait) return say(interaction, `Give it ${wait}s before opening another ticket.`);
        await interaction.deferReply({ flags: EPHEMERAL });

        // One open ticket of each kind per person. A second click points at the
        // first, unless that thread has gone, in which case the record is closed.
        const prior = await VaBotTicket.findOne({ guildId: interaction.guildId, userId: interaction.user.id, kind, status: 'open' });
        if (prior) {
            const thread = await fetchChannel(prior.threadId);
            if (thread) return say(interaction, `You already have a ticket open: ${thread}`);
            prior.status = 'closed'; prior.closedAt = new Date();
            await prior.save().catch(() => {});
        }
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
            await send(thread, {
                content: `${interaction.user}${staff ? ` <@&${staff}>` : ''}`,
                embeds: [vaEmbed(ctx.va).setTitle('Ticket').setDescription('Tell the staff what you need — someone will be with you shortly.')],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
                )],
                allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
            });
        }
        logToStaff(ctx.settings, `🎫 ${kind === 'apply' ? 'Application' : 'Support'} ticket opened by <@${interaction.user.id}>: ${thread}`).catch(() => {});
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
        ticket.stage = 'accepted';
        await ticket.save();

        // The pilot role, best-effort: a role the bot cannot give is reported to
        // staff, not a reason the acceptance did not happen.
        let roleNote = '';
        const guild = client.guilds.cache.get(ticket.guildId);
        if (ctx.settings.pilotRoleId && guild) {
            const member = await guild.members.fetch(ticket.userId).catch(() => null);
            if (member) {
                await member.roles.add(ctx.settings.pilotRoleId, `Accepted into ${ctx.va.name}`)
                    .catch(() => { roleNote = ' I could not give them the pilot role — run `/crew-admin check`.'; });
            }
        }

        const account = r.data.account || null;
        const thread = await fetchChannel(ticket.threadId);
        const hasLogin = !!(r.data.invite && r.data.invite.state === 'live') || !!(account && account.password);
        const e = vaEmbed(ctx.va).setColor(0x16A34A).setTitle(`🎉 Welcome to ${clean(ctx.va.name, 200)}!`).setDescription([
            `<@${ticket.userId}>, you’re in${r.data.invite && r.data.invite.username ? ` — your username is \`${clean(r.data.invite.username, 60)}\`` : ''}.`,
            hasLogin
                ? 'Press **Show my login** — only you can see it. You’ll choose your own password the first time you sign in.'
                : (account && account.error) || 'Your crew center login will follow from the staff.',
        ].join('\n\n'));
        const buttons = [];
        if (hasLogin) buttons.push(new ButtonBuilder().setCustomId(cid('login', ticket._id)).setLabel('Show my login').setStyle(ButtonStyle.Success).setEmoji('🔑'));
        buttons.push(new ButtonBuilder().setURL(r.data.signInUrl && isHttpUrl(r.data.signInUrl) ? r.data.signInUrl : crewUrl(ctx.va.slug)).setLabel('Crew center').setStyle(ButtonStyle.Link));
        buttons.push(new ButtonBuilder().setCustomId(cid('close', ticket._id)).setLabel('Close ticket').setStyle(ButtonStyle.Secondary));
        await send(thread, {
            content: `<@${ticket.userId}>`, embeds: [e],
            components: [new ActionRowBuilder().addComponents(buttons)],
            allowedMentions: { users: [ticket.userId] },
        });
        logToStaff(ctx.settings, `✅ <@${ticket.userId}> accepted by ${actor}.${roleNote}`).catch(() => {});
        return { ok: true, note: roleNote, loginError: account && account.error };
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
        return say(interaction, `Accepted.${out.loginError ? ` ${out.loginError}` : ''}${out.note}`);
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

    async function closeTicket(interaction, ctx, ticket) {
        if (!isOwner(interaction, ticket) && !isStaff(interaction, ctx.settings)) return say(interaction, 'Only the ticket’s owner or staff can close it.');
        if (ticket.status === 'closed') return say(interaction, 'This ticket is already closed.');
        await interaction.deferReply({ flags: EPHEMERAL });
        ticket.status = 'closed';
        ticket.closedAt = new Date();
        await ticket.save();
        const thread = await fetchChannel(ticket.threadId);
        if (thread) {
            await send(thread, { content: `🔒 Closed by ${interaction.user}.`, allowedMentions: { parse: [] } });
            await thread.setLocked(true).catch(() => {});
            await thread.setArchived(true).catch(() => {});
        }
        logToStaff(ctx.settings, `🔒 Ticket for <@${ticket.userId}> closed by ${interaction.user}.`).catch(() => {});
        return say(interaction, 'Closed.');
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
                + (passed ? (auto ? '\n\nSending the crew center login now…' : '\n\nStaff: accept to send the crew center login.') : '\n\nThe test page says when they can try again and what to read meanwhile.'));
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
            const msg = await send(ch, { embeds: [embed], allowedMentions: { parse: [] } });
            if (!msg) return;
            const thread = await msg.startThread({ name: (clean(event.title, 90) || 'Event chat'), autoArchiveDuration: THREAD_ARCHIVE_MIN }).catch(() => null);
            await VaBotEventPost.create({ guildId: link.guildId, vaId: va._id, eventId, channelId: ch.id, messageId: msg.id, threadId: thread ? thread.id : '' }).catch(() => {});
            return;
        }
        const ch = await fetchChannel(post.channelId);
        const msg = ch && ch.messages ? await ch.messages.fetch(post.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ embeds: [embed] }).catch(() => {});
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
            if (sub === 'check') return adminCheck(interaction, ctx);
            if (sub === 'unlink') return adminUnlink(interaction);
            return say(interaction, 'Unknown command.');
        }
        const wait = commandCooldown.hit(`${interaction.user.id}:${sub}`);
        if (wait) return say(interaction, `One moment — try again in ${wait}s.`);
        const ctx = await context(interaction);
        if (ctx.error) return say(interaction, ctx.error);
        if (sub === 'apply') return openTicket(interaction, ctx, 'apply');
        if (sub === 'ticket') return openTicket(interaction, ctx, 'support');
        if (sub === 'links') return showLinks(interaction, ctx);
        if (sub === 'stats') return showStats(interaction, ctx);
        if (sub === 'events') return showEvents(interaction, ctx);
        if (sub === 'pilot') return showPilot(interaction, ctx);
        return say(interaction, 'Unknown command.');
    }

    async function routeComponent(interaction, { action, args }) {
        const ctx = await context(interaction);
        if (ctx.error) return say(interaction, ctx.error);
        if (action === 'open') return openTicket(interaction, ctx, args[0] === 'support' ? 'support' : 'apply');
        if (action === 'links') return showLinks(interaction, ctx);

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
        if (ticket.status === 'closed' && action !== 'login') return say(interaction, 'This ticket is closed.');

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
            guildCache.del(guild.id);
        } catch (err) { console.warn('🤖 vaBot guildDelete cleanup failed:', err && err.message ? err.message : err); }
    }

    /** For diagnostics: what this module holds in memory. */
    const stats = () => ({
        guildCache: guildCache.size(), vaCache: vaCache.size(), joinCache: joinCache.size(),
        cooldowns: ticketCooldown.size() + commandCooldown.size() + setupCooldown.size(),
        locks: ticketLocks.size() + eventLocks.size(), api: apiLimiter.stats(),
    });

    return { commands, handleInteraction, onGuildDelete, stats };
}

/* ===========================================================================
 * CREW CENTER ROUTES — the dashboard's "Discord bot" card
 * ======================================================================== */

/**
 * @param deps.requireCap     server.js's capability gate
 * @param deps.resolveCrewVa  slug -> VA
 */
function registerRoutes(app, { requireCap, resolveCrewVa }) {
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
        settings: {
            staffRole: !!(g.settings && g.settings.staffRoleId),
            pilotRole: !!(g.settings && g.settings.pilotRoleId),
            ticketChannel: !!(g.settings && g.settings.ticketChannelId),
            eventsChannel: !!(g.settings && g.settings.eventsChannelId),
            autoInvite: !!(g.settings && g.settings.autoInvite),
        },
    });

    app.get('/api/crew/:slug/discord-bot', async (req, res) => {
        try {
            const ctx = await gateFor(req, res);
            if (!ctx) return;
            const guilds = await VaBotGuild.find({ vaId: ctx.va._id }).sort({ linkedAt: -1 }).limit(20).lean();
            res.set('Cache-Control', 'no-store');
            res.json({
                available: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID),
                inviteUrl: inviteUrl(),
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
}

module.exports = {
    configure, createVaBot, registerRoutes, hub, api, callerHeaders,
    botCallerFrom, botMay, BOT_CAPS,
    // Pure, for the tests.
    makeLinkCode, normalizeCode, hashCode, cid, parseCid, pageCount, pageQuestions,
    matchOption, pickAirline, agreeLabels, describeRequirements, draftProblems, applyBody,
    isStaff, threadName, makeCooldown, makeCache, makeLocks, makeLimiter, inviteUrl, eventEmbed, shortLabel,
    models: { VaBotGuild, VaBotLinkCode, VaBotTicket, VaBotEventPost },
};
