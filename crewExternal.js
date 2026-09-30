'use strict';

/*
 * crewExternal.js
 * Codeshares with airlines that are NOT on this platform.
 *
 * WHY THIS EXISTS
 * ---------------
 * crewCodeshare.js joins two crew centres that both live here. Plenty of the
 * airlines a VA flies with do not: they run vAMSYS, phpVMS, VAM, their own
 * site, or a Google Sheet. Their routes still have to reach our pilots, and
 * ours still have to reach theirs, and "type it all in once and hope nothing
 * changes" is exactly the failure the agreement feature was built to end.
 *
 * So an OUTSIDE PARTNER is the same idea with a file in the middle:
 *
 *   THEIRS → US   A link to their route list — a CSV or JSON feed their crew
 *                 centre publishes, or a Google Sheet. Read on a schedule and
 *                 on demand, and run through the same sync the in-platform
 *                 agreements use (crewCodeshare.planSync): renumbered legs are
 *                 edits, dropped legs go, our rank gates and notes stay ours.
 *                 A partner with no link can hand over a spreadsheet instead;
 *                 uploading it runs the same sync once.
 *   US → THEM     A private feed of the routes we share with them, as CSV or
 *                 JSON, at an unguessable address they paste into THEIR crew
 *                 centre. Rotating the token cuts the old address off.
 *
 * FETCHING SOMEBODY ELSE'S URL FROM OUR SERVER IS THE RISKY PART
 * --------------------------------------------------------------
 * A staff member types the address, our backend fetches it. Left alone that
 * is a way to make our server read its own cloud metadata or anything else on
 * the private network. So `safeGet`:
 *
 *   · https only, on the first hop and on every redirect (at most 3);
 *   · resolves every hostname itself and REFUSES private, loopback,
 *     link-local, carrier-grade NAT and metadata addresses — at connect time,
 *     through the agent's own lookup, so a DNS answer that changes between a
 *     check and the connection (rebinding) is caught too;
 *   · 10 second timeout, 2 MB cap, text only.
 *
 * Pure except for safeGet, which is the one function here that touches the
 * network, and which takes its transport as a parameter so tests never do.
 */

const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const https = require('https');
const Papa = require('papaparse');
const crewCsv = require('./crewCsv');

const MAX_PARTNERS = 30;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const PLATFORMS = ['vamsys', 'phpvms', 'vam', 'fsairlines', 'sheet', 'website', 'other'];
const FORMATS = ['auto', 'csv', 'json'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const httpsUrl = (u) => {
    const s = str(u, 800);
    if (!/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return '';
    try { return new URL(s).protocol === 'https:' ? s : ''; } catch { return ''; }
};
const newId = () => `ext${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const newToken = () => crypto.randomBytes(24).toString('hex');

/** The partner slug their copies carry — cannot collide with a real crew slug. */
const partnerSlug = (p) => `ext:${String(p && p.id || '').toLowerCase()}`;

const cleanSel = (s, fallback) => {
    const src = s && typeof s === 'object' ? s : {};
    const mode = ['all', 'selected', 'none'].includes(src.mode) ? src.mode : fallback;
    const ids = mode === 'selected' && Array.isArray(src.routeIds)
        ? [...new Set(src.routeIds.map((i) => str(i, 120)).filter(Boolean))].slice(0, 3000) : [];
    return mode === 'selected' && !ids.length ? { mode: 'none', routeIds: [] } : { mode, routeIds: ids };
};

/**
 * One outside partner as stored. `prev` is the stored record on an edit — the
 * id, the token and the sync history are never taken from a request.
 */
function sanitizePartner(p, prev = null) {
    const src = p && typeof p === 'object' ? p : {};
    const name = str(src.name, 60);
    if (!name) return null;
    return {
        id: (prev && prev.id) || newId(),
        name,
        logo: httpsUrl(src.logo),
        website: httpsUrl(src.website),
        // Which crew centre software they run, so the screen can say where in
        // THEIR system to paste our feed. Free of consequence otherwise.
        platform: PLATFORMS.includes(src.platform) ? src.platform : 'other',
        feedUrl: httpsUrl(src.feedUrl),
        format: FORMATS.includes(src.format) ? src.format : 'auto',
        // Their routes our pilots fly, and our routes we let them fly.
        take: cleanSel(src.take, 'all'),
        share: cleanSel(src.share, 'none'),
        autoSync: src.autoSync !== false,
        active: src.active !== false,
        notes: str(src.notes, 500),
        shareToken: (prev && prev.shareToken) || newToken(),
        lastSync: (prev && prev.lastSync) || null,
        createdAt: (prev && prev.createdAt) || new Date().toISOString(),
    };
}

const sanitizePartners = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_PARTNERS)
    .map((p) => sanitizePartner(p, p)).filter(Boolean);

/** What a staff screen sees: everything but the raw token, plus the feed links. */
function view(p, { origin = '', slug = '' } = {}) {
    const base = `${String(origin).replace(/\/+$/, '')}/api/crew-feed/codeshare/${p.shareToken}`;
    return {
        id: p.id, name: p.name, logo: p.logo, website: p.website, platform: p.platform,
        feedUrl: p.feedUrl, format: p.format, take: p.take, share: p.share,
        autoSync: p.autoSync, active: p.active, notes: p.notes,
        lastSync: p.lastSync, createdAt: p.createdAt,
        partnerSlug: partnerSlug(p),
        // The addresses they paste into their own crew centre.
        ourFeed: { csv: `${base}.csv`, json: `${base}.json` },
        slug,
    };
}

/* ---------------------------------------------------------------------------
 * Reading their feed
 * ------------------------------------------------------------------------- */

/**
 * A Google Sheets address as people copy it (…/edit#gid=123) becomes the CSV
 * export of that tab, which is the only form of a sheet a server can read.
 */
function normalizeFeedUrl(u) {
    const url = httpsUrl(u);
    if (!url) return '';
    const m = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m && !/\/export\?|output=csv|format=csv/.test(url)) {
        const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
        return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
    }
    return url;
}

// The only columns that describe a leg; their kind, partner and id columns are
// theirs and mean nothing here.
const FEED_KEYS = ['flightNumber', 'origin', 'destination', 'aircraft', 'distanceNm', 'departureGate', 'arrivalGate', 'active'];
const FEED_SPEC = {
    ...crewCsv.ROUTES_SPEC,
    columns: [
        // Their own id for a leg, when their system publishes one. With it a
        // renumbered flight is an edit; without it the leg is known by its
        // number and airports, and a renumber is a new leg replacing the old.
        { key: 'sourceId', header: 'id', aliases: ['routeid', 'route_id', 'scheduleid', 'flightid', 'legid', 'uid', 'uuid'], type: 'text', max: 120 },
        ...crewCsv.ROUTES_SPEC.columns.filter((c) => FEED_KEYS.includes(c.key)),
    ],
};

/** A JSON feed, whatever shape it came in, as rows of flat objects. */
function jsonRows(data) {
    let list = data;
    if (list && !Array.isArray(list) && typeof list === 'object') {
        list = list.routes || list.data || list.items || list.flights || list.schedules || list.results || [];
    }
    if (!Array.isArray(list)) return [];
    return list.slice(0, crewCsv.MAX_ROWS).filter((r) => r && typeof r === 'object').map((r) => {
        const out = {};
        for (const [k, v] of Object.entries(r)) {
            // One level of nesting, the common "departure: { icao: 'EGLL' }".
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [k2, v2] of Object.entries(v)) if (v2 == null || typeof v2 !== 'object') out[`${k}${k2[0].toUpperCase()}${k2.slice(1)}`] = v2;
            } else if (v == null || typeof v !== 'object') out[k] = v;
        }
        return out;
    });
}

// Nested JSON fields the flattener produces, and what they mean.
const JSON_ALIASES = {
    departureIcao: 'origin', departureAirport: 'origin', depIcao: 'origin', originIcao: 'origin', fromIcao: 'origin',
    arrivalIcao: 'destination', arrivalAirport: 'destination', arrIcao: 'destination', destinationIcao: 'destination', toIcao: 'destination',
    aircraftType: 'aircraft', aircraftName: 'aircraft', aircraftIcao: 'aircraft',
    callsign: 'flightNumber', flightNo: 'flightNumber', flightnumber: 'flightNumber',
};

/** The stable key a leg keeps between reads of a feed that has no ids. */
const legId = (r) => [r.flightNumber, r.origin, r.destination].map((v) => String(v || '').trim().toUpperCase()).join('|');

/**
 * Their feed, as legs. Returns { routes, total, errors, format }.
 * Each route is shaped like one of ours (kind own, active) with `_id` set to a
 * stable key, so crewCodeshare.planSync treats it exactly as it treats a
 * partner crew centre's own route.
 */
function parseFeed(text, { format = 'auto', contentType = '' } = {}) {
    const body = String(text || '').replace(/^﻿/, '');
    if (!body.trim()) return { error: 'Their feed is empty.' };
    let kind = format;
    if (kind === 'auto') kind = /json/i.test(contentType) || /^\s*[[{]/.test(body) ? 'json' : 'csv';
    let csv = body;
    if (kind === 'json') {
        let data;
        try { data = JSON.parse(body); } catch { return { error: 'Their feed says it is JSON but could not be read as JSON.' }; }
        const rows = jsonRows(data).map((r) => {
            const out = { ...r };
            for (const [from, to] of Object.entries(JSON_ALIASES)) if (out[from] != null && out[to] == null) out[to] = out[from];
            return out;
        });
        if (!rows.length) return { error: 'Their JSON feed has no list of routes in it.' };
        const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 60);
        csv = Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => (r[f] == null ? '' : r[f]))) });
    }
    const plan = crewCsv.planImport(FEED_SPEC, csv, []);
    if (plan.error) return { error: `Their feed could not be read: ${plan.error}` };
    const seen = new Set();
    const routes = [];
    for (const row of plan.create) {
        const v = row.values;
        if (!v.origin || !v.destination) continue;
        const r = {
            flightNumber: str(v.flightNumber, 12),
            origin: str(v.origin, 4).toUpperCase(),
            destination: str(v.destination, 4).toUpperCase(),
            aircraft: str(v.aircraft, 60),
            distanceNm: Math.max(0, Math.round(Number(v.distanceNm) || 0)),
            departureGate: str(v.departureGate, 12),
            arrivalGate: str(v.arrivalGate, 12),
            kind: 'own',
            active: v.active !== false,
        };
        r._id = v.sourceId ? `id:${str(v.sourceId, 110)}` : legId(r);
        if (seen.has(r._id)) continue;
        seen.add(r._id);
        routes.push(r);
    }
    return { routes, total: routes.length, errors: plan.errors.length, format: kind };
}

/* ---------------------------------------------------------------------------
 * Fetching it — safely
 * ------------------------------------------------------------------------- */

function privateAddress(ip) {
    const v = net.isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0);
    }
    if (v === 6) {
        const s = ip.toLowerCase();
        if (s === '::1' || s === '::') return true;
        if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
        const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? privateAddress(mapped[1]) : false;
    }
    return true;
}

/** A dns.lookup that refuses to hand a private address to the socket. */
function guardedLookup(hostname, options, cb) {
    dns.lookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = (addrs || []).filter((a) => !privateAddress(a.address));
        if (!ok.length) { const e = new Error('That address points at a private network.'); e.code = 'EPRIVATE'; return cb(e); }
        if (options && options.all) return cb(null, ok);
        return cb(null, ok[0].address, ok[0].family);
    });
}

/**
 * GET a partner's feed. `transport` is axios in production and a fake in
 * tests. Resolves { text, contentType } or throws an Error with a sentence a
 * staff member can act on.
 */
async function safeGet(url, { transport } = {}) {
    const target = normalizeFeedUrl(url);
    if (!target) throw new Error('Their feed address must start with https://');
    const host = new URL(target).hostname;
    if (net.isIP(host) && privateAddress(host)) throw new Error('That address points at a private network.');
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('That address points at a private network.');
    const agent = new https.Agent({ lookup: guardedLookup, keepAlive: false });
    try {
        const res = await transport.get(target, {
            httpsAgent: agent,
            timeout: FETCH_TIMEOUT_MS,
            maxContentLength: MAX_FEED_BYTES,
            maxBodyLength: MAX_FEED_BYTES,
            maxRedirects: 3,
            responseType: 'text',
            transformResponse: [(d) => d],
            headers: { Accept: 'text/csv, application/json, text/plain;q=0.9, */*;q=0.5', 'User-Agent': 'Inflight-CrewCenter/1 (codeshare feed)' },
            // Every hop stays https.
            beforeRedirect: (opts) => { if (opts.protocol !== 'https:') throw new Error('Their feed redirected away from https.'); },
            validateStatus: (s) => s >= 200 && s < 300,
        });
        return { text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), contentType: String((res.headers && res.headers['content-type']) || '') };
    } catch (err) {
        if (err && err.code === 'EPRIVATE') throw new Error('That address points at a private network.');
        if (err && err.response) throw new Error(`Their feed answered ${err.response.status}. Check the address is public.`);
        if (err && /maxContentLength|exceeded/i.test(String(err.message))) throw new Error('Their feed is larger than 2 MB.');
        if (err && err.code === 'ECONNABORTED') throw new Error('Their feed took longer than 10 seconds to answer.');
        throw new Error((err && err.message) || 'Their feed could not be reached.');
    }
}

/* ---------------------------------------------------------------------------
 * Our feed, for them
 * ------------------------------------------------------------------------- */

/** Our shareable legs, in the shape the outgoing feed publishes. */
function outgoing(routes, share, airline) {
    const shareable = (routes || []).filter((r) => r && r.active !== false && (r.kind || 'own') === 'own' && r.origin && r.destination);
    const s = cleanSel(share, 'none');
    const want = new Set(s.routeIds);
    const list = s.mode === 'all' ? shareable : s.mode === 'selected' ? shareable.filter((r) => want.has(String(r._id || r.id))) : [];
    return list.map((r) => ({
        flightNumber: r.flightNumber || '', origin: r.origin, destination: r.destination,
        aircraft: r.aircraft || '', distanceNm: r.distanceNm || 0,
        departureGate: r.departureGate || '', arrivalGate: r.arrivalGate || '',
        // How it should land in THEIR system: a codeshare on us.
        kind: 'codeshare', partnerName: (airline && airline.name) || '', partnerLogo: (airline && airline.logo) || '',
    }));
}

module.exports = {
    MAX_PARTNERS,
    PLATFORMS,
    FORMATS,
    FEED_SPEC,
    sanitizePartner,
    sanitizePartners,
    view,
    partnerSlug,
    normalizeFeedUrl,
    parseFeed,
    legId,
    privateAddress,
    guardedLookup,
    safeGet,
    outgoing,
    httpsUrl,
    cleanSel,
};
