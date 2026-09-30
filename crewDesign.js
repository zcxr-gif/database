'use strict';

/*
 * crewDesign.js
 * How a crew centre looks like the airline it belongs to.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every VA on the platform got the same page with its logo in the corner. The
 * airlines that care most about how they look — the ones with a designer on
 * staff, a livery department, a wallpaper for every new aircraft — had nowhere
 * in their own crew centre to put any of it. Their pilots left a branded
 * website and landed on something that looked like somebody else's product.
 *
 * Four things, all stored on the VA record beside the rank ladder and the
 * accent, all read by the crew centre before it has a session:
 *
 *   ARTWORK   the airline's own pictures — liveries, posters, wallpapers,
 *             banners — uploaded once, credited, shown as a showcase on the
 *             dashboard and the pilot home, and usable everywhere below.
 *   ART       where those pictures go: the hero, the page backdrop, and a
 *             cover for each section tile (Routes, Events, Fleet, Tours…).
 *   THEME     the airline's design system as a file: colours for light and
 *             dark, fonts, corner radius, a gradient, and custom CSS. A VA's
 *             designer can download it, edit it, and upload it back.
 *   UI        which of the crew centre's interfaces the crew sees first —
 *             essential, aurora, or airline.
 *
 * THE CUSTOM CSS IS THE ONE DANGEROUS PART, AND IT IS TREATED THAT WAY
 * --------------------------------------------------------------------
 * It is applied to a page pilots sign in on, so it goes through sanitizeCss:
 * a real (small) tokenizer, not a regex, that keeps style rules, @media,
 * @supports and @keyframes and drops everything else. Specifically it refuses:
 *
 *   @import / @namespace / @charset   pulls in a stylesheet we never saw
 *   url() that is not https           data:, javascript:, protocol-relative
 *   expression(), behavior, -moz-binding   script by another name
 *   anything with a "<"               cannot close the <style> it lands in
 *
 * and every selector is prefixed with `html[data-crew-css]`, so the sheet only
 * ever applies to the crew pages that switched it on, and outranks the stock
 * styles without anybody needing !important.
 *
 * What it cannot stop is a VA using CSS to make their own page ugly. That is
 * theirs to do. What it does stop is their CSS reaching anything that is not
 * a style.
 *
 * NOTHING HERE TALKS TO A DATABASE OR A BUCKET. Rules and cleaning only.
 */

const MAX_ARTWORK = 60;
const ART_KINDS = ['livery', 'poster', 'wallpaper', 'banner', 'photo', 'logo', 'other'];
const UIS = ['essential', 'aurora', 'airline'];
const MAX_CSS = 24 * 1024;

const TOKEN_KEYS = ['bg', 'surface', 'surface2', 'line', 'lineSoft', 'ink', 'muted', 'faint', 'accent', 'accentInk'];

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isHex = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || ''));
const isFontName = (s) => /^[a-z0-9][a-z0-9 \-]{0,39}$/i.test(String(s || ''));
const httpsUrl = (u) => {
    const s = str(u, 800);
    if (!/^https:\/\/[^\s"'<>()\\]+$/i.test(s)) return '';
    try { return new URL(s).protocol === 'https:' ? s : ''; } catch { return ''; }
};
const newId = () => `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ---------------------------------------------------------------------------
 * Artwork
 * ------------------------------------------------------------------------- */

function cleanArtwork(a, prev = null) {
    const src = a && typeof a === 'object' ? a : {};
    const url = httpsUrl(src.url || (prev && prev.url));
    if (!url) return null;
    return {
        id: str((prev && prev.id) || src.id, 40) || newId(),
        url,
        title: str(src.title, 80),
        kind: ART_KINDS.includes(src.kind) ? src.kind : 'other',
        // Who made it. Most VA artwork is somebody's own work, and the one
        // thing they ask for in return is their name on it.
        credit: str(src.credit, 80),
        creditUrl: httpsUrl(src.creditUrl),
        // In the rotating showcase, or only in the library.
        featured: src.featured !== false,
        width: Math.max(0, Math.min(10000, Math.round(Number(src.width) || (prev && prev.width) || 0))),
        height: Math.max(0, Math.min(10000, Math.round(Number(src.height) || (prev && prev.height) || 0))),
        // Ours to delete from the bucket when it is removed, or a link the VA
        // pasted, which is never ours to touch.
        hosted: !!((prev && prev.hosted) || src.hosted),
        addedAt: (prev && prev.addedAt) || src.addedAt || new Date().toISOString(),
    };
}

function sanitizeArtwork(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice(0, MAX_ARTWORK)
        .map((a) => cleanArtwork(a, a))
        .filter((a) => a && !seen.has(a.id) && seen.add(a.id));
}

/** What the public may see of the library: no bookkeeping. */
const publicArtwork = (list) => sanitizeArtwork(list).map(({ hosted, ...a }) => a);

/* ---------------------------------------------------------------------------
 * Where the pictures go
 * ------------------------------------------------------------------------- */

// A section key is a tile's action name ("routes", "events", "goals"…). Any
// short word is accepted rather than a fixed list, so a tile added next month
// can take a cover without this file changing.
const SECTION_KEY = /^[a-z][a-zA-Z]{1,23}$/;

function sanitizeArt(a) {
    const src = a && typeof a === 'object' ? a : {};
    const sections = {};
    const s = src.sections && typeof src.sections === 'object' ? src.sections : {};
    for (const [k, v] of Object.entries(s).slice(0, 60)) {
        const url = httpsUrl(v);
        if (SECTION_KEY.test(k) && url) sections[k] = url;
    }
    const show = src.showcase && typeof src.showcase === 'object' ? src.showcase : {};
    return {
        // Behind the identity card on the dashboard and the pilot hero.
        hero: httpsUrl(src.hero),
        // Behind the whole page, faintly. Most VAs will leave it empty.
        backdrop: httpsUrl(src.backdrop),
        backdropOpacity: Math.max(0, Math.min(1, Number.isFinite(+src.backdropOpacity) ? +src.backdropOpacity : 0.12)),
        sections,
        showcase: {
            enabled: show.enabled !== false,
            // Seconds between slides; 0 holds still.
            interval: Math.max(0, Math.min(60, Math.round(Number(show.interval ?? 7)))),
            title: str(show.title, 60),
        },
    };
}

/** Drop every reference to a picture that has been removed from the library. */
function forgetUrl(art, url) {
    const a = sanitizeArt(art);
    if (a.hero === url) a.hero = '';
    if (a.backdrop === url) a.backdrop = '';
    for (const k of Object.keys(a.sections)) if (a.sections[k] === url) delete a.sections[k];
    return a;
}

/* ---------------------------------------------------------------------------
 * The theme
 * ------------------------------------------------------------------------- */

function cleanPalette(p) {
    const out = {};
    const src = p && typeof p === 'object' ? p : {};
    for (const k of TOKEN_KEYS) if (isHex(src[k])) out[k] = String(src[k]).toLowerCase();
    return out;
}

const isGradientArgs = (s) => {
    const v = String(s || '').trim();
    if (!v || v.length > 240) return false;
    if (!/^[#a-z0-9%.,\s-]+$/i.test(v)) return false;
    if (/url|expression|javascript|import|\/\*|\\/i.test(v)) return false;
    return /#([0-9a-f]{3}|[0-9a-f]{6})/i.test(v);
};

function sanitizeTheme(t) {
    const src = t && typeof t === 'object' ? t : {};
    const css = sanitizeCss(src.css);
    const out = {
        name: str(src.name, 60),
        mode: ['light', 'dark', 'auto'].includes(src.mode) ? src.mode : 'auto',
        light: cleanPalette(src.light),
        dark: cleanPalette(src.dark),
        font: isFontName(src.font) ? str(src.font, 40) : '',
        displayFont: isFontName(src.displayFont) ? str(src.displayFont, 40) : '',
        monoFont: isFontName(src.monoFont) ? str(src.monoFont, 40) : '',
        radius: Number.isFinite(+src.radius) && src.radius !== '' && src.radius != null
            ? Math.max(0, Math.min(32, Math.round(+src.radius))) : null,
        gradient: isGradientArgs(src.gradient) ? String(src.gradient).trim() : '',
        css: css.css,
    };
    return { theme: out, dropped: css.dropped };
}

/** True when a theme says nothing, so the record can store null. */
const themeEmpty = (t) => !t || (!t.name && t.mode === 'auto' && !Object.keys(t.light || {}).length
    && !Object.keys(t.dark || {}).length && !t.font && !t.displayFont && !t.monoFont
    && t.radius == null && !t.gradient && !t.css);

/* ---------------------------------------------------------------------------
 * The custom CSS sanitiser
 *
 * A tokenizer that understands strings, comments and braces — enough to find
 * where each rule starts and ends without being fooled by a "}" inside a
 * string. It never evaluates anything; it only decides what to keep.
 * ------------------------------------------------------------------------- */

const SCOPE = 'html[data-crew-css]';
const BLOCK_AT = ['media', 'supports', 'container', 'layer'];
const KEEP_AT = ['keyframes', '-webkit-keyframes', 'font-face'];

/** Split a CSS text into top-level items: { prelude, body } or { at, text }. */
function parseBlocks(text) {
    const items = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        // Skip whitespace.
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) break;
        let prelude = '';
        let depth = 0;
        let body = '';
        let inStr = '';
        let started = false;
        for (; i < n; i++) {
            const c = text[i];
            if (inStr) {
                (started ? (body += c) : (prelude += c));
                if (c === '\\' && i + 1 < n) { i++; (started ? (body += text[i]) : (prelude += text[i])); continue; }
                if (c === inStr) inStr = '';
                continue;
            }
            if (c === '"' || c === "'") { inStr = c; (started ? (body += c) : (prelude += c)); continue; }
            if (!started) {
                if (c === ';') { i++; break; }       // an at-statement without a block
                if (c === '{') { started = true; depth = 1; continue; }
                prelude += c;
                continue;
            }
            if (c === '{') depth++;
            if (c === '}') { depth--; if (depth === 0) { i++; break; } }
            body += c;
        }
        items.push({ prelude: prelude.trim(), body: started ? body : null });
    }
    return items;
}

// A value we will not write, whatever property it is on.
function badValue(v) {
    const s = String(v).toLowerCase();
    if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|\\/.test(s)) return true;
    // Every url() must be https. Quoted or not; nothing else.
    const urls = s.match(/url\s*\(([^)]*)\)/g) || [];
    for (const u of urls) {
        const inner = u.replace(/^url\s*\(\s*/, '').replace(/\s*\)$/, '').replace(/^["']|["']$/g, '');
        if (!/^https:\/\/[^\s"'()<>]+$/.test(inner)) return true;
    }
    // image-set()/src() and friends can fetch too; only allow them with https inside.
    if (/(image-set|src)\s*\(/.test(s) && !/https:\/\//.test(s)) return true;
    return false;
}

function cleanDeclarations(body, dropped) {
    const out = [];
    // Declarations split on ';' outside strings/parentheses.
    let cur = ''; let paren = 0; let inStr = '';
    const flush = () => {
        const d = cur.trim(); cur = '';
        if (!d) return;
        const m = d.match(/^(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([\s\S]+)$/);
        if (!m) { dropped.push(d.slice(0, 60)); return; }
        const prop = m[1].toLowerCase();
        if (prop === 'behavior' || prop === '-moz-binding') { dropped.push(prop); return; }
        if (badValue(m[2])) { dropped.push(`${prop}: ${m[2].slice(0, 40)}`); return; }
        out.push(`${m[1]}:${m[2].trim()}`);
    };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) { cur += c; if (c === '\\' && i + 1 < body.length) { cur += body[++i]; continue; } if (c === inStr) inStr = ''; continue; }
        if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
        if (c === '(') paren++;
        if (c === ')') paren = Math.max(0, paren - 1);
        if (c === ';' && !paren) { flush(); continue; }
        cur += c;
    }
    flush();
    return out.join(';');
}

function scopeSelector(sel) {
    return sel.split(',').map((one) => {
        const s = one.trim();
        if (!s) return '';
        // `html` and `:root` ARE the scope element.
        if (/^(html|:root)\b/i.test(s)) return s.replace(/^(html|:root)/i, SCOPE);
        return `${SCOPE} ${s}`;
    }).filter(Boolean).join(',');
}

function cleanRules(text, dropped, depth = 0) {
    const out = [];
    for (const { prelude, body } of parseBlocks(text)) {
        if (!prelude) continue;
        if (prelude.startsWith('@')) {
            const name = (prelude.match(/^@([a-zA-Z-]+)/) || [])[1];
            const at = String(name || '').toLowerCase();
            if (body == null) { dropped.push(prelude.slice(0, 60)); continue; }     // @import & co.
            if (BLOCK_AT.includes(at) && depth < 3) {
                if (badValue(prelude)) { dropped.push(prelude.slice(0, 60)); continue; }
                out.push(`${prelude}{${cleanRules(body, dropped, depth + 1)}}`);
                continue;
            }
            if (at === 'keyframes' || at === '-webkit-keyframes') {
                // Frames are selectors like "from", "50%": declarations inside
                // are cleaned; the frame names are not scoped.
                const frames = parseBlocks(body).filter((f) => f.body != null && /^[\d.%\s,fromt]+$/i.test(f.prelude))
                    .map((f) => `${f.prelude}{${cleanDeclarations(f.body, dropped)}}`);
                if (/^@(-webkit-)?keyframes\s+[a-zA-Z_][\w-]*$/.test(prelude)) out.push(`${prelude}{${frames.join('')}}`);
                else dropped.push(prelude.slice(0, 60));
                continue;
            }
            if (at === 'font-face') {
                const d = cleanDeclarations(body, dropped);
                if (/src\s*:/.test(d)) out.push(`@font-face{${d}}`);
                continue;
            }
            dropped.push(prelude.slice(0, 60));
            continue;
        }
        if (body == null) { dropped.push(prelude.slice(0, 60)); continue; }
        const decl = cleanDeclarations(body, dropped);
        if (decl) out.push(`${scopeSelector(prelude)}{${decl}}`);
    }
    return out.join('\n');
}

/**
 * @returns { css, dropped } — the cleaned, scoped sheet, and a short list of
 * what was removed so the editor can say so rather than silently lose it.
 */
function sanitizeCss(input) {
    let text = String(input == null ? '' : input);
    if (!text.trim()) return { css: '', dropped: [] };
    const dropped = [];
    if (text.length > MAX_CSS) { dropped.push(`everything after ${Math.round(MAX_CSS / 1024)} KB`); text = text.slice(0, MAX_CSS); }
    // No markup, ever: nothing may close the <style> this is written into.
    if (/<\/?\s*[a-z!]/i.test(text)) { dropped.push('HTML tags'); text = text.replace(/<[^>]*>?/g, ''); }
    text = text.replace(/</g, '');
    // Comments go first — they are where a "}" or a url() hides from a naive scan.
    text = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, '');
    // Already scoped (a theme file downloaded and uploaded again): unscope so
    // it is not prefixed twice.
    text = text.split(`${SCOPE} `).join('').split(SCOPE).join('html');
    const css = cleanRules(text, dropped);
    return { css, dropped: [...new Set(dropped)].slice(0, 20) };
}

/* ---------------------------------------------------------------------------
 * The theme file
 * ------------------------------------------------------------------------- */

const FILE_KIND = 'inflight-crew-theme';

/** What "Download theme" hands a VA's designer. */
function themeFile({ name, slug, theme, art, ui, artwork }) {
    return {
        kind: FILE_KIND,
        version: 1,
        airline: str(name, 80),
        slug: str(slug, 80),
        exportedAt: new Date().toISOString(),
        ui: UIS.includes(ui) ? ui : 'essential',
        theme: sanitizeTheme(theme || {}).theme,
        art: sanitizeArt(art || {}),
        // For reference: the pictures the art settings point at. Uploading the
        // file does not upload pictures — they are already hosted.
        artwork: publicArtwork(artwork || []).map(({ url, title, kind }) => ({ url, title, kind })),
    };
}

/** Read a theme file back. Returns { theme, art, ui, dropped } or { error }. */
function readThemeFile(file) {
    let f = file;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { return { error: 'That is not a theme file — it is not valid JSON.' }; } }
    if (!f || typeof f !== 'object') return { error: 'That is not a theme file.' };
    // A bare theme object is accepted too: a designer writing one by hand
    // should not have to know our wrapper.
    const body = f.kind === FILE_KIND ? f : { theme: f.theme || f, art: f.art, ui: f.ui };
    const { theme, dropped } = sanitizeTheme(body.theme || {});
    return {
        theme,
        art: body.art ? sanitizeArt(body.art) : null,
        ui: UIS.includes(body.ui) ? body.ui : null,
        dropped,
    };
}

module.exports = {
    MAX_ARTWORK,
    ART_KINDS,
    UIS,
    MAX_CSS,
    FILE_KIND,
    cleanArtwork,
    sanitizeArtwork,
    publicArtwork,
    sanitizeArt,
    forgetUrl,
    sanitizeTheme,
    themeEmpty,
    sanitizeCss,
    themeFile,
    readThemeFile,
    httpsUrl,
};
