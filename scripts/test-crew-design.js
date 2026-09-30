'use strict';
// Conformance test for crewDesign.js and crewDesignRoutes.js — the airline's
// own look: artwork, where it goes, the theme file and the interface.
//
// The properties worth protecting:
//
//   * custom CSS can only ever be STYLE: no @import, no non-https url(), no
//     expression()/behavior, no markup that could close the <style> tag — and
//     every selector is scoped to the crew pages that switched it on
//   * a downloaded theme file uploads back to the same thing (no double scope)
//   * removing a picture removes it from everywhere it was placed, and only a
//     picture WE stored is ever deleted from the bucket
//   * the library has a ceiling, and a link must be https
//   * only settings.branding may change any of it
//
// Pure module test plus the handlers against an in-memory record.

const path = require('path');
const D = require(path.join('..', 'crewDesign.js'));
const registerCrewDesign = require(path.join('..', 'crewDesignRoutes.js'));

let failures = 0;
const T = (label, got, expected) => {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const Y = (label, cond, detail) => T(label + (cond ? '' : ` — ${detail || ''}`), !!cond, true);

console.log('custom CSS');
{
    const { css, dropped } = D.sanitizeCss(`
        /* a comment with } and url(javascript:x) */
        @import url(https://evil.test/x.css);
        :root{ --accent:#c8102e }
        body, .tile > a { background:url("https://cdn.test/bg.jpg") center/cover }
        .a{ background:url(data:image/png;base64,AAAA); color:red }
        .b{ width:expression(alert(1)) }
        .c{ background-image:url(//evil.test/x.png) }
        .d{ content:"</style><script>alert(1)</script>" }
        .e{ behavior:url(x.htc); -moz-binding:url(x.xml#y) }
        @media (max-width:600px){ .f{ display:none } }
        @keyframes pulse{ from{opacity:0} to{opacity:1} }
        @font-face{ font-family:Brand; src:url(https://fonts.test/b.woff2) format('woff2') }
        @namespace svg url(http://www.w3.org/2000/svg);
    `);
    Y('no @import survives', !/@import/.test(css));
    Y('no @namespace survives', !/@namespace/.test(css));
    Y('a data: url is refused', !/data:/.test(css));
    Y('a protocol-relative url is refused', !/\/\/evil/.test(css));
    Y('expression() is refused', !/expression/.test(css));
    Y('behavior and -moz-binding are refused', !/behavior|binding/.test(css));
    Y('nothing can close the style tag', !/<\/?style|<script/i.test(css), css);
    Y('an https background survives', /url\("https:\/\/cdn\.test\/bg\.jpg"\)/.test(css));
    Y('every selector is scoped to the crew pages', css.split('\n').filter((l) => !l.startsWith('@')).every((l) => l.startsWith('html[data-crew-css]')), css);
    Y(':root becomes the scope element itself', /html\[data-crew-css\]\{--accent:#c8102e\}/.test(css));
    Y('@media survives, with its rules scoped', /@media \(max-width:600px\)\{html\[data-crew-css\] \.f\{display:none\}\}/.test(css), css);
    Y('@keyframes survives', /@keyframes pulse\{from\{opacity:0\}to\{opacity:1\}\}/.test(css));
    Y('@font-face with an https src survives', /@font-face\{font-family:Brand/.test(css));
    Y('the good half of a mixed rule is kept', /\.a\{color:red\}/.test(css));
    Y('and the editor is told what went', dropped.length >= 5, JSON.stringify(dropped));
    T('empty is empty', D.sanitizeCss('').css, '');
    T('the same sheet cleaned twice is the same sheet', D.sanitizeCss(css).css, css);
    const huge = '.x{color:red}'.repeat(4000);
    Y('a sheet over the limit is cut, and says so', D.sanitizeCss(huge).dropped.some((d) => /KB/.test(d)));
}

console.log('theme');
{
    const { theme } = D.sanitizeTheme({ light: { accent: '#C8102E', bg: 'red', ink: '#111' }, font: 'Inter', displayFont: 'x;}', radius: 99, gradient: 'url(x)', mode: 'dark' });
    T('colours are hex only, lower-cased', theme.light, { ink: '#111', accent: '#c8102e' });
    T('a font name that could escape is dropped', [theme.font, theme.displayFont], ['Inter', '']);
    T('radius is clamped', theme.radius, 32);
    T('a gradient with url() is dropped', theme.gradient, '');
    Y('an empty theme is recognised as empty', D.themeEmpty(D.sanitizeTheme({}).theme));

    const file = D.themeFile({ name: 'Aurora', slug: 'aurora', theme: { light: { accent: '#c8102e' }, css: '.hero{height:300px}' }, art: { hero: 'https://x.test/h.jpg' }, ui: 'airline', artwork: [{ id: 'a', url: 'https://x.test/h.jpg', title: 'Hero', hosted: true }] });
    T('a theme file says what it is', [file.kind, file.version, file.ui], ['inflight-crew-theme', 1, 'airline']);
    const back = D.readThemeFile(JSON.stringify(file));
    T('…and reads back to the same theme', back.theme.css, file.theme.css);
    T('…with its art and interface', [back.art.hero, back.ui], ['https://x.test/h.jpg', 'airline']);
    T('a bare theme object is accepted too', D.readThemeFile({ light: { accent: '#00ff00' } }).theme.light.accent, '#00ff00');
    Y('rubbish is refused with a reason', /not a theme file|JSON/.test(D.readThemeFile('{nope').error));
}

console.log('art');
{
    const art = D.sanitizeArt({ hero: 'https://x.test/h.jpg', backdrop: 'http://x.test/b.jpg', sections: { routes: 'https://x.test/r.jpg', 'bad key': 'https://x.test/y.jpg', events: 'javascript:alert(1)' }, showcase: { interval: 999 } });
    T('only https pictures are placed', [art.hero, art.backdrop], ['https://x.test/h.jpg', '']);
    T('section covers need a word key and an https picture', art.sections, { routes: 'https://x.test/r.jpg' });
    T('the showcase interval is bounded', art.showcase.interval, 60);
    const gone = D.forgetUrl({ hero: 'https://x.test/h.jpg', sections: { routes: 'https://x.test/h.jpg', fleet: 'https://x.test/f.jpg' } }, 'https://x.test/h.jpg');
    T('a removed picture leaves every place it was used', [gone.hero, gone.sections], ['', { fleet: 'https://x.test/f.jpg' }]);
}

// ---- handlers ----
function fakeApp() {
    const hs = [];
    const add = (m) => (p, ...fns) => hs.push({ m, re: new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), keys: (p.match(/:[a-zA-Z]+/g) || []).map((k) => k.slice(1)), fn: fns[fns.length - 1], mw: fns.length > 1 ? fns[0] : null });
    const app = { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };
    app.call = async (m, url, { body = {}, as = null, file = null } = {}) => {
        const h = hs.find((x) => x.m === m && x.re.test(url));
        const mm = url.match(h.re); const params = {}; h.keys.forEach((k, i) => { params[k] = mm[i + 1]; });
        let status = 200; let json = null; let sent = null;
        const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; }, set() { return res; }, send(s) { sent = s; return res; } };
        await h.fn({ params, body, as, file }, res);
        return { status, json, sent };
    };
    return app;
}

(async () => {
    console.log('the routes');
    const doc = { _id: 'va1', name: 'Aurora', slug: 'aurora', crewArtwork: [], crewArt: null, crewTheme: null, crewUi: '' };
    const live = () => ({ ...JSON.parse(JSON.stringify(doc)), markModified() {}, toObject() { return JSON.parse(JSON.stringify(doc)); }, async save() { const { markModified, toObject, save, ...rest } = this; Object.assign(doc, JSON.parse(JSON.stringify(rest))); } });
    const deleted = [];
    const app = fakeApp();
    registerCrewDesign(app, {
        VirtualAirlineAd: { findById: () => ({ select() { return this; }, lean: async () => JSON.parse(JSON.stringify(doc)), then: (a, b) => Promise.resolve(live()).then(a, b) }) },
        resolveCrewVa: async () => ({ _id: 'va1', slug: 'aurora' }),
        requireCap: async (req) => (req.as === 'staff' ? { p: {} } : { error: 403 }),
        crewFail: (res, err) => res.status(500).json({ error: String(err && err.stack) }),
        upload: { single: () => (req, res, next) => next() },
        s3Client: {},
        uploadVaImageMeta: async () => ({ url: `https://bucket.test/va-ads/art/va1-${Date.now()}.webp`, width: 1600, height: 900 }),
        deleteVaImage: async (_s3, url) => { deleted.push(url); },
    });

    T('a pilot cannot change the look', (await app.call('PUT', '/api/crew/aurora/design', { body: { ui: 'airline' } })).status, 403);
    const up = await app.call('POST', '/api/crew/aurora/artwork', { as: 'staff', file: { path: 'x' }, body: { title: 'A350 in our colours', kind: 'livery', credit: 'Mo' } });
    T('an upload lands in the library', [up.status, up.json.artwork.kind, up.json.artwork.width], [201, 'livery', 1600]);
    Y('…without the bookkeeping on the public copy', up.json.artwork.hosted === undefined);
    const link = await app.call('POST', '/api/crew/aurora/artwork/link', { as: 'staff', body: { url: 'https://imgur.test/p.png', title: 'Poster', kind: 'poster' } });
    T('a hosted-elsewhere picture can be linked', link.status, 201);
    T('…but only over https', (await app.call('POST', '/api/crew/aurora/artwork/link', { as: 'staff', body: { url: 'http://x.test/p.png' } })).status, 400);

    const heroUrl = up.json.artwork.url;
    const saved = await app.call('PUT', '/api/crew/aurora/design', { as: 'staff', body: {
        ui: 'airline',
        art: { hero: heroUrl, sections: { routes: heroUrl, events: link.json.artwork.url } },
        theme: { light: { accent: '#c8102e' }, css: '@import url(https://evil.test/x.css); .hero{height:300px}' },
    } });
    T('the interface, art and theme save', [saved.json.ui, saved.json.art.hero === heroUrl, saved.json.theme.light.accent], ['airline', true, '#c8102e']);
    Y('…with the CSS cleaned and the removal reported', !/@import/.test(saved.json.theme.css) && saved.json.dropped.length === 1, JSON.stringify(saved.json));

    const exp = await app.call('GET', '/api/crew/aurora/design/export', { as: 'staff' });
    const file = JSON.parse(exp.sent);
    T('the theme downloads as a file', [file.kind, file.art.hero === heroUrl], ['inflight-crew-theme', true]);
    const dry = await app.call('POST', '/api/crew/aurora/design/import', { as: 'staff', body: { file: exp.sent, dryRun: true } });
    T('an upload can be previewed first', [dry.json.dryRun, dry.json.theme.css], [true, saved.json.theme.css]);

    const second = (await app.call('GET', '/api/crew/aurora/design', { as: 'staff' })).json.artwork;
    await app.call('PUT', '/api/crew/aurora/artwork/order', { as: 'staff', body: { ids: [second[1].id, second[0].id] } });
    T('the library can be reordered', (await app.call('GET', '/api/crew/aurora/design', { as: 'staff' })).json.artwork[0].id, second[1].id);
    const hid = await app.call('PATCH', `/api/crew/aurora/artwork/${second[0].id}`, { as: 'staff', body: { featured: false, title: 'Renamed' } });
    T('a picture can be renamed and left out of the showcase', [hid.json.artwork.title, hid.json.artwork.featured, hid.json.artwork.url], ['Renamed', false, heroUrl]);

    const del = await app.call('DELETE', `/api/crew/aurora/artwork/${second[0].id}`, { as: 'staff' });
    T('removing it takes it off the hero and the covers', [del.json.art.hero, del.json.art.sections.routes], ['', undefined]);
    T('…and deletes the object, because it is ours', deleted, [heroUrl]);
    await app.call('DELETE', `/api/crew/aurora/artwork/${second[1].id}`, { as: 'staff' });
    T('a linked picture is never deleted from anybody’s bucket', deleted.length, 1);

    doc.crewArtwork = Array.from({ length: D.MAX_ARTWORK }, (_, i) => ({ id: `x${i}`, url: `https://x.test/${i}.png` }));
    T('the library has a ceiling', (await app.call('POST', '/api/crew/aurora/artwork/link', { as: 'staff', body: { url: 'https://x.test/more.png' } })).status, 409);

    console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
