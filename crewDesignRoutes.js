'use strict';

/*
 * crewDesignRoutes.js
 * The HTTP half of crewDesign.js: the airline's artwork library, where its
 * pictures go, its theme file and which interface the crew sees.
 *
 *   GET    /api/crew/:slug/design              staff: everything, CSS included
 *   PUT    /api/crew/:slug/design              { theme?, art?, ui? }
 *   POST   /api/crew/:slug/design/import       { file } — a theme file, read back
 *   GET    /api/crew/:slug/design/export       the theme file, as a download
 *   POST   /api/crew/:slug/artwork             multipart `image` + title/kind/credit
 *   POST   /api/crew/:slug/artwork/link        { url, title, kind, credit } — hosted elsewhere
 *   PATCH  /api/crew/:slug/artwork/:id         { title, kind, credit, creditUrl, featured }
 *   DELETE /api/crew/:slug/artwork/:id
 *   PUT    /api/crew/:slug/artwork/order       { ids: [...] }
 *
 * The public half — theme, art, artwork, ui — goes out with the branding on
 * /api/va-ads/by-slug/:slug, because the crew centre paints it before it has
 * a session. Everything here is gated on settings.branding, the capability
 * that already governs the logo, the accent and the layout.
 */

const crewDesign = require('./crewDesign');

module.exports = function registerCrewDesign(app, deps) {
    const {
        VirtualAirlineAd, resolveCrewVa, requireCap, crewFail,
        upload, s3Client, uploadVaImageMeta, deleteVaImage,
    } = deps;

    const denied = (res, gate) => res.status(gate.error).json({
        error: gate.error === 401 ? 'Not authenticated.' : 'You don’t have permission to change the crew centre’s appearance.',
    });

    const FIELDS = 'name slug crewArtwork crewArt crewTheme crewUi';

    async function live(slug) {
        const va = await resolveCrewVa(slug);
        if (!va) return null;
        return VirtualAirlineAd.findById(va._id);
    }

    function view(ad) {
        const theme = crewDesign.sanitizeTheme(ad.crewTheme || {}).theme;
        return {
            theme,
            art: crewDesign.sanitizeArt(ad.crewArt || {}),
            artwork: crewDesign.publicArtwork(ad.crewArtwork || []),
            ui: crewDesign.UIS.includes(ad.crewUi) ? ad.crewUi : 'essential',
            limits: { artwork: crewDesign.MAX_ARTWORK, css: crewDesign.MAX_CSS },
        };
    }

    /** Only objects this feature put in the bucket are ever deleted. */
    const ours = (a) => a && a.hosted && /\/va-ads\/art\//.test(String(a.url || ''));

    app.get('/api/crew/:slug/design', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const ad = await VirtualAirlineAd.findById(va._id).select(FIELDS).lean();
            res.set('Cache-Control', 'no-store');
            res.json(view(ad || {}));
        } catch (err) { crewFail(res, err, { log: 'design read error', message: 'Could not read the design.' }); }
    });

    /**
     * Save any of the three. What was sent is written; what was not is left.
     * The CSS comes back cleaned, with a list of what was removed, so the
     * editor can show the designer exactly what did not survive.
     */
    async function save(req, res, input) {
        const ad = await live(req.params.slug);
        if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
        let dropped = [];
        if (input.theme !== undefined) {
            const t = crewDesign.sanitizeTheme(input.theme || {});
            dropped = t.dropped;
            ad.crewTheme = crewDesign.themeEmpty(t.theme) ? null : t.theme;
            ad.markModified('crewTheme');
        }
        if (input.art !== undefined && input.art !== null) {
            ad.crewArt = crewDesign.sanitizeArt(input.art);
            ad.markModified('crewArt');
        }
        if (input.ui !== undefined && input.ui !== null) {
            if (!crewDesign.UIS.includes(input.ui)) return res.status(400).json({ error: 'Unknown interface.' });
            ad.crewUi = input.ui;
        }
        await ad.save();
        res.set('Cache-Control', 'no-store');
        res.json({ ...view(ad.toObject ? ad.toObject() : ad), dropped });
    }

    app.put('/api/crew/:slug/design', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try { await save(req, res, req.body || {}); } catch (err) { crewFail(res, err, { log: 'design save error', message: 'Could not save the design.' }); }
    });

    // A theme file, uploaded. Read through the same sanitisers as a save.
    app.post('/api/crew/:slug/design/import', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const got = crewDesign.readThemeFile((req.body || {}).file);
            if (got.error) return res.status(400).json({ error: got.error });
            // A dry run shows what the file WOULD do before anything changes.
            if ((req.body || {}).dryRun === true) return res.json({ dryRun: true, theme: got.theme, art: got.art, ui: got.ui, dropped: got.dropped });
            await save(req, res, { theme: got.theme, art: got.art, ui: got.ui });
        } catch (err) { crewFail(res, err, { log: 'design import error', message: 'Could not read that theme file.' }); }
    });

    app.get('/api/crew/:slug/design/export', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const ad = await VirtualAirlineAd.findById(va._id).select(FIELDS).lean();
            const file = crewDesign.themeFile({
                name: ad.name, slug: ad.slug, theme: ad.crewTheme, art: ad.crewArt, ui: ad.crewUi, artwork: ad.crewArtwork,
            });
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${String(ad.slug || 'crew').replace(/[^a-z0-9-]/gi, '')}.crewtheme.json"`);
            res.set('Cache-Control', 'no-store');
            res.send(JSON.stringify(file, null, 2));
        } catch (err) { crewFail(res, err, { log: 'design export error', message: 'Could not export the theme.' }); }
    });

    /* ---- The artwork library ---- */

    const meta = (b) => ({
        title: b.title, kind: b.kind, credit: b.credit, creditUrl: b.creditUrl,
        featured: b.featured === undefined ? true : !(b.featured === false || b.featured === 'false'),
    });

    async function addArtwork(req, res, record) {
        const ad = await live(req.params.slug);
        if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
        const list = crewDesign.sanitizeArtwork(ad.crewArtwork || []);
        if (list.length >= crewDesign.MAX_ARTWORK) {
            return res.status(409).json({ error: `That is ${crewDesign.MAX_ARTWORK} pictures — the most a crew centre holds. Remove one first.` });
        }
        const item = crewDesign.cleanArtwork(record);
        if (!item) return res.status(400).json({ error: 'That picture needs an https address.' });
        ad.crewArtwork = [...list, item];
        ad.markModified('crewArtwork');
        await ad.save();
        res.status(201).json({ artwork: crewDesign.publicArtwork([item])[0], all: crewDesign.publicArtwork(ad.crewArtwork) });
    }

    app.post('/api/crew/:slug/artwork', upload.single('image'), async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            let stored;
            try {
                stored = await uploadVaImageMeta(s3Client, req.file, String(va._id), 'art');
            } catch (err) {
                if (err && err.status) return res.status(err.status).json({ error: err.message });
                return res.status(400).json({ error: 'That file could not be read as an image. Try a JPG, PNG, WebP or GIF.' });
            }
            await addArtwork(req, res, { ...meta(req.body || {}), url: stored.url, width: stored.width, height: stored.height, hosted: true });
        } catch (err) { crewFail(res, err, { log: 'artwork upload error', message: 'Could not upload that picture.' }); }
    });

    // A picture already hosted somewhere (the VA's own site, Imgur, a CDN).
    app.post('/api/crew/:slug/artwork/link', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const url = crewDesign.httpsUrl((req.body || {}).url);
            if (!url) return res.status(400).json({ error: 'Paste an https link to the picture.' });
            await addArtwork(req, res, { ...meta(req.body || {}), url, hosted: false });
        } catch (err) { crewFail(res, err, { log: 'artwork link error', message: 'Could not add that picture.' }); }
    });

    app.put('/api/crew/:slug/artwork/order', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await live(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : [];
            const list = crewDesign.sanitizeArtwork(ad.crewArtwork || []);
            const rank = new Map(ids.map((id, i) => [id, i]));
            list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e6) - (rank.has(b.id) ? rank.get(b.id) : 1e6));
            ad.crewArtwork = list;
            ad.markModified('crewArtwork');
            await ad.save();
            res.json({ artwork: crewDesign.publicArtwork(list) });
        } catch (err) { crewFail(res, err, { log: 'artwork order error', message: 'Could not reorder the pictures.' }); }
    });

    app.patch('/api/crew/:slug/artwork/:id', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await live(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewDesign.sanitizeArtwork(ad.crewArtwork || []);
            const i = list.findIndex((a) => a.id === String(req.params.id));
            if (i < 0) return res.status(404).json({ error: 'No such picture.' });
            const b = req.body || {};
            const next = crewDesign.cleanArtwork({
                ...list[i],
                ...Object.fromEntries(Object.entries(meta(b)).filter(([k]) => b[k] !== undefined)),
                url: list[i].url,
            }, list[i]);
            list[i] = next;
            ad.crewArtwork = list;
            ad.markModified('crewArtwork');
            await ad.save();
            res.json({ artwork: crewDesign.publicArtwork([next])[0] });
        } catch (err) { crewFail(res, err, { log: 'artwork edit error', message: 'Could not save that picture.' }); }
    });

    // Removing a picture also takes it out of anywhere it was placed — a hero
    // or a section cover pointing at a deleted object is a broken image on
    // the first thing a pilot sees.
    app.delete('/api/crew/:slug/artwork/:id', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'settings.branding');
        if (gate.error) return denied(res, gate);
        try {
            const ad = await live(req.params.slug);
            if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
            const list = crewDesign.sanitizeArtwork(ad.crewArtwork || []);
            const gone = list.find((a) => a.id === String(req.params.id));
            if (!gone) return res.status(404).json({ error: 'No such picture.' });
            ad.crewArtwork = list.filter((a) => a !== gone);
            ad.crewArt = crewDesign.forgetUrl(ad.crewArt || {}, gone.url);
            ad.markModified('crewArtwork');
            ad.markModified('crewArt');
            await ad.save();
            // The row first, the object after: a failed save leaves an extra
            // object in a bucket, never a record pointing at nothing.
            if (ours(gone)) await deleteVaImage(s3Client, gone.url);
            res.json({ ok: true, art: crewDesign.sanitizeArt(ad.crewArt) });
        } catch (err) { crewFail(res, err, { log: 'artwork delete error', message: 'Could not remove that picture.' }); }
    });

    /** The public half, for /api/va-ads/by-slug. */
    function publicDesign(ad) {
        const theme = crewDesign.sanitizeTheme(ad.crewTheme || {}).theme;
        return {
            theme: crewDesign.themeEmpty(theme) ? null : theme,
            art: crewDesign.sanitizeArt(ad.crewArt || {}),
            artwork: crewDesign.publicArtwork(ad.crewArtwork || []),
            ui: crewDesign.UIS.includes(ad.crewUi) ? ad.crewUi : '',
        };
    }

    return { publicDesign, FIELDS };
};
