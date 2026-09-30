'use strict';

/*
 * crewNetworkRoutes.js
 * The HTTP half of four things that grow a VA's network beyond its own metal:
 *
 *   CODESHARE AGREEMENTS  one crew centre asking another to sell each other's
 *                         flights, and the sync that keeps the copies true
 *                         (crewCodeshare.js holds the rules)
 *   TOURS & CHALLENGES    what the airline sets its pilots to fly
 *                         (crewGoals.js holds the arithmetic)
 *   HUBS                  where the airline says it is based, rather than
 *                         where the route count happens to be highest
 *   EXPORTS               any slice of the network as a spreadsheet — the
 *                         codeshares, one partner, the rows somebody ticked, or
 *                         one sheet with every airline in it
 *
 * Kept out of server.js because server.js is twenty-two thousand lines and
 * these are one feature family with one set of dependencies. Registered from
 * there with the helpers every crew route already uses, so the auth, the error
 * shape and the database-drift warnings are the same ones, not copies.
 */

const crewCodeshare = require('./crewCodeshare');
const crewGoals = require('./crewGoals');

const fold = (v) => String(v || '').trim().toLowerCase();
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// How long after a route edit the partners' copies follow it. Long enough that
// a VA editing ten routes in a row triggers one sync rather than ten; short
// enough that nobody notices the gap.
const FOLLOW_DELAY_MS = 20 * 1000;

const MAX_HUBS = 30;
const HUB_KINDS = ['hub', 'focus'];

function sanitizeHubs(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, MAX_HUBS).map((h) => ({
        icao: String((h && h.icao) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
        name: str(h && h.name, 60),
        // A hub is where the airline is based; a focus city is where it has a
        // presence without being based. The map draws them differently.
        kind: HUB_KINDS.includes(h && h.kind) ? h.kind : 'hub',
    })).filter((h) => {
        if (h.icao.length < 3 || seen.has(h.icao)) return false;
        seen.add(h.icao);
        return true;
    });
}

module.exports = function registerCrewNetwork(app, deps) {
    const {
        mongoose, VirtualAirlineAd, crewStore, crewCsv, crewRanks,
        resolveCrewVa, resolveCrewStore, requireCap, crewFail, withDrift, crewViewer,
        cleanRoute, publicRoute, eachLimited, crewWebhookUrlFor, postCrewNotice, SITE_ORIGIN,
    } = deps;

    /* =======================================================================
     * THE AGREEMENT
     *
     * Central, because it belongs to two airlines at once. See the head of
     * crewCodeshare.js for the shape and the reasoning.
     * ===================================================================== */

    const selectionShape = {
        _id: false,
        mode: { type: String, enum: crewCodeshare.MODES, default: 'none' },
        routeIds: { type: [String], default: [] },
    };
    const syncShape = {
        _id: false,
        at: Date, added: Number, updated: Number, removed: Number, routes: Number, error: String,
    };
    const CrewCodeshareSchema = new mongoose.Schema({
        fromVa: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', index: true },
        fromSlug: { type: String, lowercase: true, trim: true, index: true },
        fromName: String, fromLogo: String, fromCallsign: String,
        toVa: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAirlineAd', index: true },
        toSlug: { type: String, lowercase: true, trim: true, index: true },
        toName: String, toLogo: String, toCallsign: String,
        status: { type: String, enum: crewCodeshare.STATUSES, default: 'pending', index: true },
        // What each side sells of the OTHER side's network, and the most the
        // owning side allows it to. See narrowSelection.
        fromTakes: selectionShape, fromLimit: selectionShape,
        toTakes: selectionShape, toLimit: selectionShape,
        message: String, reply: String,
        requestedBy: String, decidedBy: String, endedBy: String,
        decidedAt: Date, endedAt: Date,
        sync: { _id: false, from: syncShape, to: syncShape },
    }, { timestamps: true });
    const CrewCodeshare = mongoose.models.CrewCodeshare || mongoose.model('CrewCodeshare', CrewCodeshareSchema);

    const who = (gate) => str(gate && gate.p && (gate.p.name || gate.p.username), 80);
    const denied = (res, gate) => res.status(gate.error).json({
        error: gate.error === 401 ? 'Not authenticated.' : 'You don’t have permission to manage the route network.',
    });

    /** The central record for a slug: names, logo, and the codeshare switch. */
    async function airlineCard(slug) {
        const va = await resolveCrewVa(slug);
        if (!va) return null;
        const doc = await VirtualAirlineAd.findById(va._id)
            .select('name slug callsign callsigns logoUrl country tagline crewCodeshareOpen').lean();
        return doc ? { ...doc, _id: va._id } : null;
    }

    const partyOf = (card) => ({
        slug: card.slug || '',
        name: card.name || '',
        logo: /^https:\/\//i.test(String(card.logoUrl || '')) ? card.logoUrl : '',
        callsign: card.callsign || '',
    });

    const allFor = (slug) => CrewCodeshare.find({ $or: [{ fromSlug: fold(slug) }, { toSlug: fold(slug) }] })
        .sort({ updatedAt: -1 }).limit(300).lean();

    /** Post to one airline's route feed. Fire-and-forget, like every notice. */
    function tell(vaId, notice) {
        crewWebhookUrlFor(vaId, 'routes')
            .then((hook) => hook && postCrewNotice(hook, notice))
            .catch(() => {});
    }
    const crewLink = (slug) => `${SITE_ORIGIN}/crew/${encodeURIComponent(slug)}`;

    /* ---------------------------------------------------------------------
     * The sync — one side of one agreement.
     *
     * Reads the partner's network, works out the plan, writes it, records what
     * happened on the agreement. Never throws: a partner whose database is
     * down is a sync that failed and says so, not a request that 500s.
     * ------------------------------------------------------------------- */
    async function syncSide(doc, side) {
        const them = crewCodeshare.otherSide(side);
        const takerSlug = doc[`${side}Slug`];
        const sourceSlug = doc[`${them}Slug`];
        let plan = null;
        let routes = 0;
        const done = { created: 0, updated: 0, removed: 0 };
        let error = '';
        try {
            const [{ store: taker }, sourceCard] = await Promise.all([
                resolveCrewStore(takerSlug), airlineCard(sourceSlug),
            ]);
            const partner = sourceCard ? partyOf(sourceCard) : {
                slug: sourceSlug, name: doc[`${them}Name`], logo: doc[`${them}Logo`],
            };
            let source = [];
            if (doc.status === 'active') {
                const { store: src } = await resolveCrewStore(sourceSlug);
                source = crewCodeshare.selectRoutes(await src.listRoutes({ activeOnly: true }), crewCodeshare.selling(doc, side));
            }
            const [existing, health] = await Promise.all([
                taker.listRoutes({ limit: 5000 }),
                taker.health().catch(() => ({})),
            ]);
            plan = crewCodeshare.planSync({
                source, existing, partner, schemaLinks: health.codeshareLinks !== false,
            });
            await eachLimited(plan.create, 4, async (values) => {
                try { await taker.createRoute(cleanRoute(values)); done.created++; } catch (e) { error = error || (e && e.message) || 'A route could not be added.'; }
            });
            await eachLimited(plan.update, 4, async (row) => {
                try { await taker.updateRoute(row.id, cleanRoute({ ...row.before, ...row.values })); done.updated++; } catch (e) { error = error || (e && e.message) || 'A route could not be updated.'; }
            });
            await eachLimited(plan.remove, 4, async (id) => {
                try { await taker.deleteRoute(id); done.removed++; } catch (e) { error = error || (e && e.message) || 'A route could not be removed.'; }
            });
            routes = plan.keep + done.created + done.updated;
            if (plan.stranded) {
                error = error || `${plan.stranded} old codeshare${plan.stranded === 1 ? '' : 's'} could not be tidied away until your database is updated (Settings → Data store).`;
            }
            // Refresh the names on the agreement while we have them — a partner
            // that rebranded should not stay under its old name in the list.
            if (sourceCard) {
                doc[`${them}Name`] = partner.name;
                doc[`${them}Logo`] = partner.logo;
            }
            if (done.created || done.updated || done.removed) {
                const takerCard = await airlineCard(takerSlug).catch(() => null);
                if (takerCard) {
                    tell(takerCard._id, {
                        title: `🔁 Codeshare with ${partner.name} updated`,
                        description: 'Their network changed, so the flights you sell on it did too.',
                        color: 0x0EA5E9,
                        fields: [
                            { name: 'Added', value: String(done.created), inline: true },
                            { name: 'Updated', value: String(done.updated), inline: true },
                            { name: 'Removed', value: String(done.removed), inline: true },
                        ],
                    });
                }
            }
        } catch (err) {
            error = (err && err.message) || 'The partner network could not be read.';
        }
        const record = crewCodeshare.syncRecord({ plan, done, routes, error });
        await CrewCodeshare.updateOne({ _id: doc._id }, {
            $set: {
                [`sync.${side}`]: record,
                [`${them}Name`]: doc[`${them}Name`],
                [`${them}Logo`]: doc[`${them}Logo`],
            },
        }).catch(() => {});
        return record;
    }

    async function syncBoth(doc) {
        const [from, to] = await Promise.all([syncSide(doc, 'from'), syncSide(doc, 'to')]);
        return { from, to };
    }

    /* ---- Following a partner's edits ----
     *
     * A route edit on either airline re-syncs the OTHER side of every active
     * agreement it is party to, a few seconds later and once per burst. In
     * process, and deliberately forgetful: a restart loses a pending follow,
     * and the next edit or the "Sync now" button catches up. Nothing is lost —
     * the copies are only ever as stale as the last edit before a restart.
     */
    const following = new Map();
    function routesChanged(va) {
        const slug = fold(va && va.slug);
        if (!slug) return;
        allFor(slug).then((docs) => {
            for (const doc of docs) {
                if (doc.status !== 'active') continue;
                const side = crewCodeshare.sideOf(doc, slug);
                if (!side) continue;
                const taker = crewCodeshare.otherSide(side);
                const key = `${doc._id}:${taker}`;
                clearTimeout(following.get(key));
                const t = setTimeout(() => {
                    following.delete(key);
                    CrewCodeshare.findById(doc._id).lean()
                        .then((fresh) => fresh && fresh.status === 'active' && syncSide(fresh, taker))
                        .catch(() => {});
                }, FOLLOW_DELAY_MS);
                if (t.unref) t.unref();
                following.set(key, t);
            }
        }).catch(() => {});
    }

    /** How many codeshares on this network each partner slug accounts for. */
    async function linkedCounts(slug) {
        try {
            const { store } = await resolveCrewStore(slug);
            const routes = await store.listRoutes({ limit: 5000 });
            const out = {};
            for (const r of routes) if (r.kind === 'codeshare' && r.partnerSlug) out[r.partnerSlug] = (out[r.partnerSlug] || 0) + 1;
            const health = await store.health().catch(() => ({}));
            return { counts: out, schemaLinks: health.codeshareLinks !== false };
        } catch { return { counts: {}, schemaLinks: true }; }
    }

    // ---- The list: every agreement this airline is party to ----
    app.get('/api/crew/:slug/codeshare', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const me = await airlineCard(req.params.slug);
            if (!me) return res.status(404).json({ error: 'Crew centre not found.' });
            const [docs, linked] = await Promise.all([allFor(me.slug), linkedCounts(me.slug)]);
            const agreements = docs
                .map((d) => crewCodeshare.view(d, me.slug, {
                    linked: linked.counts[fold(d[`${crewCodeshare.otherSide(crewCodeshare.sideOf(d, me.slug))}Slug`])] || 0,
                }))
                .filter(Boolean);
            res.set('Cache-Control', 'no-store');
            res.json({
                agreements,
                open: me.crewCodeshareOpen !== false,
                schemaLinks: linked.schemaLinks,
                incoming: agreements.filter((a) => a.canAccept).length,
                me: partyOf(me),
            });
        } catch (err) { crewFail(res, err, { log: 'codeshare list error', message: 'Could not read your codeshares.' }); }
    });

    // ---- Whether other airlines may send this one requests ----
    app.post('/api/crew/:slug/codeshare/settings', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const open = (req.body || {}).open !== false;
            await VirtualAirlineAd.updateOne({ _id: va._id }, { $set: { crewCodeshareOpen: open } });
            res.json({ open });
        } catch (err) { crewFail(res, err, { log: 'codeshare settings error', message: 'Could not save that.' }); }
    });

    // ---- Finding a partner ----
    //
    // Every approved airline with a crew centre and a connected database,
    // except this one and any that switched requests off. Tagged with where
    // this airline already stands with each, so the picker can say "partners
    // already" rather than offering a request that would be refused.
    app.get('/api/crew/:slug/codeshare/directory', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const me = fold(req.params.slug);
            const q = str(req.query.q, 60);
            const [ads, docs] = await Promise.all([
                VirtualAirlineAd.find({
                    status: 'approved',
                    slug: { $nin: [null, '', me] },
                    supabaseUrl: { $nin: [null, ''] },
                    crewCodeshareOpen: { $ne: false },
                }).select('name slug callsign callsigns logoUrl country tagline').limit(1500).lean(),
                allFor(me),
            ]);
            const standing = new Map();
            for (const d of docs) {
                if (!['active', 'pending'].includes(d.status)) continue;
                const side = crewCodeshare.sideOf(d, me);
                const other = fold(d[`${crewCodeshare.otherSide(side)}Slug`]);
                standing.set(other, d.status === 'active' ? 'active' : side === 'from' ? 'requested' : 'incoming');
            }
            const airlines = ads
                .filter((a) => crewCodeshare.matchesQuery(a, q))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
                .slice(0, 40)
                .map((a) => ({ ...crewCodeshare.directoryEntry(a), standing: standing.get(fold(a.slug)) || '' }));
            res.set('Cache-Control', 'no-store');
            res.json({ airlines });
        } catch (err) { crewFail(res, err, { log: 'codeshare directory error', message: 'Could not search the airlines.' }); }
    });

    /** A partner's shareable legs, in the shape the picker draws. */
    async function shareableNetwork(slug) {
        const card = await airlineCard(slug);
        if (!card) return null;
        const { va, store } = await resolveCrewStore(card.slug);
        const routes = (await store.listRoutes({ activeOnly: true })).filter(crewCodeshare.shareable);
        return {
            airline: partyOf(card),
            routes: routes.map((r) => publicRoute(r, va.ranks, null)),
        };
    }

    // ---- What a partner would let you sell ----
    //
    // Only their own published legs — see crewCodeshare.shareable. The whole
    // public network is already on their crew centre for anybody to read, so
    // this reveals nothing new; it is gated only because it is a staff tool.
    app.get('/api/crew/:slug/codeshare/network/:partner', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const net = await shareableNetwork(req.params.partner);
            if (!net) return res.status(404).json({ error: 'That airline has no crew centre here.' });
            if (String(req.query.format || '') === 'csv') {
                res.set('Content-Type', 'text/csv; charset=utf-8');
                res.set('Content-Disposition', `attachment; filename="${String(net.airline.slug).replace(/[^a-z0-9-]/gi, '')}-network-${new Date().toISOString().slice(0, 10)}.csv"`);
                res.set('Cache-Control', 'no-store');
                // Their legs as they would arrive on your network: codeshares,
                // under their name. Imported as-is, it is the same thing a sync
                // would write — minus the link that keeps it up to date.
                return res.send(crewCsv.toCsv(crewCsv.ROUTES_SPEC, net.routes.map((r) => ({
                    ...r, id: '', kind: 'codeshare', partnerName: net.airline.name, partnerLogo: net.airline.logo, minRank: '',
                })), null, { includeId: false }));
            }
            res.set('Cache-Control', 'no-store');
            res.json(net);
        } catch (err) {
            if (err instanceof crewStore.CrewStoreError && err.status !== 404) {
                return res.status(503).json({ error: 'That airline’s network could not be read right now. Try again in a little while.', code: 'partner_unavailable' });
            }
            crewFail(res, err, { log: 'codeshare network error', message: 'Could not read that airline’s network.' });
        }
    });

    // ---- Asking ----
    app.post('/api/crew/:slug/codeshare', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const body = req.body || {};
            const [me, them] = await Promise.all([airlineCard(req.params.slug), airlineCard(str(body.partner, 80))]);
            if (!me) return res.status(404).json({ error: 'Crew centre not found.' });
            if (!them) return res.status(404).json({ error: 'That airline has no crew centre here.' });
            const take = crewCodeshare.cleanSelection(body.take);
            const offer = crewCodeshare.cleanSelection(body.offer);
            const existing = [...await allFor(me.slug), ...await allFor(them.slug)];
            const problem = crewCodeshare.requestProblem({
                fromSlug: me.slug, toSlug: them.slug, take, offer, existing,
                partnerOpen: them.crewCodeshareOpen !== false,
            });
            if (problem) return res.status(409).json({ error: problem, code: 'codeshare_refused' });

            const a = partyOf(me);
            const b = partyOf(them);
            const doc = await CrewCodeshare.create({
                fromVa: me._id, fromSlug: a.slug, fromName: a.name, fromLogo: a.logo, fromCallsign: a.callsign,
                toVa: them._id, toSlug: b.slug, toName: b.name, toLogo: b.logo, toCallsign: b.callsign,
                status: 'pending',
                // What I asked to sell of theirs — capped, until they answer,
                // at exactly that. They set the real ceiling when they accept.
                fromTakes: take, fromLimit: take,
                // What I offered them of mine: the ceiling, and by default what
                // they take. They can narrow it when they accept.
                toTakes: offer, toLimit: offer,
                message: str(body.message, crewCodeshare.MESSAGE_MAX),
                requestedBy: who(gate),
            });
            tell(them._id, {
                title: `🤝 Codeshare request from ${a.name}`,
                description: [
                    doc.message ? `“${doc.message}”` : '',
                    `Answer it in your crew centre: Routes → Codeshare. ${crewLink(b.slug)}`,
                ].filter(Boolean).join('\n\n'),
                color: 0xF59E0B,
                fields: [
                    { name: 'They would sell', value: take.mode === 'all' ? 'All of your routes' : take.mode === 'none' ? 'None of your routes' : `${take.routeIds.length} of your routes`, inline: true },
                    { name: 'They offer you', value: offer.mode === 'all' ? 'Their whole network' : offer.mode === 'none' ? 'Nothing in return' : `${offer.routeIds.length} of their routes`, inline: true },
                ],
            });
            res.status(201).json({ agreement: crewCodeshare.view(doc.toObject(), me.slug) });
        } catch (err) { crewFail(res, err, { log: 'codeshare request error', message: 'Could not send the request.' }); }
    });

    /** An agreement this airline is party to, live, or a reply already sent. */
    async function mine(req, res) {
        const me = await airlineCard(req.params.slug);
        if (!me) { res.status(404).json({ error: 'Crew centre not found.' }); return null; }
        let doc = null;
        try { doc = await CrewCodeshare.findById(String(req.params.id)); } catch { doc = null; }
        const side = doc ? crewCodeshare.sideOf(doc, me.slug) : null;
        if (!doc || !side) { res.status(404).json({ error: 'No such codeshare.' }); return null; }
        return { me, doc, side };
    }

    // ---- Accepting (the airline that was asked) ----
    //
    // `take`  — which of the asking airline's routes WE will sell, inside what
    //           they offered.
    // `offer` — which of OUR routes they may sell. Anything we leave out of
    //           their request is simply not sold.
    app.post('/api/crew/:slug/codeshare/:id/accept', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'pending' || side !== 'to') {
                return res.status(409).json({ error: 'Only a request sent to you, and still waiting, can be accepted.', code: 'codeshare_state' });
            }
            const body = req.body || {};
            // What we allow them: by default, everything they asked for.
            doc.fromLimit = body.offer !== undefined ? crewCodeshare.cleanSelection(body.offer) : { mode: 'all', routeIds: [] };
            // What we want of theirs: by default, everything they offered.
            if (body.take !== undefined) doc.toTakes = crewCodeshare.cleanSelection(body.take);
            const plain = doc.toObject();
            if (crewCodeshare.selectionEmpty(crewCodeshare.selling(plain, 'from')) && crewCodeshare.selectionEmpty(crewCodeshare.selling(plain, 'to'))) {
                return res.status(400).json({ error: 'That would share nothing either way. Tick at least one route, or decline instead.' });
            }
            doc.status = 'active';
            doc.reply = str(body.reply, crewCodeshare.MESSAGE_MAX);
            doc.decidedBy = who(gate);
            doc.decidedAt = new Date();
            await doc.save();
            const sync = await syncBoth(doc.toObject());
            tell(doc.fromVa, {
                title: `✅ ${me.name} accepted your codeshare`,
                description: [doc.reply ? `“${doc.reply}”` : '', 'Their flights are on your network now, marked as codeshares.'].filter(Boolean).join('\n\n'),
                color: 0x16A34A,
                fields: [
                    { name: 'You now sell', value: String(sync.from.routes), inline: true },
                    { name: 'They now sell', value: String(sync.to.routes), inline: true },
                ],
            });
            const fresh = await CrewCodeshare.findById(doc._id).lean();
            res.json({ agreement: crewCodeshare.view(fresh, me.slug), sync: sync[side] });
        } catch (err) { crewFail(res, err, { log: 'codeshare accept error', message: 'Could not accept the codeshare.' }); }
    });

    app.post('/api/crew/:slug/codeshare/:id/decline', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'pending' || side !== 'to') {
                return res.status(409).json({ error: 'Only a request sent to you, and still waiting, can be declined.', code: 'codeshare_state' });
            }
            doc.status = 'declined';
            doc.reply = str((req.body || {}).reply, crewCodeshare.MESSAGE_MAX);
            doc.decidedBy = who(gate);
            doc.decidedAt = new Date();
            await doc.save();
            tell(doc.fromVa, {
                title: `${me.name} declined your codeshare request`,
                description: doc.reply ? `“${doc.reply}”` : undefined,
                color: 0x6E685D,
            });
            res.json({ agreement: crewCodeshare.view(doc.toObject(), me.slug) });
        } catch (err) { crewFail(res, err, { log: 'codeshare decline error', message: 'Could not decline the request.' }); }
    });

    app.post('/api/crew/:slug/codeshare/:id/withdraw', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'pending' || side !== 'from') {
                return res.status(409).json({ error: 'Only a request you sent, still waiting, can be withdrawn.', code: 'codeshare_state' });
            }
            doc.status = 'withdrawn';
            doc.endedBy = who(gate);
            doc.endedAt = new Date();
            await doc.save();
            res.json({ agreement: crewCodeshare.view(doc.toObject(), me.slug) });
        } catch (err) { crewFail(res, err, { log: 'codeshare withdraw error', message: 'Could not withdraw the request.' }); }
    });

    // ---- Changing an active agreement — either side, its own half ----
    //
    // `take`  narrows or widens what I sell of theirs, inside what they allow.
    // `offer` changes what I allow them to sell of mine; their selection is
    //         held inside it at once, and their copies follow.
    app.patch('/api/crew/:slug/codeshare/:id', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'active') return res.status(409).json({ error: 'Only an active codeshare can be changed.', code: 'codeshare_state' });
            const them = crewCodeshare.otherSide(side);
            const body = req.body || {};
            // My wish, kept as I made it; theirs is untouched, and simply held
            // inside whatever I now allow — so one who wanted "all of it" gets
            // all of what I open up, and one who picked keeps their picks.
            if (body.take !== undefined) doc[`${side}Takes`] = crewCodeshare.cleanSelection(body.take);
            if (body.offer !== undefined) doc[`${them}Limit`] = crewCodeshare.cleanSelection(body.offer);
            await doc.save();
            const sync = await syncBoth(doc.toObject());
            const fresh = await CrewCodeshare.findById(doc._id).lean();
            res.json({ agreement: crewCodeshare.view(fresh, me.slug), sync: sync[side] });
        } catch (err) { crewFail(res, err, { log: 'codeshare change error', message: 'Could not change the codeshare.' }); }
    });

    app.post('/api/crew/:slug/codeshare/:id/sync', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'active') return res.status(409).json({ error: 'Only an active codeshare can be synced.', code: 'codeshare_state' });
            const sync = await syncBoth(doc.toObject());
            const fresh = await CrewCodeshare.findById(doc._id).lean();
            res.json({ agreement: crewCodeshare.view(fresh, me.slug), sync: sync[side] });
        } catch (err) { crewFail(res, err, { log: 'codeshare sync error', message: 'Could not sync the codeshare.' }); }
    });

    // ---- Ending ----
    //
    // Either side may end it. The copies go from BOTH networks, because a
    // codeshare nobody agreed to any more is a flight sold on somebody else's
    // metal without their say. `keepRoutes` keeps THIS side's copies as
    // ordinary codeshares — unlinked, and no longer followed — for the airline
    // that wants to wind down on its own timetable. The other side's copies go
    // regardless: that is their network, and ending means ending.
    app.post('/api/crew/:slug/codeshare/:id/end', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const got = await mine(req, res);
            if (!got) return;
            const { me, doc, side } = got;
            if (doc.status !== 'active') return res.status(409).json({ error: 'Only an active codeshare can be ended.', code: 'codeshare_state' });
            const keep = (req.body || {}).keepRoutes === true;
            doc.status = 'ended';
            doc.endedBy = who(gate);
            doc.endedAt = new Date();
            await doc.save();
            const them = crewCodeshare.otherSide(side);
            let kept = 0;
            if (keep) {
                try {
                    const { store } = await resolveCrewStore(me.slug);
                    const rows = crewCodeshare.linkedRows(await store.listRoutes({ limit: 5000 }), { slug: doc[`${them}Slug`] });
                    await eachLimited(rows, 4, async (r) => {
                        await store.updateRoute(r._id, { partnerSlug: '', sourceRouteId: '' }).then(() => { kept++; }).catch(() => {});
                    });
                } catch { /* reported by the sync below as whatever is left */ }
            }
            const plain = doc.toObject();
            const [mineSync, theirSync] = await Promise.all([syncSide(plain, side), syncSide(plain, them)]);
            tell(doc[`${them}Va`], {
                title: `${me.name} ended your codeshare`,
                description: 'Their flights have been taken off your network, and yours off theirs.',
                color: 0xDC2626,
                fields: [{ name: 'Removed from your network', value: String(theirSync.removed), inline: true }],
            });
            const fresh = await CrewCodeshare.findById(doc._id).lean();
            res.json({ agreement: crewCodeshare.view(fresh, me.slug), removed: mineSync.removed, kept });
        } catch (err) { crewFail(res, err, { log: 'codeshare end error', message: 'Could not end the codeshare.' }); }
    });

    /* =======================================================================
     * HUBS
     *
     * The public feed has always WORKED OUT a VA's hubs from the route map —
     * whichever airports have the most sectors. That is a guess, and for an
     * airline that is based somewhere it flies little from, a wrong one. Now
     * the airline can say. Declared hubs win wherever they are set; an airline
     * that never sets any keeps the worked-out answer.
     * ===================================================================== */

    const hubsOf = (doc) => sanitizeHubs((doc && doc.crewHubs) || []) || [];

    app.get('/api/crew/:slug/hubs', async (req, res) => {
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const doc = await VirtualAirlineAd.findById(va._id).select('crewHubs').lean();
            res.set('Cache-Control', 'public, max-age=60');
            res.json({ hubs: hubsOf(doc) });
        } catch (err) { crewFail(res, err, { log: 'hubs read error', message: 'Could not read the hubs.' }); }
    });

    app.put('/api/crew/:slug/hubs', async (req, res) => {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const va = await resolveCrewVa(req.params.slug);
            if (!va) return res.status(404).json({ error: 'Crew centre not found.' });
            const hubs = sanitizeHubs((req.body || {}).hubs);
            if (!hubs) return res.status(400).json({ error: 'Send the hubs as a list.' });
            await VirtualAirlineAd.updateOne({ _id: va._id }, { $set: { crewHubs: hubs } });
            res.json({ hubs });
        } catch (err) { crewFail(res, err, { log: 'hubs save error', message: 'Could not save the hubs.' }); }
    });

    /* =======================================================================
     * TOURS & CHALLENGES
     *
     * Definitions on the VA record; progress computed from approved flights on
     * every read. See crewGoals.js.
     * ===================================================================== */

    async function goalsDoc(slug, live = false) {
        const va = await resolveCrewVa(slug);
        if (!va) return null;
        const q = VirtualAirlineAd.findById(va._id);
        return live ? q : q.select('name slug crewTours crewChallenges ranks').lean();
    }

    /** Approved flights, each told whether its route is a codeshare. */
    async function flightLog(store) {
        const [pireps, routes] = await Promise.all([
            store.listPireps({ status: 'approved', limit: 5000 }).catch(() => []),
            store.listRoutes({ limit: 5000 }).catch(() => []),
        ]);
        const kind = new Map(routes.map((r) => [String(r._id), r.kind === 'codeshare' ? 'codeshare' : 'own']));
        return pireps.map((p) => (p.routeId ? { ...p, routeKind: kind.get(String(p.routeId)) || '' } : p));
    }

    function tourView(t, { mine: myLog, all, ranks, viewer, full }) {
        const board = crewGoals.tourBoard(t, all, { limit: full ? 50 : 5 });
        const me = myLog ? crewGoals.tourProgress(t, myLog) : null;
        const locked = !!t.minRank && !!viewer && !crewRanks.meetsRank(ranks, viewer.hours, t.minRank);
        return {
            ...t, kind: 'tour', phase: crewGoals.phase(t), locked,
            me, board,
        };
    }
    function challengeView(c, { mine: myLog, all, full }) {
        const board = c.scope === 'crew' ? null : crewGoals.challengeBoard(c, all, { limit: full ? 50 : 5 });
        return {
            ...c, kind: 'challenge', phase: crewGoals.phase(c),
            me: myLog && c.scope === 'pilot' ? crewGoals.challengeProgress(c, myLog) : null,
            // A crew challenge is one bar everybody fills together.
            crew: c.scope === 'crew' ? crewGoals.challengeProgress(c, all) : null,
            board,
        };
    }

    async function goalsFor(req, { onlyId = '' } = {}) {
        const doc = await goalsDoc(req.params.slug);
        if (!doc) return null;
        const { store } = await resolveCrewStore(req.params.slug);
        const canManage = !(await requireCap(req, req.params.slug, 'events.manage')).error;
        const viewer = await crewViewer(req, store);
        const all = await flightLog(store);
        const myId = viewer && viewer.memberId ? String(viewer.memberId) : '';
        const myLog = myId ? all.filter((p) => String(p.memberId || '') === myId) : null;
        const visible = (g) => (canManage || g.active) && (!onlyId || g.id === onlyId);
        const ctx = { mine: myLog, all, ranks: doc.ranks, viewer, full: !!onlyId };
        return {
            canManage,
            signedIn: !!myId,
            tours: crewGoals.sanitizeTours(doc.crewTours).filter(visible).map((t) => tourView(t, ctx)),
            challenges: crewGoals.sanitizeChallenges(doc.crewChallenges).filter(visible).map((c) => challengeView(c, ctx)),
        };
    }

    // Public in the way events are: anybody who can open the crew centre can
    // see what there is to fly. `me` is filled only for a signed-in pilot.
    app.get('/api/crew/:slug/goals', async (req, res) => {
        try {
            const out = await goalsFor(req);
            if (!out) return res.status(404).json({ error: 'Crew centre not found.' });
            res.set('Cache-Control', 'no-store');
            res.json(out);
        } catch (err) { crewFail(res, err, { log: 'goals read error', message: 'Could not read the tours and challenges.' }); }
    });

    app.get('/api/crew/:slug/goals/:id', async (req, res) => {
        try {
            const out = await goalsFor(req, { onlyId: str(req.params.id, 40) });
            if (!out) return res.status(404).json({ error: 'Crew centre not found.' });
            const one = out.tours[0] || out.challenges[0];
            if (!one) return res.status(404).json({ error: 'No such tour or challenge.' });
            res.set('Cache-Control', 'no-store');
            res.json({ goal: one, canManage: out.canManage, signedIn: out.signedIn });
        } catch (err) { crewFail(res, err, { log: 'goal read error', message: 'Could not read that.' }); }
    });

    /** Create, edit and remove — one set of handlers for both kinds. */
    function goalRoutes(kind) {
        const field = kind === 'tour' ? 'crewTours' : 'crewChallenges';
        const clean = kind === 'tour' ? crewGoals.sanitizeTour : crewGoals.sanitizeChallenge;
        const cleanAll = kind === 'tour' ? crewGoals.sanitizeTours : crewGoals.sanitizeChallenges;
        const max = kind === 'tour' ? crewGoals.MAX_TOURS : crewGoals.MAX_CHALLENGES;
        const noun = kind === 'tour' ? 'tour' : 'challenge';
        const base = `/api/crew/:slug/${kind === 'tour' ? 'tours' : 'challenges'}`;
        const refuse = kind === 'tour'
            ? 'A tour needs a title and at least one leg with both airports.'
            : 'A challenge needs a title and a target above zero.';

        const announce = (va, g) => {
            crewWebhookUrlFor(va._id, 'events')
                .then((hook) => hook && postCrewNotice(hook, {
                    title: `${kind === 'tour' ? '🧭 New tour' : '🏆 New challenge'} — ${g.title}`,
                    description: [g.blurb, `${crewLink(va.slug)}`].filter(Boolean).join('\n\n').slice(0, 1800),
                    color: 0x4F46E5,
                    image: g.image || undefined,
                    fields: [
                        kind === 'tour'
                            ? { name: 'Legs', value: g.legs.map((l) => `${l.origin}→${l.destination}`).join(' · ').slice(0, 1000), inline: false }
                            : { name: 'Target', value: `${g.target.toLocaleString()} ${g.metric === 'distance' ? 'nm' : g.metric}${g.scope === 'crew' ? ' — together' : ''}`, inline: true },
                        g.endsAt ? { name: 'Ends', value: `<t:${Math.floor(new Date(g.endsAt).getTime() / 1000)}:R>`, inline: true } : null,
                        g.award && g.award.name ? { name: 'Award', value: g.award.name, inline: true } : null,
                    ].filter(Boolean),
                }))
                .catch(() => {});
        };

        app.post(base, async (req, res) => {
            const gate = await requireCap(req, req.params.slug, 'events.manage');
            if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : `You don’t have permission to manage ${noun}s.` });
            try {
                const ad = await goalsDoc(req.params.slug, true);
                if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
                const list = cleanAll(ad[field]);
                if (list.length >= max) return res.status(409).json({ error: `That is the most ${noun}s a crew centre can hold. Remove an old one first.` });
                const g = clean({ ...(req.body || {}), id: '' });
                if (!g) return res.status(400).json({ error: refuse });
                ad[field] = [g, ...list];
                ad.markModified(field);
                await ad.save();
                if (g.active && (req.body || {}).announce !== false) announce(ad, g);
                res.status(201).json({ [noun]: g });
            } catch (err) { crewFail(res, err, { log: `${noun} create error`, message: `Could not save the ${noun}.` }); }
        });

        app.patch(`${base}/:id`, async (req, res) => {
            const gate = await requireCap(req, req.params.slug, 'events.manage');
            if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : `You don’t have permission to manage ${noun}s.` });
            try {
                const ad = await goalsDoc(req.params.slug, true);
                if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
                const list = cleanAll(ad[field]);
                const i = list.findIndex((g) => g.id === String(req.params.id));
                if (i < 0) return res.status(404).json({ error: `No such ${noun}.` });
                const g = clean({ ...list[i], ...(req.body || {}) }, list[i]);
                if (!g) return res.status(400).json({ error: refuse });
                const wasDraft = !list[i].active;
                list[i] = g;
                ad[field] = list;
                ad.markModified(field);
                await ad.save();
                // Published now, having been a draft: that is the moment worth
                // telling the crew about, not every later edit.
                if (wasDraft && g.active && (req.body || {}).announce !== false) announce(ad, g);
                res.json({ [noun]: g });
            } catch (err) { crewFail(res, err, { log: `${noun} edit error`, message: `Could not save the ${noun}.` }); }
        });

        app.delete(`${base}/:id`, async (req, res) => {
            const gate = await requireCap(req, req.params.slug, 'events.manage');
            if (gate.error) return res.status(gate.error).json({ error: gate.error === 401 ? 'Not authenticated.' : `You don’t have permission to manage ${noun}s.` });
            try {
                const ad = await goalsDoc(req.params.slug, true);
                if (!ad) return res.status(404).json({ error: 'Crew centre not found.' });
                const list = cleanAll(ad[field]);
                const next = list.filter((g) => g.id !== String(req.params.id));
                if (next.length === list.length) return res.status(404).json({ error: `No such ${noun}.` });
                ad[field] = next;
                ad.markModified(field);
                await ad.save();
                res.json({ ok: true });
            } catch (err) { crewFail(res, err, { log: `${noun} delete error`, message: `Could not remove the ${noun}.` }); }
        });
    }
    goalRoutes('tour');
    goalRoutes('challenge');

    /** Completed tours and personal challenges, for the awards shelf. */
    async function goalAwardsFor(vaId, pireps) {
        try {
            const doc = await VirtualAirlineAd.findById(vaId).select('crewTours crewChallenges').lean();
            return crewGoals.goalAwards({
                tours: crewGoals.sanitizeTours(doc && doc.crewTours),
                challenges: crewGoals.sanitizeChallenges(doc && doc.crewChallenges),
                pireps,
            });
        } catch { return { catalog: [], earned: [], progress: {} }; }
    }

    /* =======================================================================
     * EXPORTS — any slice of the network
     *
     *   scope     all | own | codeshare
     *   partner   one codeshare partner, by name
     *   ids       exactly these routes — the rows somebody ticked
     *   combined  one sheet, every airline in it: an `operator` column first,
     *             holding this airline's own name on its own legs and the
     *             partner's on theirs. It imports straight back — the import
     *             reads `operator` and sorts own from codeshare by it — and it
     *             is the shape an alliance keeps its shared schedule in.
     *   layout    the VA's own column shape, as the plain export takes it
     * ===================================================================== */

    function exportRows(routes, va, { scope = 'all', partner = '', ids = null, combined = false }) {
        const want = ids && ids.length ? new Set(ids.map(String)) : null;
        const p = fold(partner);
        return (routes || [])
            .filter((r) => !want || want.has(String(r._id)))
            .filter((r) => scope === 'all' || (scope === 'codeshare' ? r.kind === 'codeshare' : r.kind !== 'codeshare'))
            .filter((r) => !p || (r.kind === 'codeshare' && fold(r.partnerName) === p))
            .map((r) => ({
                id: r._id, flightNumber: r.flightNumber, origin: r.origin, destination: r.destination,
                aircraft: r.aircraft, distanceNm: r.distanceNm, notes: r.notes, active: r.active,
                kind: r.kind || 'own',
                partnerName: combined && r.kind !== 'codeshare' ? (va.name || '') : (r.partnerName || ''),
                partnerLogo: r.partnerLogo || '', minRank: r.minRank || '',
                departureGate: r.departureGate || '', arrivalGate: r.arrivalGate || '',
            }));
    }

    // In the combined sheet the partner column leads and is called `operator`.
    const COMBINED_LAYOUT = [
        { header: 'operator', key: 'partnerName' },
        ...crewCsv.ROUTES_SPEC.columns.filter((c) => c.key !== 'partnerName' && c.key !== 'id').map((c) => ({ header: c.header, key: c.key })),
    ];

    function exportOptions(src) {
        const scope = ['own', 'codeshare'].includes(src.scope) ? src.scope : 'all';
        let ids = src.ids;
        if (typeof ids === 'string') ids = ids.split(',');
        ids = Array.isArray(ids) ? ids.map((i) => str(i, 64)).filter(Boolean).slice(0, 5000) : null;
        let layout = src.layout;
        if (typeof layout === 'string') { try { layout = JSON.parse(layout); } catch { layout = null; } }
        const combined = src.combined === true || src.combined === '1' || src.combined === 'true';
        return {
            scope, ids, combined,
            partner: str(src.partner, 60),
            layout: combined && !layout ? COMBINED_LAYOUT : (Array.isArray(layout) ? layout : null),
            includeId: !(src.id === false || src.id === '0' || src.includeId === false),
        };
    }

    async function sendExport(req, res, src) {
        const gate = await requireCap(req, req.params.slug, 'routes.manage');
        if (gate.error) return denied(res, gate);
        try {
            const { va, store } = await resolveCrewStore(req.params.slug);
            const opts = exportOptions(src || {});
            const card = await airlineCard(req.params.slug);
            const rows = exportRows(await store.listRoutes({ limit: 5000 }), card || va, opts);
            // An empty network still exports — a header row is the template a
            // VA fills in. An empty SLICE is a question that matched nothing,
            // and a blank file would read as "your codeshares are gone".
            const sliced = !!(opts.ids || opts.partner || opts.scope !== 'all');
            if (!rows.length && sliced) return res.status(404).json({ error: 'Nothing matches — no routes to export.', code: 'export_empty' });
            const what = opts.ids ? 'routes-selected' : opts.partner ? `codeshare-${fold(opts.partner).replace(/[^a-z0-9]+/g, '-')}`
                : opts.combined ? 'routes-combined' : opts.scope === 'all' ? 'routes' : `routes-${opts.scope}`;
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${String(req.params.slug).replace(/[^a-z0-9-]/gi, '')}-${what}-${new Date().toISOString().slice(0, 10)}.csv"`);
            res.set('Cache-Control', 'no-store');
            // A combined sheet goes out without ids: it is meant to travel to
            // other airlines, and an id means nothing in anybody else's project.
            res.send(crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, opts.layout, { includeId: opts.includeId && !opts.combined }));
        } catch (err) { crewFail(res, err, { log: 'routes export error', message: 'Could not export the routes.' }); }
    }

    // POST for a selection that would not fit in a URL; the body is the same
    // set of options the plain export takes in its query string.
    app.post('/api/crew/:slug/routes/export', (req, res) => sendExport(req, res, req.body));

    /**
     * The import's `prepare`: a sheet with an operator column sorts itself.
     * Rows naming this airline are its own network; rows naming anybody else
     * are codeshares on that airline, with the logo filled from a declared
     * partner or an agreement when the sheet did not carry one.
     */
    async function importPrepare(va) {
        const card = await airlineCard(va.slug).catch(() => null) || va;
        const doc = await VirtualAirlineAd.findById(va._id).select('crewPartners').lean().catch(() => null);
        const logos = new Map();
        for (const p of (doc && doc.crewPartners) || []) if (p && p.name && p.logo) logos.set(fold(p.name), p.logo);
        for (const d of await allFor(va.slug).catch(() => [])) {
            const side = crewCodeshare.sideOf(d, va.slug);
            if (!side) continue;
            const them = crewCodeshare.otherSide(side);
            if (d[`${them}Name`] && d[`${them}Logo`] && !logos.has(fold(d[`${them}Name`]))) logos.set(fold(d[`${them}Name`]), d[`${them}Logo`]);
        }
        return crewCodeshare.operatorPrepare(card, logos);
    }

    return {
        routesChanged,
        goalAwardsFor,
        hubsOf,
        sanitizeHubs,
        exportOptions,
        exportRows,
        sendExport,
        importPrepare,
        CrewCodeshare,
        syncSide,
    };
};

module.exports.sanitizeHubs = sanitizeHubs;
