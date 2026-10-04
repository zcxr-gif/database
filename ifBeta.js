'use strict';

/*
 * ifBeta.js
 * Whether a crew center may use Infinite Flight Live yet.
 *
 * WHY THIS IS LOCKED
 * ------------------
 * The Live integration rides on PublicApi v3, which Infinite Flight ship as a
 * preview: paths, scopes, enums, validation and rate limits may all change
 * before it is generally available (see the head of ifLive.js). The crew
 * center's side of it — connecting an organization, the fleet board, pushing a
 * week of departures onto a real aircraft's rota — is built and works, and it
 * is still a beta sitting on a beta. A VA that connects today is writing to its
 * real Live organization through an API that is allowed to change underneath
 * it.
 *
 * So it is shut for everyone until it is opened on purpose. Not hidden: the
 * dashboard shows the tile with a Beta lock on it and says why, because a
 * feature that silently vanished reads as "this VA lost something".
 *
 * WHAT THE LOCK COVERS
 * --------------------
 * Every /api/crew/:slug/if route (connect, fleet, schedules, push, pull…), the
 * automatic schedule sync that runs when a departure is published, and the
 * setup guide's step. Nothing is deleted: a VA that connected before the lock
 * keeps its grant and its settings, and finds them exactly where they were the
 * day the lock comes off.
 *
 * Two read routes answer EMPTY rather than refusing — the pilot board and the
 * airframe list the schedule editor asks for. Both already treat "nothing" as
 * "this VA has no Live organization" and draw nothing, which is exactly right
 * while it is locked; a refusal would put an error on a pilot's home page for a
 * feature they were never offered.
 *
 * OPENING IT
 * ----------
 *   IF_LIVE_BETA_SLUGS   comma-separated crew center slugs to open it for
 *                        (testers), or `*` to open it for every crew center —
 *                        which is what general availability will look like.
 *
 * Unset is locked. That is the safe direction for a typo, too: a slug spelled
 * wrong stays locked rather than opening something for somebody else.
 */

const MESSAGE = 'Infinite Flight Live is in beta and locked for every crew center while Infinite Flight finish their API. Nothing you set up before is lost — it will be right where you left it when it opens.';

function parseList(raw) {
    const list = String(raw == null ? '' : raw)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    return { all: list.includes('*'), slugs: new Set(list.filter((s) => s !== '*')) };
}

/**
 * Is Live open for this crew center?
 * `env` is a parameter so the tests can drive both halves without touching
 * process.env; production always reads the real one.
 */
function isOpen(slug, env = process.env) {
    const { all, slugs } = parseList(env.IF_LIVE_BETA_SLUGS);
    if (all) return true;
    const s = String(slug || '').trim().toLowerCase();
    return !!s && slugs.has(s);
}

const isLocked = (slug, env) => !isOpen(slug, env);

/** What every surface says about the lock — one sentence, one shape. */
function state(slug, env) {
    const locked = isLocked(slug, env);
    return { beta: true, locked, message: locked ? MESSAGE : '' };
}

const CODE = 'if_live_beta';

/**
 * The gate, for `app.use('/api/crew/:slug/if', …)`. Mounted once in front of
 * every Live route so a route added later cannot forget it.
 *
 * The pilot board and the editor's airframe list answer EMPTY instead of 423:
 * both already read "nothing" as "no Live organization" and draw nothing, and a
 * refusal there would put an error in front of pilots for a feature nobody
 * offered them. Everything else gets the lock, said in words, with a code the
 * panel draws its Beta screen from.
 */
function middleware(env) {
    return (req, res, next) => {
        const slug = String((req.params && req.params.slug) || '').toLowerCase();
        if (isOpen(slug, env || process.env)) return next();
        const sub = String(req.path || '/').replace(/\/+$/, '') || '/';
        const beta = state(slug, env || process.env);
        if (req.method === 'GET' && sub === '/board') {
            return res.json({ connected: false, aircraft: [], departures: [], beta });
        }
        if (req.method === 'GET' && sub === '/airframes') {
            return res.json({ airframes: [], connected: false, beta });
        }
        res.set('Cache-Control', 'no-store');
        return res.status(423).json({ error: MESSAGE, code: CODE, beta });
    };
}

module.exports = { isOpen, isLocked, state, middleware, MESSAGE, CODE };
