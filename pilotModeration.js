// pilotModeration.js
// The staff hub's view of what pilots have uploaded to the iOS app, and what
// we do about it.
//
// WHY THIS LIVES HERE AND NOT IN THE APP'S OWN PROJECT.
//
// The pictures, the profiles and the moderation tables are all in the tracker's
// Supabase project (see `Inflight-IOS/supabase/migrations/`), and the natural
// place to moderate them would seem to be there. It is not, for one reason:
// that project has no staff accounts. Moderating from it would mean inventing a
// second login, a second set of roles, and a second thing to revoke when
// somebody leaves — next to the staff hub, which already has all three.
//
// So the console is a page in the hub like any other, gated by the same
// session, and this module is the part that talks to Supabase. The database
// work — deciding what a takedown is, what a warning does, which restriction
// holds — is all on the far side, in SQL, where the rules can be tested against
// a real Postgres. This file is a courier.
//
// WHAT IT NEEDS. One secret, and it is a real one:
//
//   INFLIGHT_SUPABASE_SERVICE_KEY   the tracker project's service_role key.
//
// The `admin_pilot_*` functions are granted to `service_role` and nothing else,
// so without this key the console is inert — and says so, rather than failing
// one request at a time. There is deliberately NO fallback default here, unlike
// the anon key in vaGroupFlights.js: that one is public and ships inside the
// app bundle, this one can read and write every row in the project.
//
// THE ORDER OF A TAKEDOWN, which is the only interesting thing in this file:
//
//   1. the RPC clears the column, records the action, issues the warning
//   2. THEN the storage object is deleted, here, using the path the RPC
//      returned
//
// That order is not arbitrary. The row is what makes a picture appear anywhere
// — in the app, in a profile card, in a share sheet — so clearing it is what
// actually takes the picture down. Deleting the file first would leave a window
// where the profile still points at a 404, and a failure between the two would
// leave a profile permanently pointing at nothing. This way the worst case is
// an orphaned file in a bucket: invisible, sweepable, and not a complaint.

const axios = require('axios');

const SUPABASE_URL = (process.env.INFLIGHT_SUPABASE_URL
    || 'https://lcgaoiqwwpyqndaucyzu.supabase.co').replace(/\/+$/, '');

const SERVICE_KEY = process.env.INFLIGHT_SUPABASE_SERVICE_KEY || '';

// Whether this deployment can moderate at all. Reported to the page rather
// than discovered by a moderator whose first takedown fails: a console that
// cannot act should say so before somebody relies on it.
const isConfigured = () => !!SERVICE_KEY;

// What a picture can be taken down for. The same vocabulary the app's own
// report button uses (`profile_reports.reason`), so a takedown that came from
// a report can carry the report's category without translation, and the two
// lists cannot drift into describing different things.
const CATEGORIES = [
    { key: 'sexual', label: 'Sexual or adult content' },
    { key: 'violence', label: 'Violent or graphic content' },
    { key: 'hate', label: 'Hateful content' },
    { key: 'harassment', label: 'Harassment or bullying' },
    { key: 'impersonation', label: 'Impersonation' },
    { key: 'spam', label: 'Spam or advertising' },
    { key: 'other', label: 'Other' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

// The enforcement ladder, mirroring the check constraint on `pilot_warnings`.
// Kept here as well as there because the page needs the copy and the server
// needs to refuse an unknown level before spending a round trip on it.
const LEVELS = [
    {
        key: 'notice',
        label: 'Notice',
        meaning: 'On the record, no penalty. Please do not do it again.',
    },
    {
        key: 'first',
        label: 'First warning',
        meaning: 'A formal first warning. Serious enough to count.',
    },
    {
        key: 'final',
        label: 'Final warning',
        meaning: 'The last one. A further breach costs them the account.',
    },
    {
        key: 'suspended',
        label: 'Profile suspended',
        meaning: 'The profile is out of public view and staying there.',
    },
];
const LEVEL_KEYS = LEVELS.map((l) => l.key);

/* ===========================================================================
 * Talking to Supabase
 * ======================================================================== */

// Call one of the project's functions with the service role.
//
// Timeouts are short and deliberate: every one of these sits behind a button a
// person has just pressed, and a console that hangs is worse than one that says
// "try again" — a moderator who is not sure whether the takedown happened will
// press it twice.
async function rpc(name, args, { timeout = 15000 } = {}) {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/${name}`, args || {}, {
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout,
        validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) return res.data;

    // PostgREST puts the database's own message in `message`. Those messages
    // are written for the person reading them ("That picture has already been
    // removed."), so they are passed through rather than replaced with a
    // generic failure that hides what happened.
    const message = (res.data && (res.data.message || res.data.error)) || `Supabase answered ${res.status}.`;

    /* A REJECTED KEY IS NOT A BAD REQUEST.
     *
     * Supabase answers 401/403 when the service key is missing, wrong, or has
     * been rotated — a fact about this deployment, not about what the
     * moderator typed. Left to fall through with the rest it would surface as
     * a 400 and read as "you did something wrong", and somebody would spend
     * the afternoon rewording a takedown reason. Flagged instead, so the
     * caller can say what actually happened.
     */
    const err = new Error(
        (res.status === 401 || res.status === 403)
            ? 'The tracker project rejected our service key. It may have been rotated — check INFLIGHT_SUPABASE_SERVICE_KEY.'
            : message,
    );
    err.status = res.status;
    err.badKey = res.status === 401 || res.status === 403;
    throw err;
}

// Remove an object from a storage bucket. Best-effort by design — see the note
// at the top about the order of a takedown. A failure here is logged with the
// path, because that log line is the only trace of a file nothing points at.
async function dropObject(bucket, path) {
    if (!bucket || !path) return false;
    try {
        const res = await axios.delete(
            `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`,
            {
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
                timeout: 15000,
                validateStatus: () => true,
            },
        );
        if (res.status >= 200 && res.status < 300) return true;
        console.error(`[pilot-moderation] object left behind: ${bucket}/${path} (${res.status})`);
        return false;
    } catch (err) {
        console.error(`[pilot-moderation] object left behind: ${bucket}/${path}`, err.message);
        return false;
    }
}

/* What to answer the console when a Supabase call fails.
 *
 * Three outcomes, because they mean three different things to the person who
 * pressed the button:
 *
 *   502  we could not reach Supabase, or it rejected our key. Nothing about
 *        the request was wrong and re-typing it will not help.
 *   400  the database refused this specific request — "That picture has
 *        already been removed", a bad uuid. The message is worth reading.
 *
 * Collapsing these into one status is how a rotated key turns into an
 * afternoon of somebody rewording a takedown reason.
 */
const statusFor = (err) => {
    if (err.badKey) return 502;
    return err.status && err.status < 500 ? 400 : 502;
};

// Both buckets are public — that is the whole point of them, a stranger's
// phone has to be able to fetch the picture — so the console can show the real
// image rather than a placeholder. Built here rather than stored, so moving the
// bucket or putting a CDN in front of it is not a data migration.
const publicUrl = (bucket, path) =>
    `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;

/* ===========================================================================
 * Routes
 * ======================================================================== */
function registerPilotModerationRoutes(app, { requireAuth }) {

    // Every route needs the key. Checked once, here, so each handler can be
    // about its own job.
    const needsKey = (req, res, next) => {
        if (!isConfigured()) {
            return res.status(501).json({
                error: 'Pilot moderation is not configured on this deployment. '
                    + 'Set INFLIGHT_SUPABASE_SERVICE_KEY to the tracker project\'s service_role key.',
                unconfigured: true,
            });
        }
        next();
    };

    const staffName = (req) =>
        (req.staff && (req.staff.displayName || req.staff.username)) || 'Inflight staff';

    // --- The feed -----------------------------------------------------------
    // Every avatar and banner on the platform, newest-changed first, each with
    // the pilot's standing attached.
    app.get('/api/pilot-moderation/uploads', requireAuth, needsKey, async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
            const rows = await rpc('admin_pilot_uploads', {
                p_limit: limit,
                p_offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
                p_only_flagged: req.query.flagged === '1',
            });

            res.json({
                categories: CATEGORIES,
                levels: LEVELS,
                items: (rows || []).map((r) => ({
                    userId: r.user_id,
                    handle: r.handle || '',
                    displayName: r.display_name || '',
                    kind: r.kind,
                    bucket: r.storage_bucket,
                    path: r.storage_path,
                    url: publicUrl(r.storage_bucket, r.storage_path),
                    moderationState: r.moderation_state,
                    isPublic: !!r.is_public,
                    autohidden: !!r.autohidden,
                    openReports: r.open_reports || 0,
                    priorTakedowns: r.prior_takedowns || 0,
                    restricted: !!r.restricted,
                    restrictedUntil: r.restricted_until || null,
                    // Named for what it is. This is when the PROFILE last
                    // changed, not when the picture went up — nothing records
                    // the latter. Calling it "uploaded" in the UI would be a
                    // small lie that a moderator would eventually rely on.
                    changedAt: r.changed_at || null,
                })),
            });
        } catch (err) {
            console.error('[pilot-moderation] feed:', err.message);
            res.status(statusFor(err)).json({ error: err.message });
        }
    });

    // --- Takedown -----------------------------------------------------------
    /* Remove the picture, record why, and — if asked — warn and restrict.
     *
     * One request because it is one decision. Three would mean a takedown where
     * somebody meant to warn and did not: a record with a gap in it and a pilot
     * who was never told. The database does all three in one transaction, so a
     * warning can never be issued for a removal that then failed.
     */
    app.post('/api/pilot-moderation/takedown', requireAuth, needsKey, async (req, res) => {
        try {
            const { userId, kind, category, note, warn } = req.body || {};
            if (!userId) return res.status(400).json({ error: 'Which pilot is required.' });
            if (kind !== 'avatar' && kind !== 'banner') {
                return res.status(400).json({ error: 'kind must be avatar or banner.' });
            }
            if (category && !CATEGORY_KEYS.includes(category)) {
                return res.status(400).json({ error: 'Unknown reason.' });
            }
            if (warn && warn.level && !LEVEL_KEYS.includes(warn.level)) {
                return res.status(400).json({ error: 'Unknown warning level.' });
            }

            const blockDays = warn && warn.blockUploads && warn.blockDays
                ? Math.min(Math.max(parseInt(warn.blockDays, 10) || 0, 1), 365)
                : null;

            const rows = await rpc('admin_pilot_takedown', {
                p_user_id: userId,
                p_kind: kind,
                p_category: category || 'other',
                p_note: (note && String(note).trim()) || null,
                p_removed_by: staffName(req),
                p_warn_level: (warn && warn.level) || null,
                p_warn_reason: (warn && warn.reason && String(warn.reason).trim()) || null,
                p_block_uploads: !!(warn && warn.blockUploads),
                p_block_days: blockDays,
            });

            const result = Array.isArray(rows) ? rows[0] : rows;

            // The row is already gone by here, which is what took the picture
            // down. The file is litter, and this is the sweep.
            const objectGone = result
                ? await dropObject(result.removed_bucket, result.removed_path)
                : false;

            res.status(201).json({
                ok: true,
                warningIssued: !!(result && result.warning_id),
                uploadsBlocked: !!(warn && warn.blockUploads),
                // Surfaced rather than swallowed: an object that would not
                // delete is not a failed takedown, but it IS something somebody
                // should eventually know about.
                objectDeleted: objectGone,
            });
        } catch (err) {
            console.error('[pilot-moderation] takedown:', err.message);
            res.status(statusFor(err)).json({ error: err.message });
        }
    });

    // --- Who cannot upload --------------------------------------------------
    app.get('/api/pilot-moderation/restrictions', requireAuth, needsKey, async (req, res) => {
        try {
            const rows = await rpc('admin_pilot_restrictions', {});
            res.json({
                restrictions: (rows || []).map((r) => ({
                    userId: r.user_id,
                    handle: r.handle || '',
                    displayName: r.display_name || '',
                    warningId: r.warning_id,
                    level: r.level,
                    levelLabel: (LEVELS.find((l) => l.key === r.level) || {}).label || r.level,
                    reason: r.reason || '',
                    until: r.until || null,
                    since: r.since || null,
                    acknowledgedAt: r.acknowledged_at || null,
                })),
            });
        } catch (err) {
            console.error('[pilot-moderation] restrictions:', err.message);
            res.status(statusFor(err)).json({ error: err.message });
        }
    });

    /* Let them upload again, without rescinding the warning.
     *
     * Two different acts, and both are needed. Rescinding says the warning
     * should not have been issued; lifting says it stood, it was dealt with,
     * and they can upload again. One switch for both would mean the only way to
     * let somebody upload was to erase the reason they could not.
     */
    app.post('/api/pilot-moderation/restrictions/:warningId/lift',
        requireAuth, needsKey, async (req, res) => {
            try {
                const lifted = await rpc('admin_pilot_lift_restriction', {
                    p_warning_id: req.params.warningId,
                    p_lifted_by: staffName(req),
                });
                res.json({ ok: true, lifted: lifted === true });
            } catch (err) {
                console.error('[pilot-moderation] lift:', err.message);
                res.status(statusFor(err)).json({ error: err.message });
            }
        });

    // --- The record ---------------------------------------------------------
    app.get('/api/pilot-moderation/log', requireAuth, needsKey, async (req, res) => {
        try {
            const rows = await rpc('admin_pilot_actions', {
                p_limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000),
                p_user_id: req.query.user || null,
            });
            res.json({
                actions: (rows || []).map((r) => ({
                    id: r.id,
                    userId: r.user_id,
                    handle: r.handle || '',
                    kind: r.kind,
                    category: r.category,
                    categoryLabel: (CATEGORIES.find((c) => c.key === r.category) || {}).label || r.category,
                    note: r.note || '',
                    removedBy: r.removed_by || 'Inflight',
                    warningLevel: r.warning_level || null,
                    createdAt: r.created_at,
                })),
            });
        } catch (err) {
            console.error('[pilot-moderation] log:', err.message);
            res.status(statusFor(err)).json({ error: err.message });
        }
    });

    // Whether the console can do anything at all. Its own route so the page can
    // draw a clear "not configured" state instead of four failed requests.
    app.get('/api/pilot-moderation/status', requireAuth, (req, res) => {
        res.json({ configured: isConfigured(), project: SUPABASE_URL });
    });
}

module.exports = {
    registerPilotModerationRoutes,
    CATEGORIES,
    LEVELS,
    isConfigured,
    publicUrl,
};
