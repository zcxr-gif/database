// pilotContentFeed.js
// Everything pilots put on the platform, posted to a staff Discord channel as
// it arrives, so a bad picture or a nasty comment is in front of a moderator
// in seconds instead of whenever somebody next opens the Pilot Content console.
//
// WHERE THE ITEMS COME FROM. Triggers in the tracker's Supabase project write a
// row to `pilot_content_queue` for every new avatar, banner, window photo,
// handle, display name, bio, RateMyATC comment and kudos note (see the iOS
// repo's supabase/migrations/20261018000000_pilot_words_moderation.sql). No
// client can forget to report something, because no client is involved.
//
// HOW IT DRAINS. Poll, post, then acknowledge only what Discord accepted. A
// Discord outage or a restart delays a message; it does not lose one. The
// queue offers the last seven days, so a long outage does not end in a flood
// of week-old pictures.
//
// Anonymous RateMyATC comments are posted WITH the author. Anonymity is a
// promise to other pilots and the controller; staff moderating abuse need to
// know whose it is, and the channel is staff-only.
//
// Needs INFLIGHT_SUPABASE_SERVICE_KEY (the same key as the console). Without
// it this never starts.

const pilotModeration = require('./pilotModeration');

const CHANNEL_ID = process.env.PILOT_CONTENT_CHANNEL_ID || '1552352695308779571';
const POLL_MS = Math.max(parseInt(process.env.PILOT_CONTENT_POLL_MS, 10) || 20000, 5000);
// After a failed round (Supabase or Discord down), wait longer before trying
// again rather than hammering either.
const BACKOFF_MS = 120000;
const BATCH = 10;

const HUB_ORIGIN = String(process.env.PUBLIC_BACKEND_ORIGIN
    || 'https://site--indgo-backend--6dmjph8ltlhv.code.run').replace(/\/+$/, '');

const FACILITY = ['Ground', 'Tower', 'Unicom', 'Clearance', 'Approach', 'Departure', 'Center', 'ATIS'];

const KIND = {
    avatar: { title: 'New avatar', color: 0x3b82f6, image: true },
    banner: { title: 'New banner', color: 0x6366f1, image: true },
    window: { title: 'New flight-window photo', color: 0x8b5cf6, image: true },
    handle: { title: 'New handle', color: 0x64748b },
    display_name: { title: 'New display name', color: 0x64748b },
    bio: { title: 'New bio', color: 0x0ea5e9 },
    rating_comment: { title: 'RateMyATC comment', color: 0xf59e0b },
    kudos_note: { title: 'ATC kudos note', color: 0x22c55e },
};

const clip = (s, n) => {
    const t = String(s == null ? '' : s);
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function embedFor(item) {
    const k = KIND[item.kind] || { title: item.kind, color: 0x64748b };
    const d = item.detail || {};
    const who = item.handle ? `@${item.handle}` : 'a pilot without a profile';
    const fields = [
        { name: 'Pilot', value: clip(`${who}${item.display_name ? ` (${item.display_name})` : ''}`, 256), inline: true },
        { name: 'User id', value: `\`${item.user_id || 'unknown'}\``, inline: true },
    ];
    if (item.prior_takedowns || item.restricted) {
        fields.push({
            name: 'Standing',
            value: [
                item.prior_takedowns ? `${item.prior_takedowns} prior takedown${item.prior_takedowns === 1 ? '' : 's'}` : null,
                item.restricted ? 'currently paused' : null,
            ].filter(Boolean).join(' · '),
            inline: true,
        });
    }
    if (item.kind === 'rating_comment' || item.kind === 'kudos_note') {
        const where = [FACILITY[d.facility_type], d.airport_icao].filter(Boolean).join(' · ');
        fields.push({
            name: 'Controller',
            value: clip(`${d.controller_username || 'unknown'}${where ? ` — ${where}` : ''}`, 256),
            inline: true,
        });
    }
    if (item.kind === 'rating_comment') {
        fields.push({ name: 'Stars', value: `${'★'.repeat(d.stars || 0)}${'☆'.repeat(5 - (d.stars || 0))}`, inline: true });
        fields.push({
            name: 'Visibility',
            value: `${d.private ? 'Private to the controller' : 'Public'} · ${d.anonymous ? 'posted anonymously' : 'posted with name'}`,
            inline: true,
        });
    }

    const tab = (item.kind === 'rating_comment' || item.kind === 'kudos_note') ? 'comments' : 'uploads';
    const embed = {
        title: k.title,
        url: `${HUB_ORIGIN}/pilot-content#${tab}`,
        color: k.color,
        fields,
        footer: { text: `Pilot Content · queue #${item.id}` },
        timestamp: item.created_at || new Date().toISOString(),
    };
    if (k.image && item.storage_bucket && item.storage_path) {
        const url = pilotModeration.publicUrl(item.storage_bucket, item.storage_path);
        embed.image = { url };
        embed.description = `[Open the full picture](${url})`;
    } else if (item.body) {
        embed.description = clip(item.body, 2000);
    }
    return embed;
}

let timer = null;
let busy = false;

async function round() {
    if (busy) return POLL_MS;
    busy = true;
    try {
        const items = await pilotModeration.rpc('admin_pilot_content_queue', { p_limit: BATCH });
        if (!Array.isArray(items) || !items.length) return POLL_MS;

        const { postToChannel } = require('./bot');
        const done = [];
        let failed = false;
        for (const item of items) {
            const ok = await postToChannel(CHANNEL_ID, { embeds: [embedFor(item)] });
            if (!ok) { failed = true; break; }
            done.push(item.id);
        }
        if (done.length) await pilotModeration.rpc('admin_pilot_content_queue_ack', { p_ids: done });
        if (failed) return BACKOFF_MS;
        // A full batch means more is waiting; come straight back.
        return items.length === BATCH ? 1500 : POLL_MS;
    } catch (err) {
        console.error('[pilot-content-feed]', err.message);
        return BACKOFF_MS;
    } finally {
        busy = false;
    }
}

function start() {
    if (timer || !pilotModeration.isConfigured()) {
        if (!pilotModeration.isConfigured()) {
            console.warn('[pilot-content-feed] INFLIGHT_SUPABASE_SERVICE_KEY not set — not posting pilot content to Discord.');
        }
        return;
    }
    const tick = async () => {
        const wait = await round();
        timer = setTimeout(tick, wait);
        if (timer.unref) timer.unref();
    };
    // Give the bot a moment to log in before the first post.
    timer = setTimeout(tick, 30000);
    if (timer.unref) timer.unref();
}

module.exports = { start, embedFor, CHANNEL_ID };
