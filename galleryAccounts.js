'use strict';

/*
 * galleryAccounts.js
 * Who a gallery photo belongs to.
 *
 * WHY THIS EXISTS
 * ---------------
 * A photo used to carry a typed-in name. Two people called "Alex" were one
 * contributor, a photographer who changed how they wrote their name became two,
 * and nobody could be shown their own uploads because nothing said which were
 * theirs. This module attaches a real identity instead: the tracker account the
 * person is already signed in to, and through it the Infinite Flight username
 * on their pilot profile.
 *
 * WHAT IDENTITY MEANS HERE
 * ------------------------
 * The tracker signs people in with Supabase, and `pilot_profiles` already holds
 * the Infinite Flight side of that account (`if_username`, and whether it has
 * been verified). So a gallery account is not a new account: it is the tracker
 * account, read through its pilot profile. Nothing here creates, changes or
 * stores a credential.
 *
 * THE TWO KEYS, AND WHY THEY DIFFER
 * ---------------------------------
 *   INFLIGHT_SUPABASE_ANON_KEY     public; already ships in the tracker bundle.
 *                                  Only names the project — the user's own
 *                                  access token is what authorises /auth/v1/user.
 *   INFLIGHT_SUPABASE_SERVICE_KEY  real secret; reads pilot_profiles and
 *                                  pilot_warnings, which RLS otherwise keeps to
 *                                  their owner.
 *
 * Without the service key a person can still be identified (the token check
 * needs only the anon key) — they just arrive with no profile, so they are
 * credited by the name on their account rather than by their IF username, and
 * no upload restriction can be read. `isConfigured()` reports which of the two
 * states this deployment is in rather than letting it be discovered one failed
 * upload at a time.
 *
 * TRUST
 * -----
 * Nothing the browser says about who it is survives this file. The submit
 * endpoint passes the Authorization header and takes back whatever identity
 * Supabase confirms, or none; a client-supplied name is only ever used when
 * there is no token at all.
 */

const axios = require('axios');

const SUPABASE_URL = (process.env.INFLIGHT_SUPABASE_URL
    || 'https://lcgaoiqwwpyqndaucyzu.supabase.co').replace(/\/+$/, '');

// Public project key — identical to the one in vaGroupFlights.js and in the
// tracker bundle. It identifies the project and authorises nothing on its own.
const ANON_KEY = process.env.INFLIGHT_SUPABASE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjZ2FvaXF3d3B5cW5kYXVjeXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNjkyOTksImV4cCI6MjA4NzY0NTI5OX0.9TO21knXR_P9E80pea7gUOu-gTjb17sCGk7BYgRRe3U';

const SERVICE_KEY = process.env.INFLIGHT_SUPABASE_SERVICE_KEY || '';

const TIMEOUT_MS = 8000;

// An identity is re-read from Supabase at most this often per access token. An
// upload posts several photos in a row and the gallery asks who you are on
// every page load; without this each of those is two round trips to a service
// whose answer changes in minutes, not milliseconds.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();   // token -> { at, identity }

const isConfigured = () => ({ identity: true, profiles: !!SERVICE_KEY });

/* ===========================================================================
 * Supabase reads
 * =========================================================================== */

// Ask Supabase who an access token belongs to. Returns { id, email } for a
// signed-in, email-confirmed account and null for everything else — the same
// check vaGroupFlights.js makes, for the same reason: an address nobody has
// proved they can read is not an identity.
async function resolveUser(accessToken) {
    const token = String(accessToken || '').trim();
    if (!token || token.length < 20 || token.length > 4000) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
            timeout: TIMEOUT_MS,
            validateStatus: (s) => s === 200 || s === 401 || s === 403,
        });
        if (res.status !== 200 || !res.data) return null;
        const u = res.data;
        if (!u.email_confirmed_at && !u.confirmed_at) return null;
        return { id: String(u.id || ''), email: String(u.email || '').toLowerCase() };
    } catch (err) {
        console.warn('[gallery-account] identity lookup failed:', err.message);
        return null;
    }
}

// The pilot profile behind that account. Read with the service key because RLS
// keeps a profile to its owner, and this runs server-side on their behalf.
async function loadProfile(userId) {
    if (!SERVICE_KEY || !userId) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/rest/v1/pilot_profiles`, {
            params: {
                user_id: `eq.${userId}`,
                select: 'user_id,handle,display_name,if_username,if_username_verified,avatar_path,is_public,moderation_state',
                limit: 1,
            },
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
            timeout: TIMEOUT_MS,
            validateStatus: (s) => s === 200,
        });
        return (Array.isArray(res.data) && res.data[0]) || null;
    } catch (err) {
        console.warn('[gallery-account] profile lookup failed:', err.message);
        return null;
    }
}

// Whether this pilot is currently barred from uploading. `pilot_warnings` is
// the tracker's own enforcement ladder — a gallery that ignored it would hand
// somebody a second front door to the thing they were restricted from.
async function loadUploadBlock(userId) {
    if (!SERVICE_KEY || !userId) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/rest/v1/pilot_warnings`, {
            params: {
                user_id: `eq.${userId}`,
                upload_block: 'is.true',
                rescinded_at: 'is.null',
                upload_block_lifted_at: 'is.null',
                select: 'reason,category,upload_block_until,created_at',
                order: 'created_at.desc',
                limit: 5,
            },
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
            timeout: TIMEOUT_MS,
            validateStatus: (s) => s === 200,
        });
        const rows = Array.isArray(res.data) ? res.data : [];
        // A block with a date in the past has expired; one with no date stands
        // until somebody lifts it.
        const live = rows.find((r) => !r.upload_block_until || new Date(r.upload_block_until).getTime() > Date.now());
        return live ? { reason: live.reason || '', until: live.upload_block_until || null } : null;
    } catch (err) {
        console.warn('[gallery-account] upload block lookup failed:', err.message);
        return null;
    }
}

/* ===========================================================================
 * Identity
 * =========================================================================== */

const avatarUrl = (path) => (path
    ? `${SUPABASE_URL}/storage/v1/object/public/pilot-avatars/${encodeURI(path)}`
    : null);

// What a photo should be credited to. The IF username wins when the profile has
// one, because that is the name the rest of the community knows the person by;
// the profile's display name is the fallback, and the handle the last resort.
function creditName(identity) {
    if (!identity) return null;
    return identity.ifUsername || identity.displayName || identity.handle || null;
}

/**
 * Resolve an Authorization header into a gallery identity, or null.
 *
 * Shape:
 *   { pilotId, email, handle, displayName, ifUsername, ifVerified,
 *     avatarUrl, profileUrl, blocked }
 *
 * A signed-in account with no pilot profile yet still resolves — it simply has
 * no IF username, and is credited by its handle.
 */
async function identify(authHeader) {
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;

    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.identity;

    const user = await resolveUser(token);
    if (!user) {
        // Cache the negative too, briefly: a stale token in a background tab
        // would otherwise retry on every request the page makes.
        cache.set(token, { at: Date.now(), identity: null });
        return null;
    }

    const [profile, block] = await Promise.all([loadProfile(user.id), loadUploadBlock(user.id)]);

    const identity = {
        pilotId: user.id,
        email: user.email,
        handle: (profile && profile.handle) || null,
        displayName: (profile && profile.display_name) || null,
        ifUsername: (profile && profile.if_username) || null,
        ifVerified: !!(profile && profile.if_username_verified),
        avatarUrl: avatarUrl(profile && profile.avatar_path),
        profileUrl: profile && profile.handle ? `/pilot/${encodeURIComponent(profile.handle)}` : null,
        blocked: block,
    };

    cache.set(token, { at: Date.now(), identity });
    // The cache is per access token and tokens rotate hourly, so it would grow
    // without bound over a long uptime. Sweep when it gets big rather than on a
    // timer: there is nothing to do between requests.
    if (cache.size > 500) {
        const cutoff = Date.now() - CACHE_TTL_MS;
        for (const [key, value] of cache) if (value.at < cutoff) cache.delete(key);
    }
    return identity;
}

// Express helper: attaches req.pilot (identity or null) and never rejects. The
// routes decide what an anonymous request may do.
function attachPilot(req, _res, next) {
    identify(req.get('authorization'))
        .then((identity) => { req.pilot = identity; next(); })
        .catch(() => { req.pilot = null; next(); });
}

/* ===========================================================================
 * Claiming — the photos credited to this person before they had an account
 * ===========================================================================
 *
 * The gallery predates accounts, so the only link between an old photo and a
 * person is the credit they typed at the time. These two are pure so the rules
 * can be tested against records rather than against a database:
 *
 *   * a slot is claimed only if its printed credit is one of the names this
 *     account answers to, matched whole and case-insensitively — "Ian" must not
 *     take "Ian Simpson"
 *   * a slot already held by an account is never moved, whatever name is on it.
 *     First claim wins, and a later claimant gets nothing rather than taking it
 *   * the legacy top-level credit is claimed only when the record has no
 *     per-image credits at all, where it IS the single photo's credit
 *
 * Name matching is as strong as the names are: two people who credited
 * themselves identically are indistinguishable here, and the first to sign in
 * takes both sets. That is the accepted trade for claiming without asking.
 */

// Every name this account may be credited under, lowercased and de-duplicated.
// Anything shorter than two characters is dropped: an initial is not evidence.
function identityNames(identity) {
    return Array.from(new Set(
        [identity && identity.ifUsername, identity && identity.displayName, identity && identity.handle]
            .map((n) => String(n || '').trim().toLowerCase())
            .filter((n) => n.length >= 2)
    ));
}

const matchesName = (value, names) => names.includes(String(value || '').trim().toLowerCase());

/**
 * Work out what claiming would change. Returns { claimed, writes } where each
 * write is a Mongo bulkWrite operation; an empty writes array means this
 * account owns nothing new.
 */
function planClaim(docs, identity) {
    const names = identityNames(identity);
    const writes = [];
    let claimed = 0;
    if (!names.length || !identity || !identity.pilotId) return { claimed, writes, names };

    (docs || []).forEach((doc) => {
        const contributors = Array.isArray(doc.imageContributors) ? doc.imageContributors : [];
        const set = {};

        if (contributors.length) {
            let touched = 0;
            const next = contributors.map((slot) => {
                const c = slot || {};
                if (c.pilotId || !matchesName(c.name, names)) return c;
                touched += 1;
                return { ...c, pilotId: identity.pilotId, ifUsername: identity.ifUsername || null };
            });
            if (touched) {
                claimed += touched;
                set.imageContributors = next;
                // The legacy mirrors follow slot 0, as everywhere else.
                if (next[0] && next[0].pilotId === identity.pilotId) {
                    set.contributorPilotId = identity.pilotId;
                    set.contributorIfUsername = identity.ifUsername || null;
                }
            }
        } else if (!doc.contributorPilotId && matchesName(doc.contributorName, names)) {
            claimed += 1;
            set.contributorPilotId = identity.pilotId;
            set.contributorIfUsername = identity.ifUsername || null;
        }

        if (Object.keys(set).length) {
            writes.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
        }
    });

    return { claimed, writes, names };
}

// How many photo SLOTS an account holds across these records. Counting records
// would undercount: one record can carry three photos by three people.
function countOwnedPhotos(docs, pilotId) {
    let photos = 0;
    (docs || []).forEach((doc) => {
        const contributors = Array.isArray(doc.imageContributors) ? doc.imageContributors : [];
        if (contributors.length) {
            photos += contributors.filter((c) => c && c.pilotId === pilotId).length;
        } else if (doc.contributorPilotId === pilotId) {
            photos += 1;
        }
    });
    return photos;
}

module.exports = {
    SUPABASE_URL,
    isConfigured,
    identify,
    attachPilot,
    creditName,
    avatarUrl,
    identityNames,
    planClaim,
    countOwnedPhotos,
};
