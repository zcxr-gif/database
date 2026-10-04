'use strict';

/*
 * crewInviteBanner.js
 * The pictures that open and close a welcome message pasted on the IFC.
 *
 * WHY PICTURES
 * ------------
 * Most pilots a VA accepts are reached on the Infinite Flight Community — a
 * Discourse forum — by a staff member pasting the welcome into a private
 * message, because plenty of applicants never gave an email address. That
 * message used to be a wall of plain text that looked like every other DM in
 * their inbox. The IFC renders markdown images, so the message can open with
 * the airline's own banner and close with a small sign-off strip in the
 * airline's colours — the first thing a new pilot sees of their airline looks
 * like their airline.
 *
 * TWO PICTURES, ONE RENDERER
 * --------------------------
 *   footer   1200×200, shown at 600×100. Logo, "Welcome aboard", the airline's
 *            name and where the crew center lives. Every message ends with it.
 *   header   1200×360. Only for a VA that has never uploaded a directory banner
 *            — the message still opens with something that is theirs (their
 *            name and logo) rather than with nothing.
 *
 * SVG → PNG through sharp, the same path the event cards and the IFC profile
 * card take, with the same font (DejaVu is what the container has). A logo that
 * will not download is not an error: the plate falls back to the airline's
 * initials, because a hotlinked image on somebody's forum post has to draw
 * SOMETHING every time it is loaded.
 *
 * Pure apart from the logo fetch, which is injected so tests need no network.
 */

const sharp = require('sharp');
const axios = require('axios');

const FONT = 'DejaVu Sans, Arial, sans-serif';
const SIZES = {
    footer: { w: 1200, h: 200 },
    header: { w: 1200, h: 360 },
};
const DEFAULT_ACCENT = '#2563eb';

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const clamp = (s, n) => {
    const t = String(s || '').trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** A colour we can put in an SVG attribute, or the default. */
function accentOf(raw) {
    const s = String(raw || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
    return DEFAULT_ACCENT;
}

/** Mix a hex colour towards black (amount < 0) or white (amount > 0). */
function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const target = amount < 0 ? 0 : 255;
        return Math.round(c + (target - c) * Math.min(1, Math.abs(amount)));
    });
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const initialsOf = (name) => {
    const w = String(name || 'VA').trim().split(/\s+/).filter(Boolean);
    return (w.length >= 2 ? w[0][0] + w[1][0] : (w[0] || 'VA').slice(0, 2)).toUpperCase();
};

/** Short, readable address for the crew center: inflight.info/crew/ba */
function prettyUrl(url) {
    return String(url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function fetchLogo(url) {
    if (!/^https:\/\//i.test(String(url || ''))) return null;
    try {
        const resp = await axios.get(url, {
            responseType: 'arraybuffer', timeout: 6000,
            maxContentLength: 6 * 1024 * 1024, maxRedirects: 3,
        });
        if (!/^image\//i.test(String(resp.headers?.['content-type'] || ''))) return null;
        return Buffer.from(resp.data);
    } catch {
        return null;
    }
}

/** The logo, squared and rounded, as a PNG buffer — or null to draw initials. */
async function logoPlate(buf, size) {
    if (!buf) return null;
    try {
        const r = Math.round(size * 0.22);
        const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
        // Contained on white rather than cropped: VA marks are wordmarks about
        // as often as they are roundels, and cropping a wordmark loses the name.
        const inner = Math.round(size * 0.84);
        const fitted = await sharp(buf).resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
        return await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
            .composite([{ input: fitted, gravity: 'center' }, { input: mask, blend: 'dest-in' }])
            .png().toBuffer();
    } catch {
        return null;
    }
}

// A small aeroplane, drawn rather than fetched — nothing to fail.
const PLANE = 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z';

function footerSvg({ w, h }, { name, accent, url, hasLogo, logoSize, logoX, logoY }) {
    const deep = shade(accent, -0.72);
    const mid = shade(accent, -0.45);
    const light = shade(accent, 0.55);
    const textX = logoX + logoSize + 34;
    const initials = esc(initialsOf(name));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${deep}"/><stop offset="1" stop-color="${mid}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity=".07"/>
    </linearGradient>
    <clipPath id="card"><rect width="${w}" height="${h}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="${w * 0.55}" width="${w * 0.45}" height="${h}" fill="url(#sheen)"/>
  <rect x="0" y="0" width="10" height="${h}" fill="${accent}"/>
  </g>
  <g transform="translate(${w - 150} ${h / 2 - 54}) scale(4.5)" fill="#ffffff" fill-opacity=".10"><path d="${PLANE}" transform="rotate(45 12 12)"/></g>
  ${hasLogo ? '' : `<rect x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" rx="${Math.round(logoSize * 0.22)}" fill="${accent}"/>
  <text x="${logoX + logoSize / 2}" y="${logoY + logoSize / 2 + 16}" text-anchor="middle" font-family="${FONT}" font-size="46" font-weight="700" fill="#ffffff">${initials}</text>`}
  <text x="${textX}" y="${h / 2 - 30}" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="5" fill="${light}">WELCOME ABOARD</text>
  <text x="${textX}" y="${h / 2 + 22}" font-family="${FONT}" font-size="48" font-weight="700" fill="#ffffff">${esc(clamp(name, 30))}</text>
  ${url ? `<text x="${textX}" y="${h / 2 + 62}" font-family="${FONT}" font-size="22" fill="#ffffff" fill-opacity=".72">${esc(clamp(prettyUrl(url), 52))}</text>` : ''}
</svg>`;
}

function headerSvg({ w, h }, { name, accent, url, hasLogo, logoSize, logoX, logoY, tagline }) {
    const deep = shade(accent, -0.7);
    const mid = shade(accent, -0.35);
    const light = shade(accent, 0.6);
    const initials = esc(initialsOf(name));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${deep}"/><stop offset=".6" stop-color="${mid}"/><stop offset="1" stop-color="${accent}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="32" fill="url(#bg)"/>
  <g transform="translate(${w - 330} ${h / 2 - 150}) scale(12.5)" fill="#ffffff" fill-opacity=".08"><path d="${PLANE}" transform="rotate(45 12 12)"/></g>
  ${hasLogo ? '' : `<rect x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" rx="${Math.round(logoSize * 0.22)}" fill="${accent}" stroke="#ffffff" stroke-opacity=".35" stroke-width="3"/>
  <text x="${logoX + logoSize / 2}" y="${logoY + logoSize / 2 + 26}" text-anchor="middle" font-family="${FONT}" font-size="72" font-weight="700" fill="#ffffff">${initials}</text>`}
  <text x="${logoX + logoSize + 48}" y="${h / 2 - 26}" font-family="${FONT}" font-size="26" font-weight="700" letter-spacing="6" fill="${light}">CREW CENTER</text>
  <text x="${logoX + logoSize + 48}" y="${h / 2 + 34}" font-family="${FONT}" font-size="64" font-weight="700" fill="#ffffff">${esc(clamp(name, 24))}</text>
  ${tagline || url ? `<text x="${logoX + logoSize + 48}" y="${h / 2 + 82}" font-family="${FONT}" font-size="26" fill="#ffffff" fill-opacity=".75">${esc(clamp(tagline || prettyUrl(url), 56))}</text>` : ''}
</svg>`;
}

/**
 * Draw one.
 *
 * @param {Object} o
 * @param {'footer'|'header'} [o.kind]
 * @param {string} o.name      the airline's name
 * @param {string} [o.logoUrl] https only; anything else draws initials
 * @param {string} [o.accent]  #rgb / #rrggbb
 * @param {string} [o.url]     the crew center's address, printed small
 * @param {string} [o.tagline] header only
 * @param {Function} [o.fetch] injected logo fetch, for tests
 * @returns {Promise<Buffer>}  a PNG
 */
async function render({ kind = 'footer', name = '', logoUrl = '', accent = '', url = '', tagline = '', fetch = fetchLogo } = {}) {
    const k = SIZES[kind] ? kind : 'footer';
    const size = SIZES[k];
    const ac = accentOf(accent);
    const logoSize = k === 'header' ? 200 : 128;
    const logoX = k === 'header' ? 72 : 46;
    const logoY = Math.round((size.h - logoSize) / 2);
    const plate = await logoPlate(logoUrl ? await fetch(logoUrl) : null, logoSize);
    const opts = { name: name || 'Your airline', accent: ac, url, hasLogo: !!plate, logoSize, logoX, logoY, tagline };
    const svg = k === 'header' ? headerSvg(size, opts) : footerSvg(size, opts);
    const layers = plate ? [{ input: plate, left: logoX, top: logoY }] : [];
    return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}

/* A small cache in front of the renderer. These are hotlinked from forum posts,
   so the same picture is asked for every time somebody opens the message —
   drawing it once per airline per few hours is plenty. Keyed on everything that
   changes the picture, so a new logo or a renamed airline shows at once. */
const CACHE = new Map();
const CACHE_MAX = 300;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function cached(opts) {
    const key = JSON.stringify([opts.kind, opts.name, opts.logoUrl, opts.accent, opts.url, opts.tagline]);
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.png;
    const png = await render(opts);
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, { png, at: Date.now() });
    return png;
}

module.exports = { render, cached, accentOf, shade, initialsOf, prettyUrl, SIZES };
