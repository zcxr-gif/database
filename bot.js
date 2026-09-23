// bot.js
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    AttachmentBuilder, 
    ComponentType,
    ChannelType,
    PermissionsBitField, // Added for Mod Permissions
    Options 
} = require('discord.js');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const fsPromises = require('fs').promises; 
const os = require('os');
const path = require('path');
const stream = require('stream');
const util = require('util');

// Import the local aircraft registry for auto-registration lookup
const aircraftRegistry = require('./aircraft.json');
// --- NEW AIRPORT CONFIGURATION ---
const AIRPORT_SUBMISSION_CHANNEL_ID = '1463634001020325959';
const AIRPORT_ADMIN_CHANNEL_ID = '1463636133685628989';

// Import airport helpers (Ensure these are exported in airports.js)
const { uploadAirportImage, getAirportInfo, deleteAirportImages } = require('./airports');

// Import VA image helpers so the bot can accept banner/logo uploads in-channel
// and push them to S3, exactly like the web dashboard does.
const { uploadVaImage, deleteVaImage } = require('./vaAds');
// Shared Terms version + enforcement config (source of truth for the portal too).
const { TOS_VERSION: VA_TOS_VERSION, TOS_PAGE_PATH: VA_TOS_PAGE_PATH } = require('./vaTos');

// Promisify pipeline for efficient stream handling
const pipeline = util.promisify(stream.pipeline);

// MEMORY FIX: Disable Sharp's internal cache
sharp.cache(false);
// MEMORY FIX: limit concurrency to prevent CPU/RAM saturation
sharp.concurrency(1); 

// CONFIGURATION - REPLACE THESE WITH YOUR REAL CHANNEL IDS
const ADMIN_CHANNEL_ID = '1448137363795742942'; 
const PUBLIC_FEED_CHANNEL_ID = '1448138153335586988'; 
const WELCOME_CHANNEL_ID = '1442462899451858975'; 
const SUBMISSION_CHANNEL_ID = '1442461970371444880'; 

// --- NEW CONFIGURATION ---
const MEMBER_ROLE_ID = '1442472513849397248';          
const CONTRIBUTOR_ROLE_ID = '1442534816863223888';     
const LEADERBOARD_CHANNEL_ID = '1448178846875521064';  
const TOP_CONTRIBUTOR_ROLE_ID = '1448179466722611291'; 
const ADMIN_ROLE_ID = '1442258765016469649'; // Admin Role for Mod Commands

// --- TICKET SYSTEM CONFIGURATION ---
const TICKET_PANEL_CHANNEL_ID = '1442462474489299115';
const TRANSCRIPT_CHANNEL_ID = '1442471030642966548'; // Used for Tickets AND Mod Logs

// --- GIVEAWAY CONFIGURATION ---
const GIVEAWAY_MOD_CHANNEL_ID = ADMIN_CHANNEL_ID;        // moderation/staff channel for winner fulfillment
const GIVEAWAY_TICKET_CHANNEL_ID = TICKET_PANEL_CHANNEL_ID; // parent channel for winner help tickets
const DEFAULT_GIVEAWAY_PRIZE = 'Inflight Pro — 1 Month Subscription';

// --- VA (VIRTUAL AIRLINE) SYSTEM CONFIGURATION ---
// Pilots apply with /va_apply; the application posts to the review channel for
// staff to Approve / Reject / Request edits. On approval the bot provisions a
// private VA channel under the category, a VA-specific role, and grants the
// shared "VA Rep" role (which unlocks the reps general chat).
const VA_CATEGORY_ID = '1517173854206693416';            // parent category for per-VA channels
const VA_REPS_CHAT_ID = '1517174670334361732';           // shared reps general chat
const VA_APPLICATION_CHANNEL_ID = '1517177121422835852'; // where applications post for review
const VA_REP_ROLE_NAME = 'VA Rep';                       // shared role gating the reps chat

// Public partnership channel. When an approved VA finally has BOTH a banner and
// a logo, the bot posts a one-time "new partner" announcement here. It also
// echoes a VA member's banner when they post in this channel (see messageCreate).
const PARTNERSHIP_ANNOUNCE_CHANNEL_ID = '1517984939742597210';

// The "Inflight VA Rep" staff role. Added to every per-VA channel the bot
// provisions, and pinged + pulled into VA partnership tickets so they can field
// questions about the partnership and our Inflight Pro subscription.
const INFLIGHT_VA_REP_ROLE_ID = '1518665927254605925';

const METADATA_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api/metadata';
const BASE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run/api';

// Public URL of the VA Partnership Portal login (DM'd to a VA owner on approval).
// The portal is served by THIS backend, not the inflight.info tracker site —
// the old default sent owners to a page that doesn't exist there.
const VA_PORTAL_URL = process.env.VA_PORTAL_URL || 'https://site--indgo-backend--6dmjph8ltlhv.code.run/va-portal.html';

// --- CACHE SYSTEMS ---
let cachedAircraftData = []; 
let lastAircraftCacheUpdate = 0;
let cachedLiveries = {}; 

// --- SESSION MANAGEMENT ---
const userSessions = new Map();

// --- GIVEAWAY STATE ---
// Keyed by the giveaway message ID. This is the live in-memory mirror; the
// source of truth is the Giveaway collection so active giveaways survive a
// restart (they are reloaded on `ready` and their end timers re-armed).
const activeGiveaways = new Map();

// --- DIAGNOSTICS HOOKS ---
// Module-level references so the diagnostics terminal (see diagnostics.js) can
// read live bot state — gateway health, cache sizes, and the in-memory maps
// that have caused leaks before — without reaching into startDiscordBot's scope.
let botClientRef = null;
let vaBannerCooldownRef = null;

// Snapshot of everything the bot keeps in memory. Best-effort and defensive:
// the diagnostics endpoint must work even before the client has logged in.
function getBotStats() {
    const c = botClientRef;
    const guilds = c && c.guilds ? c.guilds.cache : null;
    let cachedMembers = 0, cachedChannels = 0;
    if (guilds) {
        for (const g of guilds.values()) {
            cachedMembers += g.members ? g.members.cache.size : 0;
            cachedChannels += g.channels ? g.channels.cache.size : 0;
        }
    }
    return {
        ready: !!(c && c.isReady && c.isReady()),
        wsPingMs: c && c.ws ? Math.round(c.ws.ping) : null,
        uptimeSec: c && c.uptime ? Math.round(c.uptime / 1000) : 0,
        caches: {
            guilds: guilds ? guilds.size : 0,
            users: c && c.users ? c.users.cache.size : 0,
            channels: c && c.channels ? c.channels.cache.size : 0,
            members: cachedMembers,
            guildChannels: cachedChannels,
        },
        inMemory: {
            userSessions: userSessions.size,
            activeGiveaways: activeGiveaways.size,
            cachedLiveries: Object.keys(cachedLiveries).length,
            vaBannerCooldown: vaBannerCooldownRef ? vaBannerCooldownRef.size : 0,
        },
    };
}

// ===================== UNIFIED VISUAL THEME =====================
// A clean white / dark-gray palette so every embed reads as one product.
// THEME.WHITE renders as a crisp white accent bar; THEME.GRAY blends into
// Discord's dark surface for neutral/secondary content.
const THEME = {
    WHITE: 0xFFFFFF,   // primary accent — active, verified, info, highlights
    GRAY:  0x2B2D31,   // neutral surface — pending, comparisons, dormant
};
const BRAND_FOOTER = 'Aircraft Database';

// Submission lifecycle states. `badge` is shown in the embed body and updates
// live as a submission moves Pending → Verified / Rejected.
const SUB_STATE = {
    PENDING:  { color: THEME.GRAY,  badge: '🟡 Awaiting Review' },
    VERIFIED: { color: THEME.WHITE, badge: '🟢 Verified' },
    REJECTED: { color: THEME.GRAY,  badge: '🔴 Rejected' },
};

// Build a consistently-branded embed. Defaults to the white accent.
const themedEmbed = (color = THEME.WHITE) =>
    new EmbedBuilder().setColor(color).setFooter({ text: BRAND_FOOTER });


// Helper to strip non-ASCII characters for AWS S3 Metadata compatibility
const sanitizeMetadata = (str) => {
    // Removes emojis, special fonts, and non-standard symbols
    const sanitized = str.replace(/[^\x00-\x7F]/g, "").trim();
    // Fallback to 'User' if the entire name was special characters
    return sanitized || "User";
};

/**
 * Converts fancy stylized fonts (NFKC normalization) to standard letters
 * and strips any remaining non-ASCII characters for S3.
 */
const normalizeContributorName = (str) => {
    if (!str) return "User";
    
    // 1. Convert fancy fonts (like 𝑺 -> S) to normal compatibility characters
    const normal = str.normalize('NFKC');
    
    // 2. Strip everything except standard printable ASCII (A-Z, 0-9, space, etc.)
    const clean = normal.replace(/[^\x20-\x7E]/g, "").trim();
    
    // 3. Fallback if the name was entirely symbols
    return clean || "User";
};

const escapeRegex = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// MEMORY FIX: Use TypedArrays to prevent heap fragmentation during high-volume lookups
const levenshteinDistance = (s, t) => {
    if (s === t) return 0;
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    // Optimization: Always ensure we iterate over the shorter string to minimize array size
    if (s.length > t.length) [s, t] = [t, s];

    // Use TypedArray for fixed memory allocation (no object overhead)
    const v0 = new Uint16Array(t.length + 1);
    const v1 = new Uint16Array(t.length + 1);

    // Initialize v0
    for (let i = 0; i < v0.length; i++) v0[i] = i;

    for (let i = 0; i < s.length; i++) {
        v1[0] = i + 1;

        for (let j = 0; j < t.length; j++) {
            const cost = s[i] === t[j] ? 0 : 1;
            v1[j + 1] = Math.min(
                v1[j] + 1,       // Deletion
                v0[j + 1] + 1,   // Insertion
                v0[j] + cost     // Substitution
            );
        }

        // Swap arrays for next iteration (copy v1 to v0)
        for (let j = 0; j < v0.length; j++) v0[j] = v1[j];
    }

    return v1[t.length];
};

const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
};

const fetchAircraftMetadata = async () => {
    if (Date.now() - lastAircraftCacheUpdate < 3600000 && cachedAircraftData.length > 0) {
        return cachedAircraftData;
    }
    try {
        const response = await axios.get(METADATA_API_URL);
        if (response.data && response.data.aircraft) {
            cachedAircraftData = response.data.aircraft.map(a => ({
                name: a.name,
                id: a.id
            })).sort((a, b) => b.name.length - a.name.length); 
            
            lastAircraftCacheUpdate = Date.now();
            console.log(`✈️  Cached ${cachedAircraftData.length} aircraft types.`);
        }
        return cachedAircraftData;
    } catch (error) {
        console.error('❌ Failed to fetch aircraft metadata:', error.message);
        return [];
    }
};

const LIVERY_CACHE_MAX = 200; // hard cap so the janitor isn't the only thing keeping us bounded

const fetchLiveriesForAircraft = async (aircraftId) => {
    const now = Date.now();
    if (cachedLiveries[aircraftId] && (now - cachedLiveries[aircraftId].timestamp < 300000)) {
        return cachedLiveries[aircraftId].data;
    }

    try {
        const url = `${BASE_API_URL}/aircraft/${aircraftId}/liveries`;
        const response = await axios.get(url);
        let liveryList = [];
        if (response.data && response.data.liveries) {
            liveryList = response.data.liveries.map(l => l.name).sort();
        }
        cachedLiveries[aircraftId] = { timestamp: now, data: liveryList };

        // Evict the oldest entry if we're over the cap.
        const keys = Object.keys(cachedLiveries);
        if (keys.length > LIVERY_CACHE_MAX) {
            let oldestKey = keys[0];
            let oldestTs = cachedLiveries[oldestKey].timestamp;
            for (const k of keys) {
                if (cachedLiveries[k].timestamp < oldestTs) {
                    oldestKey = k;
                    oldestTs = cachedLiveries[k].timestamp;
                }
            }
            delete cachedLiveries[oldestKey];
        }

        return liveryList;
    } catch (error) {
        console.error(`❌ Failed to fetch liveries for ID ${aircraftId}:`, error.message);
        return [];
    }
};

const lookupRegistration = (aircraftType, liveryName) => {
    if (!aircraftRegistry || !Array.isArray(aircraftRegistry)) return null;

    const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const targetType = clean(aircraftType);
    const targetLivery = clean(liveryName);
    
    const useFuzzy = targetType.length > 3 && targetLivery.length > 3;

    let bestMatch = null;
    let highestScore = 0;

    for (const entry of aircraftRegistry) {
        let score = 0;

        const jsonMan = clean(entry.manufacturer);
        const jsonMod = clean(entry.model);
        const jsonLivery = clean(entry.livery);
        const jsonFullPlane = jsonMan + jsonMod; 

        let liveryScore = 0;
        
        if (targetLivery === jsonLivery) liveryScore = 20;
        else if (targetLivery.includes(jsonLivery) || jsonLivery.includes(targetLivery)) liveryScore = 15;
        else if (useFuzzy) {
            const sim = getSimilarity(targetLivery, jsonLivery);
            if (sim > 0.8) liveryScore = 10 * sim; 
        }

        if (liveryScore < 5) continue; 
        score += liveryScore;

        let aircraftScore = 0;

        if (targetType === jsonMod) aircraftScore = 50;
        else if (targetType === jsonFullPlane) aircraftScore = 60;
        
        else if (targetType.includes(jsonMod)) {
            aircraftScore = 40;
            if (targetType.includes(jsonMan)) aircraftScore += 10;
        }
        else if (jsonFullPlane.includes(targetType)) aircraftScore = 20;

        else if (useFuzzy) {
            const modSim = getSimilarity(targetType, jsonMod);
            const fullSim = getSimilarity(targetType, jsonFullPlane);
            
            if (modSim > 0.85) aircraftScore = 30 * modSim;
            else if (fullSim > 0.85) aircraftScore = 35 * fullSim;
        }

        if (aircraftScore === 0) continue;

        score += aircraftScore;

        if (score > highestScore) {
            highestScore = score;
            bestMatch = entry;
        }
    }

    return (bestMatch && highestScore > 15) ? bestMatch.registration : null;
};

const normalizeData = async (rawType, rawLivery) => {
    let finalType = rawType.trim();
    let finalLivery = rawLivery.trim();
    let aircraftId = null;

    let matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase() === finalType.toLowerCase());
    
    if (!matchedAircraft) {
        matchedAircraft = cachedAircraftData.find(a => a.name.toLowerCase().includes(finalType.toLowerCase()));
    }

    if (!matchedAircraft && finalType.length > 4) {
        let bestFuzzy = null;
        let bestScore = 0;
        
        for (const ac of cachedAircraftData) {
            const sim = getSimilarity(finalType.toLowerCase(), ac.name.toLowerCase());
            if (sim > 0.7 && sim > bestScore) { 
                bestScore = sim;
                bestFuzzy = ac;
            }
        }
        if (bestFuzzy) matchedAircraft = bestFuzzy;
    }

    if (matchedAircraft) {
        finalType = matchedAircraft.name; 
        aircraftId = matchedAircraft.id;  
    }

    if (aircraftId) {
        const validLiveries = await fetchLiveriesForAircraft(aircraftId);
        
        let matchedLivery = validLiveries.find(l => l.toLowerCase() === finalLivery.toLowerCase());
        
        if (!matchedLivery) {
            matchedLivery = validLiveries.find(l => l.toLowerCase().includes(finalLivery.toLowerCase()));
        }

        if (!matchedLivery && finalLivery.length > 4) {
            let bestLiv = null;
            let bestScore = 0;
            for (const l of validLiveries) {
                const sim = getSimilarity(finalLivery.toLowerCase(), l.toLowerCase());
                if (sim > 0.75 && sim > bestScore) {
                    bestScore = sim;
                    bestLiv = l;
                }
            }
            if (bestLiv) matchedLivery = bestLiv;
        }

        if (matchedLivery) {
            finalLivery = matchedLivery; 
        }
    }

    return { type: finalType, livery: finalLivery };
};

// Auto-match a submission the same way the Discord DM flow does: normalize the
// type/livery against the known aircraft/livery catalog, then auto-fill the tail
// from the registration lookup when none was given. Safe before the bot is ready
// (the catalogs are loaded independently; missing data just yields the raw input).
// Shared by the web submission endpoint so partner submissions get identical
// tidy-up to DM ones.
async function resolveAircraftMatch(rawType, rawLivery, rawTail) {
    const { type, livery } = await normalizeData(String(rawType || ''), String(rawLivery || ''));
    let tail = String(rawTail || '').trim().toUpperCase();
    if (!tail || tail === 'UNKNOWN') {
        const auto = lookupRegistration(type, livery);
        if (auto) tail = String(auto).toUpperCase();
    }
    return { type: type.trim(), livery: livery.trim(), tail: tail || 'UNKNOWN' };
}

// Module-level handle to the logged-in Discord client, set inside
// startDiscordBot. Lets server-side code (e.g. the VA portal's activity logging)
// post to a channel by ID without holding its own bot connection.
let botClient = null;

// Assigned inside startDiscordBot. Lets the HTTP layer (server.js) hand an
// aircraft photo submitted from an EXTERNAL partner site into the exact same
// admin review + public-feed flow that Discord DM submissions use, so staff
// approve/reject them with the identical buttons. Kept as a stable exported
// wrapper (see submitWebAircraftReview) over this reassignable impl so a
// destructured `require('./bot')` import always sees the live function.
let _submitWebAircraftReviewImpl = null;

// Public entry: post an aircraft photo (already uploaded to our S3 bucket) to the
// admin review channel + public feed. Throws if the bot isn't ready so the caller
// can surface a clear error to the submitting site. See the impl inside
// startDiscordBot for the accepted fields.
async function submitWebAircraftReview(payload) {
    if (typeof _submitWebAircraftReviewImpl !== 'function') {
        throw new Error('Discord bot not ready — cannot post aircraft review');
    }
    return _submitWebAircraftReviewImpl(payload);
}

// Post a message/embed to a Discord channel by ID using the running bot client.
// Fire-and-forget: a no-op (logged) if the client isn't ready or the channel
// can't be reached, so callers never have to guard against startup races.
async function postToChannel(channelId, payload) {
    try {
        if (!botClient || typeof botClient.isReady === 'function' && !botClient.isReady()) {
            console.warn('[discord] bot not ready — dropping channel post to', channelId);
            return;
        }
        const channel = await botClient.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') {
            console.warn('[discord] channel not found or not sendable:', channelId);
            return;
        }
        await channel.send(typeof payload === 'string' ? { content: payload } : payload);
    } catch (err) {
        console.error('[discord] postToChannel failed:', err.message);
    }
}

const startDiscordBot = (CommunityAircraftModel, s3Client, bucketName, region, models = {}) => {
    const { DailyPilotStats, VirtualAirlineAd, Giveaway, VaTermsAcceptance,
            GallerySubmission,
            provisionVaPortalAccount, provisionVaPortalRepAccount,
            deactivateVaPortalRepAccount, purgeVaData } = models;

    // A review card carries its submission id in the footer, because the footer
    // is the only thing that survives the days a card can sit in the channel.
    const submissionIdFrom = (footerText) =>
        (String(footerText || '').match(/Sub: ([a-f0-9]{24})/) || [])[1] || null;

    // Close the row the submitter reads. Never allowed to break a review: a
    // decision that reached Discord has happened whether or not we recorded it.
    const closeSubmission = async (footerText, fields) => {
        if (!GallerySubmission) return;
        const id = submissionIdFrom(footerText);
        if (!id) return;
        try {
            await GallerySubmission.updateOne(
                { _id: id, status: 'pending' },
                { $set: { reviewedAt: new Date(), ...fields } },
            );
        } catch (err) {
            console.error('Submission status update failed:', err.message);
        }
    };

    // NOTE: `Options.cacheEverything()` is the *opposite* of what we want — it
    // caches everything with no caps and silently ignores the limits passed to
    // it. `cacheWithLimits` is the API that actually honours these numbers and
    // keeps memory bounded.
    const client = new Client({
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 50,
            UserManager: 100,
            GuildMemberManager: 100,
            ThreadManager: 10,
            PresenceManager: 0,
            VoiceStateManager: 0,
            GuildEmojiManager: 0,
            GuildStickerManager: 0,
            ReactionManager: 0,
            ReactionUserManager: 0,
            StageInstanceManager: 0,
            GuildInviteManager: 0,
            GuildScheduledEventManager: 0,
            AutoModerationRuleManager: 0,
            BaseGuildEmojiManager: 0
        }),
        sweepers: {
            ...Options.DefaultSweeperSettings,
            messages: { interval: 300, lifetime: 900 },
            users: {
                interval: 3600,
                filter: () => user => user.id !== client.user.id
            },
            threads: { interval: 3600, lifetime: 3600 }
        },
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent
        ]
    });
    botClientRef = client; // expose to the diagnostics terminal (getBotStats)

    // Discord client error surface — without these, transport errors bubble up
    // as unhandled rejections and (without the process-level guards in server.js)
    // would take down the whole API.
    client.on('error', (err) => console.error('🤖 Discord client error:', err && err.message ? err.message : err));
    client.on('shardError', (err) => console.error('🤖 Discord shard error:', err && err.message ? err.message : err));
    client.on('warn', (msg) => console.warn('🤖 Discord warn:', msg));
    client.on('invalidated', () => console.error('🤖 Discord session invalidated — login required.'));

    // --- HELPER: LOG MODERATION ACTION ---
    const logModAction = async (actionType, executor, target, reason, details = '') => {
        try {
            const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
            if (!transcriptChannel) return;

            const colorMap = {
                'KICK': 0xFFA500, // Orange
                'BAN': 0xFF0000, // Red
                'UNBAN': 0x00FF00, // Green
                'TIMEOUT': 0xFFFF00, // Yellow
                'UNTIMEOUT': 0x00FF99, // Teal
                'WARN': 0xFFD700, // Gold
                'PURGE': 0x808080, // Grey
                'LOCK': 0xFF0000, // Red
                'UNLOCK': 0x00FF00, // Green
                'ANNOUNCE': 0x0099FF // Blue
            };

            const logEmbed = new EmbedBuilder()
                .setTitle(`🛡️ Admin Action: ${actionType}`)
                .setColor(colorMap[actionType] || 0xFFFFFF)
                .addFields(
                    { name: 'Executor', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                    { name: 'Target', value: target ? `${target.tag || target.user?.tag || target} (<@${target.id || target}>)` : 'N/A', inline: true },
                    { name: 'Reason', value: reason || 'No reason provided', inline: false }
                )
                .setTimestamp();

            if (details) logEmbed.addFields({ name: 'Additional Details', value: details });

            await transcriptChannel.send({ embeds: [logEmbed] });
        } catch (error) {
            console.error('❌ Failed to log mod action:', error);
        }
    };

    // --- HELPER: PERSIST A GIVEAWAY (upsert the live state to the database) ---
    // Called on create, on every entry, and when a giveaway ends so the DB
    // always reflects the in-memory state and can rebuild it after a restart.
    const persistGiveaway = async (messageId) => {
        if (!Giveaway) return;
        const g = activeGiveaways.get(messageId);
        if (!g) return;
        try {
            await Giveaway.updateOne(
                { messageId },
                {
                    messageId,
                    channelId: g.channelId,
                    prize: g.prize,
                    delivery: g.delivery,
                    hostId: g.hostId,
                    entrants: Array.from(g.entrants),
                    endsAt: new Date(g.endsAt),
                    ended: g.ended
                },
                { upsert: true }
            );
        } catch (e) {
            console.error('❌ Failed to persist giveaway:', e);
        }
    };

    // --- HELPER: SCHEDULE A GIVEAWAY'S END ---
    // setTimeout overflows for delays beyond ~24.8 days (its max is a signed
    // 32-bit int of milliseconds), silently firing immediately instead. Clamp
    // long delays and re-arm in chunks; fire now if the end time has passed.
    const MAX_TIMEOUT_MS = 2147483647;
    const scheduleGiveawayEnd = (messageId, endsAt) => {
        const delay = endsAt - Date.now();
        if (delay <= 0) {
            endGiveaway(messageId);
            return;
        }
        if (delay > MAX_TIMEOUT_MS) {
            setTimeout(() => scheduleGiveawayEnd(messageId, endsAt), MAX_TIMEOUT_MS);
            return;
        }
        setTimeout(() => endGiveaway(messageId), delay);
    };

    // --- HELPER: END A GIVEAWAY (pick a winner, announce, hand off to staff) ---
    const endGiveaway = async (messageId) => {
        const g = activeGiveaways.get(messageId);
        if (!g || g.ended) return;
        g.ended = true;

        try {
            const channel = await client.channels.fetch(g.channelId).catch(() => null);
            const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;

            const entrants = Array.from(g.entrants);
            const winnerId = entrants.length ? entrants[Math.floor(Math.random() * entrants.length)] : null;

            const endedEmbed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Ended')
                .setColor(THEME.WHITE)
                .setFooter({ text: BRAND_FOOTER })
                .addFields(
                    { name: 'Prize', value: g.prize, inline: false },
                    { name: 'Entries', value: `${entrants.length}`, inline: true },
                    { name: 'Winner', value: winnerId ? `<@${winnerId}>` : 'No valid entries 😢', inline: true }
                )
                .setTimestamp();

            // Lock the original message (remove the Enter button).
            if (message) await message.edit({ embeds: [endedEmbed], components: [] }).catch(() => {});

            if (!winnerId) {
                if (channel) await channel.send('🎉 The giveaway ended but nobody entered — no winner this time!').catch(() => {});
                return;
            }

            const winnerTag = `<@${winnerId}>`;

            // Public announcement in the giveaway channel.
            if (channel) {
                await channel.send({ content: `🎉 Congratulations ${winnerTag}! You won **${g.prize}**!`, embeds: [endedEmbed] }).catch(() => {});
            }

            // Hand the winner off to staff so the prize can be fulfilled.
            if (g.delivery === 'ticket') {
                try {
                    const ticketParent = await client.channels.fetch(GIVEAWAY_TICKET_CHANNEL_ID).catch(() => null);
                    if (ticketParent && ticketParent.threads) {
                        const thread = await ticketParent.threads.create({
                            name: `giveaway-winner-${winnerId}`,
                            type: ChannelType.PrivateThread,
                            reason: 'Giveaway winner prize fulfillment'
                        });
                        await thread.members.add(winnerId).catch(() => {});
                        const tEmbed = new EmbedBuilder()
                            .setTitle('🎁 Giveaway Winner — Prize Fulfillment')
                            .setColor(THEME.WHITE)
                            .setDescription('Please deliver the prize to the winner and close this ticket when done.')
                            .addFields(
                                { name: 'Winner', value: winnerTag, inline: true },
                                { name: 'Prize', value: g.prize, inline: true },
                                { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true }
                            )
                            .setTimestamp();
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
                        );
                        await thread.send({ content: `<@&${ADMIN_ROLE_ID}> ${winnerTag}`, embeds: [tEmbed], components: [row] });
                    }
                } catch (e) { console.error('❌ Failed to open giveaway winner ticket:', e); }
            } else {
                try {
                    const modChannel = await client.channels.fetch(GIVEAWAY_MOD_CHANNEL_ID).catch(() => null);
                    if (modChannel) {
                        const mEmbed = new EmbedBuilder()
                            .setTitle('🎁 Giveaway Winner — Action Needed')
                            .setColor(THEME.WHITE)
                            .setDescription('Please deliver the prize to the winner below.')
                            .addFields(
                                { name: 'Winner', value: winnerTag, inline: true },
                                { name: 'Prize', value: g.prize, inline: true },
                                { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true },
                                { name: 'Total Entries', value: `${entrants.length}`, inline: true }
                            )
                            .setTimestamp();
                        await modChannel.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [mEmbed] });
                    }
                } catch (e) { console.error('❌ Failed to send giveaway winner mod message:', e); }
            }
        } catch (e) {
            console.error('❌ endGiveaway error:', e);
        } finally {
            // Mark it ended in the DB so a restart won't resurrect it, then
            // drop the in-memory copy.
            if (Giveaway) {
                await Giveaway.updateOne({ messageId }, { ended: true }).catch(() => {});
            }
            activeGiveaways.delete(messageId);
        }
    };

    // ===================== VA (VIRTUAL AIRLINE) SYSTEM =====================

    // Turn a VA name into a valid Discord channel slug.
    const vaChannelSlug = (name) => {
        const slug = (name || 'va').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
        return slug || 'virtual-airline';
    };

    // Render a VA's stored callsign the way its pilots actually fly it, e.g.
    // "OCEAN ##VA" — the "##" standing in for their individual pilot number.
    //
    // The tag is READ OFF the stored mask rather than assumed to be "VA". A VA
    // may register "SHAMROCK ###EX" or no tag at all ("BAW ###"); the old
    // version stripped a literal "VA" and glued one back on, so those VAs were
    // told their pilots fly "SHAMROCK ###EX ##VA" — a callsign nobody flies and
    // nothing matches. Mirrors vaCallsignParts / formatCallsignDisplay on the
    // server so the bot, the portals and the feed all describe one callsign.
    const vaCallsignParts = (raw) => {
        const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
        if (!s) return null;
        const first = s.indexOf('#');
        if (first !== -1) {
            const base = s.slice(0, first).trim();
            return base ? { base, tag: s.slice(s.lastIndexOf('#') + 1).trim() } : null;
        }
        const m = s.match(/^(.*?)\s+VA$/);
        if (m && m[1].trim()) return { base: m[1].trim(), tag: 'VA' };
        return { base: s, tag: 'VA' };   // legacy bare base
    };
    const formatVaCallsign = (raw) => {
        const p = vaCallsignParts(raw);
        if (!p || !p.base) return null;
        return p.tag ? `${p.base} ##${p.tag}` : `${p.base} ###`;
    };

    // The card pinned inside a VA's private channel (and shown on approval).
    const buildVaInfoEmbed = (ad) => {
        const embed = new EmbedBuilder()
            .setTitle(`✈️ ${ad.name}`)
            .setColor(THEME.WHITE)
            .setFooter({ text: BRAND_FOOTER })
            .setTimestamp();
        if (ad.tagline) embed.setDescription(ad.tagline);

        const fields = [{ name: 'Type', value: ad.type || 'VA', inline: true }];
        if (ad.callsign) fields.push({ name: 'Callsign', value: formatVaCallsign(ad.callsign), inline: true });
        if (ad.region) fields.push({ name: 'Region', value: ad.region, inline: true });
        if (ad.hubs && ad.hubs.length) fields.push({ name: 'Hubs', value: ad.hubs.join(', '), inline: true });
        fields.push({ name: 'Recruiting', value: ad.recruiting ? 'Yes ✅' : 'No', inline: true });

        const links = [];
        if (ad.websiteUrl) links.push(`[Website](${ad.websiteUrl})`);
        if (ad.applicationUrl) links.push(`[Apply](${ad.applicationUrl})`);
        if (ad.discordUrl) links.push(`[Discord](${ad.discordUrl})`);
        if (ad.ifcThreadUrl) links.push(`[IFC Thread](${ad.ifcThreadUrl})`);
        if (links.length) fields.push({ name: 'Links', value: links.join(' • '), inline: false });

        embed.addFields(fields);
        if (ad.logoUrl) { try { embed.setThumbnail(ad.logoUrl); } catch (_) {} }
        if (ad.bannerUrl) { try { embed.setImage(ad.bannerUrl); } catch (_) {} }
        return embed;
    };

    // The celebratory embed posted to the public partnership channel when an
    // approved VA is fully kitted out (banner + logo). Leads with the banner.
    const buildVaPartnershipEmbed = (ad) => {
        const embed = new EmbedBuilder()
            .setTitle(`🤝 New VA Partner — ${ad.name}`)
            .setColor(THEME.WHITE)
            .setFooter({ text: BRAND_FOOTER })
            .setTimestamp();

        const intro = [];
        if (ad.tagline) intro.push(`*${ad.tagline}*`);
        intro.push(`We're proud to welcome **${ad.name}** to our network of partnered Virtual Airlines! 🛫`);
        embed.setDescription(intro.join('\n\n'));

        const fields = [{ name: 'Type', value: ad.type || 'VA', inline: true }];
        if (ad.callsign) fields.push({ name: 'Callsign', value: formatVaCallsign(ad.callsign), inline: true });
        if (ad.region) fields.push({ name: 'Region', value: ad.region, inline: true });
        if (ad.hubs && ad.hubs.length) fields.push({ name: 'Hubs', value: ad.hubs.join(', '), inline: true });
        fields.push({ name: 'Recruiting', value: ad.recruiting ? 'Yes ✅' : 'No', inline: true });

        const links = [];
        if (ad.websiteUrl) links.push(`[Website](${ad.websiteUrl})`);
        if (ad.applicationUrl) links.push(`[Apply](${ad.applicationUrl})`);
        if (ad.discordUrl) links.push(`[Discord](${ad.discordUrl})`);
        if (ad.ifcThreadUrl) links.push(`[IFC Thread](${ad.ifcThreadUrl})`);
        if (links.length) fields.push({ name: 'Links', value: links.join(' • '), inline: false });

        embed.addFields(fields);
        if (ad.logoUrl) { try { embed.setThumbnail(ad.logoUrl); } catch (_) {} }
        if (ad.bannerUrl) { try { embed.setImage(ad.bannerUrl); } catch (_) {} }
        return embed;
    };

    // Post the one-time partnership announcement for a VA. No-ops unless the VA
    // is approved AND has both a banner and a logo. The announcement is claimed
    // atomically via `partnershipAnnouncedAt` so the approval path and the
    // image-upload path (or a re-approval) can never double-post.
    const announceVaPartnership = async (ad) => {
        try {
            if (!ad || ad.status !== 'approved') return false;
            if (!ad.bannerUrl || !ad.logoUrl) return false;

            let claimed = ad;
            if (VirtualAirlineAd) {
                // Only the writer that flips partnershipAnnouncedAt from null wins.
                claimed = await VirtualAirlineAd.findOneAndUpdate(
                    { _id: ad._id, partnershipAnnouncedAt: null },
                    { partnershipAnnouncedAt: new Date() },
                    { new: true }
                ).catch(() => null);
                if (!claimed) return false; // already announced, or lost the race
            } else if (ad.partnershipAnnouncedAt) {
                return false;
            } else {
                ad.partnershipAnnouncedAt = new Date();
                claimed = ad;
            }
            ad.partnershipAnnouncedAt = claimed.partnershipAnnouncedAt;

            try {
                const channel = await client.channels.fetch(PARTNERSHIP_ANNOUNCE_CHANNEL_ID);
                await channel.send({
                    content: claimed.ownerId
                        ? `🎉 Please welcome our newest VA partner — <@${claimed.ownerId}>'s **${claimed.name}**!`
                        : `🎉 Please welcome our newest VA partner — **${claimed.name}**!`,
                    embeds: [buildVaPartnershipEmbed(claimed)]
                });
                return true;
            } catch (sendErr) {
                console.error('❌ VA partnership announce send error:', sendErr);
                // Revert the claim so a later trigger can retry the announcement.
                if (VirtualAirlineAd) {
                    await VirtualAirlineAd.findByIdAndUpdate(ad._id, { partnershipAnnouncedAt: null }).catch(() => {});
                }
                ad.partnershipAnnouncedAt = null;
                return false;
            }
        } catch (e) {
            console.error('❌ announceVaPartnership error:', e);
            return false;
        }
    };

    // The embed staff see in the review channel for a pending application.
    const buildVaReviewEmbed = (ad) => new EmbedBuilder()
        .setTitle('🆕 VA Application — Pending Review')
        .setColor(THEME.GRAY)
        .addFields(
            { name: 'Name', value: ad.name, inline: true },
            { name: 'Type', value: ad.type || 'VA', inline: true },
            { name: 'Callsign', value: formatVaCallsign(ad.callsign) || '—', inline: true },
            { name: 'Owner', value: ad.ownerId ? `<@${ad.ownerId}>` : (ad.ownerName || 'Unknown'), inline: true },
            { name: 'Tagline', value: ad.tagline || '—', inline: false },
            { name: 'Links', value: [ad.websiteUrl, ad.discordUrl].filter(Boolean).join('\n') || '—', inline: false }
        )
        .setFooter({ text: `Application ID: ${ad._id}` })
        .setTimestamp();

    const buildVaReviewButtons = (id) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`va_approve_${id}`).setLabel('Approve & Create').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`va_edit_${id}`).setLabel('Request Edits').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`va_reject_${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    // The short /va_apply form only captures the basics. Once a VA is approved and
    // its private channel exists, we post this card so the owner can fill in
    // everything the directory card wants — banner, logo, description, hubs, etc.
    // Buttons carry the ad id so the handlers know which VA they're editing.
    const buildVaSetupCard = (ad) => {
        const missing = [];
        if (!ad.bannerUrl) missing.push('banner');
        if (!ad.logoUrl) missing.push('logo');
        if (!ad.description) missing.push('description');
        if (!ad.region || ad.region === 'Global') missing.push('region');
        if (!ad.hubs || !ad.hubs.length) missing.push('hubs');
        if (!ad.fleet || !ad.fleet.length) missing.push('fleet');

        const embed = new EmbedBuilder()
            .setTitle('🧩 Finish setting up your VA listing')
            .setColor(THEME.WHITE)
            .setDescription(
                "Your VA is approved and live, but the application only captured the basics. " +
                "Tap the buttons below to plug in the rest so your directory card looks complete.\n\n" +
                "• **Add Details** — description, region, hubs, fleet, requirements\n" +
                "• **Links & Recruiting** — apply link, IFC thread, min grade, pilot count, tags\n" +
                "• **Upload Banner / Logo** — send the image as your next message here" +
                (missing.length
                    ? `\n\n**Still missing:** ${missing.join(', ')}`
                    : "\n\n✅ Everything's filled in — thanks!")
            )
            .setFooter({ text: BRAND_FOOTER });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`va_setup_details_${ad._id}`).setLabel('Add Details').setStyle(ButtonStyle.Primary).setEmoji('📝'),
            new ButtonBuilder().setCustomId(`va_setup_links_${ad._id}`).setLabel('Links & Recruiting').setStyle(ButtonStyle.Secondary).setEmoji('🔗'),
            new ButtonBuilder().setCustomId(`va_setup_banner_${ad._id}`).setLabel('Upload Banner').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
            new ButtonBuilder().setCustomId(`va_setup_logo_${ad._id}`).setLabel('Upload Logo').setStyle(ButtonStyle.Secondary).setEmoji('🏷️')
        );
        return { embeds: [embed], components: [row] };
    };

    // ---- VA PARTNERSHIP TICKET FLOW ------------------------------------------
    // The /va_apply modal, factored out so both the slash command and the
    // partnership ticket's "Start VA Application" button can present it.
    const buildVaApplyModal = () => {
        const modal = new ModalBuilder().setCustomId('va_apply_modal').setTitle('VA / VO Application');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_name').setLabel('VA / VO Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_callsign').setLabel('Callsign mask, tag included').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setPlaceholder('e.g. OCEAN ##VA — or SHAMROCK ###EX')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_type').setLabel('Type — VA or VO').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2).setPlaceholder('VA')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_tagline').setLabel('Short description / tagline').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(140)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_links').setLabel('Website / Discord invite (both optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300).setPlaceholder('https://yourva.com\ndiscord.gg/… (optional — one per line)'))
        );
        return modal;
    };

    // Version this so a future ToS revision can re-prompt previous accepters.
    // Mirrors the shared Terms version so the ticket, the portal and the PDF
    // never disagree. Bumping TOS_VERSION in vaTos.js re-prompts prior accepters.
    const VA_PARTNERSHIP_TOS_VERSION = VA_TOS_VERSION;

    // The official VA Advertisement Program Terms & Conditions, shipped as a PDF
    // in the repo and attached to the partnership ticket so VAs get the real
    // contract (not a paraphrase). Path resolves next to this file.
    const VA_TERMS_PDF_PATH = path.join(__dirname, 'VA-Advertisement-Terms.pdf');

    // The partnership Terms of Service shown inside the ticket. The full contract
    // is attached as a PDF; the embed summarises the key obligations and points
    // users at it + the Inflight VA Rep for questions.
    const buildPartnershipTosCard = () => {
        const embed = new EmbedBuilder()
            .setTitle('📄 Inflight VA Advertisement Program — Terms & Conditions')
            .setColor(THEME.WHITE)
            .setDescription(
                "Please read our **Terms & Conditions** (attached as a PDF above) before continuing. " +
                "By accepting, your VA agrees to the full contract. Key points:\n\n" +
                "• **Free program** — a directory advertising your VA across our platform, subject to staff approval.\n" +
                "• **Official tracking provider** — by joining, you accept Inflight as your VA's **official flight-tracking provider**. This does **not** require every pilot to use Inflight, but events you post or run are tracked with Inflight and credit Inflight as the tracker.\n" +
                "• **Event tracking** — any event you announce or run **must be tracked using Inflight**, with a screenshot from our tracker.\n" +
                "• **Accurate content** — listing info, logos and banners must be accurate, owned by you, and not offensive or infringing.\n" +
                "• **Staff authority** — Inflight may review, edit, approve, decline, feature or remove any listing at our discretion.\n" +
                "• **Enforcement** — breaches are handled through a warning ladder (**verbal → first → second → final**) and may end in **contract termination**. Warnings are delivered here and recorded in your VA Portal.\n" +
                "• **iOS app** — VA listings are **not** shown in our iOS app for copyright-compliance reasons.\n" +
                "• **Changes/suspension** — required changes not made within **7 days** of contact may lead to suspension.\n\n" +
                "If you have **any questions**, please inquire our Inflight VA Rep <@&" + INFLIGHT_VA_REP_ROLE_ID + "> or our moderators <@&" + ADMIN_ROLE_ID + "> right here in this ticket.\n\n" +
                "When you've read the attached Terms and agree, tap **I Accept** below."
            )
            .setFooter({ text: `${BRAND_FOOTER} • Terms ${VA_PARTNERSHIP_TOS_VERSION}` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('partnership_accept_tos').setLabel('I Accept').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
        );

        const payload = { embeds: [embed], components: [row] };
        // Attach the real contract if the PDF is present (best-effort).
        try {
            if (fs.existsSync(VA_TERMS_PDF_PATH)) {
                payload.files = [new AttachmentBuilder(VA_TERMS_PDF_PATH, { name: 'Inflight-VA-Advertisement-Terms.pdf' })];
            }
        } catch (_) { /* ship the embed without the attachment */ }
        return payload;
    };

    // Pull staff (Inflight VA Rep + mods) into a (private) ticket thread so the
    // role mentions actually reach people who can see the channel. Best-effort,
    // deduped across roles, and capped so we never iterate a huge member list.
    const addStaffToThread = async (thread, guild, roleIds) => {
        try {
            // role.members is populated from the guild member cache; fetch members
            // first so it isn't empty on a cold cache.
            await guild.members.fetch().catch(() => {});
            const seen = new Set();
            let added = 0;
            for (const roleId of roleIds) {
                if (added >= 25) break;
                const role = guild.roles.cache.get(roleId)
                    || await guild.roles.fetch(roleId).catch(() => null);
                if (!role) continue;
                for (const member of role.members.values()) {
                    if (added >= 25) break;
                    if (seen.has(member.id)) continue; // a mod could also be a rep
                    seen.add(member.id);
                    await thread.members.add(member.id).catch(() => {});
                    added++;
                }
            }
        } catch (e) {
            console.error('❌ addStaffToThread error:', e);
        }
    };

    // Create and seed a VA partnership ticket: private thread, rep pinged + added,
    // then the ToS card.
    const openPartnershipTicket = async (interaction) => {
        const thread = await interaction.channel.threads.create({
            name: `partnership-${interaction.user.username}`.slice(0, 90),
            type: ChannelType.PrivateThread,
            reason: 'VA Partnership ticket'
        });
        await thread.members.add(interaction.user.id).catch(() => {});
        await addStaffToThread(thread, interaction.guild, [INFLIGHT_VA_REP_ROLE_ID, ADMIN_ROLE_ID]);

        await thread.send({
            content: `<@${interaction.user.id}> <@&${INFLIGHT_VA_REP_ROLE_ID}> <@&${ADMIN_ROLE_ID}>`,
            embeds: [new EmbedBuilder()
                .setTitle('🤝 VA Partnership Request')
                .setColor(THEME.WHITE)
                .setDescription(
                    `Welcome <@${interaction.user.id}>! Our Inflight VA Rep and moderators have been pinged and will help you set up a partnership.\n\n` +
                    `Partnering with Inflight gets your VA a private channel, a directory listing, and access to our reps chat.`
                )
                .setFooter({ text: BRAND_FOOTER })]
        });
        await thread.send(buildPartnershipTosCard());
        return thread;
    };

    // Who may review VA applications (Approve & Create / Request Edits / Reject):
    // admins, anyone with the Administrator permission, or the Inflight VA Rep.
    const canReviewVa = (member) =>
        !!member?.roles?.cache?.has(ADMIN_ROLE_ID) ||
        !!member?.roles?.cache?.has(INFLIGHT_VA_REP_ROLE_ID) ||
        !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);

    // Only the VA's owner (or staff) may edit its listing.
    const canManageVa = (interaction, ad) =>
        (ad.ownerId && interaction.user.id === ad.ownerId) ||
        !!interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID) ||
        !!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

    // Download a Discord image attachment and push it to S3 as the VA's banner or
    // logo. Runs from a message collector started by the Upload buttons below.
    const handleVaImageUpload = async (channel, user, ad, kind) => {
        const prompt = await channel.send(`📥 <@${user.id}> — send your **${kind}** image as your next message in this channel (PNG/JPG, within 2 minutes).`);
        const collector = channel.createMessageCollector({
            filter: (m) => m.author.id === user.id && m.attachments.size > 0,
            max: 1,
            time: 120000
        });

        collector.on('collect', async (msg) => {
            const att = msg.attachments.first();
            const isImage = (att.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.name || '');
            if (!isImage) {
                await channel.send(`❌ That didn't look like an image. Tap **Upload ${kind === 'banner' ? 'Banner' : 'Logo'}** again to retry.`).catch(() => {});
                return;
            }
            try {
                const resp = await axios.get(att.url, { responseType: 'arraybuffer' });
                const ref = ad.callsign || ad.name;
                const url = await uploadVaImage(s3Client, { buffer: Buffer.from(resp.data) }, ref, kind);

                // Swap out the old image so we don't orphan it in the bucket.
                // Re-read the live doc so we delete the CURRENT image (not a stale
                // one captured when the button was clicked) and write only this
                // single field — a stale full-document save could otherwise
                // resurrect a just-replaced image URL and leak the new one.
                const field = kind === 'banner' ? 'bannerUrl' : 'logoUrl';
                const fresh = VirtualAirlineAd ? await VirtualAirlineAd.findById(ad._id).catch(() => null) : null;
                const oldUrl = fresh ? fresh[field] : (kind === 'banner' ? ad.bannerUrl : ad.logoUrl);
                if (oldUrl && oldUrl !== url) await deleteVaImage(s3Client, oldUrl).catch(() => {});

                const updated = VirtualAirlineAd
                    ? await VirtualAirlineAd.findByIdAndUpdate(ad._id, { [field]: url, updatedAt: new Date() }, { new: true }).catch(() => null)
                    : null;
                // Keep the in-memory ad in sync for the confirmation embed.
                if (updated) { ad.bannerUrl = updated.bannerUrl; ad.logoUrl = updated.logoUrl; }
                else { ad[field] = url; await ad.save().catch(() => {}); }

                await channel.send({ content: `✅ ${kind === 'banner' ? 'Banner' : 'Logo'} updated!`, embeds: [buildVaInfoEmbed(updated || ad)] }).catch(() => {});

                // This upload may have completed the banner + logo pair — if the
                // VA is approved and now fully kitted, announce the partnership.
                // announceVaPartnership no-ops if either image is still missing or
                // it was already announced.
                await announceVaPartnership(updated || ad).catch(() => {});
            } catch (e) {
                console.error(`❌ VA ${kind} upload error:`, e);
                await channel.send(`❌ Couldn't process that image. Please try again.`).catch(() => {});
            }
        });

        collector.on('end', (collected) => {
            if (collected.size === 0) channel.send(`⌛ <@${user.id}> — ${kind} upload timed out. Tap the button again when you're ready.`).catch(() => {});
            prompt.delete().catch(() => {});
        });
    };

    // Find-or-create the shared "VA Rep" role and make sure it can see the reps
    // general chat. Called on every provision so the wiring self-heals.
    const ensureVaRepRole = async (guild) => {
        try {
            let role = guild.roles.cache.find(r => r.name === VA_REP_ROLE_NAME)
                || (await guild.roles.fetch().then(rs => rs.find(r => r.name === VA_REP_ROLE_NAME)).catch(() => null));
            if (!role) {
                role = await guild.roles.create({ name: VA_REP_ROLE_NAME, color: 0x3BA55D, mentionable: true, reason: 'Shared VA representative role' });
            }
            const repsChat = await guild.channels.fetch(VA_REPS_CHAT_ID).catch(() => null);
            if (repsChat && !repsChat.permissionOverwrites.cache.get(role.id)) {
                await repsChat.permissionOverwrites.edit(role.id, {
                    ViewChannel: true, SendMessages: true, ReadMessageHistory: true
                }).catch(() => {});
            }
            return role;
        } catch (e) {
            console.error('❌ ensureVaRepRole error:', e);
            return null;
        }
    };

    // Provision (idempotently) a VA's role + private channel, grant the owner the
    // VA role and the shared rep role, and persist the IDs back onto the ad.
    const provisionVaSpace = async (guild, ad) => {
        const result = { role: null, channel: null, repRole: null };

        // 1. VA-specific role (reuse if already linked).
        let vaRole = ad.discordRoleId
            ? (guild.roles.cache.get(ad.discordRoleId) || await guild.roles.fetch(ad.discordRoleId).catch(() => null))
            : null;
        if (!vaRole) {
            vaRole = await guild.roles.create({
                name: ad.name.slice(0, 90),
                color: Math.floor(Math.random() * 0xFFFFFF),
                mentionable: true,
                reason: `VA space for ${ad.name}`
            });
            ad.discordRoleId = vaRole.id;
        }
        result.role = vaRole;

        // 2. Shared rep role + reps chat access.
        result.repRole = await ensureVaRepRole(guild);

        // 3. Private VA channel under the category (reuse if already linked).
        let channel = ad.discordChannelId
            ? (guild.channels.cache.get(ad.discordChannelId) || await guild.channels.fetch(ad.discordChannelId).catch(() => null))
            : null;
        if (!channel) {
            channel = await guild.channels.create({
                name: vaChannelSlug(ad.name),
                type: ChannelType.GuildText,
                parent: VA_CATEGORY_ID,
                topic: `${ad.type || 'VA'} • ${formatVaCallsign(ad.callsign) || ad.name} — private VA channel`,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: vaRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    // Inflight VA Rep gets eyes on every VA channel.
                    { id: INFLIGHT_VA_REP_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    { id: ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] }
                ],
                reason: `VA space for ${ad.name}`
            });
            ad.discordChannelId = channel.id;
            try {
                const info = await channel.send({ content: `Welcome to **${ad.name}**! 🛫`, embeds: [buildVaInfoEmbed(ad)] });
                await info.pin().catch(() => {});
                // Right after provisioning, ask the owner for everything the short
                // application form didn't capture (banner, logo, full details).
                await channel.send({
                    content: ad.ownerId ? `<@${ad.ownerId}>` : undefined,
                    ...buildVaSetupCard(ad)
                });
            } catch (_) { /* pin/send best-effort */ }
        }
        result.channel = channel;

        // 3b. Self-heal: make sure the Inflight VA Rep can see this channel even
        // if it was provisioned before this role existed.
        if (channel && !channel.permissionOverwrites.cache.get(INFLIGHT_VA_REP_ROLE_ID)) {
            await channel.permissionOverwrites.edit(INFLIGHT_VA_REP_ROLE_ID, {
                ViewChannel: true, SendMessages: true, ReadMessageHistory: true
            }).catch(() => {});
        }

        // 4. Give the owner the VA role + the shared rep role.
        if (ad.ownerId) {
            const owner = await guild.members.fetch(ad.ownerId).catch(() => null);
            if (owner) {
                await owner.roles.add(vaRole).catch(() => {});
                if (result.repRole) await owner.roles.add(result.repRole).catch(() => {});
            }
        }

        // 5. Persist the linkage.
        if (ad.save) { try { await ad.save(); } catch (e) { console.error('❌ Failed to save VA ad linkage:', e.message); } }

        return result;
    };

    const uploadImageToS3 = async (url, tailNumber) => {
        let tempOutputPath = null;
        let fileStream = null;
        
        try {
            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
            // We only need an output path. Input is processed in-memory via streams.
            tempOutputPath = path.join(os.tmpdir(), `processed_${uniqueId}.webp`);

            // 1. Fetch the stream
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            // 2. Create the Sharp pipeline
            // We pipe the Axios stream directly into Sharp, then to the file system.
            // This prevents loading the full image into RAM and avoids writing a raw temp file.
            const transformer = sharp()
                .resize({ width: 1920, withoutEnlargement: true })
                .webp({ quality: 80 });

            await pipeline(
                response.data,
                transformer,
                fs.createWriteStream(tempOutputPath)
            );

            // 3. Prepare upload
            const stats = await fsPromises.stat(tempOutputPath);
            const cleanTail = (tailNumber || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`;
            
            // Create the stream for S3
            fileStream = fs.createReadStream(tempOutputPath);

            const uploadCommand = new PutObjectCommand({
                Bucket: bucketName,
                Key: fileName,
                Body: fileStream,
                ContentType: 'image/webp',
                ContentLength: stats.size 
            });

            await s3Client.send(uploadCommand);

            // MEMORY FIX: Explicitly trigger GC after heavy image processing if enabled.
            // This cleans up the large Buffer objects immediately rather than waiting for the 10m timer.
            if (global.gc) {
                global.gc();
            }

            return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;

        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new Error('Failed to upload image to storage.');
        } finally {
            // cleanup: Destroy stream explicitly to release file handle
            if (fileStream) fileStream.destroy();
            
            // Delete the processed file
            if (tempOutputPath) {
                await fsPromises.unlink(tempOutputPath).catch(() => {});
            }
        }
    };

    // Delete a single stored image from S3 (used when a slot is replaced).
    const deleteImageFromS3 = async (url) => {
        if (!url) return;
        try {
            const key = new URL(url).pathname.substring(1); // strip leading '/'
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
            console.log(`🗑️ Deleted replaced S3 image: ${key}`);
        } catch (err) {
            console.error('S3 delete error:', err.message);
        }
    };

    // True when the URL already points at a processed object in OUR community
    // bucket. Both DM and web submissions carry a Discord-hosted attachment into
    // review (so it always renders), which approval moves to S3. This guard is
    // defensive: if an image that's already in our bucket is ever (re-)approved,
    // reuse the URL as-is instead of re-fetching + re-running a full sharp
    // pipeline — saving a native image allocation and avoiding a duplicate object.
    const isOwnCommunityS3Url = (url) => {
        if (!url) return false;
        try {
            const u = new URL(url);
            return u.hostname === `${bucketName}.s3.${region}.amazonaws.com`
                && u.pathname.startsWith('/community-aircraft/');
        } catch (_) { return false; }
    };

    // Normalize a record's images into an ordered array (handles legacy single-image docs).
    const getEntryImages = (entry) => {
        if (!entry) return [];
        if (Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0) return entry.imageUrls.filter(Boolean);
        return entry.imageUrl ? [entry.imageUrl] : [];
    };

    // Per-image contributors aligned to getEntryImages(). Slots without their own
    // attribution (legacy records) fall back to the entry's top-level contributor.
    const getEntryContributors = (entry) => {
        const imgs = getEntryImages(entry);
        const stored = (entry && Array.isArray(entry.imageContributors)) ? entry.imageContributors : [];
        return imgs.map((_, i) => {
            const c = stored[i];
            // The account fields ride along with the credit: a reorder or an
            // insert moves other people's slots around, and rebuilding them
            // without pilotId would quietly unlink their photos.
            if (c && (c.name || c.id)) {
                return {
                    name: c.name || 'System',
                    id: c.id || null,
                    pilotId: c.pilotId || null,
                    ifUsername: c.ifUsername || null,
                };
            }
            return {
                name: (entry && entry.contributorName) || 'System',
                id: (entry && entry.contributorId) || null,
                pilotId: (entry && entry.contributorPilotId) || null,
                ifUsername: (entry && entry.contributorIfUsername) || null,
            };
        });
    };

    const MAX_AIRCRAFT_IMAGES = 3;

    /**
     * Where an approved photo lands, decided against the LIVE image count rather
     * than the count that was on record when the review card was rendered.
     *
     * Actions an approve button can carry:
     *   • 'replace' — overwrite that slot (the old photo is deleted from S3)
     *   • 'add'     — append after the last photo
     *   • 'insert'  — take that slot and push the photos at/after it DOWN one
     *                 place, so nothing is deleted. This is how a better shot
     *                 becomes Photo 1 while the current Photo 1 survives as
     *                 Photo 2 (and Photo 2 as Photo 3).
     *   • null      — a legacy button with no encoded intent; infer from state.
     *
     * Returns { slotIndex, mode } where mode is 'replace' | 'append' | 'insert'
     * | 'full'. 'full' means the insert can no longer happen without pushing a
     * photo out of the record entirely — the caller must abort rather than
     * quietly trash the last one.
     */
    const resolveAircraftSlot = (action, chosenSlot, imageCount) => {
        const count = Math.max(0, Math.min(imageCount || 0, MAX_AIRCRAFT_IMAGES));
        const wanted = Math.min(Math.max((parseInt(chosenSlot, 10) || 1) - 1, 0), count);

        if (action === 'insert' || action === 'insertend') {
            // Inserting past the last photo is just an append, and that stays
            // legal on a full record only as a replace of the final slot — which
            // 'insert' never is. Anything that would displace a photo off the
            // end of a full record is refused.
            if (wanted >= count) return { slotIndex: count, mode: count >= MAX_AIRCRAFT_IMAGES ? 'full' : 'append' };
            if (count >= MAX_AIRCRAFT_IMAGES) return { slotIndex: wanted, mode: 'full' };
            // 'insertend' sends the displaced photo to the LAST slot rather than
            // one place down — "make this the primary and push the old primary
            // to the back". With no photo after the displaced one there is no
            // difference between the two, so it collapses to a plain insert.
            const sendsToEnd = action === 'insertend' && wanted < count - 1;
            return { slotIndex: wanted, mode: sendsToEnd ? 'insertEnd' : 'insert' };
        }

        if (action === 'add') {
            if (count < MAX_AIRCRAFT_IMAGES) return { slotIndex: count, mode: 'append' };
            return { slotIndex: MAX_AIRCRAFT_IMAGES - 1, mode: 'replace' };
        }

        if (action === 'replace') {
            // Replace the targeted slot if it still exists; if that photo is gone
            // (images shrank since render), append instead.
            const slotIndex = (parseInt(chosenSlot, 10) || 1) - 1;
            if (slotIndex >= 0 && slotIndex < count) return { slotIndex, mode: 'replace' };
            const fallback = Math.min(count, MAX_AIRCRAFT_IMAGES - 1);
            return { slotIndex: fallback, mode: fallback < count ? 'replace' : 'append' };
        }

        return { slotIndex: wanted, mode: wanted < count ? 'replace' : 'append' };
    };

    // Apply a resolved placement to a record's image/contributor arrays (both
    // mutated in step). Returns the URL that was overwritten and therefore needs
    // deleting from S3, or null when nothing was displaced — an insert shifts the
    // existing photos down a slot instead of trashing one.
    const applyAircraftPlacement = (images, contributors, placement, url, contributor) => {
        const { mode, slotIndex } = placement;
        if (mode === 'replace' && slotIndex < images.length) {
            const replaced = images[slotIndex];
            images[slotIndex] = url;
            contributors[slotIndex] = contributor;
            return replaced;
        }
        if (mode === 'insert' && slotIndex < images.length) {
            images.splice(slotIndex, 0, url);
            contributors.splice(slotIndex, 0, contributor);
            return null;
        }
        if (mode === 'insertEnd' && slotIndex < images.length) {
            // The photo being displaced goes to the back instead of one place
            // down; everything between it and the end moves up to close the gap.
            const [displaced] = images.splice(slotIndex, 1);
            const [displacedBy] = contributors.splice(slotIndex, 1);
            images.splice(slotIndex, 0, url);
            contributors.splice(slotIndex, 0, contributor);
            images.push(displaced);
            contributors.push(displacedBy);
            return null;
        }
        images.push(url);
        contributors.push(contributor);
        return null;
    };

    // Reorder a record that is already saved: pull the photo at `from` out and
    // drop it back in at `to`, carrying its contributor credit with it. The
    // after-the-fact counterpart to an insert — no upload, no deletion. Returns
    // false for a no-op or out-of-range move so the caller re-renders against
    // live state instead of writing.
    const moveAircraftPhoto = (images, contributors, from, to) => {
        const last = images.length - 1;
        if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
        if (from < 0 || from > last || to < 0 || to > last || from === to) return false;
        const [url] = images.splice(from, 1);
        const [credit] = contributors.splice(from, 1);
        images.splice(to, 0, url);
        contributors.splice(to, 0, credit);
        return true;
    };

    /**
     * The submitter token exactly as a pending review card carries it.
     *
     * Two shapes, both written into the footer as `User: <token>`:
     *   • a Discord snowflake — a DM submission, or a site submission from an
     *     account with a linked Discord identity
     *   • the literal 'web' — a site submission with no Discord identity, in
     *     which case the display name to credit rides in the footer's `Collab:`
     *
     * PARSED AS A TOKEN, NOT AS DIGITS. It used to be read with /User: (\d+)/,
     * which cannot see 'web' — and the two callers handled that miss
     * differently, both badly. The rebuild loop skipped web cards entirely, so
     * their buttons never refreshed. The admin-edit handler fell back to
     * `interaction.user.id`, baking the MODERATOR's Discord id into the rebuilt
     * approve buttons; approval then read that id back, resolved it to a guild
     * member, and credited the photo to whoever had edited the card instead of
     * to the person who submitted it. Every site submission an admin touched
     * before approving came out under a staff name.
     */
    const submitterTokenFrom = (footerText) =>
        (String(footerText || '').match(/User: ([^\s|]+)/)?.[1] || '');

    /**
     * The same token, recovered from the approve buttons already on a card.
     *
     * The footer is the primary source and normally survives an edit; this is
     * the second place the token exists, for a card whose footer was lost. It
     * matters because the alternative fallback — the moderator — is the bug
     * above, and there is no third guess worth making.
     */
    const submitterTokenFromComponents = (message) => {
        for (const row of (message?.components || [])) {
            for (const c of (row?.components || [])) {
                const id = String(c?.customId || '');
                if (!id.startsWith('approve_') || id.startsWith('approve_apt_')) continue;
                // approve_<action>_<slot>_<token>, or the older approve_<slot>_<token>
                // / approve_<token>. The token is always last.
                const token = id.split('_').pop();
                if (token) return token;
            }
        }
        return '';
    };

    // Build the admin review UI for an aircraft submission: mutates `mainEmbed`
    // (title/colour/description) and returns the slot-choice buttons plus a
    // comparison embed per existing photo. The admin chooses which of the (up to
    // 3) slots the submission lands in — Replace overwrites, Add appends.
    const buildAircraftReview = (mainEmbed, existingEntry, userId) => {
        const existingImages = getEntryImages(existingEntry);
        const extraEmbeds = [];
        const approveButtons = [];
        const insertButtons = [];

        if (existingImages.length === 0) {
            // No photo yet: this is an "add" so the approval handler appends
            // against the live DB state rather than assuming a fixed slot.
            approveButtons.push(
                new ButtonBuilder().setCustomId(`approve_add_1_${userId}`).setLabel('Approve & Verify').setStyle(ButtonStyle.Success).setEmoji('✅')
            );
            mainEmbed.setTitle('📋 New Submission — Awaiting Review').setColor(SUB_STATE.PENDING.color)
                .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nNo photo on record yet for this aircraft.`);
        } else {
            const slotsToShow = Math.min(existingImages.length + 1, MAX_AIRCRAFT_IMAGES);
            for (let slot = 1; slot <= slotsToShow; slot++) {
                const isReplace = slot <= existingImages.length;
                // Encode the intent (add/replace/insert) in the customId so the
                // approval handler re-checks the live image state instead of
                // trusting the slot number captured when these buttons were
                // first rendered.
                const action = isReplace ? 'replace' : 'add';
                approveButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`approve_${action}_${slot}_${userId}`)
                        .setLabel(`${isReplace ? 'Replace' : 'Add'} Photo ${slot}`)
                        .setStyle(isReplace ? ButtonStyle.Primary : ButtonStyle.Success)
                        .setEmoji(isReplace ? '♻️' : '➕')
                );
            }

            // Non-destructive alternative to Replace: the new photo takes the
            // slot and the photo sitting there slides down one (Photo 1 → 2,
            // 2 → 3). Only offered while there is a free slot to slide into —
            // on a full record every insert would push a photo out.
            const hasRoom = existingImages.length < MAX_AIRCRAFT_IMAGES;
            if (hasRoom) {
                const endSlot = existingImages.length + 1;
                for (let slot = 1; slot <= existingImages.length; slot++) {
                    insertButtons.push(
                        new ButtonBuilder()
                            .setCustomId(`approve_insert_${slot}_${userId}`)
                            .setLabel(`Insert as Photo ${slot} (${slot} → ${slot + 1})`)
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('⬇️')
                    );
                    // Where the displaced photo lands is the admin's call too:
                    // one place down (above), or all the way to the back. Only
                    // offered when those differ — with nothing after the
                    // displaced photo, "down one" already IS the back.
                    if (slot < existingImages.length) {
                        insertButtons.push(
                            new ButtonBuilder()
                                .setCustomId(`approve_insertend_${slot}_${userId}`)
                                .setLabel(`Insert as Photo ${slot} (${slot} → ${endSlot})`)
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji('⏬')
                        );
                    }
                }
            }

            const insertHint = hasRoom
                ? `\n**Insert** puts it in that slot and keeps the photo that was there — the button says where that one lands (e.g. \`1 → 2\` moves it down one, \`1 → ${existingImages.length + 1}\` sends it to the back). Nothing is deleted.`
                : `\nAll ${MAX_AIRCRAFT_IMAGES} slots are full, so there is no free slot to push a photo down into — **Replace** deletes the photo it overwrites.`;
            mainEmbed.setTitle('♻️ Replacement / Additional Photo — Awaiting Review').setColor(SUB_STATE.PENDING.color)
                .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nThis aircraft already has **${existingImages.length}/${MAX_AIRCRAFT_IMAGES}** photo(s).\nChoose a slot below — **Replace** overwrites (and deletes) that photo, **Add** appends a new one.${insertHint}`);

            const existingContributors = getEntryContributors(existingEntry);
            existingImages.forEach((imgUrl, idx) => {
                const slotContributor = existingContributors[idx]?.name || 'Unknown';
                const compEmbed = new EmbedBuilder()
                    .setTitle(`🖼️ Current Photo ${idx + 1}`)
                    .setColor(THEME.GRAY)
                    .setImage(imgUrl)
                    .setFooter({ text: hasRoom
                        ? `Replacing Photo ${idx + 1} deletes this image — inserting keeps it, moved to the slot the button names.`
                        : `Replacing Photo ${idx + 1} deletes this image.` });
                // Show who contributed each existing photo so admins know a replace
                // only overwrites that one slot's contributor, not the others.
                const lines = [`**Photo ${idx + 1} Contributor:** ${slotContributor}`];
                if (idx === 0) lines.push(`**Tail:** ${existingEntry.tailNumber || 'Unknown'}`);
                compEmbed.setDescription(lines.join('\n'));
                extraEmbeds.push(compEmbed);
            });
        }

        const components = [
            new ActionRowBuilder().addComponents(...approveButtons),
            // Own row: a row holds 5 buttons, and the insert choices must not be
            // squeezed out by the replace/add ones on a 2-photo record.
            ...(insertButtons.length ? [new ActionRowBuilder().addComponents(...insertButtons)] : []),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`edit_admin_${userId}`).setLabel('Edit Details').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
                new ButtonBuilder().setCustomId(`reject_${userId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
            )
        ];

        return { components, extraEmbeds };
    };

    // After an aircraft photo is approved, OTHER still-pending review cards in the
    // admin channel for the SAME aircraft were rendered against the old image count
    // (e.g. two users submit the same plane → both cards say "no photo yet"). Once
    // one is approved the others are stale: they still show the empty-state "Approve
    // & Verify" button instead of the live "Replace Photo 1 / Add Photo 2" choices.
    // Re-render those siblings against the freshly-updated entry so the admin sees
    // the real slot count and picks Add/Replace deliberately.
    const refreshPendingReviewsFor = async (typeField, liveryField, updatedEntry, skipMessageId) => {
        try {
            const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
            if (!adminChannel) return;
            const recent = await adminChannel.messages.fetch({ limit: 50 }).catch(() => null);
            if (!recent) return;
            for (const [, msg] of recent) {
                if (msg.id === skipMessageId) continue;
                if (!client.user || msg.author.id !== client.user.id) continue;
                if (!msg.components || msg.components.length === 0) continue;
                const embed = msg.embeds[0];
                if (!embed || !Array.isArray(embed.fields)) continue;
                // Only refresh cards that still carry approve buttons (i.e. unresolved
                // pending reviews — verified/rejected cards have their buttons stripped).
                const stillPending = msg.components.some(row =>
                    row.components.some(c => (c.customId || '').startsWith('approve_') && !(c.customId || '').startsWith('approve_apt_')));
                if (!stillPending) continue;
                const t = embed.fields.find(f => f.name === 'Aircraft Type')?.value;
                const l = embed.fields.find(f => f.name === 'Livery')?.value;
                if (!t || !l) continue;
                if (t.toLowerCase() !== typeField.toLowerCase() || l.toLowerCase() !== liveryField.toLowerCase()) continue;

                // Web cards carry `User: web`, which the old digits-only parse
                // could not see — so they were skipped here and never had their
                // buttons refreshed when a duplicate appeared.
                const submitterId = submitterTokenFrom(embed.footer?.text)
                    || submitterTokenFromComponents(msg);
                if (!submitterId) continue;
                const refreshed = EmbedBuilder.from(embed);
                const review = buildAircraftReview(refreshed, updatedEntry, submitterId);
                // buildAircraftReview rewrites title/description but not the footer; keep
                // the pending footer (User/Msg/Ch ids) so later handlers can recover them.
                if (embed.footer?.text) refreshed.setFooter({ text: embed.footer.text });
                await msg.edit({ embeds: [refreshed, ...review.extraEmbeds], components: review.components }).catch(() => {});
            }
        } catch (e) {
            console.error('refreshPendingReviewsFor failed:', e);
        }
    };

    /**
     * Re-render a pending review card around new type / livery / tail values.
     *
     * Shared by the admin's own Edit Details and by a submitter correcting
     * their own pending submission, because both have to do the same three
     * things: rewrite the fields, re-run the duplicate check (an edit that now
     * matches an existing record needs the comparison embeds and the real slot
     * buttons — and an edit away from one needs them gone), and keep the
     * pending footer that later handlers read ids out of.
     *
     * The submitter token comes from the footer, then from the buttons already
     * on the card, then 'web' — which credits the footer's `Collab:` name.
     * NEVER from whoever clicked: that was the old fallback, and because
     * `User: web` did not match a digits-only parse it fired on every site
     * submission an admin edited. The moderator's id went into the approve
     * buttons, approval read it back as the contributor, and the photo went
     * live credited to staff instead of to the person who sent it in.
     *
     * `correctedBy` adds a line to the card naming who changed it, so an admin
     * can see the details moved under them. It never changes who gets credit,
     * and it never approves anything — the card still has to be actioned.
     */
    const rebuildReviewCard = async (adminMsg, { tail, type, livery, correctedBy = null }) => {
        const oldEmbed = adminMsg?.embeds?.[0];
        if (!oldEmbed) return false;

        const newEmbed = EmbedBuilder.from(oldEmbed);
        const fields = newEmbed.data.fields || [];
        const setField = (name, value) => {
            const f = fields.find(x => x.name === name);
            if (f) f.value = value;
        };
        setField('Tail Number', String(tail || 'UNKNOWN').toUpperCase());
        setField('Aircraft Type', type);
        setField('Livery', livery);
        if (correctedBy) {
            const note = {
                name: '✏️ Corrected by submitter',
                value: `<@${correctedBy.id}> updated the details before review — edit or reject if it still looks wrong.`,
                inline: false
            };
            const at = fields.findIndex(f => f.name === note.name);
            if (at >= 0) fields[at] = note; else fields.push(note);
        }

        // Recomputed on every rebuild rather than passed in, so the flag tracks
        // the name actually on the card: it appears when an edit moves the card
        // to an aircraft the list doesn't carry, and clears itself when an admin
        // edits it back onto a listed one.
        const unlistedAt = fields.findIndex(f => f.name === UNLISTED_FIELD);
        if (await isListedAircraft(type)) {
            if (unlistedAt >= 0) fields.splice(unlistedAt, 1);
        } else {
            const flag = {
                name: UNLISTED_FIELD,
                value: 'Not in the aircraft list — check the name before approving.',
                inline: false
            };
            if (unlistedAt >= 0) fields[unlistedAt] = flag; else fields.push(flag);
        }
        newEmbed.setFields(fields);

        const submitterId = submitterTokenFrom(oldEmbed.footer?.text)
            || submitterTokenFromComponents(adminMsg)
            || 'web';

        let embeds = [newEmbed];
        let components;
        try {
            const existingEntry = await CommunityAircraftModel.findOne({
                aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") },
                liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, "i") }
            });
            const review = buildAircraftReview(newEmbed, existingEntry, submitterId);
            components = review.components;
            embeds = [newEmbed, ...review.extraEmbeds];
            // buildAircraftReview rewrites title/description but not the footer.
            if (oldEmbed.footer?.text) newEmbed.setFooter({ text: oldEmbed.footer.text });
        } catch (e) {
            console.error('Review card duplicate re-check failed:', e);
        }

        const payload = { embeds };
        if (components) payload.components = components;
        await adminMsg.edit(payload);
        return true;
    };

    // The pending review card for a given public feed message, found by the
    // `Msg: <id>` its footer carries. Only cards that still have approve buttons
    // count — a card that has been actioned is not a pending submission any more.
    const findPendingReviewCard = async (publicMsgId) => {
        try {
            const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
            if (!adminChannel) return null;
            const recent = await adminChannel.messages.fetch({ limit: 50 }).catch(() => null);
            if (!recent) return null;
            for (const [, msg] of recent) {
                if (!client.user || msg.author.id !== client.user.id) continue;
                const footer = msg.embeds?.[0]?.footer?.text || '';
                if (footer.match(/Msg: (\d+)/)?.[1] !== String(publicMsgId)) continue;
                const stillPending = (msg.components || []).some(row =>
                    row.components.some(c => (c.customId || '').startsWith('approve_') && !(c.customId || '').startsWith('approve_apt_')));
                return stillPending ? msg : null;
            }
        } catch (e) {
            console.error('findPendingReviewCard failed:', e);
        }
        return null;
    };

    /**
     * The staff photo manager behind /photos: a record's slots as they stand,
     * plus the controls to reorder or remove one.
     *
     * Reordering here is the after-the-fact counterpart to the review card's
     * Insert. Before this existed, the order a record ended up in at approval
     * time was the order it kept — the only way to promote a photo to primary
     * was to replace Photo 1, which deleted whatever was there.
     *
     * Removal is offered only while more than one photo is on record: dropping
     * the last one would leave an entry with no image at all, which the site's
     * gallery and every /pull would render as a hole. Clearing a record out
     * entirely stays a staff-panel job.
     */
    const buildPhotoManager = (entry) => {
        const images = getEntryImages(entry);
        const contributors = getEntryContributors(entry);
        const id = String(entry._id);

        const header = themedEmbed(THEME.WHITE)
            .setTitle('🛠️ Photo Manager')
            .setDescription(
                `**${entry.aircraftType}** — ${entry.liveryName}\n` +
                `**${images.length}/${MAX_AIRCRAFT_IMAGES}** photo(s) on record. Photo 1 is the primary image shown everywhere.\n` +
                (images.length > 1
                    ? 'Reordering moves a photo and its credit to another slot — nothing is deleted.'
                    : 'Only one photo on record: nothing to reorder, and the last photo cannot be removed here.')
            );

        const gallery = images.map((url, i) => new EmbedBuilder()
            .setTitle(i === 0 ? '⭐ Photo 1 (primary)' : `📷 Photo ${i + 1}`)
            .setColor(THEME.GRAY)
            .setDescription(`Contributor: ${contributors[i]?.name || 'Unknown'}`)
            .setImage(url));

        const components = [];
        if (images.length > 1) {
            const moves = [];
            for (let from = 1; from <= images.length; from++) {
                for (let to = 1; to <= images.length; to++) {
                    if (from === to) continue;
                    moves.push(new StringSelectMenuOptionBuilder()
                        .setLabel(`Move Photo ${from} → Photo ${to}`)
                        .setDescription(to === 1 ? 'Becomes the primary image' : `Photo ${from} takes slot ${to}`)
                        .setValue(`${from}:${to}`));
                }
            }
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`photos_move_${id}`)
                    .setPlaceholder('Reorder a photo…')
                    .addOptions(moves.slice(0, 25))
            ));
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`photos_del_${id}`)
                    .setPlaceholder('Remove a photo…')
                    .addOptions(images.map((_, i) => new StringSelectMenuOptionBuilder()
                        .setLabel(`Remove Photo ${i + 1}`)
                        .setDescription(`By ${(contributors[i]?.name || 'Unknown').slice(0, 80)} — asks to confirm`)
                        .setValue(String(i + 1))))
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`photos_refresh_${id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        ));

        return { content: '', embeds: [header, ...gallery], components };
    };

    // Write a reordered/trimmed image set back to a record. The legacy mirrors
    // (imageUrl and the top-level contributor) track slot 0, so a reorder that
    // changes the primary has to carry them with it or the site keeps showing
    // the old primary and credits the wrong person.
    const saveAircraftImages = async (entry, images, contributors) => {
        entry.imageUrls = images;
        entry.imageContributors = contributors;
        entry.imageUrl = images[0] || null;
        entry.contributorName = contributors[0]?.name || entry.contributorName || 'System';
        entry.contributorId = contributors[0]?.id || null;
        entry.contributorPilotId = contributors[0]?.pilotId || null;
        entry.contributorIfUsername = contributors[0]?.ifUsername || null;
        await entry.save();
    };

    // Reordering and removal are silent from the outside — the record just looks
    // different — so every one of them leaves a line in the admin channel saying
    // who did what to which aircraft.
    const logPhotoAction = async (interaction, entry, text) => {
        try {
            const channel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
            if (!channel) return;
            await channel.send({
                embeds: [themedEmbed(THEME.GRAY)
                    .setTitle('🛠️ Photo Manager')
                    .setDescription(`**${entry.aircraftType}** — ${entry.liveryName}\n${text}\nBy <@${interaction.user.id}>`)
                    .setTimestamp()]
            });
        } catch (_) { /* logging must never break the action itself */ }
    };

    // Staff gate shared by /photos and its components (mirrors the /va_remove guard).
    const isPhotoStaff = (interaction) =>
        Boolean(interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID)) ||
        Boolean(interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator));

    // ---------------------------------------------------------------------
    // AIRCRAFT PICKER
    //
    // Submitting used to mean typing the aircraft and livery into a modal and
    // hoping the normalizer recognised them. "737 max 8", "delta", a typo, a
    // livery that was retired two updates ago — each one reaches an admin
    // wrong, and someone has to fix it by hand before it can be approved.
    //
    // The picker offers the real lists instead: the aircraft the game actually
    // has, then the liveries that aircraft actually wears. Two taps, already
    // matched. Discord caps a select at 25 options and both lists are longer
    // than that, so each step pages and carries a Search button to narrow by
    // text; free-text entry stays as a fallback for anything the API list
    // doesn't carry (and for the odd custom livery).
    //
    // One ephemeral message per use. The state — and what to do once a livery
    // is chosen — lives here, keyed by a short id carried in the component
    // custom ids, because a custom id has 100 characters and a search string
    // plus three message ids does not fit in them.
    // ---------------------------------------------------------------------
    const PICKER_TTL_MS = 10 * 60 * 1000;
    const PICKER_PAGE_SIZE = 25;
    // Every picker control falls back to this once its session is gone (expired,
    // or the bot restarted under it). Re-opening costs two taps; guessing at
    // what a stale picker meant costs an admin a correction.
    const PICKER_EXPIRED = { content: '⏳ This picker expired — open it again and it will only take a moment.', embeds: [], components: [] };
    const pickerSessions = new Map(); // pickerId -> { step, type, query, page, apply, … }

    const sweepPickerSessions = () => {
        const now = Date.now();
        for (const [key, s] of pickerSessions) {
            if (now > s.expiresAt) pickerSessions.delete(key);
        }
    };

    // A live session, or null if it has expired or never existed (the bot
    // restarted, or the user came back to an old picker). Callers tell the user
    // to start again rather than guessing at what they meant.
    const getPickerSession = (id) => {
        const s = pickerSessions.get(id);
        if (!s) return null;
        if (Date.now() > s.expiresAt) { pickerSessions.delete(id); return null; }
        return s;
    };

    // Picker control ids: `pick_<action>_<sessionId>`, with `pick_page_` alone
    // carrying a trailing `_<page>`. Session ids are base36 (no underscores), so
    // the page is whatever follows the last one.
    const parsePickerCustomId = (customId) => {
        const id = String(customId || '');
        if (!id.startsWith('pick_')) return null;
        const action = id.split('_')[1] || '';
        const rest = id.slice(`pick_${action}_`.length);
        if (!action || !rest) return null;
        if (action !== 'page') return { action, sessionId: rest, page: null };
        const cut = rest.lastIndexOf('_');
        if (cut <= 0) return null;
        const page = parseInt(rest.slice(cut + 1), 10);
        return { action, sessionId: rest.slice(0, cut), page: Number.isInteger(page) ? page : 0 };
    };

    const filterByQuery = (names, query) => {
        const q = (query || '').trim().toLowerCase();
        if (!q) return names;
        return names.filter(n => String(n).toLowerCase().includes(q));
    };

    // Is this an aircraft the metadata knows about? Anything else is a new or
    // unlisted type — a brand-new release, or something the API hasn't caught
    // up with — which is allowed, but says so on the card so an admin checks
    // the name rather than assuming the normalizer got it right.
    const isListedAircraft = async (type) => {
        const list = await fetchAircraftMetadata();
        return list.some(a => String(a.name).toLowerCase() === String(type || '').trim().toLowerCase());
    };

    const UNLISTED_FIELD = '🆕 Not in the aircraft list';

    // The picker's manual entry can end in a disagreement: the submitter typed
    // something the normalizer then rewrote into a listed aircraft. That is
    // usually right (a typo, a nickname) and sometimes badly wrong — a new
    // aircraft fuzzy-matched onto last year's model. Rather than pick for them,
    // show both and let them choose.
    const renderPickerConfirm = (session) => ({
        content: [
            session.intro,
            '**Is this the same aircraft?**',
            `You typed: **${session.raw.type}** — **${session.raw.livery}**`,
            `Closest match: **${session.match.type}** — **${session.match.livery}**`,
            'If you are submitting an aircraft or livery that isn\'t in the list yet, keep your own wording — an admin will confirm the name.'
        ].filter(Boolean).join('\n'),
        embeds: [],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pick_usematch_${session.id}`).setEmoji('✅').setLabel(`Use ${session.match.type}`.slice(0, 78)).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pick_usemine_${session.id}`).setEmoji('🆕').setLabel(`Keep ${session.raw.type}`.slice(0, 78)).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`pick_manual_${session.id}`).setEmoji('✍️').setLabel('Edit again').setStyle(ButtonStyle.Secondary)
        )]
    });

    // The choices for the step the picker is on, already narrowed by the search.
    const pickerChoices = async (session) => {
        const list = await fetchAircraftMetadata();
        if (session.step === 'type') {
            // The metadata cache is sorted longest-name-first (the normalizer
            // needs that so "737-800" doesn't match inside "737-8 MAX"); a human
            // reading a dropdown needs it alphabetical.
            return filterByQuery(list.map(a => a.name).sort((a, b) => a.localeCompare(b)), session.query);
        }
        const matched = list.find(a => a.name === session.type);
        const liveries = matched ? await fetchLiveriesForAircraft(matched.id) : [];
        return filterByQuery(liveries, session.query);
    };

    const renderPicker = async (session) => {
        const all = await pickerChoices(session);
        const pages = Math.max(1, Math.ceil(all.length / PICKER_PAGE_SIZE));
        session.page = Math.min(Math.max(session.page, 0), pages - 1);
        const page = session.page;
        const slice = all.slice(page * PICKER_PAGE_SIZE, (page + 1) * PICKER_PAGE_SIZE);
        const id = session.id;
        const isType = session.step === 'type';

        const lines = [];
        if (session.intro) lines.push(session.intro);
        lines.push(isType
            ? '**Step 1 of 2 — pick the aircraft**'
            : `**Step 2 of 2 — pick the livery** for **${session.type}**`);
        lines.push(all.length === 0
            ? `Nothing matches **${session.query}**. Search for something else, or enter it by hand.`
            : `${all.length} option${all.length === 1 ? '' : 's'}${session.query ? ` matching **${session.query}**` : ''} • page ${page + 1} of ${pages}`);

        const rows = [];
        if (slice.length) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`pick_${isType ? 'type' : 'livery'}_${id}`)
                    .setPlaceholder(isType ? 'Choose an aircraft…' : 'Choose a livery…')
                    .addOptions(slice.map(name => new StringSelectMenuOptionBuilder()
                        .setLabel(String(name).slice(0, 100))
                        .setValue(String(name).slice(0, 100))))
            ));
        }

        const nav = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pick_page_${id}_${page - 1}`).setEmoji('◀️').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
            new ButtonBuilder().setCustomId(`pick_page_${id}_${page + 1}`).setEmoji('▶️').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
            new ButtonBuilder().setCustomId(`pick_search_${id}`).setEmoji('🔎').setLabel(session.query ? `Search: ${session.query}`.slice(0, 78) : 'Search').setStyle(ButtonStyle.Primary)
        );
        // Step 2 only: going back re-opens the aircraft list without losing the
        // photo or the flow it was opened from.
        if (!isType) nav.addComponents(new ButtonBuilder().setCustomId(`pick_back_${id}`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary));
        nav.addComponents(new ButtonBuilder().setCustomId(`pick_manual_${id}`).setEmoji('✍️').setLabel('Not listed? Type it').setStyle(ButtonStyle.Secondary));
        rows.push(nav);

        return { content: lines.join('\n'), embeds: [], components: rows };
    };

    /**
     * Open a picker as an ephemeral reply to `interaction`.
     *
     * `apply(pickInteraction, type, livery)` runs once a livery is chosen (or
     * typed by hand) and OWNS the response to that interaction — it is what
     * turns a choice into a preview, a corrected card, or whatever the caller
     * needs. Everything else about the picker is the same wherever it is used.
     */
    const openAircraftPicker = async (interaction, { userId, type = null, intro = '', apply }) => {
        sweepPickerSessions();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const session = {
            id, userId, apply, intro,
            step: 'type', type, query: '', page: 0,
            expiresAt: Date.now() + PICKER_TTL_MS
        };
        pickerSessions.set(id, session);
        const payload = await renderPicker(session);
        return interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
    };

    /**
     * `opts.keepWording` sends the type and livery through exactly as given,
     * skipping the normalizer. It is set when the values came from the picker —
     * either straight off the API lists (nothing to normalize) or kept
     * deliberately by a submitter who was shown the normalizer's suggestion and
     * turned it down, which is how an aircraft the list doesn't carry yet
     * reaches review under its real name instead of the nearest old one.
     *
     * Whether the result is an unlisted aircraft is then derived from the
     * metadata, not taken on trust from the caller.
     */
    const startSubmissionFlow = async (source, rawType, rawLivery, ignoredTail, photoUrl, user, originChannelId, opts = {}) => {

        let currentType = rawType;
        let currentLivery = rawLivery;
        let currentTail = 'UNKNOWN';
        let unlistedNaming = false;

        // Helper for initial checking (used for User Preview only)
        const checkDuplicate = async (t, l) => {
            try {
                const existing = await CommunityAircraftModel.findOne({ 
                    aircraftType: { $regex: new RegExp(`^${escapeRegex(t)}$`, "i") },
                    liveryName: { $regex: new RegExp(`^${escapeRegex(l)}$`, "i") }
                });
                return !!existing;
            } catch (err) { return false; }
        };

        if (opts.keepWording) {
            currentType = String(currentType || '').trim();
            currentLivery = String(currentLivery || '').trim();
        } else {
            try {
                const normalized = await normalizeData(currentType, currentLivery);
                currentType = normalized.type;
                currentLivery = normalized.livery;
            } catch (e) { console.error("Normalization error:", e); }
        }
        // Derived from the metadata, never from the caller: whether the name is
        // in the list is a fact about the name, and deriving it here means no
        // entry point can forget to flag one.
        unlistedNaming = !(await isListedAircraft(currentType));

        const autoReg = lookupRegistration(currentType, currentLivery);
        if (autoReg) currentTail = autoReg;
        else currentTail = 'UNKNOWN';

        // Initial check for the User's Preview Embed
        let isDuplicate = await checkDuplicate(currentType, currentLivery);

        const createPreviewEmbed = (t, tp, l, imgUrl, isDup) => {
            const embed = themedEmbed(THEME.WHITE)
                .addFields(
                    { name: 'Aircraft Type', value: tp, inline: true },
                    { name: 'Livery', value: l, inline: true },
                    { name: 'Tail Number', value: t.toUpperCase(), inline: true },
                )
                // Reference the attached preview.webp file so the image lives
                // *inside* the embed. Without this, edits via editReply (which
                // drops re-attached files) leave a fields-only embed with no
                // visible preview.
                .setImage('attachment://preview.webp')
                .setFooter({ text: `${BRAND_FOOTER} • Confirm to submit` });

            if (isDup) {
                embed.setTitle('♻️ Existing Entry Detected')
                    .setColor(THEME.GRAY)
                    .setDescription(`We already have a photo for **${tp}** in **${l}** livery.\nThis will generally be treated as a **replacement or additional photo**.`);
            } else {
                embed.setTitle('📝 Review Your Submission')
                    .setDescription('I auto-detected the registration and tidied the names.\nConfirm the details below — or edit them first.');
            }
            // Kept as typed because the aircraft isn't in the list: say so here,
            // so nobody is surprised when the admin card flags it.
            if (unlistedNaming) {
                embed.addFields({
                    name: UNLISTED_FIELD,
                    value: 'Going in exactly as you typed it. An admin will confirm the name.',
                    inline: false
                });
            }
            return embed;
        };

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('confirm_submission').setLabel('Confirm & Submit').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit Type/Livery').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('discard_submission').setLabel('Discard').setStyle(ButtonStyle.Danger),
            );

        const payload = { 
            embeds: [createPreviewEmbed(currentTail, currentType, currentLivery, photoUrl, isDuplicate)], 
            components: [row],
            files: [{ attachment: photoUrl, name: 'preview.webp' }] 
        };

        let reply;
        try {
            if (source.deferred || source.replied) reply = await source.editReply(payload);
            else reply = await source.reply({ ...payload, fetchReply: true });
        } catch (err) { return; }

        const finalPhotoUrl = reply.attachments.first() ? reply.attachments.first().url : photoUrl;
        // Long enough to outlast a picker session: choosing an aircraft and a
        // livery happens on a separate ephemeral message, which doesn't touch
        // this collector, and a preview whose Confirm button had gone dead by
        // the time the user came back was a submission silently lost.
        const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: PICKER_TTL_MS + 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== user.id) return i.reply({ content: "This is not your submission.", ephemeral: true });

            if (i.customId === 'discard_submission') {
                await i.update({ content: '🗑️ Submission discarded.', embeds: [], components: [], files: [] }); 
                userSessions.delete(user.id); 
                setTimeout(() => { if (reply) reply.delete().catch(() => {}); }, 5000);
                collector.stop();
                return;
            }

            if (i.customId === 'edit_details') {
                // The picker opens as its own ephemeral message, so the preview
                // card stays on screen next to it while the user chooses.
                await openAircraftPicker(i, {
                    userId: user.id,
                    type: currentType,
                    intro: '✏️ **Change the details.**',
                    apply: async (pick, pickedType, pickedLivery, pickOpts = {}) => {
                        await pick.deferUpdate();
                        if (pickOpts.keepWording) {
                            currentType = String(pickedType || '').trim();
                            currentLivery = String(pickedLivery || '').trim();
                        } else {
                            const normalized = await normalizeData(pickedType, pickedLivery);
                            currentType = normalized.type;
                            currentLivery = normalized.livery;
                        }
                        unlistedNaming = !(await isListedAircraft(currentType));
                        currentTail = lookupRegistration(currentType, currentLivery) || 'UNKNOWN';
                        isDuplicate = await checkDuplicate(currentType, currentLivery);

                        // The preview belongs to `source`, not to the picker, so
                        // it is edited through the interaction that created it —
                        // which works whether that reply was ephemeral or not.
                        await source.editReply({
                            embeds: [createPreviewEmbed(currentTail, currentType, currentLivery, finalPhotoUrl, isDuplicate)],
                            components: [row]
                        }).catch(() => {});
                        await pick.editReply({
                            content: `✅ Set to **${currentType}** — **${currentLivery}** (tail ${currentTail.toUpperCase()}).\nCheck the preview, then hit **Confirm & Submit**.`,
                            embeds: [], components: []
                        }).catch(() => {});
                    }
                });
            }

            if (i.customId === 'confirm_submission') {
                await i.deferUpdate();

                const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
                const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

                const attachmentData = { attachment: finalPhotoUrl, name: 'aircraft.webp' };

                // 1. Send to Public Feed (Pending Status)
                const publicEmbed = themedEmbed(SUB_STATE.PENDING.color)
                    .setTitle('📸 New Aircraft Spotted')
                    .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nA new photo has been submitted and is awaiting admin review.`)
                    .addFields(
                        { name: 'Aircraft', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Spotted By', value: `<@${user.id}>`, inline: false }
                    )
                    // Render the photo INSIDE the embed (not as a loose attachment)
                    // so the layout matches the verified state after approval.
                    .setImage('attachment://aircraft.webp')
                    .setTimestamp();

                // The submitter keeps a way in after sending: a mis-matched type
                // or livery used to mean waiting for an admin to notice, or a
                // rejection and a re-upload. The button clears itself the moment
                // the submission is approved or rejected.
                const publicMsg = await feedChannel.send({
                    embeds: [publicEmbed],
                    files: [attachmentData],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`submission_fix_${user.id}`).setLabel('Fix Details').setEmoji('🔧').setStyle(ButtonStyle.Secondary)
                    )]
                });

                // 2. Prepare Admin Embeds
                const finalEmbed = new EmbedBuilder()
                    .addFields(
                        { name: 'Contributor', value: `<@${user.id}>`, inline: true },
                        { name: 'Tail Number', value: currentTail.toUpperCase(), inline: true },
                        { name: 'Aircraft Type', value: currentType, inline: true },
                        { name: 'Livery', value: currentLivery, inline: true },
                    )
                    .setTimestamp();

                // An aircraft the metadata doesn't carry reaches an admin under
                // the submitter's own name — correct for a new release, wrong if
                // they meant something already in the list. Either way it is the
                // admin's call, so the card says which it is.
                if (unlistedNaming) {
                    finalEmbed.addFields({
                        name: UNLISTED_FIELD,
                        value: 'Not in the aircraft list — this is the contributor\'s own wording. Check the name (or fix it with **Edit Details**) before approving.',
                        inline: false
                    });
                }

                // --- KEY FIX: Force Fresh Duplicate Check for Admins ---
                // We do NOT rely on the previous 'isDuplicate' boolean here.
                // We perform a real-time lookup right before sending to admin.
                let existingEntry = null;
                try {
                    existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(currentType)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(currentLivery)}$`, "i") }
                    });
                } catch(e) { console.error("Error fetching duplicate for comparison", e); }

                // Build the admin slot-choice UI (buttons + per-photo comparison embeds).
                const { components: adminComponents, extraEmbeds } = buildAircraftReview(finalEmbed, existingEntry, user.id);
                const embedsToSend = [finalEmbed, ...extraEmbeds];

                finalEmbed.setFooter({ text: `Pending | User: ${user.id} | Msg: ${publicMsg.id} | Ch: ${originChannelId}` });

                await adminChannel.send({ embeds: embedsToSend, components: adminComponents, files: [attachmentData] });
                
                userSessions.set(user.id, {
                    type: currentType, 
                    livery: currentLivery,
                    tail: currentTail,
                    expiresAt: Date.now() + 300000 
                });

                await i.editReply({ 
                    content: `✅ Submission sent for review!\n\n**Have another photo of this same aircraft?**\nUpload it now and I'll automatically apply the corrected details (${currentType}, ${currentTail}).`, 
                    embeds: [], components: [], files: [] 
                });

                const messageToDelete = reply;
                setTimeout(() => {
                    if (messageToDelete) messageToDelete.delete().catch(() => {});
                }, 15000);
                
                collector.stop();
            }
        });
        
        collector.on('end', () => {
             reply = null;
        });
    };

    const updateLeaderboard = async () => {
        if (!LEADERBOARD_CHANNEL_ID) return;
        try {
            const leaderboard = await CommunityAircraftModel.aggregate([
                { 
                    $group: { 
                        _id: { $ifNull: ["$contributorId", "$contributorName"] }, 
                        count: { $sum: 1 }, 
                        displayName: { $first: "$contributorName" },
                        isId: { $max: { $cond: [{ $ifNull: ["$contributorId", false] }, true, false] } }
                    } 
                },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            if (leaderboard.length === 0) return;

            const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
            if (!channel) return;

            const description = leaderboard.map((entry, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
                const nameDisplay = (entry.isId && entry._id.match && entry._id.match(/^\d+$/)) ? `<@${entry._id}>` : entry.displayName;
                return `${medal} ${nameDisplay} — **${entry.count}** contributions`;
            }).join('\n');

            const leaderboardEmbed = themedEmbed(THEME.WHITE)
                .setTitle('🏆 Top Contributors Leaderboard')
                .setDescription(`Here are the top pilots helping build our database!\n\n${description}`)
                .setFooter({ text: `${BRAND_FOOTER} • Updated daily — submit photos to climb!` })
                .setTimestamp();

            let lastMessage = (await channel.messages.fetch({ limit: 5 })).find(m => m.author.id === client.user.id);
            if (lastMessage) await lastMessage.edit({ embeds: [leaderboardEmbed] });
            else await channel.send({ embeds: [leaderboardEmbed] });

        } catch (error) { console.error('❌ Error updating leaderboard:', error); }
    };

    const generateBountyBoard = async (page = 0, sortBy = 'type') => {
        try {
            // Fetch all aircraft flagged as needing an update
            const flagged = await CommunityAircraftModel.find({ needsUpdate: true });
            
            // Enrich with manufacturer from your local registry for sorting
            const enriched = flagged.map(doc => {
                const ac = doc.toObject ? doc.toObject() : doc;
                let manufacturer = 'Unknown';
                if (aircraftRegistry && Array.isArray(aircraftRegistry)) {
                    const match = aircraftRegistry.find(r => 
                        (ac.aircraftType || '').toLowerCase().includes((r.model || '').toLowerCase()) ||
                        (r.model || '').toLowerCase().includes((ac.aircraftType || '').toLowerCase())
                    );
                    if (match && match.manufacturer) manufacturer = match.manufacturer;
                }
                return { ...ac, manufacturer };
            });

            // Apply Sorting
            if (sortBy === 'type') {
                enriched.sort((a, b) => (a.aircraftType || '').localeCompare(b.aircraftType || ''));
            } else if (sortBy === 'livery') {
                enriched.sort((a, b) => (a.liveryName || '').localeCompare(b.liveryName || ''));
            } else if (sortBy === 'manufacturer') {
                enriched.sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || (a.aircraftType || '').localeCompare(b.aircraftType || ''));
            } else if (sortBy === 'date') {
                enriched.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
            }
            
            // Pagination Logic
            const itemsPerPage = 5; // Reduced from 10 to 5 for a much cleaner look
            const totalPages = Math.ceil(enriched.length / itemsPerPage) || 1;
            const safePage = Math.max(0, Math.min(page, totalPages - 1));
            const start = safePage * itemsPerPage;
            const pageData = enriched.slice(start, start + itemsPerPage);
            
            const embed = themedEmbed(THEME.WHITE)
                .setTitle('🎯 Aircraft Photo Update Bounties')
                .setFooter({ text: `${BRAND_FOOTER} • Page ${safePage + 1} of ${totalPages}` })
                .setTimestamp();
                
            if (pageData.length === 0) {
                embed.setDescription('🎉 All good! No aircraft currently need photo updates.');
            } else {
                // Build a clean markdown description instead of using clunky fields
                let boardDescription = `These aircraft need new or better photos! Submit a photo to update the database.\n\n**Total Needed:** ${enriched.length}\n\n`;

                pageData.forEach((ac, index) => {
                    const listNumber = start + index + 1;
                    const mfg = ac.manufacturer !== 'Unknown' ? ac.manufacturer + ' ' : '';
                    
                    boardDescription += `**${listNumber}. ${mfg}${ac.aircraftType}**\n`;
                    boardDescription += `> 🎨 **Livery:** ${ac.liveryName}\n`;
                    boardDescription += `> 🆔 **Tail:** ${ac.tailNumber || 'Unknown'}\n`;
                    boardDescription += `> 🖼️ [**Click to View Current Picture**](${ac.imageUrl || '#'})\n\n`;
                });

                embed.setDescription(boardDescription);

                // Make the image easier to see by setting the first item's image as the embed thumbnail
                if (pageData[0] && pageData[0].imageUrl) {
                    embed.setThumbnail(pageData[0].imageUrl);
                }
            }
            
            // Interaction Buttons
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bnty_prev_${safePage}_${sortBy}`).setLabel('◀️ Prev').setStyle(ButtonStyle.Primary).setDisabled(safePage === 0),
                new ButtonBuilder().setCustomId(`bnty_ref_${safePage}_${sortBy}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`bnty_next_${safePage}_${sortBy}`).setLabel('Next ▶️').setStyle(ButtonStyle.Primary).setDisabled(safePage >= totalPages - 1)
            );
            
            // Sorting Dropdown
            const row2 = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`bnty_sort_${safePage}`)
                    .setPlaceholder(`Sorted by: ${sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}`)
                    .addOptions(
                        { label: 'Sort by Manufacturer', value: 'manufacturer', emoji: '🏭' },
                        { label: 'Sort by Aircraft Type', value: 'type', emoji: '✈️' },
                        { label: 'Sort by Livery', value: 'livery', emoji: '🎨' },
                        { label: 'Sort by Date Flagged', value: 'date', emoji: '📅' }
                    )
            );
            
            // Only show dropdown/pagination if items exist
            if (enriched.length > 0) {
                return { embeds: [embed], components: [row2, row1] };
            } else {
                return { embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bnty_ref_0_${sortBy}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Success))] };
            }
        } catch (error) {
            console.error('Bounty Board Error:', error);
            throw error;
        }
    };

    client.once('ready', async () => {
        console.log(`🤖 Discord Bot Online as ${client.user.tag}`);
        await fetchAircraftMetadata();

        // Restore giveaways that were still running before this restart and
        // re-arm their end timers (otherwise the in-memory state is lost and the
        // Enter button reports "already ended").
        if (Giveaway) {
            try {
                const pending = await Giveaway.find({ ended: false }).lean();
                for (const doc of pending) {
                    const endsAt = new Date(doc.endsAt).getTime();
                    activeGiveaways.set(doc.messageId, {
                        prize: doc.prize,
                        delivery: doc.delivery,
                        hostId: doc.hostId,
                        channelId: doc.channelId,
                        messageId: doc.messageId,
                        entrants: new Set(doc.entrants || []),
                        endsAt,
                        ended: false
                    });
                    scheduleGiveawayEnd(doc.messageId, endsAt);
                }
                if (pending.length) {
                    console.log(`🎉 Restored ${pending.length} active giveaway(s) from the database.`);
                }
            } catch (e) {
                console.error('❌ Failed to restore giveaways:', e);
            }
        }
        
        console.log('🧹 Starting Memory Janitor...');
        setInterval(() => {
            const now = Date.now();
            let cleanedLiveries = 0;
            let cleanedSessions = 0;

            Object.keys(cachedLiveries).forEach(key => {
                if (now - cachedLiveries[key].timestamp > 1200000) { 
                    delete cachedLiveries[key];
                    cleanedLiveries++;
                }
            });

            userSessions.forEach((value, key) => {
                if (now > value.expiresAt) {
                    userSessions.delete(key);
                    cleanedSessions++;
                }
            });

            // vaBannerCooldown gains an entry per user who posts in the partnership
            // channel and is otherwise never cleared — a slow unbounded leak. Once
            // an entry is older than the cooldown window it can't gate anything, so
            // drop it. (Declared later in startDiscordBot's scope; this interval
            // fires long after that runs, so the reference is always resolved.)
            if (typeof vaBannerCooldown !== 'undefined') {
                vaBannerCooldown.forEach((ts, key) => {
                    if (now - ts > VA_BANNER_COOLDOWN_MS) {
                        vaBannerCooldown.delete(key);
                    }
                });
            }

            // Picker sessions hold a closure each (what to do once an aircraft
            // and livery are chosen), so an abandoned one is worth more than its
            // state. Sweeping here catches the pickers nobody re-opens.
            // (Declared later in startDiscordBot's scope, like the map above.)
            if (typeof sweepPickerSessions !== 'undefined') sweepPickerSessions();

            if (global.gc) {
                global.gc();
            }

            if (cleanedLiveries > 0 || cleanedSessions > 0) {
                console.log(`🧹 Memory Cleaned: Pruned ${cleanedLiveries} livery caches and ${cleanedSessions} stale sessions.`);
            }
        }, 600000);

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        
        const commands = [
            // User Commands
            new SlashCommandBuilder().setName('lookup').setDescription('Find an aircraft by Tail, Livery, or Type (Public)').addStringOption(o => o.setName('query').setDescription('Tail/Livery/Type').setAutocomplete(true).setRequired(true)),
            new SlashCommandBuilder().setName('stats').setDescription('View stats'),
            new SlashCommandBuilder().setName('profile').setDescription('Check contribution stats').addUserOption(o => o.setName('user').setDescription('User to check')),
            new SlashCommandBuilder().setName('pull').setDescription('Fetch a specific aircraft image from the database')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true)),
            
            new SlashCommandBuilder().setName('pull_airport').setDescription('Fetch a specific airport image by ICAO code')
                .addStringOption(o => o.setName('icao').setDescription('4-letter ICAO code').setRequired(true).setMinLength(4).setMaxLength(4)),

            new SlashCommandBuilder().setName('submit').setDescription('Submit a new aircraft photo')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Type (Start typing to search)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline').setAutocomplete(true).setRequired(true))
                .addAttachmentOption(o => o.setName('photo').setDescription('Upload photo').setRequired(true)),
            // Two ways to name a record, neither required on its own: the type +
            // livery pair the rest of the bot works in, or a tail number when
            // that is what staff have in hand.
            new SlashCommandBuilder().setName('photos').setDescription('[STAFF] Reorder or remove the photos on an aircraft record')
                .addStringOption(o => o.setName('aircraft_type').setDescription('Aircraft type (pair with livery)').setAutocomplete(true).setRequired(false))
                .addStringOption(o => o.setName('livery').setDescription('Livery/airline (pair with aircraft type)').setAutocomplete(true).setRequired(false))
                .addStringOption(o => o.setName('tail').setDescription('Or just the tail number on its own').setAutocomplete(true).setRequired(false))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

            new SlashCommandBuilder().setName('links').setDescription('Get helpful resource links (Tracker, Forum, Liveries)'),
            
            new SlashCommandBuilder()
                .setName('track')
                .setDescription('Track a live flight on the server')
                .addStringOption(o => 
                    o.setName('target')
                     .setDescription('Username or Callsign (e.g., "Delta 101")')
                     .setRequired(true)
                ),

            new SlashCommandBuilder()
                .setName('hangar')
                .setDescription('View detailed breakdown of a user\'s contributions')
                .addUserOption(o => 
                    o.setName('user')
                     .setDescription('User to inspect')
                ),
                
            // NEW: The Live Bounty Board
            new SlashCommandBuilder()
                .setName('bounty_board')
                .setDescription('View the live, sortable list of aircraft pictures needing updates'),

            // Top tracked pilots today (from the tracker view counter).
            new SlashCommandBuilder()
                .setName('most_watched')
                .setDescription('See the top 5 most-tracked pilots on Inflight today'),

            // Pull a random aircraft from the DB.
            new SlashCommandBuilder()
                .setName('random')
                .setDescription('Pull a random aircraft photo from the database'),

            // Show the latest submissions.
            new SlashCommandBuilder()
                .setName('recent')
                .setDescription('Show the 5 most recent aircraft submissions'),

            // Lists every public-facing command grouped by category.
            new SlashCommandBuilder()
                .setName('help')
                .setDescription('Show what this bot can do'),

            // System Admin Commands
            new SlashCommandBuilder().setName('migrate_legacy').setDescription('[SYSTEM] Auto-match legacy DB names to current Discord Users').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
            new SlashCommandBuilder().setName('setup_tickets').setDescription('[SYSTEM] Post the help ticket panel in the current channel').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

            new SlashCommandBuilder().setName('giveaway').setDescription('[MOD] Start a giveaway for an Inflight Pro subscription')
                .addIntegerOption(o => o.setName('duration').setDescription('How long the giveaway runs, in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
                .addStringOption(o => o.setName('prize').setDescription('Prize (defaults to Inflight Pro — 1 Month)').setRequired(false))
                .addStringOption(o => o.setName('delivery').setDescription('How to hand the prize to the winner (default: moderation channel)').setRequired(false)
                    .addChoices(
                        { name: 'Message the moderation channel', value: 'mod_message' },
                        { name: 'Open a help ticket for the winner', value: 'ticket' }
                    ))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageEvents),

            new SlashCommandBuilder().setName('va_apply').setDescription('Apply to register your Virtual Airline / Organization'),

            new SlashCommandBuilder().setName('va_addrep').setDescription('[STAFF] Add a representative to a VA (grants VA + rep access)')
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            new SlashCommandBuilder().setName('va_removerep').setDescription('[STAFF] Remove a representative from a VA')
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            new SlashCommandBuilder().setName('va_remove').setDescription('[STAFF] Permanently remove a VA and everything it owns')
                .addStringOption(o => o.setName('va').setDescription('VA name').setRequired(true).setAutocomplete(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

            // Moderator Commands
            new SlashCommandBuilder().setName('mod_kick').setDescription('[MOD] Kick a user')
                .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for kick').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers),
                
            new SlashCommandBuilder().setName('mod_ban').setDescription('[MOD] Ban a user')
                .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for ban').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),

            new SlashCommandBuilder().setName('mod_timeout').setDescription('[MOD] Timeout a user')
                .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
                .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for timeout').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),

            new SlashCommandBuilder().setName('mod_untimeout').setDescription('[MOD] Remove timeout')
                .addUserOption(o => o.setName('user').setDescription('User to restore').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),

            new SlashCommandBuilder().setName('mod_warn').setDescription('[MOD] Warn a user (Logs to Transcript)')
                .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for warning').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

            new SlashCommandBuilder().setName('mod_purge').setDescription('[MOD] Bulk delete messages')
                .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

            new SlashCommandBuilder().setName('mod_lock').setDescription('[MOD] Lock the current channel')
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

            new SlashCommandBuilder().setName('mod_unlock').setDescription('[MOD] Unlock the current channel')
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

            new SlashCommandBuilder().setName('mod_say').setDescription('[MOD] Make the bot say something')
                .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel to send in (optional)'))
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages),

        ].map(c => c.toJSON());

        try {
            await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
            console.log('✅ Commands registered.');
        } catch (e) { console.error('❌ Error registering commands:', e); }

        updateLeaderboard();
        setInterval(updateLeaderboard, 86400000);
    });

    client.on('guildMemberAdd', async (member) => {
        if (MEMBER_ROLE_ID) {
            try { 
                const role = await member.guild.roles.fetch(MEMBER_ROLE_ID); 
                if (role) await member.roles.add(role); 
            } catch (e) {}
        }
        if (!WELCOME_CHANNEL_ID) return;
        try {
            const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
            if (!channel) return;
            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Welcome to Inflight!`)
                .setDescription(`Hello ${member}, welcome to the server!`)
                .setColor(THEME.WHITE)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({ name: '📸 Submit Photos', value: `Post your photos directly in <#${SUBMISSION_CHANNEL_ID}> to contribute!` })
                .setTimestamp();
            await channel.send({ content: `Welcome ${member}! 👋`, embeds: [welcomeEmbed] });
        } catch (e) {}
    });

    // Per-user cooldown for the partnership-channel banner echo, so a chatty VA
    // member doesn't trigger a banner on every single message.
    const vaBannerCooldown = new Map(); // userId -> last-posted timestamp (ms)
    vaBannerCooldownRef = vaBannerCooldown; // expose to diagnostics (getBotStats)
    const VA_BANNER_COOLDOWN_MS = 10 * 60 * 1000;

    // When a member who belongs to an approved VA posts in the partnership
    // channel, drop just that VA's banner. A user "belongs" to a VA if they own
    // it or hold its VA-specific role.
    const maybePostVaBanner = async (message) => {
        try {
            if (!VirtualAirlineAd) return;

            const now = Date.now();
            const last = vaBannerCooldown.get(message.author.id) || 0;
            if (now - last < VA_BANNER_COOLDOWN_MS) return;

            // Owned VA first (cheap, exact), then any VA whose role they hold.
            let ad = await VirtualAirlineAd.findOne({
                status: 'approved', ownerId: message.author.id, bannerUrl: { $ne: null }
            }).catch(() => null);

            if (!ad) {
                const member = message.member
                    || await message.guild.members.fetch(message.author.id).catch(() => null);
                const roleIds = member ? [...member.roles.cache.keys()] : [];
                if (roleIds.length) {
                    ad = await VirtualAirlineAd.findOne({
                        status: 'approved', discordRoleId: { $in: roleIds }, bannerUrl: { $ne: null }
                    }).catch(() => null);
                }
            }

            if (!ad || !ad.bannerUrl) return;

            vaBannerCooldown.set(message.author.id, now);
            // Just the banner — no embed, no text.
            await message.channel.send({ files: [ad.bannerUrl] }).catch(() => {});
        } catch (e) {
            console.error('❌ maybePostVaBanner error:', e);
        }
    };

    client.on('messageCreate', async (message) => {
      try {
        if (message.author.bot) return;

        // --- HANDLER: VA PARTNERSHIP CHANNEL — echo a member's VA banner ---
        if (message.channelId === PARTNERSHIP_ANNOUNCE_CHANNEL_ID) {
            await maybePostVaBanner(message);
            return;
        }

        // --- CHECK CHANNELS ---
        const isAircraftChannel = message.channelId === SUBMISSION_CHANNEL_ID || 
                                   (message.channel.isThread() && message.channel.parentId === SUBMISSION_CHANNEL_ID);
        
        const isAirportChannel = message.channelId === AIRPORT_SUBMISSION_CHANNEL_ID ||
                                 (message.channel.isThread() && message.channel.parentId === AIRPORT_SUBMISSION_CHANNEL_ID);

        // --- HANDLER: AIRCRAFT SUBMISSIONS ---
        if (isAircraftChannel) {
            if (message.attachments.size > 0) {
                const photo = message.attachments.first();
                const isImage = photo.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(photo.name);

                if (!isImage) return;

                const session = userSessions.get(message.author.id);
                if (session && Date.now() < session.expiresAt) {
                    // Don't silently reuse the last aircraft — ask the user to confirm
                    // the auto-fill. Stash this photo so the button handler can use it.
                    session.expiresAt = Date.now() + 300000;
                    session.pendingPhoto = photo.url;
                    userSessions.set(message.author.id, session);

                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`autofill_yes_${message.author.id}`).setLabel('Yes — same aircraft').setEmoji('✅').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`autofill_no_${message.author.id}`).setLabel('No — new aircraft').setEmoji('🆕').setStyle(ButtonStyle.Secondary),
                    );
                    const confirmEmbed = themedEmbed(THEME.WHITE)
                        .setTitle('🔁 Same aircraft as before?')
                        .setDescription(`I still have your last submission details saved:\n\n> **Aircraft:** ${session.type}\n> **Livery:** ${session.livery}\n> **Tail:** ${session.tail}\n\nTap **Yes** to auto-fill these, or **No** to enter new details.`);

                    await message.reply({ embeds: [confirmEmbed], components: [confirmRow] });
                    return;
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`start_ident_${message.author.id}`)
                            .setLabel('Identify Aircraft')
                            .setEmoji('✈️')
                            .setStyle(ButtonStyle.Primary)
                    );

                const promptEmbed = themedEmbed(THEME.WHITE)
                    .setTitle('📸 New Aircraft Photo')
                    .setDescription('Thanks for the photo! Tap **Identify Aircraft** below to enter the **aircraft type** and **livery**.');

                await message.reply({ embeds: [promptEmbed], components: [row] });
            }
        }

        // --- HANDLER: AIRPORT SUBMISSIONS ---
        if (isAirportChannel) {
            if (message.attachments.size > 0) {
                const photo = message.attachments.first();
                const isImage = photo.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(photo.name);

                if (!isImage) return;

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`start_airport_ident_${message.author.id}`)
                            .setLabel('Identify Airport')
                            .setEmoji('🏢')
                            .setStyle(ButtonStyle.Primary)
                    );

                const promptEmbed = themedEmbed(THEME.WHITE)
                    .setTitle('🏢 New Airport Photo')
                    .setDescription('Thanks for the airport photo! Tap **Identify Airport** below to enter the **ICAO code**.');

                await message.reply({ embeds: [promptEmbed], components: [row] });
            }
        }
      } catch (err) {
        console.error('🛑 messageCreate handler error:', err && err.stack ? err.stack : err);
      }
    });

client.on('interactionCreate', async (interaction) => {
      try {
        // --- 1. AUTOCOMPLETE HANDLERS ---
        if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);

            if (interaction.commandName === 'lookup' && focused.name === 'query') {
                const list = await fetchAircraftMetadata();
                const filtered = list.filter(a => a.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
                await interaction.respond(filtered.map(a => ({ name: a.name, value: a.name })));
                return;
            }

            // VA name autocomplete for the /va_* staff commands.
            if (focused.name === 'va') {
                if (!VirtualAirlineAd) return interaction.respond([]);
                try {
                    const q = (focused.value || '').trim();
                    const ads = await VirtualAirlineAd.find(q ? { name: { $regex: q, $options: 'i' } } : {})
                        .select('name').sort({ name: 1 }).limit(25).lean();
                    return interaction.respond(ads.map(a => ({ name: a.name.slice(0, 100), value: a.name.slice(0, 100) })));
                } catch (_) {
                    return interaction.respond([]);
                }
            }

            if (focused.name === 'aircraft_type') {
                const list = await fetchAircraftMetadata();
                const filtered = list.filter(a => a.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
                await interaction.respond(filtered.map(a => ({ name: a.name, value: a.name })));
                return;
            }

            // Tail numbers for /photos, matched against what is actually in the
            // database (each choice shows the type + livery it belongs to, so a
            // near-miss is obvious before it's picked).
            if (focused.name === 'tail') {
                try {
                    const q = (focused.value || '').trim();
                    const rows = await CommunityAircraftModel
                        .find(q ? { tailNumber: { $regex: escapeRegex(q), $options: 'i' } } : {})
                        .select('tailNumber aircraftType liveryName').sort({ tailNumber: 1 }).limit(25).lean();
                    return interaction.respond(rows.map(r => ({
                        name: `${r.tailNumber} — ${r.aircraftType} (${r.liveryName})`.slice(0, 100),
                        value: String(r.tailNumber).slice(0, 100)
                    })));
                } catch (_) {
                    return interaction.respond([]);
                }
            }

            if (focused.name === 'livery') {
                const selectedType = interaction.options.getString('aircraft_type');
                if (!selectedType) return interaction.respond([{ name: "Select Aircraft Type first", value: "Unknown" }]);

                const list = await fetchAircraftMetadata();
                const matched = list.find(a => a.name === selectedType);

                if (matched) {
                    const liveries = await fetchLiveriesForAircraft(matched.id);
                    const filtered = liveries.filter(l => l.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 24);
                    const options = filtered.map(l => ({ name: l, value: l }));
                    if (focused.value && !liveries.includes(focused.value)) options.push({ name: `${focused.value} (Custom)`, value: focused.value });
                    await interaction.respond(options);
                } else {
                    await interaction.respond([{ name: "Aircraft not found", value: "Unknown" }]);
                }
                return;
            }
            return;
        }

        // --- 2. BUTTON HANDLERS ---
        if (interaction.isButton()) {
            const customId = interaction.customId;

            // --- BOUNTY BOARD PAGINATION BUTTONS ---
            if (customId.startsWith('bnty_')) {
                await interaction.deferUpdate();
                const parts = customId.split('_');
                const action = parts[1]; // prev, next, ref
                let page = parseInt(parts[2], 10);
                const sortBy = parts[3];
                
                if (action === 'prev') page--;
                if (action === 'next') page++;
                
                try {
                    const payload = await generateBountyBoard(page, sortBy);
                    await interaction.editReply(payload);
                } catch (e) {
                    await interaction.followUp({ content: 'Error updating board.', ephemeral: true });
                }
                return;
            }

            // --- AIRCRAFT BUTTONS ---
            // Autofill confirmation: user uploaded another photo within the session.
            if (customId.startsWith('autofill_yes_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This isn't your submission.", ephemeral: true });
                const session = userSessions.get(originalUserId);
                if (!session || Date.now() >= session.expiresAt || !session.pendingPhoto) {
                    return interaction.update({ embeds: [themedEmbed(THEME.GRAY).setTitle('⏳ Session Expired').setDescription('Please re-upload your photo to start a new submission.')], components: [] });
                }
                const photoUrl = session.pendingPhoto;
                session.pendingPhoto = null;
                session.expiresAt = Date.now() + 300000;
                userSessions.set(originalUserId, session);
                // deferUpdate so startSubmissionFlow edits THIS prompt into the preview.
                await interaction.deferUpdate();
                // keepWording: these details were already resolved for the first
                // photo of this session — re-normalizing here would quietly undo
                // a name the submitter chose to keep.
                await startSubmissionFlow(interaction, session.type, session.livery, null, photoUrl, interaction.user, interaction.channelId, { keepWording: true });
                return;
            }

            if (customId.startsWith('autofill_no_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This isn't your submission.", ephemeral: true });
                // Reset the saved session so the user can enter brand-new details.
                userSessions.delete(originalUserId);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_ident_${originalUserId}`).setLabel('Identify Aircraft').setEmoji('✈️').setStyle(ButtonStyle.Primary)
                );
                await interaction.update({
                    embeds: [themedEmbed(THEME.WHITE).setTitle('📸 New Aircraft Photo').setDescription('No problem — tap **Identify Aircraft** below to enter new details.')],
                    components: [row]
                });
                return;
            }

            if (customId.startsWith('start_ident_')) {
                const originalUserId = customId.split('_')[2];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "This is not your photo.", ephemeral: true });

                // The picker instead of the old free-text modal: pick the
                // aircraft, then its livery, both from the real in-game lists.
                // (Typing it by hand is still one tap away inside the picker.)
                const promptMsg = interaction.message;
                const photoMsgId = interaction.message.reference?.messageId;
                await openAircraftPicker(interaction, {
                    userId: originalUserId,
                    intro: '📸 **Identify your photo.**',
                    apply: async (pick, type, livery, pickOpts = {}) => {
                        const photoMsg = photoMsgId
                            ? await interaction.channel.messages.fetch(photoMsgId).catch(() => null)
                            : null;
                        const photoUrl = photoMsg?.attachments?.first()?.url;
                        if (!photoUrl) {
                            return pick.update({ content: '❌ I can no longer find that photo — upload it again to start over.', embeds: [], components: [] }).catch(() => {});
                        }
                        // deferUpdate first: startSubmissionFlow edits this same
                        // ephemeral message into the preview card.
                        await pick.deferUpdate();
                        await startSubmissionFlow(pick, type, livery, null, photoUrl, pick.user, pick.channelId, pickOpts);
                        try { await promptMsg.delete(); } catch (_) {}
                    }
                });
                return;
            }

            if (customId.startsWith('edit_admin_')) {
                const receivedEmbed = interaction.message.embeds[0];
                const currentTail = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';
                const currentType = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value || '';
                const currentLivery = receivedEmbed.fields.find(f => f.name === 'Livery')?.value || '';

                const modal = new ModalBuilder().setCustomId('admin_edit_modal').setTitle('Edit Submission Details');
                const tailInput = new TextInputBuilder().setCustomId('ae_tail').setLabel("Tail Number").setValue(currentTail).setStyle(TextInputStyle.Short).setRequired(true);
                const typeInput = new TextInputBuilder().setCustomId('ae_type').setLabel("Aircraft Type").setValue(currentType).setStyle(TextInputStyle.Short).setRequired(true);
                const liveryInput = new TextInputBuilder().setCustomId('ae_livery').setLabel("Livery").setValue(currentLivery).setStyle(TextInputStyle.Short).setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(tailInput), new ActionRowBuilder().addComponents(typeInput), new ActionRowBuilder().addComponents(liveryInput));
                await interaction.showModal(modal);
                return;
            }

            if (customId.startsWith('approve_') && !customId.startsWith('approve_apt_')) {
                await interaction.deferUpdate();
                // customId format: approve_<action>_<slot>_<userId> where action is
                // 'add' | 'replace' | 'insert'. Older formats are still accepted:
                //   approve_<slot>_<userId>  (slot only — intent inferred at approval)
                //   approve_<userId>         (legacy single-photo => slot 1)
                const approveParts = customId.split('_');
                let approveAction = null; // 'add' | 'replace' | null (infer)
                let chosenSlot, targetUserId;
                if (approveParts.length >= 4) {
                    approveAction = approveParts[1];
                    chosenSlot = parseInt(approveParts[2], 10) || 1;
                    targetUserId = approveParts[3];
                } else if (approveParts.length === 3) {
                    chosenSlot = parseInt(approveParts[1], 10) || 1;
                    targetUserId = approveParts[2];
                } else {
                    chosenSlot = 1;
                    targetUserId = approveParts[1];
                }
                const receivedEmbed = interaction.message.embeds[0];

                try {
                    const tailField = receivedEmbed.fields.find(f => f.name === 'Tail Number')?.value;
                    const typeField = receivedEmbed.fields.find(f => f.name === 'Aircraft Type')?.value;
                    const liveryField = receivedEmbed.fields.find(f => f.name === 'Livery')?.value;

                    if (!tailField || !typeField || !liveryField) throw new Error("Missing required aircraft embed fields.");

                    let imageUrl = receivedEmbed.image?.url || interaction.message.attachments.first()?.url;
                    const footerText = receivedEmbed.footer?.text || '';
                    const publicMsgId = footerText.match(/Msg: (\d+)/)?.[1];
                    const originChannelId = footerText.match(/Ch: (\d+)/)?.[1];

                    // Find the existing record (if any) so we can place the new photo into
                    // the admin-chosen slot without disturbing the other images.
                    //
                    // Read BEFORE the upload: an insert that no longer fits is refused
                    // below, and aborting after the upload would leave an orphaned
                    // object in the bucket.
                    const existingEntry = await CommunityAircraftModel.findOne({
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") }
                    });

                    let images = getEntryImages(existingEntry);
                    let contributors = getEntryContributors(existingEntry);

                    // RE-CHECK against the LIVE database before placing the photo.
                    // The slot baked into the button was decided when the buttons
                    // were rendered; by the time an admin clicks, other submissions
                    // for the same aircraft may already have been approved. Without
                    // this re-check, a second pending "add" (rendered as slot 1 when
                    // there were 0 photos) would overwrite the photo that was just
                    // approved into slot 1. We honour the admin's intent (add vs
                    // replace vs insert) against the current image count instead.
                    const placement = resolveAircraftSlot(approveAction, chosenSlot, images.length);

                    // The record filled up between render and click, so the insert the
                    // admin asked for would now shove Photo 3 out of the database —
                    // exactly the loss insert exists to avoid. Change nothing, re-render
                    // the card against the live state, and let them choose again.
                    if (placement.mode === 'full') {
                        const stale = EmbedBuilder.from(receivedEmbed);
                        const review = buildAircraftReview(stale, existingEntry, targetUserId);
                        if (footerText) stale.setFooter({ text: footerText });
                        // No `attachments` key: the pending photo is still a Discord
                        // attachment this embed points at, and clearing it would blank
                        // the card.
                        await interaction.editReply({ embeds: [stale, ...review.extraEmbeds], components: review.components });
                        await interaction.followUp({
                            content: `⚠️ **${typeField}** (${liveryField}) now has ${MAX_AIRCRAFT_IMAGES}/${MAX_AIRCRAFT_IMAGES} photos, so inserting would push Photo ${MAX_AIRCRAFT_IMAGES} out of the database. Nothing was changed — the card is refreshed, so use **Replace** if you do want to overwrite a slot.`,
                            ephemeral: true
                        }).catch(() => {});
                        return;
                    }

                    // Both DM and web submissions carry a Discord-hosted attachment,
                    // so this moves it to S3. (If the image is somehow already in our
                    // bucket, reuse it instead of re-running the sharp pipeline.)
                    const permanentUrl = isOwnCommunityS3Url(imageUrl)
                        ? imageUrl
                        : await uploadImageToS3(imageUrl, tailField);

                    // Resolve the collaborator. A numeric token is a Discord id
                    // (DM submissions, or a web submission from a Discord-linked
                    // account) — fetch the member/user for their name and grant the
                    // contributor role. A non-numeric token ('web') means the
                    // submitting site had no linked Discord identity, so credit the
                    // display name carried in the footer with no Discord id.
                    const isDiscordId = /^\d{5,}$/.test(String(targetUserId));
                    const footerCollab = footerText.match(/Collab: ([^|]+?)\s*(?:\||$)/)?.[1]?.trim();
                    // The tracker account behind the submission, if it had one.
                    const footerPilotId = footerText.match(/Pilot: ([^|]+?)\s*(?:\||$)/)?.[1]?.trim() || null;
                    const footerIfUser = footerText.match(/IF: ([^|]+?)\s*(?:\||$)/)?.[1]?.trim() || null;
                    let member = null;
                    let contributorName = null;
                    let contributorId = null;
                    if (isDiscordId) {
                        member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                        contributorName = member
                            ? member.displayName
                            : await client.users.fetch(targetUserId).then(u => u.username).catch(() => null);
                        contributorId = targetUserId;
                    }
                    if (!contributorName) contributorName = footerCollab || 'Anonymous';

                    // The person who submitted this photo is the contributor of THIS
                    // slot only — adding/replacing/inserting a photo must not overwrite
                    // the contributor(s) of the other images. An insert carries each
                    // existing photo's credit down with it.
                    const slotContributor = {
                        name: contributorName,
                        id: contributorId,
                        pilotId: footerPilotId,
                        ifUsername: footerIfUser,
                    };

                    const slotIndex = placement.slotIndex;
                    const replacedUrl = applyAircraftPlacement(images, contributors, placement, permanentUrl, slotContributor);
                    images = images.slice(0, MAX_AIRCRAFT_IMAGES);
                    contributors = contributors.slice(0, MAX_AIRCRAFT_IMAGES);

                    // Legacy top-level contributor mirrors the primary (slot 0) image.
                    const primaryContributor = contributors[0] || slotContributor;

                    // Automatically remove the 'needsUpdate' flag upon approval
                    const updateData = {
                        contributorName: primaryContributor.name,
                        contributorId: primaryContributor.id,
                        contributorPilotId: primaryContributor.pilotId || null,
                        contributorIfUsername: primaryContributor.ifUsername || null,
                        aircraftType: typeField,
                        liveryName: liveryField,
                        imageUrls: images,
                        imageContributors: contributors,
                        imageUrl: images[0], // keep legacy primary field in sync
                        uploadedAt: new Date(),
                        needsUpdate: false
                    };

                    if (tailField !== 'UNKNOWN') updateData.tailNumber = tailField.toUpperCase();

                    await CommunityAircraftModel.findOneAndUpdate(
                        { aircraftType: { $regex: new RegExp(`^${escapeRegex(typeField)}$`, "i") }, liveryName: { $regex: new RegExp(`^${escapeRegex(liveryField)}$`, "i") } },
                        updateData, { upsert: true }
                    );

                    // Tell whoever sent it. A web submitter has no DM channel to
                    // be messaged on, so their copy of this is the row.
                    await closeSubmission(footerText, {
                        status: 'approved',
                        reason: '',
                        reviewedBy: interaction.user.username,
                        photoUrl: permanentUrl,
                    });

                    // Remove the overwritten image from storage (after the DB is updated)
                    if (replacedUrl && replacedUrl !== permanentUrl) await deleteImageFromS3(replacedUrl);

                    if (CONTRIBUTOR_ROLE_ID && member) await member.roles.add(CONTRIBUTOR_ROLE_ID).catch(() => {});

                    const keptAt = placement.mode === 'insertEnd' ? images.length : slotIndex + 2;
                    const approvedTitle = (placement.mode === 'insert' || placement.mode === 'insertEnd')
                        ? `✅ Approved — Inserted as Photo ${slotIndex + 1} of ${images.length} (previous Photo ${slotIndex + 1} kept as ${keptAt})`
                        : `✅ Approved — Photo ${slotIndex + 1} of ${images.length}`;
                    // Keep the verified photo rendered inside the admin embed (using the
                    // permanent S3 URL) and drop the temporary upload attachment.
                    await interaction.editReply({
                        embeds: [EmbedBuilder.from(receivedEmbed).setColor(SUB_STATE.VERIFIED.color).setTitle(approvedTitle).setImage(permanentUrl)],
                        components: [],
                        attachments: []
                    });

                    if (publicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(publicMsgId);
                            // Embed the PERMANENT image (S3 URLs don't expire) instead of
                            // posting the raw link as message content. This keeps the photo
                            // visible on the message forever and removes the temp attachment.
                            await publicMsg.edit({
                                content: '',
                                embeds: [EmbedBuilder.from(publicMsg.embeds[0])
                                    .setTitle('✅ Verified Aircraft')
                                    .setColor(SUB_STATE.VERIFIED.color)
                                    .setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nThis photo has been verified and saved to the database.`)
                                    .setImage(permanentUrl)],
                                attachments: [],
                                // Drops the submitter's Fix Details button: the
                                // details are in the database now, and changing
                                // them is /photos and an admin's job.
                                components: []
                            });
                        } catch (e) {}
                    }

                    // Let the submitter know their photo went live, with the image.
                    if (originChannelId) {
                        try {
                            const userChannel = await client.channels.fetch(originChannelId).catch(() => null);
                            if (userChannel) {
                                await userChannel.send({
                                    content: `<@${targetUserId}>`,
                                    embeds: [themedEmbed(SUB_STATE.VERIFIED.color)
                                        .setTitle('✅ Photo Approved')
                                        .setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nYour **${typeField}** (${liveryField}) photo is now live in the database. Thanks for contributing! 🎉`)
                                        .setImage(permanentUrl)]
                                });
                            }
                        } catch (e) {}
                    }

                    // Refresh any other still-pending review cards for the same aircraft so
                    // they reflect the photo we just saved (e.g. a duplicate submission's
                    // card flips from "no photo yet" to "1/3 — Add Photo 2 / Replace Photo 1").
                    await refreshPendingReviewsFor(typeField, liveryField, {
                        imageUrls: images,
                        imageContributors: contributors,
                        tailNumber: updateData.tailNumber
                    }, interaction.message.id);
                } catch (err) {
                    console.error("Aircraft Approval Error:", err);
                }
                return;
            }

            if (customId.startsWith('reject_') && !customId.startsWith('reject_apt_')) {
                const targetUserId = customId.split('_')[1];
                const modal = new ModalBuilder().setCustomId(`rejectModal_${targetUserId}`).setTitle('Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return;
            }

            // --- AIRPORT BUTTONS ---
            if (customId.startsWith('start_airport_ident_')) {
                const originalUserId = customId.split('_')[3];
                if (interaction.user.id !== originalUserId) return interaction.reply({ content: "Not your photo.", ephemeral: true });
                const modal = new ModalBuilder().setCustomId('airport_modal').setTitle('Airport Details');
                const icaoInput = new TextInputBuilder().setCustomId('a_icao').setLabel("ICAO Code").setPlaceholder("e.g. KJFK").setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(4).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(icaoInput));
                await interaction.showModal(modal);
                return;
            }

            if (customId.startsWith('approve_apt_')) {
                await interaction.deferUpdate();
                const [_, __, targetUserId, icao] = customId.split('_');
                const imageUrl = interaction.message.embeds[0].image?.url;
                const aptPublicMsgId = (interaction.message.embeds[0].footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const aptOriginChannelId = (interaction.message.embeds[0].footer?.text || '').match(/Ch: (\d+)/)?.[1];
                try {
                    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                    const contributorName = sanitizeMetadata(member ? member.displayName : "Unknown");
                    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    if (typeof deleteAirportImages === 'function') await deleteAirportImages(s3Client, icao);
                    const finalUrl = await uploadAirportImage(s3Client, { buffer: Buffer.from(response.data) }, icao, contributorName);
                    await interaction.editReply({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setTitle(`✅ Airport Approved: ${icao}`).setColor(SUB_STATE.VERIFIED.color).setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}`).setImage(finalUrl)], components: [] });

                    // Update the public feed message too, swapping the temporary Discord
                    // image URL (which expires) for the permanent stored one.
                    if (aptPublicMsgId) {
                        try {
                            const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                            const publicMsg = await feedChannel.messages.fetch(aptPublicMsgId);
                            await publicMsg.edit({ embeds: [EmbedBuilder.from(publicMsg.embeds[0]).setTitle(`✅ Verified Airport: ${icao}`).setColor(SUB_STATE.VERIFIED.color).setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}`).setImage(finalUrl)] });
                        } catch (e) {}
                    }

                    // Notify the submitter in their channel with the verified image.
                    if (aptOriginChannelId) {
                        try {
                            const userChannel = await client.channels.fetch(aptOriginChannelId).catch(() => null);
                            if (userChannel) await userChannel.send({ content: `<@${targetUserId}>`, embeds: [themedEmbed(SUB_STATE.VERIFIED.color).setTitle('✅ Airport Photo Approved').setDescription(`**Status:** ${SUB_STATE.VERIFIED.badge}\nYour **${icao}** photo is now live. Thanks! 🎉`).setImage(finalUrl)] });
                        } catch (e) {}
                    }
                } catch (err) { console.error("Airport Approval Error:", err); }
                return;
            }

            if (customId.startsWith('reject_apt_')) {
                const targetUserId = customId.split('_')[2];
                const modal = new ModalBuilder().setCustomId(`rejectAptModal_${targetUserId}`).setTitle('Airport Rejection Reason');
                const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel("Why?").setStyle(TextInputStyle.Paragraph).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return;
            }

            // --- SUBMITTER CORRECTS THEIR OWN PENDING SUBMISSION ---
            // The admin still has the last say: this only moves the details on a
            // card that is still awaiting review, and the card keeps its Edit
            // Details / Approve / Reject buttons either way.
            if (customId.startsWith('submission_fix_')) {
                const submitterId = customId.split('_')[2];
                if (interaction.user.id !== submitterId && !isPhotoStaff(interaction)) {
                    return interaction.reply({ content: "This isn't your submission — only the person who sent it in (or staff) can correct it.", ephemeral: true });
                }
                const publicMsg = interaction.message;
                const pendingEmbed = publicMsg.embeds?.[0];
                if (!(pendingEmbed?.description || '').includes(SUB_STATE.PENDING.badge)) {
                    return interaction.reply({ content: 'ℹ️ This submission has already been reviewed — there is nothing left to correct.', ephemeral: true });
                }

                await openAircraftPicker(interaction, {
                    userId: interaction.user.id,
                    type: pendingEmbed.fields?.find(f => f.name === 'Aircraft')?.value || null,
                    intro: '🔧 **Correct the aircraft or livery.** An admin still reviews it, and can change it again.',
                    apply: async (pick, pickedType, pickedLivery, pickOpts = {}) => {
                        await pick.deferUpdate();
                        let type = String(pickedType || '').trim();
                        let livery = String(pickedLivery || '').trim();
                        if (!pickOpts.keepWording) {
                            const normalized = await normalizeData(type, livery);
                            type = normalized.type;
                            livery = normalized.livery;
                        }
                        const tail = lookupRegistration(type, livery) || 'UNKNOWN';

                        // The card may have been approved or rejected while the
                        // picker was open — the review card is the authority on
                        // that, so a missing one means the correction is too late.
                        const reviewCard = await findPendingReviewCard(publicMsg.id);
                        if (!reviewCard) {
                            return pick.editReply({
                                content: '⏳ That submission has just been reviewed, so nothing was changed. If the details came out wrong, ask an admin — the photo is already in the database.',
                                embeds: [], components: []
                            }).catch(() => {});
                        }

                        await rebuildReviewCard(reviewCard, { tail, type, livery, correctedBy: pick.user });

                        const fresh = EmbedBuilder.from(pendingEmbed);
                        const fields = fresh.data.fields || [];
                        const setField = (name, value) => {
                            const f = fields.find(x => x.name === name);
                            if (f) f.value = value;
                        };
                        setField('Aircraft', type);
                        setField('Livery', livery);
                        setField('Tail Number', tail.toUpperCase());
                        fresh.setFields(fields);
                        await publicMsg.edit({ embeds: [fresh] }).catch(() => {});

                        return pick.editReply({
                            content: `✅ Updated to **${type}** — **${livery}** (tail ${tail.toUpperCase()}). The admins' review card now shows your correction.`,
                            embeds: [], components: []
                        }).catch(() => {});
                    }
                });
                return;
            }

            // --- AIRCRAFT PICKER: PAGING, SEARCH, BACK, MANUAL ENTRY ---
            if (customId.startsWith('pick_')) {
                const parsed = parsePickerCustomId(customId);
                if (!parsed) return;
                const { action } = parsed;
                const session = getPickerSession(parsed.sessionId);
                if (!session) return interaction.update(PICKER_EXPIRED).catch(() => {});
                if (session.userId !== interaction.user.id) {
                    return interaction.reply({ content: "That picker isn't yours.", ephemeral: true });
                }

                if (action === 'page') {
                    session.page = parsed.page;
                    return interaction.update(await renderPicker(session)).catch(() => {});
                }
                if (action === 'back') {
                    session.step = 'type';
                    session.query = '';
                    session.page = 0;
                    return interaction.update(await renderPicker(session)).catch(() => {});
                }
                // The manual-entry disagreement, settled either way. "Keep mine"
                // is the whole point of the prompt: an aircraft or livery the
                // list doesn't carry yet goes in with the submitter's wording,
                // flagged for an admin rather than silently renamed.
                if (action === 'usematch' || action === 'usemine') {
                    if (!session.raw || !session.match) return interaction.update(PICKER_EXPIRED).catch(() => {});
                    const chosen = action === 'usematch' ? session.match : session.raw;
                    pickerSessions.delete(session.id);
                    return session.apply(interaction, chosen.type, chosen.livery, { keepWording: true });
                }

                if (action === 'search') {
                    const modal = new ModalBuilder().setCustomId(`pick_searchmodal_${session.id}`).setTitle('Search');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('p_query')
                            .setLabel(session.step === 'type' ? 'Part of the aircraft name' : 'Part of the livery name')
                            .setPlaceholder(session.step === 'type' ? 'e.g. 737, A350, Cessna' : 'e.g. Delta, Qatar, Generic')
                            .setValue(session.query || '')
                            .setStyle(TextInputStyle.Short).setRequired(false)
                    ));
                    return interaction.showModal(modal).catch(() => {});
                }
                if (action === 'manual') {
                    // The escape hatch: a livery the API doesn't list yet, or an
                    // aircraft named differently in-game. The normalizer still
                    // runs on whatever is typed, and an admin still reviews it.
                    const modal = new ModalBuilder().setCustomId(`pick_manualmodal_${session.id}`).setTitle('Type it yourself');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_type').setLabel('Aircraft Type (new or unlisted is fine)')
                            .setPlaceholder('e.g. 737-8 MAX, A321, 777-300ER')
                            // Prefilled with what was typed last (Edit again from
                            // the confirm step), else whatever step 1 selected.
                            .setValue(session.raw?.type || session.type || '').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_livery').setLabel('Livery Name (new or unlisted is fine)')
                            .setPlaceholder('e.g. Delta Air Lines, Generic, Private')
                            .setValue(session.raw?.livery || '').setStyle(TextInputStyle.Short).setRequired(true))
                    );
                    return interaction.showModal(modal).catch(() => {});
                }
                return;
            }

            // --- PHOTO MANAGER BUTTONS (from /photos) ---
            if (customId.startsWith('photos_refresh_') || customId.startsWith('photos_delok_') || customId === 'photos_cancel') {
                if (!isPhotoStaff(interaction)) {
                    return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
                }
                await interaction.deferUpdate();
                if (customId === 'photos_cancel') {
                    return interaction.editReply({ content: '✋ Cancelled — nothing was deleted.', components: [] }).catch(() => {});
                }
                try {
                    if (customId.startsWith('photos_refresh_')) {
                        const entry = await CommunityAircraftModel.findById(customId.replace('photos_refresh_', '')).catch(() => null);
                        if (!entry || getEntryImages(entry).length === 0) {
                            return interaction.editReply({ content: '❌ That record no longer has photos on it.', embeds: [], components: [] }).catch(() => {});
                        }
                        return interaction.editReply(buildPhotoManager(entry)).catch(() => {});
                    }

                    // photos_delok_<recordId>_<slot> — the record id is a Mongo
                    // ObjectId (no underscores), so the slot is the tail.
                    const rest = customId.replace('photos_delok_', '');
                    const cut = rest.lastIndexOf('_');
                    const entry = await CommunityAircraftModel.findById(rest.slice(0, cut)).catch(() => null);
                    const slot = parseInt(rest.slice(cut + 1), 10);
                    if (!entry) {
                        return interaction.editReply({ content: '❌ That record no longer exists.', components: [] }).catch(() => {});
                    }
                    const images = getEntryImages(entry);
                    const contributors = getEntryContributors(entry);
                    // Re-checked against live state: the photo may already be gone,
                    // or be the only one left, in which case removing it would
                    // leave the record with no image at all.
                    if (!(slot >= 1 && slot <= images.length) || images.length <= 1) {
                        return interaction.editReply({ content: '⚠️ Nothing was deleted — that photo is already gone, or it is the record\'s only photo.', components: [] }).catch(() => {});
                    }
                    const [removed] = images.splice(slot - 1, 1);
                    contributors.splice(slot - 1, 1);
                    // Storage last: a failed DB write must not leave the record
                    // pointing at a file that no longer exists.
                    await saveAircraftImages(entry, images, contributors);
                    if (removed) await deleteImageFromS3(removed);
                    await logPhotoAction(interaction, entry, `🗑️ Removed Photo ${slot} — ${images.length} left.`);
                    return interaction.editReply({
                        content: `🗑️ Photo ${slot} removed. **${images.length}** photo(s) remain — run \`/photos\` again for the updated record.`,
                        components: []
                    }).catch(() => {});
                } catch (e) {
                    console.error('Photo manager button failed:', e);
                    return interaction.followUp({ content: '⚠️ That didn\'t go through — nothing was changed.', ephemeral: true }).catch(() => {});
                }
            }

            // --- GIVEAWAY ENTRY BUTTON ---
            if (customId === 'giveaway_enter') {
                const g = activeGiveaways.get(interaction.message.id);
                if (!g || g.ended) {
                    return interaction.reply({ content: '❌ This giveaway has already ended.', ephemeral: true });
                }
                if (g.entrants.has(interaction.user.id)) {
                    return interaction.reply({ content: 'ℹ️ You are already entered. Good luck! 🎉', ephemeral: true });
                }
                g.entrants.add(interaction.user.id);
                // Persist the new entrant so it survives a restart.
                persistGiveaway(interaction.message.id).catch(() => {});

                // Live-update the entry count shown on the embed.
                try {
                    const baseEmbed = interaction.message.embeds[0];
                    if (baseEmbed) {
                        const newEmbed = EmbedBuilder.from(baseEmbed);
                        const fields = newEmbed.data.fields || [];
                        const idx = fields.findIndex(f => f.name === 'Entries');
                        if (idx !== -1) fields[idx].value = `${g.entrants.size}`;
                        newEmbed.setFields(fields);
                        await interaction.message.edit({ embeds: [newEmbed] }).catch(() => {});
                    }
                } catch (e) { /* non-fatal — entry still counts */ }

                return interaction.reply({ content: '✅ You have entered the giveaway! Good luck! 🎉', ephemeral: true });
            }

            // --- VA FULL-REMOVAL CONFIRMATION (from /va_remove) ---
            if (customId.startsWith('va_purge_confirm_') || customId.startsWith('va_purge_cancel_')) {
                // Staff only (mirrors the /va_remove guard).
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
                }
                if (customId.startsWith('va_purge_cancel_')) {
                    return interaction.update({ content: '✋ Cancelled — nothing was removed.', components: [] }).catch(() => {});
                }
                if (!VirtualAirlineAd) {
                    return interaction.update({ content: '❌ VA system unavailable.', components: [] }).catch(() => {});
                }

                const adId = customId.replace('va_purge_confirm_', '');
                await interaction.update({ content: '🗑️ Removing everything…', components: [] }).catch(() => {});
                // Load the select:false webhook URL too so purgeVaData can delete it at Discord.
                const ad = await VirtualAirlineAd.findById(adId).select('+flightEventsWebhookUrl').catch(() => null);
                if (!ad) return interaction.editReply({ content: '❌ That VA no longer exists.' }).catch(() => {});
                const vaName = ad.name;

                try {
                    // 1) Discord space — channel + role (best-effort; either may already be gone).
                    const discordBits = [];
                    if (ad.discordChannelId) {
                        const ch = await interaction.guild.channels.fetch(ad.discordChannelId).catch(() => null);
                        if (ch) { await ch.delete('VA fully removed by staff').catch(() => {}); discordBits.push('channel'); }
                    }
                    if (ad.discordRoleId) {
                        const role = interaction.guild.roles.cache.get(ad.discordRoleId) || await interaction.guild.roles.fetch(ad.discordRoleId).catch(() => null);
                        if (role) { await role.delete('VA fully removed by staff').catch(() => {}); discordBits.push('role'); }
                    }

                    // 2) Portal data + embeds + S3 images (centralized helper).
                    let counts = {};
                    if (typeof purgeVaData === 'function') {
                        counts = await purgeVaData(ad).catch((e) => { console.error('❌ purgeVaData error:', e.message); return {}; });
                    }

                    // 3) The ad document itself — this also drops the stored flight-events webhook URL.
                    await VirtualAirlineAd.deleteOne({ _id: ad._id }).catch(() => {});

                    const summary =
                        `🗑️ **${vaName}** fully removed.\n` +
                        `• Discord: ${discordBits.length ? discordBits.join(' + ') + ' deleted' : 'nothing left to delete'}\n` +
                        `• Portal accounts: ${counts.accounts || 0} · Submissions: ${counts.submissions || 0} · Events: ${counts.events || 0}\n` +
                        `• Embeds: ${counts.embeds || 0} · Activity rows: ${counts.activity || 0} · S3 images: ${counts.images || 0}\n` +
                        `• Flight-events webhook: ${counts.webhook ? 'deleted from Discord' : 'none on file'} · Public listing removed.`;
                    return interaction.editReply({ content: summary }).catch(() => {});
                } catch (e) {
                    console.error('❌ va_purge error:', e);
                    return interaction.editReply({ content: `❌ Something failed while removing **${vaName}**. Some parts may already be gone — check the logs.` }).catch(() => {});
                }
            }

            // --- VA APPLICATION REVIEW BUTTONS ---
            if (customId.startsWith('va_approve_') || customId.startsWith('va_reject_') || customId.startsWith('va_edit_')) {
                // Staff or the Inflight VA Rep may review applications.
                if (!canReviewVa(interaction.member)) {
                    return interaction.reply({ content: '❌ Staff or Inflight VA Rep only.', ephemeral: true });
                }
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable (database not connected).', ephemeral: true });
                }

                // Reject / Request Edits both collect text via a modal first. Encode
                // the review message id so the modal submit can update this message.
                if (customId.startsWith('va_reject_')) {
                    const id = customId.replace('va_reject_', '');
                    const modal = new ModalBuilder().setCustomId(`va_reject_modal_${id}_${interaction.message.id}`).setTitle('Reject VA Application');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('va_reason').setLabel('Reason (sent to the applicant)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
                    ));
                    return interaction.showModal(modal);
                }
                if (customId.startsWith('va_edit_')) {
                    const id = customId.replace('va_edit_', '');
                    const modal = new ModalBuilder().setCustomId(`va_editreq_modal_${id}_${interaction.message.id}`).setTitle('Request Edits');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('va_changes').setLabel('What needs changing?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
                    ));
                    return interaction.showModal(modal);
                }

                // Approve → provision the VA space.
                const id = customId.replace('va_approve_', '');
                await interaction.deferReply({ ephemeral: true });
                const ad = await VirtualAirlineAd.findById(id).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found (it may have been deleted).');

                try {
                    ad.status = 'approved';
                    const { role, channel } = await provisionVaSpace(interaction.guild, ad);

                    const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0] || buildVaReviewEmbed(ad))
                        .setTitle('✅ VA Application — Approved')
                        .setColor(THEME.WHITE);
                    await interaction.message.edit({ embeds: [approvedEmbed], components: [] }).catch(() => {});

                    await interaction.message.reply(`✅ **${ad.name}** approved by <@${interaction.user.id}>.\n• Role: ${role ? `<@&${role.id}>` : '—'}\n• Channel: ${channel ? `<#${channel.id}>` : '—'}`).catch(() => {});

                    // The portal login is named after the VA's OWNER, so resolve
                    // them BEFORE provisioning rather than after: `ad.ownerName`
                    // was captured when they applied and goes stale the moment
                    // they rename themselves on Discord. Same fetch that DMs them
                    // below, just moved up — no extra call.
                    const owner = ad.ownerId ? await client.users.fetch(ad.ownerId).catch(() => null) : null;

                    // Provision the VA's self-service Partnership Portal account
                    // (idempotent). The plaintext password is only returned the very
                    // first time, so we only DM credentials on initial creation.
                    let portalLine = '';
                    if (typeof provisionVaPortalAccount === 'function') {
                        try {
                            const { created, username, password } = await provisionVaPortalAccount(ad, {
                                createdVia: 'bot',
                                createdByName: `Bot (approved by ${interaction.user.username})`,
                                discordUsername: owner ? owner.username : '',
                            });
                            if (created && password) {
                                portalLine = `\n\n🔐 **Your VA Partnership Portal is ready.**\n` +
                                    `Log in at ${VA_PORTAL_URL} to submit documents, requests, reports — anything — ` +
                                    `and to give your own staff access.\n` +
                                    `• Username: \`${username}\`\n` +
                                    `• Temporary password: \`${password}\`\n` +
                                    `Please change your password after your first login.`;
                            } else {
                                portalLine = `\n\n🔐 Your VA Partnership Portal is at ${VA_PORTAL_URL} ` +
                                    `(sign in with your existing portal credentials).`;
                            }
                        } catch (e) {
                            console.error('❌ VA portal provision error:', e.message);
                        }
                    }

                    if (owner) {
                        await owner.send(`🎉 Your VA **${ad.name}** has been approved! Your private channel is ${channel ? `<#${channel.id}>` : 'ready'}.${portalLine}`).catch(() => {});
                    }

                    // If the VA already shipped a banner + logo (e.g. submitted via
                    // the web dashboard), announce the partnership now. Otherwise the
                    // image-upload flow will fire it once both are in place.
                    await announceVaPartnership(ad).catch(() => {});

                    return interaction.editReply(`✅ Provisioned **${ad.name}** — ${channel ? `<#${channel.id}>` : 'channel'} and role created.`);
                } catch (e) {
                    console.error('❌ VA approval/provision error:', e);
                    return interaction.editReply('❌ Failed to provision the VA space. Check that the bot has **Manage Roles** + **Manage Channels** and that the category ID is correct.');
                }
            }

            // --- VA SETUP CARD BUTTONS (owner fills in the rest, post-approval) ---
            if (customId.startsWith('va_setup_')) {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable (database not connected).', ephemeral: true });
                }
                // customId: va_setup_<action>_<adId>
                const rest = customId.replace('va_setup_', '');
                const sep = rest.indexOf('_');
                const action = rest.slice(0, sep);
                const adId = rest.slice(sep + 1);

                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.reply({ content: '❌ This VA listing no longer exists.', ephemeral: true });
                if (!canManageVa(interaction, ad)) {
                    return interaction.reply({ content: '❌ Only this VA\'s owner (or staff) can edit its listing.', ephemeral: true });
                }

                // Banner / logo come in as image attachments — a modal can't take a
                // file, so we kick off a message collector in this channel.
                if (action === 'banner' || action === 'logo') {
                    await interaction.reply({ content: `🖼️ Ready for your **${action}** — see the prompt below.`, ephemeral: true });
                    handleVaImageUpload(interaction.channel, interaction.user, ad, action);
                    return;
                }

                // Text details → modal #1 (5 fields max per Discord modal).
                if (action === 'details') {
                    const modal = new ModalBuilder().setCustomId(`va_setup_details_modal_${adId}`).setTitle('VA Details');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_description').setLabel('Full description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(ad.description || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_region').setLabel('Region (e.g. Asia, Europe, Global)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40).setValue(ad.region && ad.region !== 'Global' ? ad.region : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_hubs').setLabel('Hub ICAOs (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('VABB, VIDP, OMDB').setValue((ad.hubs || []).join(', '))),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_fleet').setLabel('Fleet (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setPlaceholder('A320, B738, B77W').setValue((ad.fleet || []).join(', '))),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_requirements').setLabel('Joining requirements').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setValue(ad.requirements || ''))
                    );
                    return interaction.showModal(modal);
                }

                // Links + recruiting → modal #2.
                if (action === 'links') {
                    const modal = new ModalBuilder().setCustomId(`va_setup_links_modal_${adId}`).setTitle('Links & Recruiting');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_applicationUrl').setLabel('Apply / join link').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(ad.applicationUrl || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_ifcThreadUrl').setLabel('IFC forum thread URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(ad.ifcThreadUrl || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_minGrade').setLabel('Minimum IF grade (1-5, blank = none)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1).setPlaceholder('3').setValue(ad.minGrade ? String(ad.minGrade) : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_pilotCount').setLabel('Current pilot count').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6).setPlaceholder('25').setValue(ad.pilotCount ? String(ad.pilotCount) : '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('va_tags').setLabel('Tags / keywords (comma separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setPlaceholder('long-haul, realism, events').setValue((ad.tags || []).join(', ')))
                    );
                    return interaction.showModal(modal);
                }

                return interaction.reply({ content: '❌ Unknown setup action.', ephemeral: true });
            }

            // --- TICKET BUTTONS ---
            if (customId === 'create_ticket_start') {
                const topicSelect = new StringSelectMenuBuilder().setCustomId('ticket_topic_select').setPlaceholder('Select a topic')
                    .addOptions(
                        { label: 'Database Correction', value: 'db_correction', emoji: '📝' },
                        { label: 'Submission Issue', value: 'submission_issue', emoji: '📸' },
                        { label: 'VA Partnership', value: 'va_partnership', emoji: '🤝', description: 'Partner your VA with Inflight' },
                        { label: 'Subscription Issue (Inflight Pro)', value: 'subscription', emoji: '💳', description: 'Problems with your Inflight Pro subscription' },
                        { label: 'Other Inquiry', value: 'other', emoji: '❓' }
                    );
                await interaction.reply({ content: 'Select a topic:', components: [new ActionRowBuilder().addComponents(topicSelect)], ephemeral: true });
                return;
            }

            if (customId === 'close_ticket_action') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
                await interaction.deferReply({ ephemeral: true });
                const thread = interaction.channel;
                try {
                    const messages = await thread.messages.fetch({ limit: 100 });
                    const transcript = Array.from(messages.values()).reverse().map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content}`).join('\n');
                    const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
                    if (transcriptChannel) {
                        await transcriptChannel.send({ embeds: [new EmbedBuilder().setTitle('🔒 Ticket Closed').setDescription(`Ticket: ${thread.name}`).setColor(0xFF0000)], files: [new AttachmentBuilder(Buffer.from(transcript), { name: `${thread.name}-transcript.txt` })] });
                    }
                    await interaction.editReply("Closing in 5s...");
                    setTimeout(() => thread.delete().catch(() => {}), 5000);
                } catch (e) { console.error(e); }
                return;
            }

            // --- VA PARTNERSHIP: ACCEPT TERMS ---
            if (customId === 'partnership_accept_tos') {
                await interaction.deferUpdate();

                // Persist the acceptance (latest wins). Best-effort — never block
                // the user if the DB is briefly unavailable.
                if (VaTermsAcceptance) {
                    try {
                        await VaTermsAcceptance.findOneAndUpdate(
                            { userId: interaction.user.id },
                            {
                                userId: interaction.user.id,
                                username: interaction.user.username,
                                termsVersion: VA_PARTNERSHIP_TOS_VERSION,
                                channelId: interaction.channelId,
                                acceptedAt: new Date(),
                            },
                            { upsert: true, setDefaultsOnInsert: true }
                        );
                    } catch (e) {
                        console.error('❌ Save terms acceptance error:', e);
                    }
                }

                // Lock the ToS card so it can't be re-accepted.
                try {
                    const lockedRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('partnership_accepted_done').setLabel('Terms Accepted').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(true),
                        new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
                    );
                    await interaction.editReply({ components: [lockedRow] });
                } catch (_) { /* card may have been deleted */ }

                // Walk them straight into the VA application — no /va_apply needed.
                const setupRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('partnership_apply_va').setLabel('Start VA Application').setStyle(ButtonStyle.Primary).setEmoji('🛫')
                );
                await interaction.followUp({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Terms accepted — let’s set up your VA')
                        .setColor(THEME.WHITE)
                        .setDescription(
                            `Thanks <@${interaction.user.id}>! We’ve recorded that you accepted our partnership terms.\n\n` +
                            "Tap **Start VA Application** below to register your VA — no need to run `/va_apply`. " +
                            `Once submitted, our Inflight VA Rep <@&${INFLIGHT_VA_REP_ROLE_ID}> will review and approve it.`
                        )
                        .setFooter({ text: BRAND_FOOTER })],
                    components: [setupRow]
                }).catch(() => {});
                return;
            }

            // --- VA PARTNERSHIP: START APPLICATION ---
            if (customId === 'partnership_apply_va') {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable right now.', ephemeral: true });
                }
                await interaction.showModal(buildVaApplyModal());
                return;
            }
        }

        // --- 3. SELECT MENU HANDLERS ---
        if (interaction.isStringSelectMenu()) {

            // --- AIRCRAFT PICKER: STEP 1 (aircraft) / STEP 2 (livery) ---
            if (interaction.customId.startsWith('pick_type_') || interaction.customId.startsWith('pick_livery_')) {
                const isType = interaction.customId.startsWith('pick_type_');
                const session = getPickerSession(interaction.customId.replace(isType ? 'pick_type_' : 'pick_livery_', ''));
                if (!session) return interaction.update(PICKER_EXPIRED).catch(() => {});
                if (session.userId !== interaction.user.id) {
                    return interaction.reply({ content: "That picker isn't yours.", ephemeral: true });
                }
                const chosen = interaction.values[0];
                if (isType) {
                    // Step 1 → step 2: the livery list is per-aircraft, so the
                    // search from step 1 would filter the wrong list.
                    session.type = chosen;
                    session.step = 'livery';
                    session.query = '';
                    session.page = 0;
                    return interaction.update(await renderPicker(session)).catch(() => {});
                }
                pickerSessions.delete(session.id);
                // Both halves came straight from the API lists, so there is
                // nothing for the normalizer to improve and a listed aircraft is
                // never flagged.
                return session.apply(interaction, session.type, chosen, { keepWording: true });
            }

            // --- PHOTO MANAGER: REORDER / REMOVE (from /photos) ---
            if (interaction.customId.startsWith('photos_move_') || interaction.customId.startsWith('photos_del_')) {
                if (!isPhotoStaff(interaction)) {
                    return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
                }
                const isMove = interaction.customId.startsWith('photos_move_');
                const recordId = interaction.customId.replace(isMove ? 'photos_move_' : 'photos_del_', '');
                await interaction.deferUpdate();
                try {
                    // Re-read the record on every action: another staff member may
                    // have reordered or removed a photo since this manager was
                    // rendered, and the slot numbers in these options would then
                    // point at the wrong photos.
                    const entry = await CommunityAircraftModel.findById(recordId).catch(() => null);
                    if (!entry) {
                        return interaction.editReply({ content: '❌ That record no longer exists.', embeds: [], components: [] }).catch(() => {});
                    }
                    const images = getEntryImages(entry);
                    const contributors = getEntryContributors(entry);

                    if (isMove) {
                        const [from, to] = String(interaction.values[0]).split(':').map(n => parseInt(n, 10));
                        if (!moveAircraftPhoto(images, contributors, from - 1, to - 1)) {
                            await interaction.editReply(buildPhotoManager(entry)).catch(() => {});
                            return interaction.followUp({ content: '⚠️ Those slots have changed since this was opened — the manager is refreshed above.', ephemeral: true }).catch(() => {});
                        }
                        await saveAircraftImages(entry, images, contributors);
                        await logPhotoAction(interaction, entry, `↕️ Moved Photo ${from} → Photo ${to}.`);
                        return interaction.editReply(buildPhotoManager(entry)).catch(() => {});
                    }

                    // Removal deletes the file from S3, so it asks first — in its
                    // own ephemeral message, leaving the manager on screen.
                    const slot = parseInt(interaction.values[0], 10);
                    if (!(slot >= 1 && slot <= images.length) || images.length <= 1) {
                        await interaction.editReply(buildPhotoManager(entry)).catch(() => {});
                        return interaction.followUp({ content: '⚠️ That photo is no longer there — the manager is refreshed above.', ephemeral: true }).catch(() => {});
                    }
                    return interaction.followUp({
                        content: `⚠️ Deleting **Photo ${slot}** of **${entry.aircraftType}** (${entry.liveryName}) removes it from storage permanently — the photos after it move up a slot. Reorder it instead if you only want it out of the way.`,
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`photos_delok_${recordId}_${slot}`).setLabel(`Delete Photo ${slot}`).setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
                            new ButtonBuilder().setCustomId('photos_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                        )],
                        ephemeral: true
                    }).catch(() => {});
                } catch (e) {
                    console.error('Photo manager action failed:', e);
                    return interaction.followUp({ content: '⚠️ That didn\'t go through — nothing was changed.', ephemeral: true }).catch(() => {});
                }
            }

            // --- BOUNTY BOARD SORTING MENU ---
            if (interaction.customId.startsWith('bnty_sort_')) {
                await interaction.deferUpdate();
                const sortBy = interaction.values[0];
                try {
                    // Reset to page 0 whenever the sort method changes
                    const payload = await generateBountyBoard(0, sortBy);
                    await interaction.editReply(payload);
                } catch (e) {
                    await interaction.followUp({ content: 'Error changing sort order.', ephemeral: true });
                }
                return;
            }

            if (interaction.customId === 'ticket_topic_select') {
                // VA Partnership runs its own flow: a ticket that pings the
                // Inflight VA Rep and walks the user through the ToS + setup,
                // so it skips the generic "describe your issue" modal.
                if (interaction.values[0] === 'va_partnership') {
                    await interaction.deferReply({ ephemeral: true });
                    try {
                        const thread = await openPartnershipTicket(interaction);
                        await interaction.editReply(`✅ Partnership ticket opened: <#${thread.id}>`);
                    } catch (e) {
                        console.error('❌ Partnership ticket error:', e);
                        await interaction.editReply('❌ Could not open a partnership ticket. Please try again or contact staff.');
                    }
                    return;
                }
                const modal = new ModalBuilder().setCustomId(`ticket_modal_${interaction.values[0]}`).setTitle('Ticket Details');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_desc').setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(false)));
                await interaction.showModal(modal);
                return;
            }
        }

        // --- 4. MODAL SUBMIT HANDLERS ---
        if (interaction.isModalSubmit()) {
            const customId = interaction.customId;

            // --- AIRCRAFT PICKER MODALS (search / manual entry) ---
            if (customId.startsWith('pick_searchmodal_') || customId.startsWith('pick_manualmodal_')) {
                const isSearch = customId.startsWith('pick_searchmodal_');
                const session = getPickerSession(customId.replace(isSearch ? 'pick_searchmodal_' : 'pick_manualmodal_', ''));
                if (!session) return interaction.update(PICKER_EXPIRED).catch(() => {});
                if (session.userId !== interaction.user.id) {
                    return interaction.reply({ content: "That picker isn't yours.", ephemeral: true });
                }
                if (isSearch) {
                    session.query = (interaction.fields.getTextInputValue('p_query') || '').trim();
                    session.page = 0;
                    return interaction.update(await renderPicker(session)).catch(() => {});
                }
                const rawType = (interaction.fields.getTextInputValue('p_type') || '').trim();
                const rawLivery = (interaction.fields.getTextInputValue('p_livery') || '').trim();

                // The normalizer matches by substring and then fuzzily, so a
                // genuinely new aircraft can be rewritten into an older one that
                // merely reads like it. Where it wants to change what was typed,
                // the submitter decides which one is right.
                let match = { type: rawType, livery: rawLivery };
                try {
                    const normalized = await normalizeData(rawType, rawLivery);
                    match = { type: normalized.type, livery: normalized.livery };
                } catch (e) { console.error('Picker normalize failed:', e); }

                const rewritten = match.type.toLowerCase() !== rawType.toLowerCase()
                    || match.livery.toLowerCase() !== rawLivery.toLowerCase();
                if (rewritten) {
                    session.raw = { type: rawType, livery: rawLivery };
                    session.match = match;
                    return interaction.update(renderPickerConfirm(session)).catch(() => {});
                }

                pickerSessions.delete(session.id);
                return session.apply(interaction, rawType, rawLivery, { keepWording: true });
            }

            if (customId === 'identify_modal') {
                await interaction.deferReply({ ephemeral: true });
                const type = interaction.fields.getTextInputValue('i_type');
                const livery = interaction.fields.getTextInputValue('i_livery');
                const originalMsg = await interaction.channel.messages.fetch(interaction.message.reference.messageId).catch(() => null);
                if (!originalMsg?.attachments.first()) return interaction.editReply("❌ Image not found.");
                await startSubmissionFlow(interaction, type, livery, null, originalMsg.attachments.first().url, interaction.user, interaction.channelId);
                try { await interaction.message.delete(); } catch(e) {}
                return;
            }

            if (customId === 'admin_edit_modal') {
                await interaction.deferUpdate();
                let newTail = interaction.fields.getTextInputValue('ae_tail');
                const newType = interaction.fields.getTextInputValue('ae_type');
                const newLivery = interaction.fields.getTextInputValue('ae_livery');
                const oldEmbed = interaction.message.embeds[0];
                const oldTail = oldEmbed.fields.find(f => f.name === 'Tail Number')?.value || 'UNKNOWN';

                if (newTail === oldTail || newTail.toUpperCase() === 'UNKNOWN') {
                    newTail = lookupRegistration(newType, newLivery) || newTail;
                }

                // Same rebuild a submitter correction goes through — fields, a
                // fresh duplicate check, and the footer kept intact.
                await rebuildReviewCard(interaction.message, { tail: newTail, type: newType, livery: newLivery });
                return;
            }

            if (customId.startsWith('rejectModal_')) {
                await interaction.deferUpdate();
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                const oldEmbed = interaction.message.embeds[0];
                const publicMsgId = (oldEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const originChannelId = (oldEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];
                // Grab the image being rejected so we can show it to the user.
                const rejectedImageUrl = oldEmbed.image?.url || interaction.message.attachments.first()?.url;

                // The same reason staff just typed is what the submitter reads in
                // the gallery — one decision, one wording, not two.
                await closeSubmission(oldEmbed.footer?.text, {
                    status: 'rejected',
                    reason,
                    reviewedBy: interaction.user.username,
                });

                // Keep the photo visible on the admin message (don't null it) so the
                // record of what was rejected stays intact.
                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}`)], components: [] });

                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        // components: [] drops the submitter's Fix Details button —
                        // a rejected submission is closed, not correctable.
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\nThis submission was not approved.`).setImage(null)], attachments: [], components: [] });
                    } catch(e) {}
                }

                if (originChannelId) {
                    const channel = await client.channels.fetch(originChannelId).catch(() => null);
                    if (channel) {
                        const userEmbed = themedEmbed(SUB_STATE.REJECTED.color)
                            .setTitle('❌ Photo Rejected')
                            .setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}\n\nFeel free to submit a new photo — corrections are welcome!`);
                        const payload = { content: `<@${targetUserId}>`, embeds: [userEmbed] };
                        // Re-upload the rejected image onto the user's message so they can
                        // see exactly what was declined (and it stays persistent).
                        if (rejectedImageUrl) {
                            userEmbed.setImage('attachment://rejected.webp');
                            payload.files = [{ attachment: rejectedImageUrl, name: 'rejected.webp' }];
                        }
                        await channel.send(payload).catch(() => {});
                    }
                }

                // Defensive: submissions carry a Discord-hosted attachment into
                // review (nothing of ours in S3 until approval), so normally there's
                // nothing to clean here. But if a rejected image is ever already in
                // our bucket, remove it so a decline can't orphan a stored object.
                if (isOwnCommunityS3Url(rejectedImageUrl)) {
                    await deleteImageFromS3(rejectedImageUrl);
                }
                return;
            }

            if (customId === 'airport_modal') {
                await interaction.deferReply({ ephemeral: true });
                const icao = interaction.fields.getTextInputValue('a_icao').toUpperCase().trim();

                // Defensive: the prompt message we replied to may have been
                // deleted (or never had a reference in the first place).
                // Without these guards a single missing attachment threw an
                // uncaught error and the user saw a frozen spinner.
                const referencedId = interaction.message?.reference?.messageId;
                if (!referencedId) {
                    return interaction.editReply("❌ I couldn't find the original photo message — please re-upload.");
                }
                const originalMsg = await interaction.channel.messages.fetch(referencedId).catch(() => null);
                const photo = originalMsg?.attachments?.first();
                if (!photo) {
                    return interaction.editReply("❌ The original photo is no longer available. Please re-upload.");
                }
                const photoUrl = photo.url;

                try {
                    const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                    const publicMsg = await feedChannel.send({ embeds: [themedEmbed(SUB_STATE.PENDING.color).setTitle('🏢 New Airport Submission').setDescription(`**Status:** ${SUB_STATE.PENDING.badge}`).setImage(photoUrl).addFields({ name: 'ICAO', value: icao })] });

                    const adminEmbed = themedEmbed(SUB_STATE.PENDING.color).setTitle('🏢 Airport Review — Awaiting Approval').setDescription(`**Status:** ${SUB_STATE.PENDING.badge}`).setImage(photoUrl).addFields({ name: 'ICAO', value: icao }).setFooter({ text: `User: ${interaction.user.id} | Msg: ${publicMsg.id} | Ch: ${interaction.channelId}` });
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`approve_apt_${interaction.user.id}_${icao}`).setLabel('Approve').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`reject_apt_${interaction.user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
                    const adminChannel = await client.channels.fetch(AIRPORT_ADMIN_CHANNEL_ID);
                    await adminChannel.send({ embeds: [adminEmbed], components: [row] });
                    await interaction.editReply("✅ Sent for review.");
                    try { await interaction.message.delete(); } catch(e) {}
                } catch (err) {
                    console.error('Airport submission send failed:', err);
                    await interaction.editReply("❌ Couldn't post for review. Please try again or contact an admin.");
                }
                return;
            }

            if (customId.startsWith('rejectAptModal_')) {
                await interaction.deferUpdate();
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reasonInput');
                const oldEmbed = interaction.message.embeds[0];
                const publicMsgId = (oldEmbed.footer?.text || '').match(/Msg: (\d+)/)?.[1];
                const originChannelId = (oldEmbed.footer?.text || '').match(/Ch: (\d+)/)?.[1];
                const rejectedImageUrl = oldEmbed.image?.url;

                await interaction.editReply({ embeds: [EmbedBuilder.from(oldEmbed).setTitle('❌ Airport Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}`)], components: [] });
                if (publicMsgId) {
                    try {
                        const feed = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);
                        const msg = await feed.messages.fetch(publicMsgId);
                        await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle('❌ Rejected').setColor(SUB_STATE.REJECTED.color).setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}`).setImage(null)] });
                    } catch(e) {}
                }
                if (originChannelId) {
                    const ch = await client.channels.fetch(originChannelId).catch(() => null);
                    if (ch) {
                        const userEmbed = themedEmbed(SUB_STATE.REJECTED.color)
                            .setTitle('❌ Airport Photo Rejected')
                            .setDescription(`**Status:** ${SUB_STATE.REJECTED.badge}\n**Reason:** ${reason}\n\nFeel free to submit a new photo.`);
                        const payload = { content: `<@${targetUserId}>`, embeds: [userEmbed] };
                        if (rejectedImageUrl) {
                            userEmbed.setImage('attachment://rejected.webp');
                            payload.files = [{ attachment: rejectedImageUrl, name: 'rejected.webp' }];
                        }
                        await ch.send(payload).catch(() => {});
                    }
                }
                return;
            }

            if (customId.startsWith('ticket_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                const topic = customId.replace('ticket_modal_', '');
                const desc = interaction.fields.getTextInputValue('ticket_desc') || 'No description';
                const thread = await interaction.channel.threads.create({ name: `ticket-${interaction.user.username}-${topic}`, type: ChannelType.PrivateThread, reason: 'Support Ticket' });
                await thread.members.add(interaction.user.id);
                const embed = new EmbedBuilder().setTitle('🎫 Support Ticket').addFields({ name: 'Topic', value: topic }, { name: 'Description', value: desc }).setColor(THEME.WHITE);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_action').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
                await thread.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [row] });
                await interaction.editReply(`Ticket created: <#${thread.id}>`);
                return;
            }

            // --- VA APPLICATION SUBMITTED ---
            if (customId === 'va_apply_modal') {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable (database not connected).');

                const name = interaction.fields.getTextInputValue('va_name').trim();
                // Store the mask exactly as the applicant wrote it, tag and all
                // — "OCEAN ##VA", "SHAMROCK ###EX", "BAW ###". The tag is the
                // half every matcher reads (vaCallsignParts), so stripping it
                // here to a bare base threw away the one thing a VA with a
                // non-"VA" tag needs us to keep; a bare base is then read as the
                // legacy "##VA" form and their real callsigns stop matching.
                // Same rule as cleanCallsignInput on the server: trim, uppercase,
                // store. Display collapses the mask, so nothing doubles up.
                const callsign = (interaction.fields.getTextInputValue('va_callsign') || '')
                    .trim().toUpperCase().replace(/\s+/g, ' ') || null;
                let type = (interaction.fields.getTextInputValue('va_type') || 'VA').trim().toUpperCase();
                if (type !== 'VA' && type !== 'VO') type = 'VA';
                const tagline = (interaction.fields.getTextInputValue('va_tagline') || '').trim().slice(0, 140);
                const linksRaw = (interaction.fields.getTextInputValue('va_links') || '').trim();

                // Parse the free-text links field: a discord invite vs a generic
                // website. Both are optional; a bare "discord.gg/…" (no scheme)
                // is accepted and normalised into a clickable https:// link.
                let websiteUrl = null, discordUrl = null;
                for (const line of linksRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)) {
                    if (/discord(\.gg|app\.com|\.com)/i.test(line)) {
                        discordUrl = /^https?:\/\//i.test(line) ? line : `https://${line}`;
                    } else if (!websiteUrl) websiteUrl = line;
                }

                try {
                    // Names are unique in the directory. Reuse an existing pending row the
                    // same owner already submitted (a re-apply after a "request edits"),
                    // otherwise refuse to clash with someone else's VA.
                    let ad = await VirtualAirlineAd.findOne({ name });
                    if (ad) {
                        if (ad.status === 'approved') {
                            return interaction.editReply(`⚠️ **${name}** is already registered and approved.`);
                        }
                        if (ad.ownerId && ad.ownerId !== interaction.user.id) {
                            return interaction.editReply(`❌ A VA named **${name}** has already been submitted by someone else. Please use a different name.`);
                        }
                        ad.callsign = callsign; ad.type = type; ad.tagline = tagline;
                        ad.websiteUrl = websiteUrl; ad.discordUrl = discordUrl;
                        ad.ownerId = interaction.user.id; ad.ownerName = interaction.user.username;
                        ad.status = 'pending';
                    } else {
                        ad = new VirtualAirlineAd({
                            name, callsign, type, tagline, websiteUrl, discordUrl,
                            ownerId: interaction.user.id, ownerName: interaction.user.username,
                            status: 'pending'
                        });
                    }
                    await ad.save();

                    const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                    if (reviewChannel) {
                        // Self-heal: make sure the Inflight VA Rep can see (and act on)
                        // the review channel, since they can now review applications.
                        if (reviewChannel.permissionOverwrites && !reviewChannel.permissionOverwrites.cache.get(INFLIGHT_VA_REP_ROLE_ID)) {
                            await reviewChannel.permissionOverwrites.edit(INFLIGHT_VA_REP_ROLE_ID, {
                                ViewChannel: true, SendMessages: true, ReadMessageHistory: true
                            }).catch(() => {});
                        }
                        await reviewChannel.send({
                            content: `<@&${ADMIN_ROLE_ID}> <@&${INFLIGHT_VA_REP_ROLE_ID}> new VA application`,
                            embeds: [buildVaReviewEmbed(ad)],
                            components: [buildVaReviewButtons(ad._id)]
                        });
                    }
                    return interaction.editReply(`✅ Your application for **${name}** has been submitted! Staff will review it shortly.`);
                } catch (e) {
                    console.error('❌ VA apply error:', e);
                    return interaction.editReply('❌ Could not submit your application. Please try again later.');
                }
            }

            // --- VA: REJECT (with reason) ---
            if (customId.startsWith('va_reject_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const [adId, msgId] = customId.replace('va_reject_modal_', '').split('_');
                const reason = interaction.fields.getTextInputValue('va_reason');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found.');

                ad.status = 'rejected';
                try { await ad.save(); } catch (_) {}

                if (ad.ownerId) {
                    const owner = await client.users.fetch(ad.ownerId).catch(() => null);
                    if (owner) await owner.send(`❌ Your VA application for **${ad.name}** was rejected.\n**Reason:** ${reason}`).catch(() => {});
                }
                // Update the original review message.
                const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                const reviewMsg = reviewChannel ? await reviewChannel.messages.fetch(msgId).catch(() => null) : null;
                if (reviewMsg) {
                    const rejEmbed = EmbedBuilder.from(reviewMsg.embeds[0] || buildVaReviewEmbed(ad))
                        .setTitle('❌ VA Application — Rejected')
                        .setColor(THEME.GRAY)
                        .addFields({ name: 'Rejection Reason', value: reason });
                    await reviewMsg.edit({ embeds: [rejEmbed], components: [] }).catch(() => {});
                }
                return interaction.editReply(`❌ Rejected **${ad.name}** and notified the applicant.`);
            }

            // --- VA: REQUEST EDITS ---
            if (customId.startsWith('va_editreq_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const [adId, msgId] = customId.replace('va_editreq_modal_', '').split('_');
                const changes = interaction.fields.getTextInputValue('va_changes');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ Application not found.');

                if (ad.ownerId) {
                    const owner = await client.users.fetch(ad.ownerId).catch(() => null);
                    if (owner) await owner.send(`✏️ Edits requested for your VA application **${ad.name}**:\n> ${changes}\n\nPlease run \`/va_apply\` again with the same name to resubmit.`).catch(() => {});
                }
                const reviewChannel = await client.channels.fetch(VA_APPLICATION_CHANNEL_ID).catch(() => null);
                const reviewMsg = reviewChannel ? await reviewChannel.messages.fetch(msgId).catch(() => null) : null;
                if (reviewMsg) {
                    await reviewMsg.reply(`✏️ <@${interaction.user.id}> requested edits from <@${ad.ownerId}>:\n> ${changes}`).catch(() => {});
                }
                return interaction.editReply('✏️ Edit request sent to the applicant. The application stays pending.');
            }

            // --- VA SETUP: DETAILS SUBMITTED (post-approval profile fill-in) ---
            if (customId.startsWith('va_setup_details_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const adId = customId.replace('va_setup_details_modal_', '');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ This VA listing no longer exists.');
                if (!canManageVa(interaction, ad)) return interaction.editReply('❌ Only this VA\'s owner (or staff) can edit its listing.');

                const splitList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const description = (interaction.fields.getTextInputValue('va_description') || '').trim();
                const region = (interaction.fields.getTextInputValue('va_region') || '').trim();
                const requirements = (interaction.fields.getTextInputValue('va_requirements') || '').trim();

                ad.description = description;
                if (region) ad.region = region;
                ad.hubs = splitList(interaction.fields.getTextInputValue('va_hubs')).map(h => h.toUpperCase());
                ad.fleet = splitList(interaction.fields.getTextInputValue('va_fleet')).map(f => f.toUpperCase());
                ad.requirements = requirements;

                try {
                    await ad.save();
                } catch (e) {
                    console.error('❌ VA setup details save error:', e);
                    return interaction.editReply('❌ Could not save those details. Please try again.');
                }
                return interaction.editReply({ content: '✅ Details saved! Here\'s how your listing looks now:', embeds: [buildVaInfoEmbed(ad)] });
            }

            // --- VA SETUP: LINKS & RECRUITING SUBMITTED ---
            if (customId.startsWith('va_setup_links_modal_')) {
                await interaction.deferReply({ ephemeral: true });
                if (!VirtualAirlineAd) return interaction.editReply('❌ VA system unavailable.');
                const adId = customId.replace('va_setup_links_modal_', '');
                const ad = await VirtualAirlineAd.findById(adId).catch(() => null);
                if (!ad) return interaction.editReply('❌ This VA listing no longer exists.');
                if (!canManageVa(interaction, ad)) return interaction.editReply('❌ Only this VA\'s owner (or staff) can edit its listing.');

                const splitList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const applicationUrl = (interaction.fields.getTextInputValue('va_applicationUrl') || '').trim();
                const ifcThreadUrl = (interaction.fields.getTextInputValue('va_ifcThreadUrl') || '').trim();
                const minGradeRaw = (interaction.fields.getTextInputValue('va_minGrade') || '').trim();
                const pilotCountRaw = (interaction.fields.getTextInputValue('va_pilotCount') || '').trim();

                ad.applicationUrl = applicationUrl || null;
                ad.ifcThreadUrl = ifcThreadUrl || null;

                const minGrade = parseInt(minGradeRaw, 10);
                ad.minGrade = (Number.isInteger(minGrade) && minGrade >= 1 && minGrade <= 5) ? minGrade : null;

                const pilotCount = parseInt(pilotCountRaw, 10);
                if (Number.isInteger(pilotCount) && pilotCount >= 0) ad.pilotCount = pilotCount;

                ad.tags = splitList(interaction.fields.getTextInputValue('va_tags')).map(t => t.toLowerCase());

                try {
                    await ad.save();
                } catch (e) {
                    console.error('❌ VA setup links save error:', e);
                    return interaction.editReply('❌ Could not save those links. Please try again.');
                }
                return interaction.editReply({ content: '✅ Links & recruiting info saved! Here\'s your updated listing:', embeds: [buildVaInfoEmbed(ad)] });
            }
        }

        // --- 5. SLASH COMMAND HANDLERS ---
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            // --- BOUNTY BOARD COMMAND ---
            if (commandName === 'bounty_board') {
                await interaction.deferReply();
                try {
                    const payload = await generateBountyBoard(0, 'type');
                    await interaction.editReply(payload);
                } catch (e) {
                    console.error(e);
                    await interaction.editReply('❌ Error generating the board. Ensure database connection is active.');
                }
                return;
            }

            if (commandName.startsWith('mod_')) {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
                }
                const targetUser = interaction.options.getUser('user');
                const targetMember = targetUser ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
                const reason = interaction.options.getString('reason') || 'No reason provided';

                try {
                    if (commandName === 'mod_kick' && targetMember) {
                        await targetMember.kick(reason);
                        await interaction.reply({ content: `✅ Kicked ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('KICK', interaction.user, targetUser, reason);
                    } else if (commandName === 'mod_ban') {
                        await interaction.guild.members.ban(targetUser, { reason });
                        await interaction.reply({ content: `✅ Banned ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('BAN', interaction.user, targetUser, reason);
                    } else if (commandName === 'mod_timeout' && targetMember) {
                        const duration = interaction.options.getInteger('duration');
                        await targetMember.timeout(duration * 60 * 1000, reason);
                        await interaction.reply({ content: `✅ Timed out ${targetUser.tag}.`, ephemeral: true });
                        await logModAction('TIMEOUT', interaction.user, targetUser, reason, `Duration: ${duration}m`);
                    } else if (commandName === 'mod_purge') {
                        const amount = interaction.options.getInteger('amount');
                        const deleted = await interaction.channel.bulkDelete(amount, true);
                        await interaction.reply({ content: `✅ Deleted ${deleted.size} msgs.`, ephemeral: true });
                        await logModAction('PURGE', interaction.user, interaction.channel, 'Bulk Delete', `Count: ${deleted.size}`);
                    } else if (commandName === 'mod_lock') {
                        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
                        await interaction.reply({ content: '🔒 Locked.', ephemeral: true });
                        await logModAction('LOCK', interaction.user, interaction.channel, 'Lockdown');
                    } else if (commandName === 'mod_unlock') {
                        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null });
                        await interaction.reply({ content: '🔓 Unlocked.', ephemeral: true });
                        await logModAction('UNLOCK', interaction.user, interaction.channel, 'Unlock');
                    }
                } catch (e) { console.error(e); }
                return;
            }

            if (commandName === 'track') {
                await interaction.deferReply();
                const query = interaction.options.getString('target').toUpperCase().trim();
                const LIVE_API_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run';
                try {
                    const sessionsRes = await axios.get(`${LIVE_API_URL}/if-sessions`);
                    const session = sessionsRes.data.sessions.find(s => s.name === 'Expert Server');
                    if (!session) return interaction.editReply("❌ Expert Server offline.");
                    const flightsRes = await axios.get(`${LIVE_API_URL}/flights/${session.id}`);
                    const match = flightsRes.data.flights.find(f => f.username?.toUpperCase().includes(query) || f.callsign?.toUpperCase().includes(query));
                    if (!match) return interaction.editReply(`❌ Pilot "${query}" not found.`);
                    
                    const phase = match.position.alt_ft < 1000 && match.position.gs_kt < 40 ? 'On Ground' : 'Flying';
                    const embed = new EmbedBuilder().setTitle(`📡 Tracking: ${match.callsign}`).setColor(THEME.WHITE).addFields({ name: 'Pilot', value: match.username || 'Unknown', inline: true }, { name: 'Aircraft', value: match.aircraft?.aircraftName || 'Unknown', inline: true }, { name: 'Altitude', value: `${Math.round(match.position.alt_ft).toLocaleString()} ft`, inline: true }, { name: 'Status', value: phase, inline: true });
                    await interaction.editReply({ embeds: [embed] });
                } catch (e) { await interaction.editReply("❌ API Connection Failed."); }
                return;
            }

            if (commandName === 'hangar') {
                await interaction.deferReply();
                const target = interaction.options.getUser('user') || interaction.user;
                try {
                    const stats = await CommunityAircraftModel.aggregate([{ $match: { $or: [{ contributorId: target.id }, { contributorName: target.username }] } }, { $group: { _id: null, total: { $sum: 1 }, types: { $addToSet: "$aircraftType" }, liveries: { $addToSet: "$liveryName" } } }]);
                    if (!stats.length) return interaction.editReply(`📂 ${target.username}'s hangar is empty.`);
                    const embed = new EmbedBuilder().setTitle(`✈️ ${target.username}'s Hangar`).setColor(THEME.WHITE).addFields({ name: 'Total Photos', value: `${stats[0].total}`, inline: true }, { name: 'Unique Types', value: `${stats[0].types.length}`, inline: true });
                    const latest = await CommunityAircraftModel.findOne({ $or: [{ contributorId: target.id }, { contributorName: target.username }] }).sort({ uploadedAt: -1 });
                    if (latest) embed.setImage(latest.imageUrl);
                    await interaction.editReply({ embeds: [embed] });
                } catch (e) { await interaction.editReply("❌ Database Error."); }
                return;
            }

            // --- GIVEAWAY COMMAND ---
            if (commandName === 'giveaway') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
                }

                const durationMin = interaction.options.getInteger('duration');
                const prize = interaction.options.getString('prize') || DEFAULT_GIVEAWAY_PRIZE;
                const delivery = interaction.options.getString('delivery') || 'mod_message';
                const endsAt = Date.now() + durationMin * 60 * 1000;
                const endsUnix = Math.floor(endsAt / 1000);

                const embed = new EmbedBuilder()
                    .setTitle('🎉 GIVEAWAY 🎉')
                    .setColor(THEME.WHITE)
                    .setDescription('Click the button below to enter!')
                    .addFields(
                        { name: 'Prize', value: prize, inline: false },
                        { name: 'Ends', value: `<t:${endsUnix}:R> (<t:${endsUnix}:f>)`, inline: false },
                        { name: 'Entries', value: '0', inline: true },
                        { name: 'Hosted by', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setFooter({ text: BRAND_FOOTER })
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('giveaway_enter').setLabel('Enter Giveaway').setEmoji('🎉').setStyle(ButtonStyle.Success)
                );

                await interaction.reply({ content: '✅ Giveaway started!', ephemeral: true });
                const giveawayMessage = await interaction.channel.send({ embeds: [embed], components: [row] });

                activeGiveaways.set(giveawayMessage.id, {
                    prize,
                    delivery,
                    hostId: interaction.user.id,
                    channelId: interaction.channel.id,
                    messageId: giveawayMessage.id,
                    entrants: new Set(),
                    endsAt,
                    ended: false
                });

                // Persist so the giveaway survives a restart, then arm the timer.
                await persistGiveaway(giveawayMessage.id);
                scheduleGiveawayEnd(giveawayMessage.id, endsAt);
                return;
            }

            // --- VA: APPLY (opens the application modal) ---
            if (commandName === 'va_apply') {
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable right now.', ephemeral: true });
                }
                await interaction.showModal(buildVaApplyModal());
                return;
            }

            // --- VA: STAFF MANAGEMENT (add/remove rep, remove VA) ---
            if (commandName === 'va_addrep' || commandName === 'va_removerep' || commandName === 'va_remove') {
                if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
                }
                if (!VirtualAirlineAd) {
                    return interaction.reply({ content: '❌ VA system unavailable.', ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });

                const vaName = interaction.options.getString('va');
                const ad = await VirtualAirlineAd.findOne({ name: vaName }).catch(() => null);
                if (!ad) return interaction.editReply(`❌ No VA named **${vaName}** found.`);

                // --- FULL REMOVAL ---
                // Wipes EVERYTHING tied to the VA, not just its Discord space, so it
                // must work even when the role/channel is already gone (hence it runs
                // before the role guards below). Because it is irreversible — portal
                // accounts, submissions, embeds and S3 images all go too — we confirm
                // with a button before touching anything.
                if (commandName === 'va_remove') {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`va_purge_confirm_${ad._id}`).setLabel('Delete everything').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
                        new ButtonBuilder().setCustomId(`va_purge_cancel_${ad._id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.editReply({
                        content: `⚠️ **Permanently remove ${ad.name}?**\n` +
                            `This deletes its Discord channel & role, every portal account (owner + staff), ` +
                            `all submissions, scheduled events and activity history, its live-map embeds, ` +
                            `the saved flight-events webhook, and the VA's logo & banner — and removes the ` +
                            `public listing.\n**This cannot be undone.**`,
                        components: [row],
                    });
                }

                // --- REP MANAGEMENT (add/remove) needs the provisioned role. ---
                if (!ad.discordRoleId) return interaction.editReply(`❌ **${vaName}** hasn't been provisioned yet (approve its application first).`);

                const vaRole = interaction.guild.roles.cache.get(ad.discordRoleId) || await interaction.guild.roles.fetch(ad.discordRoleId).catch(() => null);
                if (!vaRole) return interaction.editReply(`❌ The role for **${vaName}** no longer exists.`);

                // add/remove rep
                const user = interaction.options.getUser('user');
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                if (!member) return interaction.editReply('❌ That user is not in this server.');

                try {
                    if (commandName === 'va_addrep') {
                        const repRole = await ensureVaRepRole(interaction.guild);
                        await member.roles.add(vaRole).catch(() => {});
                        if (repRole) await member.roles.add(repRole).catch(() => {});

                        // Give the rep their own Partnership Portal login too.
                        // Idempotent per Discord user: re-adding someone revives a
                        // paused account instead of minting a duplicate.
                        let portalLine = '';
                        if (typeof provisionVaPortalRepAccount === 'function') {
                            try {
                                const { created, reactivated, username, password } = await provisionVaPortalRepAccount(ad, {
                                    discordUserId: user.id,
                                    discordUsername: user.username,
                                    displayName: member.displayName || user.username,
                                    createdByName: `Bot (added by ${interaction.user.username})`,
                                });
                                if (password) {
                                    // Credentials go to the rep in a DM, never into the channel.
                                    const dmOk = await user.send(
                                        `👋 You've been added as a representative of **${ad.name}** on Inflight!\n\n` +
                                        `🔐 **Your VA Partnership Portal account is ready.**\n` +
                                        `Log in at ${VA_PORTAL_URL} to submit documents, requests and reports for your VA.\n` +
                                        `• Username: \`${username}\`\n` +
                                        `• Temporary password: \`${password}\`\n` +
                                        `Please change your password after your first login.`
                                    ).then(() => true).catch(() => false);
                                    portalLine = dmOk
                                        ? `\n🔐 Portal account \`@${username}\` ${reactivated ? 'reactivated' : 'created'} — credentials DM'd to them.`
                                        : `\n🔐 Portal account \`@${username}\` ${reactivated ? 'reactivated' : 'created'}, but their DMs are closed. ` +
                                          `Temporary password: ||\`${password}\`|| — please pass it on privately.`;
                                } else if (!created) {
                                    portalLine = `\n🔐 They already have portal access as \`@${username}\`.`;
                                }
                            } catch (e) {
                                console.error('❌ va_addrep portal provision error:', e);
                                portalLine = '\n⚠️ Could not set up their portal account — create one manually from the VA Ads manager.';
                            }
                        }
                        return interaction.editReply(`✅ Added <@${user.id}> as a rep of **${vaName}** (VA channel + reps chat access granted).${portalLine}`);
                    } else {
                        // Remove only the VA-specific role; keep the shared rep role since
                        // the user may represent other VAs.
                        await member.roles.remove(vaRole).catch(() => {});

                        // Pause (don't delete) any portal account the bot provisioned
                        // for them on this VA; /va_addrep revives it.
                        let portalLine = '';
                        if (typeof deactivateVaPortalRepAccount === 'function') {
                            try {
                                const paused = await deactivateVaPortalRepAccount(ad, user.id, {
                                    actorName: `Bot (removed by ${interaction.user.username})`,
                                });
                                if (paused) portalLine = '\n🔐 Their portal access has been paused (re-adding them restores it).';
                            } catch (e) {
                                console.error('❌ va_removerep portal deactivate error:', e);
                            }
                        }
                        return interaction.editReply(`✅ Removed <@${user.id}> from **${vaName}**. (They keep the shared VA Rep role in case they rep other VAs — remove it manually if needed.)${portalLine}`);
                    }
                } catch (e) {
                    console.error('❌ va rep management error:', e);
                    return interaction.editReply('❌ Failed to update roles. Check the bot has **Manage Roles** and its role is above the VA roles.');
                }
            }
        }
        
        if (interaction.commandName === 'setup_tickets') {
            if (!interaction.member.permissions.has(GatewayIntentBits.Administrator) && interaction.channelId !== ADMIN_CHANNEL_ID) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            const ticketEmbed = new EmbedBuilder()
                .setTitle('🎫 Inflight Support')
                .setDescription('Click the button below to open a private support ticket.\n\nYou can ask about:\n• Database corrections\n• Submission issues\n• 🤝 VA partnerships\n• 💳 Inflight Pro subscription issues\n• Role/Account help')
                .setColor(THEME.WHITE)
                .setFooter({ text: 'Our team will assist you as soon as possible.' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('create_ticket_start')
                    .setLabel('Open Ticket')
                    .setEmoji('📩')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.channel.send({ embeds: [ticketEmbed], components: [row] });
            await interaction.reply({ content: '✅ Ticket panel posted!', ephemeral: true });
        }

        if (interaction.commandName === 'links') {
            const embed = new EmbedBuilder()
                .setTitle('🔗 Useful Resources')
                .setColor(THEME.WHITE)
                .setDescription('Here are the links to the flight tracker, forum thread, and livery database:')
                .addFields(
                    { name: '📡 Flight Tracker', value: '[Inflight.info](https://inflight.info)', inline: true },
                    { name: '📢 Official Thread', value: '[Community Forum](https://community.infiniteflight.com/t/inflight-official-open-beta-infinite-flight-tracker-update/1114286/80)', inline: true },
                    { name: '🎨 Livery Database', value: '[Livery Search](https://www.helpathand.nl/janpolet/infinite-flight-aircraft-liveries/)', inline: true }
                )
                .setFooter({ text: 'Use these to verify registrations!' });

            await interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'migrate_legacy') {
            if (!interaction.member.permissions.has(GatewayIntentBits.Administrator) && interaction.channelId !== ADMIN_CHANNEL_ID) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            await interaction.deferReply();

            try {
                // Only pull the fields we need to keep memory small on large guilds.
                const legacyRecords = await CommunityAircraftModel.find({
                    $or: [{ contributorId: { $exists: false } }, { contributorId: null }]
                }).select('contributorName').lean();

                if (legacyRecords.length === 0) {
                    return interaction.editReply("✅ Database is fully linked! No legacy records found.");
                }

                const uniqueNames = [...new Set(legacyRecords.map(r => r.contributorName))];

                // Resolve each legacy name via search() instead of fetching the
                // whole roster — Discord's `members.fetch()` pulls every member
                // into RAM, which blew up memory on larger servers.
                const resolveMember = async (name) => {
                    try {
                        const results = await interaction.guild.members.search({ query: name, limit: 5 });
                        return results.find(m =>
                            m.user.username.toLowerCase() === name.toLowerCase() ||
                            m.displayName.toLowerCase() === name.toLowerCase()
                        );
                    } catch (e) {
                        return null;
                    }
                };

                let linkedCount = 0;
                let failedCount = 0;
                let log = [];

                for (const name of uniqueNames) {
                    const match = await resolveMember(name);

                    if (match) {
                        const res = await CommunityAircraftModel.updateMany(
                            { contributorName: name },
                            { 
                                $set: { 
                                    contributorId: match.id,
                                    contributorName: match.user.username 
                                } 
                            }
                        );
                        linkedCount += res.modifiedCount;
                        log.push(`✅ Linked **${name}** → <@${match.id}> (${res.modifiedCount} docs)`);
                    } else {
                        failedCount++;
                        log.push(`❌ Could not find user for: **${name}**`);
                    }
                }

                const reportEmbed = new EmbedBuilder()
                    .setTitle('🔄 Migration Report')
                    .setDescription(`**Processed:** ${uniqueNames.length} unique names\n**Records Updated:** ${linkedCount}\n**Unmatched Users:** ${failedCount}\n\n${log.slice(0, 15).join('\n')}${log.length > 15 ? '\n...(and more)' : ''}`)
                    .setColor(linkedCount > 0 ? 0x00FF00 : 0xFF0000);

                await interaction.editReply({ embeds: [reportEmbed] });

            } catch (error) {
                console.error("Migration Error:", error);
                await interaction.editReply("❌ Error running migration. Check console.");
            }
        }

        if (interaction.commandName === 'submit') {
            const type = interaction.options.getString('aircraft_type');
            const livery = interaction.options.getString('livery');
            const tail = null;
            const photo = interaction.options.getAttachment('photo');

            if (!photo.contentType.startsWith('image/')) {
                return interaction.reply({ content: '❌ Invalid image.', ephemeral: true });
            }

            await startSubmissionFlow(interaction, type, livery, tail, photo.url, interaction.user, interaction.channelId);
        }

        if (interaction.commandName === 'lookup') {
            const query = interaction.options.getString('query');
            await interaction.deferReply();
            try {
                const result = await CommunityAircraftModel.findOne({
                    $or: [
                        { tailNumber: { $regex: new RegExp(`^${escapeRegex(query)}$`, "i") } }, 
                        { tailNumber: { $regex: escapeRegex(query), $options: 'i' } },
                        { liveryName: { $regex: escapeRegex(query), $options: 'i' } },
                        { aircraftType: { $regex: escapeRegex(query), $options: 'i' } } 
                    ]
                });
                if (!result) await interaction.editReply(`❌ No match for "**${query}**".`);
                else {
                    const embed = new EmbedBuilder().setTitle(`🔍 ${result.tailNumber}`).setColor(THEME.WHITE).addFields({ name: 'Aircraft', value: result.aircraftType, inline: true }, { name: 'Livery', value: result.liveryName, inline: true }, { name: 'Contributor', value: result.contributorName, inline: true }).setImage(result.imageUrl).setTimestamp(result.uploadedAt);
                    await interaction.editReply({ embeds: [embed] });
                }
            } catch (e) { await interaction.editReply('⚠️ Search Error.'); }
        }

        if (interaction.commandName === 'pull') {
            const typeInput = interaction.options.getString('aircraft_type');
            const liveryInput = interaction.options.getString('livery');
            
            await interaction.deferReply();
            
            try {
                const result = await CommunityAircraftModel.findOne({
                    aircraftType: { $regex: new RegExp(`^${escapeRegex(typeInput)}$`, "i") }, 
                    liveryName: { $regex: new RegExp(`^${escapeRegex(liveryInput)}$`, "i") }
                });

                if (!result) {
                    await interaction.editReply(`❌ No database record found for **${typeInput}** in **${liveryInput}** livery.`);
                    return;
                }

                // Show every stored photo (up to 3), not just the primary one.
                const pullImages = getEntryImages(result);
                const pullContributors = getEntryContributors(result);
                const primaryImage = pullImages[0] || result.imageUrl;

                const pullEmbed = new EmbedBuilder()
                    .setTitle('🗃️ Aircraft Database Record')
                    .setColor(THEME.WHITE)
                    .setDescription(`**Status:** ✅ Verified / Live${pullImages.length > 1 ? `\n📸 **${pullImages.length} photos** on record` : ''}`)
                    .addFields(
                        { name: 'Aircraft Type', value: result.aircraftType, inline: true },
                        { name: 'Livery', value: result.liveryName, inline: true },
                        { name: 'Tail Number', value: result.tailNumber.toUpperCase(), inline: true },
                        { name: 'Contributor', value: result.contributorName, inline: true },
                        { name: 'Uploaded', value: `<t:${Math.floor(new Date(result.uploadedAt).getTime() / 1000)}:R>`, inline: true }
                    )
                    .setImage(primaryImage)
                    .setFooter({ text: `Record ID: ${result._id}` });

                // Additional photos ride along as extra embeds so they all render
                // inside the same message.
                const galleryEmbeds = pullImages.slice(1).map((url, i) =>
                    new EmbedBuilder()
                        .setColor(THEME.WHITE)
                        .setTitle(`📷 Photo ${i + 2}`)
                        .setDescription(`Contributor: ${pullContributors[i + 1]?.name || result.contributorName}`)
                        .setImage(url)
                );

                await interaction.editReply({ embeds: [pullEmbed, ...galleryEmbeds] });

            } catch (e) { 
                console.error(e);
                await interaction.editReply('⚠️ Error retrieving record.'); 
            }
        }
        
        // --- PHOTO MANAGER (staff): reorder or remove photos already on record ---
        if (interaction.commandName === 'photos') {
            if (!isPhotoStaff(interaction)) {
                return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
            }
            const typeInput = interaction.options.getString('aircraft_type');
            const liveryInput = interaction.options.getString('livery');
            const tailInput = (interaction.options.getString('tail') || '').trim();

            // Either identifier works; neither is mandatory on its own. A tail
            // number alone is enough because it's unique in the schema, so it
            // names exactly one record.
            if (!tailInput && !(typeInput && liveryInput)) {
                return interaction.reply({
                    content: '❌ Tell me which record: a **tail** number on its own, or an **aircraft_type** *and* a **livery**.',
                    ephemeral: true
                });
            }

            // Ephemeral: this is a management surface, not something to leave
            // sitting in a channel for anyone to click.
            await interaction.deferReply({ ephemeral: true });
            try {
                const entry = await CommunityAircraftModel.findOne(tailInput
                    ? { tailNumber: { $regex: new RegExp(`^${escapeRegex(tailInput)}$`, "i") } }
                    : {
                        aircraftType: { $regex: new RegExp(`^${escapeRegex(typeInput)}$`, "i") },
                        liveryName: { $regex: new RegExp(`^${escapeRegex(liveryInput)}$`, "i") }
                    });
                if (!entry) {
                    return interaction.editReply(tailInput
                        ? `❌ No database record found for tail **${tailInput.toUpperCase()}**.`
                        : `❌ No database record found for **${typeInput}** in **${liveryInput}** livery.`);
                }
                if (getEntryImages(entry).length === 0) {
                    return interaction.editReply(`⚠️ **${entry.aircraftType}** (${entry.liveryName}) has no photos on record yet — nothing to manage.`);
                }
                await interaction.editReply(buildPhotoManager(entry));
            } catch (e) {
                console.error('photos command error:', e);
                await interaction.editReply('⚠️ Error loading that record.').catch(() => {});
            }
            return;
        }

        if (interaction.commandName === 'pull_airport') {
            const icaoInput = interaction.options.getString('icao').toUpperCase().trim();
            await interaction.deferReply();
            
            try {
                const airportData = await getAirportInfo(s3Client, icaoInput);
                
                const imageUrl = typeof airportData === 'string' ? airportData : (airportData?.url || airportData?.imageUrl);
                const contributor = airportData?.contributor || airportData?.contributorName || 'Unknown';

                if (!airportData || !imageUrl) {
                    const noPicEmbed = new EmbedBuilder()
                        .setTitle(`🏢 Airport: ${icaoInput}`)
                        .setColor(THEME.GRAY)
                        .setDescription(`❌ No picture submitted yet for **${icaoInput}**.`);
                    
                    return interaction.editReply({ embeds: [noPicEmbed] });
                }

                const pullEmbed = new EmbedBuilder()
                    .setTitle(`🏢 Airport Database Record`)
                    .setColor(THEME.WHITE) 
                    .setDescription(`**Status:** ✅ Verified / Live`) 
                    .addFields(
                        { name: 'ICAO Code', value: icaoInput, inline: true },
                        { name: 'Contributor', value: contributor, inline: true }
                    )
                    .setImage(imageUrl);

                await interaction.editReply({ embeds: [pullEmbed] });

            } catch (e) { 
                console.error("Airport Pull Error:", e);
                const noPicEmbed = new EmbedBuilder()
                    .setTitle(`🏢 Airport: ${icaoInput}`)
                    .setColor(THEME.GRAY)
                    .setDescription(`❌ No picture submitted yet for **${icaoInput}**.`);
                
                await interaction.editReply({ embeds: [noPicEmbed] });
            }
        }

        if (interaction.commandName === 'profile') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            await interaction.deferReply();
            try {
                const count = await CommunityAircraftModel.countDocuments({
                    $or: [
                        { contributorId: targetUser.id },
                        { contributorName: targetUser.username } 
                    ]
                });
                
                const recent = await CommunityAircraftModel.findOne({ 
                    $or: [{ contributorId: targetUser.id }, { contributorName: targetUser.username }]
                }).sort({ uploadedAt: -1 });

                const embed = new EmbedBuilder().setTitle(`✈️ Pilot Profile: ${targetUser.username}`).setThumbnail(targetUser.displayAvatarURL()).setColor(THEME.WHITE).addFields({ name: 'Total Contributions', value: `${count}`, inline: true });
                if (recent) { embed.addFields({ name: 'Last Spotted', value: `${recent.tailNumber}` }); embed.setImage(recent.imageUrl); }
                await interaction.editReply({ embeds: [embed] });
            } catch (e) { await interaction.editReply('Error.'); }
        }

        if (interaction.commandName === 'stats') {
            try {
                const count = await CommunityAircraftModel.countDocuments();
                await interaction.reply({ embeds: [new EmbedBuilder().setTitle('📊 Database Stats').setColor(THEME.WHITE).setDescription(`Tracked **${count}** aircraft.`)] });
            } catch (e) { await interaction.reply('Error.'); }
        }

        if (interaction.commandName === 'most_watched') {
            await interaction.deferReply();
            if (!DailyPilotStats) {
                return interaction.editReply('❌ Leaderboard is not available right now.');
            }
            try {
                const date = new Date().toISOString().split('T')[0];
                const top = await DailyPilotStats
                    .find({ date })
                    .sort({ viewCount: -1 })
                    .limit(5)
                    .select('pilotName viewCount -_id')
                    .lean();

                if (!top.length) {
                    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('📡 Most-Watched Pilots').setColor(THEME.WHITE).setDescription('Nobody has been tracked yet today. Open the tracker to start!')] });
                }

                const medals = ['🥇', '🥈', '🥉', '#4', '#5'];
                const description = top.map((p, i) => `${medals[i]} **${p.pilotName}** — ${p.viewCount} ${p.viewCount === 1 ? 'view' : 'views'}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('📡 Most-Watched Pilots Today')
                    .setColor(THEME.WHITE)
                    .setDescription(description)
                    .setFooter({ text: 'Updates live as people tune in on Inflight.' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('most_watched error:', e);
                await interaction.editReply('⚠️ Failed to load the leaderboard.');
            }
        }

        if (interaction.commandName === 'random') {
            await interaction.deferReply();
            try {
                // $sample is the only way to get a true random doc without
                // pulling the whole collection into memory.
                const [pick] = await CommunityAircraftModel.aggregate([
                    { $match: { imageUrl: { $ne: null } } },
                    { $sample: { size: 1 } }
                ]);

                if (!pick) {
                    return interaction.editReply('📭 No aircraft in the database yet.');
                }

                const embed = new EmbedBuilder()
                    .setTitle(`🎲 ${pick.tailNumber || 'Unknown'}`)
                    .setColor(THEME.WHITE)
                    .addFields(
                        { name: 'Aircraft', value: pick.aircraftType || 'Unknown', inline: true },
                        { name: 'Livery', value: pick.liveryName || 'Unknown', inline: true },
                        { name: 'Contributor', value: pick.contributorName || 'Unknown', inline: true }
                    )
                    .setImage(pick.imageUrl)
                    .setTimestamp(pick.uploadedAt);
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('random error:', e);
                await interaction.editReply('⚠️ Could not fetch a random aircraft.');
            }
        }

        if (interaction.commandName === 'recent') {
            await interaction.deferReply();
            try {
                const recents = await CommunityAircraftModel
                    .find({ imageUrl: { $ne: null } })
                    .sort({ uploadedAt: -1 })
                    .limit(5)
                    .lean();

                if (!recents.length) {
                    return interaction.editReply('📭 No submissions yet.');
                }

                const lines = recents.map(r => {
                    const ts = Math.floor(new Date(r.uploadedAt).getTime() / 1000);
                    return `**${r.tailNumber || '???'}** — ${r.aircraftType || 'Unknown'} / ${r.liveryName || 'Unknown'} (<t:${ts}:R>)`;
                });

                const embed = new EmbedBuilder()
                    .setTitle('🕒 Most Recent Submissions')
                    .setColor(THEME.WHITE)
                    .setDescription(lines.join('\n'))
                    .setImage(recents[0].imageUrl)
                    .setFooter({ text: `Newest photo: ${recents[0].tailNumber}` });
                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('recent error:', e);
                await interaction.editReply('⚠️ Could not load recent submissions.');
            }
        }

        if (interaction.commandName === 'help') {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Inflight Bot — Command Guide')
                .setColor(THEME.WHITE)
                .setDescription('Everything this bot can do, grouped by purpose.')
                .addFields(
                    {
                        name: '📸 Submissions',
                        value: [
                            '`/submit` — submit a new aircraft photo',
                            'Or drop a photo directly in the submission channels and follow the prompts.',
                            'Identifying it is two dropdowns — pick the aircraft, then its livery (search or type it by hand if it isn\'t listed).',
                            'Got it wrong? Tap **🔧 Fix Details** on your pending post to correct it before an admin reviews it.'
                        ].join('\n')
                    },
                    {
                        name: '🔍 Database',
                        value: [
                            '`/lookup` — find an aircraft by tail, livery, or type',
                            '`/pull` — fetch a specific aircraft by type + livery',
                            '`/pull_airport` — fetch an airport photo by ICAO',
                            '`/random` — pull a random aircraft',
                            '`/recent` — last 5 submissions',
                            '`/stats` — database size'
                        ].join('\n')
                    },
                    {
                        name: '✈️ Live Flights',
                        value: [
                            '`/track` — track a live flight on Expert Server',
                            '`/most_watched` — top 5 tracked pilots today',
                            '`/links` — tracker, forum & livery DB links'
                        ].join('\n')
                    },
                    {
                        name: '👤 Contributors',
                        value: [
                            '`/profile` — quick contribution stats',
                            '`/hangar` — detailed breakdown of a user\'s hangar',
                            '`/bounty_board` — aircraft still needing better photos'
                        ].join('\n')
                    },
                    {
                        name: '🎉 Events',
                        value: [
                            '`/giveaway` — *(staff)* start a giveaway; members tap a button to enter and a winner is drawn automatically'
                        ].join('\n')
                    },
                    {
                        name: '🛫 Virtual Airlines',
                        value: [
                            '`/va_apply` — apply to register your VA/VO (staff approve in Discord)',
                            '`/va_addrep` / `/va_removerep` — *(staff)* manage a VA\'s reps',
                            '`/va_remove` — *(staff)* delete a VA\'s role + channel'
                        ].join('\n')
                    },
                    {
                        name: '🛠️ Photo Management',
                        value: [
                            '`/photos` — *(staff)* reorder the photos on a record (promote one to primary, push another back) or remove one — find it by aircraft type + livery, or by tail number alone',
                            'On a review card, **Insert** saves a submission into a slot and keeps the photo that was there — only **Replace** deletes.'
                        ].join('\n')
                    }
                )
                .setFooter({ text: 'Staff-only: mod_*, /giveaway, /photos, and /va_* management commands.' });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (err) {
        // Top-level guard: any uncaught throw inside the interaction handler
        // used to bubble out as an unhandled rejection and (combined with the
        // bot living in the same process as Express) crash the API.
        console.error('🛑 interactionCreate handler error:', err && err.stack ? err.stack : err);
        try {
            if (interaction.isRepliable && interaction.isRepliable()) {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: '⚠️ Something went wrong handling that.', ephemeral: true }).catch(() => {});
                } else {
                    await interaction.reply({ content: '⚠️ Something went wrong handling that.', ephemeral: true }).catch(() => {});
                }
            }
        } catch (_) { /* swallow — we already logged */ }
      }
    });

    // Expose the client module-wide so postToChannel() can reach it.
    botClient = client;

    // Web-submitted aircraft photos (from our front-end via
    // POST /api/community/aircraft/submit) are routed through the SAME admin
    // review flow as Discord DM submissions: a pending card in the public feed +
    // a review card in the admin channel with the existing approve/reject/edit
    // buttons. To match the DM path exactly, the photo is sent as a Discord
    // ATTACHMENT (Discord hosts it, so it always renders in the embed) rather than
    // as an external image URL; on approval the existing handler moves it to S3,
    // just as it does for a DM submission's attachment. The only real differences:
    //   • the type/livery/tail are already auto-matched by the caller (same
    //     normalize + registration lookup the DM flow runs); and
    //   • the collaborator identity comes from the submitting site, not a DM
    //     author — a linked Discord id when the site has one (so credit, the
    //     contributor role and the leaderboard all work natively), otherwise a
    //     display name carried in the footer for the approval handler to use.
    _submitWebAircraftReviewImpl = async ({
        aircraftType, liveryName, tailNumber,
        imageBuffer, collaboratorId, collaboratorName, pilotId, ifUsername,
        submissionId, sourceSite,
    }) => {
        if (!client || !client.isReady || !client.isReady()) {
            throw new Error('Discord bot not ready');
        }

        const type = String(aircraftType || '').trim();
        const livery = String(liveryName || '').trim();
        const tail = String(tailNumber || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
        if (!type || !livery || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
            throw new Error('aircraftType, liveryName and a non-empty image are required');
        }

        // A linked Discord id is the strongest identity — thread it through the
        // buttons/footer exactly like the DM path's user id. Otherwise use a
        // non-numeric 'web' token and carry the display name in the footer.
        const hasDiscordId = /^\d{5,}$/.test(String(collaboratorId || ''));
        const buttonToken = hasDiscordId ? String(collaboratorId) : 'web';
        // Sanitize the display name so it can't break footer parsing (we split on
        // '|') or overflow Discord's field limits.
        const safeName = String(collaboratorName || 'Anonymous')
            .replace(/[|\r\n]+/g, ' ').trim().slice(0, 60) || 'Anonymous';
        const safeSource = String(sourceSite || '')
            .replace(/[|\r\n]+/g, ' ').trim().slice(0, 40);

        const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
        const feedChannel = await client.channels.fetch(PUBLIC_FEED_CHANNEL_ID);

        const contributorDisplay = hasDiscordId ? `<@${buttonToken}>` : safeName;
        // The same optimized webp is attached to both the feed and admin messages
        // and rendered inside each embed via attachment://. Discord hosts it, so it
        // shows immediately regardless of the S3 bucket's public policy.
        const attachmentName = 'aircraft.webp';
        const makeAttachment = () => ({ attachment: imageBuffer, name: attachmentName });

        // 1. Public feed — pending. NOTE: the source/origin (which may be a private
        // test/preview URL) is deliberately NOT shown here — this channel is public.
        // It's recorded only in the admin card footer below (staff-only channel).
        const publicEmbed = themedEmbed(SUB_STATE.PENDING.color)
            .setTitle('📸 New Aircraft Spotted')
            .setDescription(`**Status:** ${SUB_STATE.PENDING.badge}\nA new photo has been submitted and is awaiting admin review.`)
            .addFields(
                { name: 'Aircraft', value: type, inline: true },
                { name: 'Livery', value: livery, inline: true },
                { name: 'Tail Number', value: tail, inline: true },
                { name: 'Submitted By', value: contributorDisplay, inline: false }
            )
            .setImage(`attachment://${attachmentName}`)
            .setTimestamp();
        const publicMsg = await feedChannel.send({ embeds: [publicEmbed], files: [makeAttachment()] });

        // 2. Admin review card — identical field layout to the DM path so the
        //    approve/reject handlers read it unchanged.
        const finalEmbed = new EmbedBuilder()
            .addFields(
                { name: 'Contributor', value: contributorDisplay, inline: true },
                { name: 'Tail Number', value: tail, inline: true },
                { name: 'Aircraft Type', value: type, inline: true },
                { name: 'Livery', value: livery, inline: true },
            )
            .setImage(`attachment://${attachmentName}`)
            .setTimestamp();

        let existingEntry = null;
        try {
            existingEntry = await CommunityAircraftModel.findOne({
                aircraftType: { $regex: new RegExp(`^${escapeRegex(type)}$`, 'i') },
                liveryName: { $regex: new RegExp(`^${escapeRegex(livery)}$`, 'i') }
            });
        } catch (e) { console.error('Web submission duplicate check failed:', e.message); }

        const { components: adminComponents, extraEmbeds } = buildAircraftReview(finalEmbed, existingEntry, buttonToken);

        // Footer carries the same Msg pointer the approval/reject handlers parse.
        // No `Ch:` (there's no submitter DM channel to notify). For the id-less
        // case we append `Collab:` so approval can credit the external identity.
        // A tracker account, when the submitter was signed in. It rides the
        // footer like the rest of the identity because the footer is the only
        // thing that survives from here to the approval handler — the card may
        // sit in the admin channel for days, across restarts.
        const safePilotId = String(pilotId || '').replace(/[^0-9a-f-]/gi, '').slice(0, 40);
        const safeIfUser = String(ifUsername || '').replace(/[|\r\n]+/g, ' ').trim().slice(0, 40);

        let footer = `Pending | User: ${buttonToken} | Msg: ${publicMsg.id}`;
        if (!hasDiscordId) footer += ` | Collab: ${safeName}`;
        if (safePilotId) footer += ` | Pilot: ${safePilotId}`;
        if (safeIfUser) footer += ` | IF: ${safeIfUser}`;
        const safeSubmission = String(submissionId || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
        if (safeSubmission) footer += ` | Sub: ${safeSubmission}`;
        if (safeSource) footer += ` | Src: ${safeSource}`;
        finalEmbed.setFooter({ text: footer });

        await adminChannel.send({ embeds: [finalEmbed, ...extraEmbeds], components: adminComponents, files: [makeAttachment()] });

        return { ok: true, feedMessageId: publicMsg.id };
    };

    if (process.env.DISCORD_BOT_TOKEN) {
        client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
            console.error('🤖 Discord login failed (continuing without bot):', err && err.message ? err.message : err);
        });
    } else {
        console.log('⚠️ DISCORD_BOT_TOKEN missing.');
    }
};

module.exports = { startDiscordBot, postToChannel, submitWebAircraftReview, resolveAircraftMatch, getBotStats };