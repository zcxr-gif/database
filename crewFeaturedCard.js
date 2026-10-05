'use strict';

/*
 * crewFeaturedCard.js
 * The pictures the Route of the Week, the Route of the Day and a new codeshare
 * are posted to Discord with.
 *
 * WHY A PICTURE AND NOT AN EMBED
 * ------------------------------
 * A Discord embed is a column of grey text, and seven legs in one is a wall of
 * it. The crew center draws these as tiles — the airline's own colour, a big
 * DEP → ARR, the block time and any bonus as pills — and a channel that gets
 * the same tile reads as the same airline. So the card is drawn here, as an SVG
 * rasterised by sharp, in the crew center's own shape, and the embed around it
 * carries only the words somebody might want to copy.
 *
 * EVERY LOGO IS BEST-EFFORT. A codeshare partner's logo is a URL somebody else
 * hosts; one that 404s, times out or is not an image is drawn as the partner's
 * initials instead, and a card never fails over decoration. If the whole render
 * throws, the caller posts the plain embed — the notice still goes out.
 *
 * NOTHING HERE KNOWS ABOUT A DATABASE OR A WEBHOOK. It is handed plain legs
 * and hands back a PNG buffer, which is what lets a test draw one.
 */

const sharp = require('sharp');
const axios = require('axios');

const W = 1200;
const FONT = 'DejaVu Sans, Arial, sans-serif';

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, n) => {
    const t = String(s == null ? '' : s).trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Rough text width — DejaVu Sans averages a little over half an em. */
const textW = (s, size, bold) => String(s).length * size * (bold ? 0.64 : 0.58);

const HEX = /^#?([0-9a-f]{6})$/i;
function accentOf(v) {
    const m = HEX.exec(String(v || '').trim());
    return m ? `#${m[1].toLowerCase()}` : '#2563eb';
}
/** Mix a hex colour toward black (t<0) or white (t>0). */
function shade(hex, t) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(t < 0 ? c * (1 + t) : c + (255 - c) * t));
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** "7h 05m", "45m". */
function durationText(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    if (!m) return '';
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
/** "2×", "1.5×". */
const bonusText = (b) => `${Number(b) % 1 ? Number(b).toFixed(2).replace(/0$/, '') : Number(b)}×`;

/* ---- Logos ---------------------------------------------------------------- */

const LOGO_TTL_MS = 60 * 60 * 1000;
const logoCache = new Map();   // url -> { at, buf|null }

async function fetchLogo(url) {
    const u = String(url || '');
    if (!/^https:\/\/\S+$/i.test(u)) return null;
    const hit = logoCache.get(u);
    if (hit && Date.now() - hit.at < LOGO_TTL_MS) return hit.buf;
    let buf = null;
    try {
        const res = await axios.get(u, {
            responseType: 'arraybuffer', timeout: 5000, maxContentLength: 4 * 1024 * 1024,
            validateStatus: (s) => s >= 200 && s < 300,
        });
        if (/^image\//i.test(String(res.headers['content-type'] || '')) || res.data) buf = Buffer.from(res.data);
    } catch { buf = null; }
    if (logoCache.size > 80) logoCache.delete(logoCache.keys().next().value);
    logoCache.set(u, { at: Date.now(), buf });
    return buf;
}

/**
 * A logo as a round badge of `size` px: white disc, the logo contained inside.
 * Initials on the accent when there is no usable picture.
 */
async function badge(buf, size, { initials = '', accent = '#2563eb' } = {}) {
    const r = size / 2;
    const disc = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="${r}" cy="${r}" r="${r}" fill="#ffffff"/></svg>`);
    if (buf) {
        try {
            const inner = Math.round(size * 0.74);
            const logo = await sharp(buf).resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
            const off = Math.round((size - inner) / 2);
            return await sharp(disc).composite([{ input: logo, left: off, top: off }]).png().toBuffer();
        } catch { /* fall through to initials */ }
    }
    const letters = esc(String(initials || '?').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
        .slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="${r}" cy="${r}" r="${r}" fill="${shade(accent, 0.85)}"/>
        <text x="${r}" y="${r + size * 0.14}" text-anchor="middle" font-family="${FONT}" font-weight="bold"
            font-size="${Math.round(size * 0.4)}" fill="${shade(accent, -0.35)}">${letters}</text></svg>`)).png().toBuffer();
}

/* ---- The tile background, as the crew center draws it --------------------- */

function backdrop(w, h, accent, { light = false } = {}) {
    const top = light ? shade(accent, 0.3) : shade(accent, 0.1);
    const a = light ? shade(accent, -0.26) : shade(accent, -0.08);
    const b = light ? shade(accent, -0.6) : shade(accent, -0.45);
    return `
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
            </linearGradient>
            <radialGradient id="glow" cx="0.1" cy="0" r="1.1">
                <stop offset="0" stop-color="${top}" stop-opacity="0.95"/><stop offset="0.6" stop-color="${top}" stop-opacity="0"/>
            </radialGradient>
            <pattern id="stripes" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(68)">
                <rect width="1.2" height="12" fill="#ffffff" fill-opacity="0.5"/>
            </pattern>
            <radialGradient id="fade" cx="0.85" cy="0.15" r="0.75">
                <stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
            </radialGradient>
            <mask id="m"><rect width="${w}" height="${h}" fill="url(#fade)"/></mask>
        </defs>
        <rect width="${w}" height="${h}" fill="url(#bg)"/>
        <rect width="${w}" height="${h}" fill="url(#glow)"/>
        <rect width="${w}" height="${h}" fill="url(#stripes)" opacity="0.14" mask="url(#m)"/>`;
}

function pill(x, y, label, { size = 22, fill = 'rgba(255,255,255,0.16)', color = '#ffffff', anchor = 'start', h = 42 } = {}) {
    const w = Math.round(textW(label, size, true) + 30);
    const left = anchor === 'end' ? x - w : x;
    return {
        w,
        svg: `<rect x="${left}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>
            <text x="${left + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" font-family="${FONT}"
                font-size="${size}" font-weight="bold" fill="${color}">${esc(label)}</text>`,
    };
}
const BONUS_FILL = '#fbbf24';
const BONUS_INK = '#3b2a00';

/* ---- The week: up to seven legs ------------------------------------------- */

const ROW_H = 84;
const ROW_GAP = 10;
const HEAD_H = 196;
const FOOT_H = 78;

/**
 * Draw the Route of the Week.
 *
 * `legs`: [{ flightNumber, origin, destination, aircraft, minutes, bonus,
 *            logoUrl, partnerName }]
 */
async function renderWeekCard({ vaName = '', vaLogoUrl = '', accent, periodLabel = '', legs = [], showBonus = true, footer = '' } = {}) {
    const ac = accentOf(accent);
    const list = (legs || []).slice(0, 7);
    const H = HEAD_H + list.length * (ROW_H + ROW_GAP) + FOOT_H;
    const parts = [backdrop(W, H, ac)];

    parts.push(`<text x="48" y="70" font-family="${FONT}" font-size="22" font-weight="bold" fill="#fff" fill-opacity="0.82"
        letter-spacing="4">ROUTE OF THE WEEK</text>`);
    parts.push(`<text x="48" y="122" font-family="${FONT}" font-size="44" font-weight="bold" fill="#fff">${esc(clip(vaName || 'This week', 34))}</text>`);
    if (periodLabel) {
        parts.push(`<text x="48" y="162" font-family="${FONT}" font-size="24" fill="#fff" fill-opacity="0.85">${esc(periodLabel)}</text>`);
    }

    const layers = [];
    const [vaLogo, ...legLogos] = await Promise.all([
        fetchLogo(vaLogoUrl),
        ...list.map((l) => fetchLogo(l.logoUrl)),
    ]);
    layers.push({ input: await badge(vaLogo, 108, { initials: vaName, accent: ac }), left: W - 48 - 108, top: 40 });

    for (let i = 0; i < list.length; i++) {
        const l = list[i];
        const y = HEAD_H + i * (ROW_H + ROW_GAP);
        parts.push(`<rect x="40" y="${y}" width="${W - 80}" height="${ROW_H}" rx="18" fill="#000" fill-opacity="0.22"/>
            <rect x="40.5" y="${y + 0.5}" width="${W - 81}" height="${ROW_H - 1}" rx="18" fill="none" stroke="#fff" stroke-opacity="0.12"/>`);
        const route = `${l.origin || '????'}  →  ${l.destination || '????'}`;
        parts.push(`<text x="132" y="${y + 50}" font-family="${FONT}" font-size="34" font-weight="bold" fill="#fff">${esc(route)}</text>`);
        const sub = [l.flightNumber, l.aircraft, l.partnerName ? `Codeshare · ${l.partnerName}` : ''].filter(Boolean).join('   ·   ');
        if (sub) {
            parts.push(`<text x="132" y="${y + 74}" font-family="${FONT}" font-size="17" fill="#fff" fill-opacity="0.78">${esc(clip(sub, 70))}</text>`);
        }
        // Right side: bonus pill, then the block time to its left.
        let right = W - 64;
        if (showBonus && Number(l.bonus) > 1) {
            const p = pill(right, y + 21, `${bonusText(l.bonus)} PAY`, { anchor: 'end', fill: BONUS_FILL, color: BONUS_INK });
            parts.push(p.svg);
            right -= p.w + 18;
        }
        const time = durationText(l.minutes);
        if (time) {
            parts.push(`<text x="${right}" y="${y + 50}" text-anchor="end" font-family="${FONT}" font-size="32" font-weight="bold" fill="#fff">${esc(time)}</text>
                <text x="${right}" y="${y + 72}" text-anchor="end" font-family="${FONT}" font-size="15" fill="#fff" fill-opacity="0.7">BLOCK</text>`);
        }
        layers.push({
            input: await badge(legLogos[i], 56, { initials: l.partnerName || vaName, accent: ac }),
            left: 60, top: y + 14,
        });
    }

    const foot = footer || 'Open to every pilot, whatever their rank. File it as Route of the Week.';
    parts.push(`<text x="48" y="${H - 30}" font-family="${FONT}" font-size="20" fill="#fff" fill-opacity="0.8">${esc(clip(foot, 96))}</text>`);

    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
    return sharp(svg).composite(layers).png().toBuffer();
}

/* ---- The day: one leg, drawn big ------------------------------------------ */

async function renderDayCard({ vaName = '', vaLogoUrl = '', accent, periodLabel = '', leg = {}, showBonus = true, footer = '' } = {}) {
    const ac = accentOf(accent);
    const H = 560;
    const parts = [backdrop(W, H, ac, { light: true })];
    parts.push(`<text x="56" y="80" font-family="${FONT}" font-size="24" font-weight="bold" fill="#fff" fill-opacity="0.85"
        letter-spacing="4">ROUTE OF THE DAY</text>`);
    if (periodLabel) {
        parts.push(`<text x="56" y="118" font-family="${FONT}" font-size="26" fill="#fff" fill-opacity="0.85">${esc(periodLabel)}</text>`);
    }
    const route = `${leg.origin || '????'} → ${leg.destination || '????'}`;
    parts.push(`<text x="52" y="282" font-family="${FONT}" font-size="128" font-weight="bold" fill="#fff" letter-spacing="-2">${esc(route)}</text>`);
    const sub = [leg.flightNumber, leg.aircraft].filter(Boolean).join('  ·  ');
    if (sub) parts.push(`<text x="58" y="340" font-family="${FONT}" font-size="34" fill="#fff" fill-opacity="0.9">${esc(clip(sub, 52))}</text>`);

    let x = 56;
    const chips = [];
    const time = durationText(leg.minutes);
    if (time) chips.push({ label: `${time} BLOCK` });
    if (leg.distanceNm) chips.push({ label: `${Math.round(leg.distanceNm).toLocaleString('en-US')} NM` });
    if (showBonus && Number(leg.bonus) > 1) chips.push({ label: `${bonusText(leg.bonus)} PAY`, fill: BONUS_FILL, color: BONUS_INK });
    if (leg.partnerName) chips.push({ label: `CODESHARE · ${clip(leg.partnerName, 24).toUpperCase()}` });
    for (const c of chips) {
        const p = pill(x, 392, c.label, { size: 24, h: 50, fill: c.fill, color: c.color });
        parts.push(p.svg);
        x += p.w + 14;
    }
    const foot = footer || 'Open to every pilot, whatever their rank. File it as Route of the Day.';
    parts.push(`<text x="56" y="${H - 44}" font-family="${FONT}" font-size="22" fill="#fff" fill-opacity="0.82">${esc(clip(foot, 90))}</text>`);

    const [vaLogo, legLogo] = await Promise.all([fetchLogo(vaLogoUrl), fetchLogo(leg.logoUrl)]);
    const layers = [{ input: await badge(vaLogo, 120, { initials: vaName, accent: ac }), left: W - 56 - 120, top: 44 }];
    // The operating airline, when it is somebody else: their logo beside ours.
    if (leg.partnerName) {
        layers.push({ input: await badge(legLogo, 120, { initials: leg.partnerName, accent: ac }), left: W - 56 - 120 - 140, top: 44 });
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
    return sharp(svg).composite(layers).png().toBuffer();
}

/* ---- A codeshare: two logos, one handshake -------------------------------- */

async function renderCodeshareCard({ accent, left = {}, right = {}, headline = '', subline = '' } = {}) {
    const ac = accentOf(accent);
    const H = 420;
    const parts = [backdrop(W, H, ac)];
    parts.push(`<text x="${W / 2}" y="70" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="bold"
        fill="#fff" fill-opacity="0.85" letter-spacing="5">NEW CODESHARE</text>`);
    parts.push(`<text x="${W / 2}" y="250" text-anchor="middle" font-family="${FONT}" font-size="64" font-weight="bold" fill="#fff">×</text>`);
    parts.push(`<text x="330" y="330" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="bold" fill="#fff">${esc(clip(left.name, 22))}</text>`);
    parts.push(`<text x="${W - 330}" y="330" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="bold" fill="#fff">${esc(clip(right.name, 22))}</text>`);
    if (headline || subline) {
        parts.push(`<text x="${W / 2}" y="384" text-anchor="middle" font-family="${FONT}" font-size="22" fill="#fff" fill-opacity="0.85">${esc(clip([headline, subline].filter(Boolean).join('  ·  '), 90))}</text>`);
    }
    const [a, b] = await Promise.all([fetchLogo(left.logoUrl), fetchLogo(right.logoUrl)]);
    const layers = [
        { input: await badge(a, 170, { initials: left.name, accent: ac }), left: 330 - 85, top: 104 },
        { input: await badge(b, 170, { initials: right.name, accent: ac }), left: W - 330 - 85, top: 104 },
    ];
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
    return sharp(svg).composite(layers).png().toBuffer();
}

/* ---- Words for the embed around the picture ------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "6 – 12 Oct 2026 · Week 41" / "Tuesday 6 October". `start` is the period's first day, Z. */
function periodLabel(period, key, start) {
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) return String(key || '');
    if (period === 'day') {
        return `${DAYS[start.getUTCDay()]} ${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
    }
    const end = new Date(start.getTime() + 6 * 86400000);
    const same = start.getUTCMonth() === end.getUTCMonth();
    const week = String(key || '').split('-W')[1];
    return `${start.getUTCDate()}${same ? '' : ` ${MONTHS[start.getUTCMonth()]}`} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`
        + (week ? ` · Week ${Number(week)}` : '');
}

/** One line per leg, for the embed's description. Markdown, Discord-flavoured. */
function legLine(l, { showBonus = true } = {}) {
    const bits = [`**${l.origin} → ${l.destination}**`];
    if (l.flightNumber) bits.unshift(`\`${l.flightNumber}\``);
    const tail = [l.aircraft, durationText(l.minutes)].filter(Boolean).join(' · ');
    if (tail) bits.push(tail);
    if (l.partnerName) bits.push(`🤝 ${l.partnerName}`);
    if (showBonus && Number(l.bonus) > 1) bits.push(`💰 **${bonusText(l.bonus)} pay**`);
    return bits.join('  ·  ');
}

module.exports = {
    renderWeekCard,
    renderDayCard,
    renderCodeshareCard,
    periodLabel,
    legLine,
    durationText,
    bonusText,
};
