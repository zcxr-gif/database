'use strict';

/*
 * liveFlightMap.js
 * One live flight, drawn on satellite imagery — the picture behind the crew
 * bot's `/crew flight`.
 *
 * NOT THE WEBHOOK CARD. The takeoff/landing webhook posts a branded card and a
 * flat vector map, which is right for "somebody just left": the moment is the
 * news. A flight looked up mid-air is about WHERE it is, so this is the view
 * the tracker itself opens on — Esri World Imagery (the same key-less source
 * the tracker's airport windows use), the path flown so far, the plan still to
 * fly, the aeroplane pointing the way it is heading, and a strip along the
 * bottom with the numbers. The aircraft's photo sits in the corner.
 *
 * ONE REQUEST FOR THE IMAGERY. Esri's `export` endpoint renders an arbitrary
 * Web-Mercator box at an arbitrary size, so there is no tile stitching: the box
 * is worked out here in metres with the output's exact aspect ratio, which
 * makes the pixel mapping exact (x and y are linear in Mercator metres).
 *
 * NEVER WITHOUT A PICTURE. Imagery that does not arrive (Esri down, a proxy in
 * the way) leaves a dark background with a graticule, and everything else is
 * drawn on it exactly the same — a flight is still worth showing.
 */

const axios = require('axios');
const sharp = require('sharp');
const {
    fetchImage, coverRounded, contain, coordsOf, queueRender, brandLogo,
} = require('./vaEventCardImage');

const W = 1200;
const H = 675;
const PANEL_H = 150;                  // the numbers strip along the bottom
const PAD = { l: 70, r: 70, t: 90, b: PANEL_H + 50 };
const PHOTO = { w: 300, h: 170, x: W - 300 - 24, y: 24 };
const R = 6378137;
const WORLD = Math.PI * R;            // half the Mercator world width, metres
const IMAGERY = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export';
// Metres per pixel, at least: on the ground ~13 km across (the airfield
// fills the frame), in the air ~180 km (enough land to recognise).
const MIN_MPP_GROUND = 11;
const MIN_MPP_AIR = 150;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { const t = String(s == null ? '' : s).trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fmt = (n) => (Math.round(n * 10) / 10).toString();
const finite = (...v) => v.every((x) => Number.isFinite(x));

const merc = (lat, lon) => {
    const la = Math.max(-85, Math.min(85, lat));
    return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360))];
};

/** Put every longitude within 180° of the aircraft, so a leg over the dateline is one line. */
const unwrap = (lon, ref) => { let l = lon; while (l - ref > 180) l -= 360; while (ref - l > 180) l += 360; return l; };

const pt = (p) => {
    if (!p) return null;
    const lat = Number(p.lat ?? p.latitude ?? (Array.isArray(p) ? p[0] : NaN));
    const lon = Number(p.lon ?? p.lng ?? p.longitude ?? (Array.isArray(p) ? p[1] : NaN));
    if (!finite(lat, lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
    return { lat, lon, name: p.name ? String(p.name) : '' };
};

const nm = (a, b) => {
    const t = Math.PI / 180;
    const dLat = (b.lat - a.lat) * t; const dLon = (b.lon - a.lon) * t;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const pathNm = (pts) => pts.reduce((sum, p, i) => (i ? sum + nm(pts[i - 1], p) : 0), 0);

/**
 * The frame: a Mercator box with the output's aspect ratio that holds every
 * point inside the padded area, centred on them. Pure, for the tests.
 */
function frameFor(points, { onGround = false, photo = false } = {}) {
    const ms = points.map((p) => merc(p.lat, p.lon));
    const xs = ms.map((m) => m[0]); const ys = ms.map((m) => m[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // With a photo in the top-right corner, the route keeps to the left of it.
    const padR = photo ? W - PHOTO.x + 30 : PAD.r;
    const availW = W - PAD.l - padR; const availH = H - PAD.t - PAD.b;
    const mpp = Math.max((x1 - x0) / availW, (y1 - y0) / availH, onGround ? MIN_MPP_GROUND : MIN_MPP_AIR);
    // The middle of the points goes to the middle of the padded area, not of
    // the image, so the numbers strip never covers the route.
    const cx = (x0 + x1) / 2 - (PAD.l + availW / 2 - W / 2) * mpp;
    const cy = (y0 + y1) / 2 + (PAD.t + availH / 2 - H / 2) * mpp;
    let left = cx - (W / 2) * mpp; let right = cx + (W / 2) * mpp;
    // Kept inside the world: Esri answers a box past the antimeridian with
    // blank imagery. Shifted rather than clipped, so the scale stays true.
    if (right - left >= 2 * WORLD) { left = -WORLD; right = WORLD; } else if (left < -WORLD) { right += -WORLD - left; left = -WORLD; } else if (right > WORLD) { left -= right - WORLD; right = WORLD; }
    const scale = (right - left) / W;
    const top = cy + (H / 2) * scale; const bottom = cy - (H / 2) * scale;
    return {
        bbox: [left, bottom, right, top],
        px: (lat, lon) => { const [x, y] = merc(lat, lon); return [(x - left) / scale, (top - y) / scale]; },
    };
}

const imageryUrl = (bbox) => `${IMAGERY}?bbox=${bbox.map((n) => n.toFixed(1)).join(',')}`
    + `&bboxSR=3857&imageSR=3857&size=${W},${H}&format=jpg&f=image`;

async function fetchImagery(bbox) {
    try {
        const res = await axios.get(imageryUrl(bbox), {
            responseType: 'arraybuffer', timeout: 8000, maxContentLength: 6 * 1024 * 1024,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        if (!/^image\//i.test(String(res.headers['content-type'] || ''))) return null;
        return Buffer.from(res.data);
    } catch { return null; }
}

const line = (pts, px) => pts.map((p, i) => { const [x, y] = px(p.lat, p.lon); return `${i ? 'L' : 'M'}${fmt(x)},${fmt(y)}`; }).join(' ');

// A plain airliner silhouette, nose up at (0,-1); rotated to the heading.
const PLANE = 'M0,-26 C2.6,-26 3.6,-22 3.6,-18 L3.6,-6 L24,6 L24,10.5 L3.6,4 L3.4,16 L10,21 L10,24.5 L0,22 L-10,24.5 L-10,21 L-3.4,16 L-3.6,4 L-24,10.5 L-24,6 L-3.6,-6 L-3.6,-18 C-3.6,-22 -2.6,-26 0,-26 Z';

function label(x, y, text, { size = 20, anchor = 'start', fill = '#ffffff', weight = 'bold' } = {}) {
    const t = (dx, dy, f, extra = '') => `<text x="${fmt(x + dx)}" y="${fmt(y + dy)}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${f}"${extra}>${esc(text)}</text>`;
    return t(0, 0, '#000000', ' stroke="#000000" stroke-width="5" stroke-opacity="0.55" stroke-linejoin="round"') + t(0, 0, fill);
}

/**
 * The overlay: path flown (solid), plan ahead (dashed), airports, aircraft,
 * and the numbers strip. Pure, for the tests.
 */
function overlaySvg(f, geo, { accent = '#38bdf8', hasPhoto = false } = {}) {
    const { px } = geo;
    const { pos, flown, ahead, dep, arr } = geo.points;
    let svg = '';
    // A little darkening over the whole image keeps white type readable over
    // snow, cloud and desert alike.
    svg += `<rect width="${W}" height="${H}" fill="#000" fill-opacity="0.12"/>`;
    svg += `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/></linearGradient></defs>`;
    svg += `<rect y="${H - PANEL_H - 70}" width="${W}" height="${PANEL_H + 70}" fill="url(#fade)"/>`;

    if (ahead.length >= 2) {
        svg += `<path d="${line(ahead, px)}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3" stroke-dasharray="10 9" stroke-linecap="round"/>`;
    }
    if (flown.length >= 2) {
        const d = line(flown, px);
        svg += `<path d="${d}" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`;
        svg += `<path d="${d}" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    for (const [ap, end] of [[dep, false], [arr, true]]) {
        if (!ap) continue;
        const [x, y] = px(ap.lat, ap.lon);
        svg += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="9" fill="${end ? '#ffffff' : '#0f172a'}" stroke="#ffffff" stroke-width="3"/>`;
        // The label goes on whichever side the aeroplane is not — just after
        // takeoff the two sit on top of each other.
        const [ax, ay] = pos ? px(pos.lat, pos.lon) : [-1e9, -1e9];
        const near = (lx) => Math.abs(ax - lx) < 70 && Math.abs(ay - y) < 40;
        const [lx, ly, anchor] = !near(x + 55) && x < W - 110 ? [x + 15, y + 7, 'start']
            : !near(x - 55) && x > 110 ? [x - 15, y + 7, 'end'] : [x, y + 36, 'middle'];
        svg += label(lx, ly, ap.name, { size: 22, anchor });
    }
    if (pos) {
        const [x, y] = px(pos.lat, pos.lon);
        const hdg = Number(f.heading) || 0;
        svg += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="30" fill="${accent}" fill-opacity="0.22"/>`;
        svg += `<g transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(hdg)}) scale(1.15)"><path d="${PLANE}" fill="#ffffff" stroke="#0f172a" stroke-width="2.2" stroke-linejoin="round"/></g>`;
    }

    // ---- the numbers strip
    const y0 = H - PANEL_H;
    const callsign = clip(f.callsign || 'Flight', 26);
    const who = clip((f.pilot && f.pilot.name) || f.username || '', 34);
    svg += label(40, y0 + 46, callsign, { size: 38 });
    const sub = [who, clip([f.aircraftName, f.liveryName].filter(Boolean).join(' · '), 50)].filter(Boolean).join('   ·   ');
    if (sub) svg += label(40, y0 + 80, sub, { size: 19, fill: '#dbe4ef', weight: 'normal' });

    // Route progress, when both ends are known: how far along, in a bar.
    if (dep && arr) {
        const done = geo.progress;
        const bx = 40; const bw = 440; const by = y0 + 112;
        svg += label(bx, by - 8, dep.name, { size: 17 });
        svg += label(bx + bw, by - 8, arr.name, { size: 17, anchor: 'end' });
        svg += `<rect x="${bx}" y="${by}" width="${bw}" height="8" rx="4" fill="#ffffff" fill-opacity="0.28"/>`;
        svg += `<rect x="${bx}" y="${by}" width="${fmt(Math.max(8, bw * done))}" height="8" rx="4" fill="${accent}"/>`;
        if (geo.remainingNm != null) svg += label(bx + bw / 2, by - 8, `${Math.round(geo.remainingNm).toLocaleString('en-US')} nm to go`, { size: 15, anchor: 'middle', fill: '#dbe4ef', weight: 'normal' });
    }

    // Four readouts on the right of the strip.
    const alt = Number(f.altitude) || 0;
    const reads = [
        ['ALTITUDE', f.onGround ? 'GROUND' : alt >= 18000 ? `FL${String(Math.round(alt / 100)).padStart(3, '0')}` : `${Math.round(alt).toLocaleString('en-US')} ft`],
        ['GROUND SPEED', `${Math.round(Number(f.speed) || 0)} kt`],
        ['HEADING', `${String(Math.round(Number(f.heading) || 0) % 360).padStart(3, '0')}°`],
        ['VERTICAL', `${Number(f.verticalSpeed) > 0 ? '+' : ''}${Math.round(Number(f.verticalSpeed) || 0).toLocaleString('en-US')} fpm`],
    ];
    const colW = 158; const startX = W - 40 - colW * reads.length;
    reads.forEach(([k, v], i) => {
        const x = startX + i * colW;
        svg += label(x, y0 + 72, k, { size: 13, fill: '#a9b8ca' });
        svg += label(x, y0 + 104, v, { size: 25 });
    });

    // Status pill, top-left beside the brand.
    const status = f.onGround ? 'ON GROUND' : 'IN FLIGHT';
    svg += `<rect x="214" y="24" width="${status.length * 13 + 36}" height="44" rx="22" fill="${f.onGround ? '#f59e0b' : '#22c55e'}"/>`;
    svg += `<text x="${214 + (status.length * 13 + 36) / 2}" y="53" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="19" font-weight="bold" fill="#06121f">${status}</text>`;
    svg += `<rect x="12" y="16" width="186" height="60" rx="22" fill="#0d1117" fill-opacity="0.78"/>`;
    if (hasPhoto) svg += `<rect x="${PHOTO.x - 3}" y="${PHOTO.y - 3}" width="${PHOTO.w + 6}" height="${PHOTO.h + 6}" rx="19" fill="#ffffff" fill-opacity="0.9"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`;
}

/** Where the pieces go on the map, from what the crew center knows about the flight. */
function geometry(f, { plan = [], history = [] } = {}) {
    const pos0 = pt({ lat: f.latitude, lon: f.longitude });
    const ref = pos0 ? pos0.lon : 0;
    const fix = (p) => (p ? { ...p, lon: unwrap(p.lon, ref) } : null);
    const pos = fix(pos0);
    const planPts = plan.map(pt).filter(Boolean).map(fix);
    const flown = history.map(pt).filter(Boolean).map(fix);
    if (pos && flown.length) flown.push(pos);
    const airport = (icao, fallback) => {
        const c = icao ? coordsOf(icao) : null;
        if (c) return fix({ lat: c[0], lon: c[1], name: icao });
        return fallback ? { ...fallback, name: icao || fallback.name } : null;
    };
    const dep = f.origin ? airport(f.origin, planPts[0]) : null;
    const arr = f.destination ? airport(f.destination, planPts[planPts.length - 1]) : null;

    // The plan still to fly: from the aircraft to the fix nearest it, then on.
    let ahead = [];
    if (pos && planPts.length >= 2) {
        let best = 0; let bestD = Infinity;
        planPts.forEach((p, i) => { const d = nm(pos, p); if (d < bestD) { bestD = d; best = i; } });
        // The nearest fix behind us is skipped, so the dashed line never doubles back.
        const next = best < planPts.length - 1 && nm(pos, planPts[best + 1]) < nm(planPts[best], planPts[best + 1]) ? best + 1 : best;
        ahead = [pos, ...planPts.slice(next)];
    } else if (pos && arr) ahead = [pos, arr];

    let progress = 0; let remainingNm = null;
    if (pos && dep && arr) {
        remainingNm = ahead.length >= 2 ? pathNm(ahead) : nm(pos, arr);
        const flownNm = flown.length >= 2 ? pathNm(flown) : nm(dep, pos);
        progress = Math.max(0, Math.min(1, flownNm / Math.max(1, flownNm + remainingNm)));
    }
    // What the frame must hold. On the ground, only the aircraft and its
    // immediate surroundings — the route would zoom it out past the airfield.
    const frameOn = f.onGround && pos ? [pos] : [pos, dep, arr, ...flown, ...ahead].filter(Boolean);
    return { points: { pos, flown, ahead, dep, arr }, frameOn, progress, remainingNm };
}

async function renderImpl(f, { plan = [], history = [], photoUrl = '', accent, imagery = fetchImagery } = {}) {
    try {
        const geo = geometry(f, { plan, history });
        if (!geo.frameOn.length) return null;
        Object.assign(geo, frameFor(geo.frameOn, { onGround: !!f.onGround, photo: !!photoUrl }));

        const [sat, photoRaw] = await Promise.all([
            imagery(geo.bbox).catch(() => null),
            photoUrl ? fetchImage(photoUrl) : null,
        ]);
        let base = null;
        if (sat) base = await sharp(sat).resize(W, H, { fit: 'fill' }).png().toBuffer().catch(() => null);
        if (!base) {
            // No imagery: a night-sky graticule, so the rest still reads as a map.
            let grid = '';
            for (let i = 1; i < 12; i++) grid += `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="${H}" stroke="#1e3a5f" stroke-width="1"/>`;
            for (let i = 1; i < 7; i++) grid += `<line x1="0" y1="${i * 100}" x2="${W}" y2="${i * 100}" stroke="#1e3a5f" stroke-width="1"/>`;
            base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#11263f"/><stop offset="1" stop-color="#050b14"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>${grid}</svg>`)).png().toBuffer();
        }
        const photo = photoRaw ? await coverRounded(photoRaw, PHOTO.w, PHOTO.h, 16) : null;
        const hex = /^#?[0-9a-f]{6}$/i.test(String(accent || '')) ? `#${String(accent).replace('#', '')}` : '#38bdf8';
        const layers = [{ input: Buffer.from(overlaySvg(f, geo, { accent: hex, hasPhoto: !!photo })), left: 0, top: 0 }];
        if (photo) layers.push({ input: photo, left: PHOTO.x, top: PHOTO.y });
        const logo = brandLogo() ? await contain(brandLogo(), 150, 40) : null;
        if (logo) {
            const meta = await sharp(logo).metadata();
            layers.push({ input: logo, left: 30, top: 26 + Math.max(0, Math.round((40 - (meta.height || 40)) / 2)) });
        }
        return await sharp(base).composite(layers).png().toBuffer();
    } catch (err) {
        console.error('[live-map] render failed:', err && err.message ? err.message : err);
        return null;
    }
}

/** A PNG Buffer, or null when there is nothing to place on a map. Never throws. */
const renderLiveFlightMap = (f, opts) => queueRender(() => renderImpl(f || {}, opts || {}));

module.exports = { renderLiveFlightMap, frameFor, geometry, overlaySvg, imageryUrl, SIZE: { w: W, h: H } };
