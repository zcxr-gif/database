'use strict';

/*
 * crewExternalRoutes.js
 * The HTTP half of crewExternal.js — codeshares with airlines that run their
 * crew centre somewhere else.
 *
 *   GET    /api/crew/:slug/codeshare/external              staff: every outside partner
 *   POST   /api/crew/:slug/codeshare/external/preview      { feedUrl, format } | { csv }
 *   POST   /api/crew/:slug/codeshare/external              add one (and sync it)
 *   PATCH  /api/crew/:slug/codeshare/external/:id          change it (and sync it)
 *   POST   /api/crew/:slug/codeshare/external/:id/sync     { csv? | sheets? } — now
 *   POST   /api/crew/:slug/codeshare/external/:id/token    a new private feed address
 *   DELETE /api/crew/:slug/codeshare/external/:id          ?keep=1 keeps the copies
 *
 *   GET    /api/crew-feed/codeshare/:token.csv|.json       PUBLIC, token-gated:
 *                                                          the routes we share with them
 *
 * Every staff route is gated on routes.manage, like the in-platform
 * agreements. The feed is gated on a 48-character token and nothing else —
 * it is meant to be pasted into somebody else's software — and it publishes
 * only what the airline chose to share with that one partner.
 */

const crewExternal = require('./crewExternal');
const crewCodeshare = require('./crewCodeshare');

// How often outside feeds are re-read on their own. Their crew centres change
// on human timescales; six hours keeps a renumbered flight from lingering for
// a day without hammering anybody's server.
const AUTO_SYNC_MS = 6 * 60 * 60 * 1000;

module.exports = function registerCrewExternal(app, deps) {
    const {
        mongoose, VirtualAirlineAd, resolveCrewVa, resolveCrewStore, requireCap, crewFail,
        cleanRoute, publicRoute, eachLimited, crewCsv, crewWebhookUrlFor, postCrewNotice, transport, SITE_ORIGIN,
    } = deps;

    const denied = (res, gate) => res.status(gate.error).json({
        error: gate.error === 401 ? 'Not authenticated.' : 'You don’t have permission to manage the route network.',
    });
    const origin = (req) => `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');

    async function liveDoc(slug) {
        const va = await resolveCrewVa(slug);
        if (!va) return null;
        return VirtualAirlineAd.findById(va._id);
    }

    /** Their routes as a feed: fetched from their address, or an uploaded file. */
    async function readTheirs(p, { csv = null, sheets = null } = {}) {
        if (Array.isArray(sheets) && sheets.length) {
            const all = sheets.slice(0, 40).map((s) => crewExternal.parseFeed(String((s && s.csv) || ''), { format: 'csv' })).filter((f) => !f.error);
            if (!all.length) return { error: 'None of those sheets had routes in them.' };
            const seen = new Set();
            const routes = all.flatMap((f) => f.routes).filter((r) => !seen.has(r._id) && seen.add(r._id));
            return { routes, total: routes.length, errors: all.reduce((n, f) => n + f.errors, 0), format: 'csv' };
        }
        if (typeof csv === 'string' && csv.trim()) return crewExternal.parseFeed(csv, { format: 'auto' });
        if (!p.feedUrl) return { error: 'This partner has no feed address — upload their spreadsheet instead.' };
        const got = await crewExternal.safeGet(p.feedUrl, { transport });
        return crewExternal.parseFeed(got.text, { format: p.format, contentType: got.contentType });
    }

    /**
     * One sync of one outside partner onto one airline's network. Never throws.
     *
     * A feed that cannot be read, or comes back EMPTY while we hold their
     * routes, removes nothing: an outage on their side must not wipe a
     * codeshare off ours. It is recorded and said, and the next good read
     * catches up.
     */
    async function syncOne(slug, id, opts = {}) {
        const ad = await liveDoc(slug);
        if (!ad) return { error: 'Crew centre not found.' };
        const list = crewExternal.sanitizePartners(ad.crewExternalPartners || []);
        const p = list.find((x) => x.id === String(id));
        if (!p) return { error: 'No such partner.' };
        const done = { created: 0, updated: 0, removed: 0 };
        let error = '';
        let routes = 0;
        let feedTotal = null;
        try {
            const { store } = await resolveCrewStore(ad.slug);
            const [existing, health] = await Promise.all([store.listRoutes({ limit: 5000 }), store.health().catch(() => ({}))]);
            const partner = { slug: crewExternal.partnerSlug(p), name: p.name, logo: p.logo };
            const held = crewCodeshare.linkedRows(crewCodeshare.adoptLegacy(existing, partner, { schemaLinks: health.codeshareLinks !== false }), partner);
            let source = [];
            if (p.active && !opts.ending) {
                const feed = await readTheirs(p, opts);
                if (feed.error) throw new Error(feed.error);
                feedTotal = feed.total;
                if (!feed.routes.length && held.length) throw new Error('Their feed came back empty, so nothing was removed. Check it with them.');
                source = crewCodeshare.selectRoutes(feed.routes, p.take);
            }
            const plan = crewCodeshare.planSync({ source, existing, partner, schemaLinks: health.codeshareLinks !== false });
            await eachLimited(plan.create, 4, async (values) => {
                try { await store.createRoute(cleanRoute(values)); done.created++; } catch (e) { error = error || e.message; }
            });
            await eachLimited(plan.update, 4, async (row) => {
                try { await store.updateRoute(row.id, cleanRoute({ ...row.before, ...row.values })); done.updated++; } catch (e) { error = error || e.message; }
            });
            if (!opts.keepRoutes) {
                await eachLimited(plan.remove, 4, async (rid) => {
                    try { await store.deleteRoute(rid); done.removed++; } catch (e) { error = error || e.message; }
                });
            } else {
                await eachLimited(plan.remove, 4, async (rid) => {
                    await store.updateRoute(rid, { partnerSlug: '', sourceRouteId: '' }).catch(() => {});
                });
            }
            routes = plan.keep + done.created + done.updated;
            if (plan.stranded) error = error || `${plan.stranded} old codeshare${plan.stranded === 1 ? '' : 's'} could not be tidied away until your database is updated (Settings → Data store).`;
            if (done.created || done.updated || done.removed) {
                crewWebhookUrlFor(ad._id, 'routes').then((hook) => hook && postCrewNotice(hook, {
                    title: `🔁 Codeshare with ${p.name} updated`,
                    description: 'Their route list changed, so the codeshares your pilots fly on it did too.',
                    color: 0x0EA5E9,
                    fields: [
                        { name: 'Added', value: String(done.created), inline: true },
                        { name: 'Updated', value: String(done.updated), inline: true },
                        { name: 'Removed', value: String(done.removed), inline: true },
                    ],
                })).catch(() => {});
            }
        } catch (err) {
            error = (err && err.message) || 'Their routes could not be read.';
        }
        const record = { at: new Date().toISOString(), ...done, routes, feedTotal, error: String(error || '').slice(0, 300) };
        if (!opts.ending) {
            // Re-read before writing: a staff edit may have landed while the
            // feed was being fetched, and this must only touch lastSync.
            const fresh = await liveDoc(slug);
            if (fresh) {
                const now = crewExternal.sanitizePartners(fresh.crewExternalPartners || []);
                const i = now.findIndex((x) => x.id === p.id);
                if (i >= 0) {
                    now[i] = { ...now[i], lastSync: record };
                    fresh.crewExternalPartners = now;
                    fresh.markModified('crewExternalPartners');
                    await fresh.save().catch(() => {});
                }
            }
        }
        return record;
    }

    const views = (list, req, slug) => list.map((p) => crewExternal.view(p, { origin: origin(req), slug }));

    app.get('/api/crew/:slug/codeshare/external', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const ad = await VirtualAirlineAd.findById(va._id).select('slug crewExternalPartners').lean();
            res.set('Cache-Control', 'no-store');
            res.json({ partners: views(crewExternal.sanitizePartners((ad && ad.crewExternalPartners) || []), req, ad && ad.slug), platforms: crewExternal.PLATFORMS, max: crewExternal.MAX_PARTNERS });
        } catch (err) { crewFail(res, err, { log: 'external list error', message: 'Could not read your outside partners.' }); }
    });

    // Read a feed or a file without saving anything, so the screen can show
    // what is in it and let the staff member choose routes before committing.
    app.post('/api/crew/:slug/codeshare/external/preview', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const b = req.body || {};
            const feed = await readTheirs({ feedUrl: crewExternal.normalizeFeedUrl(b.feedUrl), format: crewExternal.FORMATS.includes(b.format) ? b.format : 'auto' }, { csv: b.csv, sheets: b.sheets })
                .catch((err) => ({ error: err.message }));
            if (feed.error) return res.status(400).json({ error: feed.error });
            res.set('Cache-Control', 'no-store');
            res.json({
                total: feed.total, errors: feed.errors, format: feed.format,
                routes: feed.routes.slice(0, 3000).map((r) => ({ id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination, aircraft: r.aircraft, distanceNm: r.distanceNm })),
            });
        } catch (err) { crewFail(res, err, { log: 'external preview error', message: 'Could not read that feed.' }); }
    });

    app.post('/api/crew/:slug/codeshare/external', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await liveDoc(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewExternal.sanitizePartners(ad.crewExternalPartners || []);
            if (list.length >= crewExternal.MAX_PARTNERS) return res.status(409).json({ error: `That is ${crewExternal.MAX_PARTNERS} outside partners — the most a crew centre holds.` });
            const b = req.body || {};
            const p = crewExternal.sanitizePartner({ ...b, feedUrl: crewExternal.normalizeFeedUrl(b.feedUrl) });
            if (!p) return res.status(400).json({ error: 'Give the partner a name.' });
            if (list.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) return res.status(409).json({ error: 'You already have an outside partner by that name.' });
            ad.crewExternalPartners = [...list, p];
            ad.markModified('crewExternalPartners');
            await ad.save();
            const sync = (p.feedUrl || b.csv || b.sheets) ? await syncOne(ad.slug, p.id, { csv: b.csv, sheets: b.sheets }) : null;
            const fresh = crewExternal.sanitizePartners((await VirtualAirlineAd.findById(ad._id).select('crewExternalPartners').lean()).crewExternalPartners || []);
            res.status(201).json({ partner: views(fresh.filter((x) => x.id === p.id), req, ad.slug)[0], sync });
        } catch (err) { crewFail(res, err, { log: 'external add error', message: 'Could not add that partner.' }); }
    });

    app.patch('/api/crew/:slug/codeshare/external/:id', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await liveDoc(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewExternal.sanitizePartners(ad.crewExternalPartners || []);
            const i = list.findIndex((x) => x.id === String(req.params.id));
            if (i < 0) return res.status(404).json({ error: 'No such partner.' });
            const b = req.body || {};
            const merged = { ...list[i], ...b };
            if (b.feedUrl !== undefined) merged.feedUrl = crewExternal.normalizeFeedUrl(b.feedUrl);
            const next = crewExternal.sanitizePartner(merged, list[i]);
            if (!next) return res.status(400).json({ error: 'Give the partner a name.' });
            // A new name on the copies too: they carry it.
            list[i] = next;
            ad.crewExternalPartners = list;
            ad.markModified('crewExternalPartners');
            await ad.save();
            const sync = (next.feedUrl && (b.take !== undefined || b.feedUrl !== undefined || b.active !== undefined || b.name !== undefined || b.logo !== undefined))
                ? await syncOne(ad.slug, next.id) : null;
            const fresh = crewExternal.sanitizePartners((await VirtualAirlineAd.findById(ad._id).select('crewExternalPartners').lean()).crewExternalPartners || []);
            res.json({ partner: views(fresh.filter((x) => x.id === next.id), req, ad.slug)[0], sync });
        } catch (err) { crewFail(res, err, { log: 'external edit error', message: 'Could not save that partner.' }); }
    });

    app.post('/api/crew/:slug/codeshare/external/:id/sync', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const b = req.body || {};
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const sync = await syncOne(va.slug, req.params.id, { csv: b.csv, sheets: b.sheets });
            if (sync.error === 'No such partner.') return res.status(404).json({ error: sync.error });
            res.json({ sync });
        } catch (err) { crewFail(res, err, { log: 'external sync error', message: 'Could not sync that partner.' }); }
    });

    app.post('/api/crew/:slug/codeshare/external/:id/token', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await liveDoc(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewExternal.sanitizePartners(ad.crewExternalPartners || []);
            const i = list.findIndex((x) => x.id === String(req.params.id));
            if (i < 0) return res.status(404).json({ error: 'No such partner.' });
            list[i] = { ...list[i], shareToken: require('crypto').randomBytes(24).toString('hex') };
            ad.crewExternalPartners = list;
            ad.markModified('crewExternalPartners');
            await ad.save();
            res.json({ partner: views([list[i]], req, ad.slug)[0] });
        } catch (err) { crewFail(res, err, { log: 'external token error', message: 'Could not make a new address.' }); }
    });

    // Ending it. Their copies come off our network unless `keep=1`, which
    // leaves them as ordinary codeshares, no longer followed.
    app.delete('/api/crew/:slug/codeshare/external/:id', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await liveDoc(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewExternal.sanitizePartners(ad.crewExternalPartners || []);
            const p = list.find((x) => x.id === String(req.params.id));
            if (!p) return res.status(404).json({ error: 'No such partner.' });
            const keep = String(req.query.keep || '') === '1';
            const sync = await syncOne(ad.slug, p.id, { ending: true, keepRoutes: keep });
            const again = await liveDoc(req.params.slug);
            again.crewExternalPartners = crewExternal.sanitizePartners(again.crewExternalPartners || []).filter((x) => x.id !== p.id);
            again.markModified('crewExternalPartners');
            await again.save();
            res.json({ ok: true, removed: keep ? 0 : sync.removed, kept: keep });
        } catch (err) { crewFail(res, err, { log: 'external end error', message: 'Could not end that codeshare.' }); }
    });

    /* ---- The feed they read from us ---- */
    app.get('/api/crew-feed/codeshare/:file', async (req, res) => {
        try {
            const m = String(req.params.file || '').match(/^([a-f0-9]{48})\.(csv|json)$/);
            if (!m) return res.status(404).json({ error: 'No such feed.' });
            const [, token, ext] = m;
            const ad = await VirtualAirlineAd.findOne({ 'crewExternalPartners.shareToken': token, status: 'approved' })
                .select('name slug callsign logoUrl crewExternalPartners').lean();
            const p = ad && crewExternal.sanitizePartners(ad.crewExternalPartners || []).find((x) => x.shareToken === token);
            if (!p || !p.active) return res.status(404).json({ error: 'No such feed.' });
            const { store } = await resolveCrewStore(ad.slug);
            const airline = { name: ad.name, logo: /^https:\/\//i.test(String(ad.logoUrl || '')) ? ad.logoUrl : '' };
            const rows = crewExternal.outgoing(await store.listRoutes({ activeOnly: true, limit: 5000 }), p.share, airline);
            res.set('Cache-Control', 'public, max-age=300');
            res.set('Access-Control-Allow-Origin', '*');
            if (ext === 'json') {
                return res.json({
                    airline: { name: ad.name, callsign: ad.callsign || '', logo: airline.logo, crewCenter: `${SITE_ORIGIN}/crew/${encodeURIComponent(ad.slug)}` },
                    partner: p.name,
                    generatedAt: new Date().toISOString(),
                    routes: rows,
                });
            }
            const layout = ['flightNumber', 'origin', 'destination', 'aircraft', 'distanceNm', 'departureGate', 'arrivalGate', 'kind', 'partnerName', 'partnerLogo']
                .map((key) => ({ header: key === 'partnerName' ? 'operator' : key, key }));
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `inline; filename="${String(ad.slug).replace(/[^a-z0-9-]/gi, '')}-codeshare.csv"`);
            res.send(crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, layout, { includeId: false }));
        } catch (err) { crewFail(res, err, { log: 'external feed error', message: 'That feed is not available right now.' }); }
    });

    /* ---- Keeping it going on its own ---- */
    let timer = null;
    let running = false;
    async function sweep() {
        if (running || !mongoose || !mongoose.connection || mongoose.connection.readyState !== 1) return;
        running = true;
        try {
            const ads = await VirtualAirlineAd.find({ 'crewExternalPartners.0': { $exists: true }, status: 'approved' })
                .select('slug crewExternalPartners').limit(500).lean();
            for (const ad of ads) {
                for (const p of crewExternal.sanitizePartners(ad.crewExternalPartners || [])) {
                    if (!p.active || !p.autoSync || !p.feedUrl) continue;
                    await syncOne(ad.slug, p.id).catch(() => {});
                }
            }
        } catch (err) { console.warn('external codeshare sweep:', err && err.message); }
        running = false;
    }
    function startAutoSync() {
        if (timer) return;
        timer = setInterval(sweep, AUTO_SYNC_MS);
        if (timer.unref) timer.unref();
    }

    return { syncOne, sweep, startAutoSync, readTheirs };
};
