'use strict';

/*
 * crewAnnounceBanner.js
 * The picture at the top of an announcement posted to a VA's Discord.
 *
 * WHY A DRAWN PICTURE
 * -------------------
 * A notice posted from the crew center used to be one more grey embed in a
 * channel full of them — flight filed, flight approved, route added. An
 * announcement is the thing staff actually want read, so it opens with a wide
 * banner in the airline's own colours: their logo, their name, a label that
 * says what kind of message this is, and the headline set large enough to read
 * from the channel list's preview.
 *
 * Staff who have their own artwork upload it instead and this is not drawn at
 * all (see the announcement route). This is the default, and it has to look
 * finished for an airline that has never opened an image editor.
 *
 * FOUR STYLES
 * -----------
 *   notice       the airline's accent. Everyday news.
 *   event        night-sky navy with the accent as the highlight. Group
 *                flights, fly-ins, anything with a date.
 *   celebration  warm gold with confetti. Milestones, anniversaries, records.
 *   urgent       red with a hazard band. Outages, rule changes, read-this-now.
 *
 * SVG → PNG through sharp with DejaVu, the same path crewInviteBanner takes.
 * The logo fetch is injected so tests need no network, and a logo that will not
 * download draws the airline's initials rather than failing the post.
 */

const sharp = require('sharp');
const {
    accentOf, shade, initialsOf, prettyUrl, fetchLogo, logoPlate, esc, PLANE, FONT,
} = require('./crewInviteBanner');

const W = 1200;
const H = 500;
const STYLES = ['notice', 'event', 'celebration', 'urgent'];
const styleOf = (s) => (STYLES.includes(s) ? s : 'notice');

// What the label says, and what each style is painted with. `accent` is the
// airline's colour already resolved; the styles that override it do so because
// "urgent" in a VA's pastel green does not read as urgent.
function paletteFor(style, accent) {
    switch (style) {
        case 'event':
            return { from: '#0b1324', mid: '#14213d', to: shade(accent, -0.25), hi: shade(accent, 0.45), label: 'EVENT', ink: '#ffffff' };
        case 'celebration':
            return { from: '#3a1d04', mid: '#8a4b08', to: '#e0a526', hi: '#ffe7a3', label: 'CELEBRATION', ink: '#ffffff' };
        case 'urgent':
            return { from: '#3b0707', mid: '#7f1414', to: '#c2410c', hi: '#fecaca', label: 'IMPORTANT', ink: '#ffffff' };
        default:
            return { from: shade(accent, -0.72), mid: shade(accent, -0.4), to: accent, hi: shade(accent, 0.6), label: 'ANNOUNCEMENT', ink: '#ffffff' };
    }
}

/**
 * Break text into at most `lines` lines of roughly `perLine` characters, on
 * word boundaries, with an ellipsis if it had to stop. DejaVu is not monospaced
 * but it is even enough that a character budget keeps a line inside the card.
 */
function wrap(text, perLine, lines) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const out = [];
    let cur = '';
    let i = 0;
    for (; i < words.length; i++) {
        const w = words[i].length > perLine ? `${words[i].slice(0, perLine - 1)}…` : words[i];
        const next = cur ? `${cur} ${w}` : w;
        if (next.length <= perLine) { cur = next; continue; }
        out.push(cur);
        cur = w;
        if (out.length === lines) break;
    }
    if (out.length < lines && cur) { out.push(cur); cur = ''; i = words.length; }
    if (i < words.length || cur) {
        const last = out[out.length - 1] || '';
        out[out.length - 1] = `${last.slice(0, Math.max(0, perLine - 1)).trimEnd()}…`;
    }
    return out;
}

/** Headline size: as large as the text allows, smaller as it gets longer. */
function headline(title) {
    const t = String(title || '').trim();
    // DejaVu Sans Bold averages ~0.62em a character; the card leaves ~1050px.
    if (t.length <= 23) return { size: 72, perLine: 23, lines: wrap(t, 23, 2) };
    if (t.length <= 54) return { size: 60, perLine: 28, lines: wrap(t, 28, 2) };
    return { size: 50, perLine: 33, lines: wrap(t, 33, 2) };
}

// Small marks for each label chip — drawn, never fetched.
const ICONS = {
    notice: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zm13.5 1a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z',
    event: 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z',
    celebration: 'M12 2l2.4 6.9H22l-6 4.6 2.3 7L12 16.2 5.7 20.5 8 13.5 2 8.9h7.6z',
    urgent: 'M12 2L1 21h22L12 2zm-1 7h2v6h-2zm0 8h2v2h-2z',
};

function confetti(seedText) {
    // Deterministic, so the same announcement draws the same picture twice.
    let seed = 0;
    for (const ch of String(seedText || 'x')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const colours = ['#fde68a', '#fca5a5', '#a5f3fc', '#c4b5fd', '#ffffff', '#86efac'];
    let s = '';
    for (let n = 0; n < 46; n++) {
        const x = Math.round(W * 0.6 + rnd() * W * 0.38);
        const y = Math.round(rnd() * H);
        const r = Math.round(rnd() * 40);
        const c = colours[Math.floor(rnd() * colours.length)];
        s += rnd() > 0.5
            ? `<rect x="${x}" y="${y}" width="14" height="6" rx="2" fill="${c}" fill-opacity=".45" transform="rotate(${r} ${x} ${y})"/>`
            : `<circle cx="${x}" cy="${y}" r="${3 + Math.round(rnd() * 4)}" fill="${c}" fill-opacity=".4"/>`;
    }
    return s;
}

function bannerSvg(o) {
    const p = paletteFor(o.style, o.accent);
    const head = headline(o.title);
    const sub = wrap(o.body, 62, 2);
    const left = 72;
    const logoSize = 84;
    const logoY = 56;
    const nameX = left + logoSize + 24;
    const chipY = 186;
    const chipW = 50 + p.label.length * 18 + 24;
    const titleY = chipY + 64 + head.size * 0.9;
    const lineGap = head.size * 1.08;
    const subY = titleY + (head.lines.length - 1) * lineGap + 54;
    const initials = esc(initialsOf(o.name));
    const deco = o.style === 'celebration'
        ? confetti(o.title)
        : `<g transform="translate(${W - 360} ${H / 2 - 170}) scale(14)" fill="#ffffff" fill-opacity=".07"><path d="${PLANE}" transform="rotate(45 12 12)"/></g>`;
    const hazard = o.style === 'urgent'
        ? `<defs><pattern id="hz" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="20" height="40" fill="#facc15"/><rect x="20" width="20" height="40" fill="#111827"/></pattern></defs><rect x="0" y="${H - 16}" width="${W}" height="16" fill="url(#hz)"/>`
        : `<rect x="0" y="${H - 8}" width="${W}" height="8" fill="${p.hi}" fill-opacity=".85"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.from}"/><stop offset=".55" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.to}"/>
    </linearGradient>
    <radialGradient id="glow" cx=".85" cy=".2" r=".7">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${deco}
  ${hazard}
  ${o.hasLogo ? '' : `<rect x="${left}" y="${logoY}" width="${logoSize}" height="${logoSize}" rx="${Math.round(logoSize * 0.22)}" fill="${o.accent}" stroke="#ffffff" stroke-opacity=".35" stroke-width="2"/>
  <text x="${left + logoSize / 2}" y="${logoY + logoSize / 2 + 12}" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="700" fill="#ffffff">${initials}</text>`}
  <text x="${nameX}" y="${logoY + 38}" font-family="${FONT}" font-size="30" font-weight="700" fill="${p.ink}">${esc(String(o.name || '').slice(0, 40))}</text>
  ${o.url ? `<text x="${nameX}" y="${logoY + 72}" font-family="${FONT}" font-size="20" fill="${p.ink}" fill-opacity=".7">${esc(prettyUrl(o.url).slice(0, 60))}</text>` : ''}
  <rect x="${left}" y="${chipY}" width="${chipW}" height="44" rx="22" fill="#ffffff" fill-opacity=".14" stroke="#ffffff" stroke-opacity=".3"/>
  <g transform="translate(${left + 16} ${chipY + 10}) scale(1)" fill="${p.hi}"><path d="${ICONS[o.style]}"/></g>
  <text x="${left + 50}" y="${chipY + 30}" font-family="${FONT}" font-size="19" font-weight="700" letter-spacing="4" fill="${p.hi}">${p.label}</text>
  ${head.lines.map((l, i) => `<text x="${left}" y="${Math.round(titleY + i * lineGap)}" font-family="${FONT}" font-size="${head.size}" font-weight="700" fill="${p.ink}">${esc(l)}</text>`).join('\n  ')}
  ${sub.map((l, i) => `<text x="${left}" y="${Math.round(subY + i * 36)}" font-family="${FONT}" font-size="27" fill="${p.ink}" fill-opacity=".82">${esc(l)}</text>`).join('\n  ')}
</svg>`;
}

/**
 * Draw one.
 *
 * @param {Object} o
 * @param {string} o.title      the headline
 * @param {string} [o.body]     first lines of the notice, printed under it
 * @param {string} [o.style]    notice | event | celebration | urgent
 * @param {string} o.name       the airline's name
 * @param {string} [o.logoUrl]  https only; anything else draws initials
 * @param {string} [o.accent]   #rgb / #rrggbb
 * @param {string} [o.url]      the crew center's address, printed small
 * @param {Function} [o.fetch]  injected logo fetch, for tests
 * @returns {Promise<Buffer>}   a PNG, 1200×500
 */
async function render({ title = '', body = '', style = 'notice', name = '', logoUrl = '', accent = '', url = '', fetch = fetchLogo } = {}) {
    const st = styleOf(style);
    const ac = accentOf(accent);
    const plate = await logoPlate(logoUrl ? await fetch(logoUrl) : null, 84);
    const svg = bannerSvg({
        title: title || 'Announcement', body, style: st, name: name || 'Your airline',
        accent: ac, url, hasLogo: !!plate,
    });
    const layers = plate ? [{ input: plate, left: 72, top: 56 }] : [];
    return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}

module.exports = { render, wrap, headline, styleOf, STYLES, W, H };
