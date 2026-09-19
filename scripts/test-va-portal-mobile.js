/*
 * scripts/test-va-portal-mobile.js
 *
 * THE VA PARTNERSHIP PORTAL'S TEAM TAB, ON A PHONE.
 *
 * Every control on that row was present in the DOM and reachable with a mouse,
 * and the row was still broken: the role picker and the Make owner button took
 * the action group past 270px, and because it was `shrink-0` it won every fight
 * with the text beside it. On a 390px screen the NAME was left 30 pixels —
 * narrower than two characters, and truncated. The row it happened to was the
 * active staff one, which is to say the person you would hand the VA to was
 * exactly whose name you could no longer read.
 *
 * Nothing about that shows up in a test that asserts on the DOM. It needs a
 * browser, a phone-sized viewport and the real stylesheet — so the properties
 * here are measured, not inspected:
 *
 *   • the page never scrolls sideways
 *   • no name is truncated to make room for the controls beside it
 *   • every control on a row is inside the screen
 *   • the tab strip scrolls, so Team — ninth of ten — is reachable at all
 *   • and the row still collapses back to ONE line on a wide screen, so this
 *     was not bought by making the desktop worse
 *
 * THE STYLESHEET. Layout is the whole subject, so the page needs its CSS, and
 * the CDN build is not reachable from a test runner. A locally built copy of
 * the same Tailwind output is served in its place and checked in beside this
 * file — the same arrangement tracker's tools/test-crew-mobile.js uses.
 * Regenerate it when the portal starts using a utility class it never has
 * before; a missing class shows up here as a layout wrong in a way no browser
 * would actually render:
 *
 *   npm i --no-save tailwindcss@3.4.17
 *   echo "module.exports={darkMode:'class',content:['./va-portal.html'],theme:{extend:{screens:{xs:'400px'}}}}" > /tmp/tw.config.js
 *   printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/tw.css
 *   npx tailwindcss -c /tmp/tw.config.js -i /tmp/tw.css -o scripts/va-portal-tailwind.css --minify
 *
 * Run:  node scripts/test-va-portal-mobile.js
 * Needs: playwright-core, and a Chromium at $PLAYWRIGHT_CHROMIUM (or the
 *        pre-installed /opt/pw-browsers/chromium). Skips cleanly (exit 0)
 *        where neither is available, so it can sit in a suite that also runs
 *        on machines without a browser.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS = path.join(__dirname, 'va-portal-tailwind.css');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';

let chromium;
try { ({ chromium } = require('playwright-core')); } catch {
    console.log('playwright-core not installed — skipping');
    process.exit(0);
}
if (!fs.existsSync(CHROME)) { console.log(`no chromium at ${CHROME} — skipping`); process.exit(0); }
if (!fs.existsSync(CSS)) { console.log('va-portal-tailwind.css missing — skipping (see the header)'); process.exit(0); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? '/va-portal.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(''); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});

const ME = { id: 'o1', username: 'founder', displayName: 'Antony', role: 'owner', active: true, vaName: 'Ocean Virtual' };
// Deliberately shaped like a real team: the owner, an ACTIVE STAFF member (the
// row that carries every control, and the one that broke), a disabled staff
// member, and a pilot. The long name is there because a short one hides a
// truncation bug.
const TEAM = [
    ME,
    { id: 's1', username: 'robin', displayName: 'Robin Vale', role: 'staff', active: true },
    { id: 's2', username: 'kim', displayName: 'Kim Arda-Whitfield', role: 'staff', active: false },
    { id: 'p1', username: 'flyer', displayName: 'Jules Pike', role: 'pilot', active: true },
];

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) { pass++; } else { fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`)); }
};

async function openTeam(browser, width) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const css = fs.readFileSync(CSS, 'utf8');
    await page.route('**/cdn.tailwindcss.com**', (r) => r.fulfill({
        contentType: 'application/javascript',
        body: 'window.tailwind={config:{}};(function(){var s=document.createElement("style");s.textContent='
            + JSON.stringify(css) + ';document.head.appendChild(s);})();',
    }));
    // Lucide draws the icon buttons; stubbed, because whether an <svg> arrived
    // is not what this file is about and the CDN is not reachable anyway.
    await page.route('**/unpkg.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.lucide={createIcons:function(){}};' }));
    await page.route('**/api/**', (route) => {
        const u = new URL(route.request().url()).pathname;
        const json = (x) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
        if (u.endsWith('/auth/me')) return json({ account: ME });
        if (u.endsWith('/va-portal/team')) return json({ team: TEAM });
        if (u.endsWith('/va-portal/va')) return json({ va: { name: 'Ocean Virtual', callsign: 'OCN' }, embeds: [], editable: true });
        if (u.endsWith('/tos')) return json({ current: null, acknowledged: true });
        if (u.endsWith('/warnings')) return json({ warnings: [] });
        return json({});
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/va-portal.html`);
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
        document.getElementById('panel-team').classList.remove('hidden');
    });
    await page.evaluate(() => loadTeam());
    await page.waitForTimeout(500);
    return { page, errors };
}

/** Name width, action width and whether the name had to be cut, per row. */
const rowMetrics = (page) => page.evaluate(() => [...document.querySelectorAll('#teamList > div')].map((row) => {
    const name = row.firstElementChild;
    const acts = row.lastElementChild;
    const title = name.querySelector('p');
    const rb = row.getBoundingClientRect();
    return {
        who: (title && title.textContent.trim()) || '',
        nameW: Math.round(name.getBoundingClientRect().width),
        rowTop: Math.round(rb.top), rowH: Math.round(rb.height),
        truncated: !!title && title.scrollWidth > title.clientWidth + 1,
        // Every control on the row, and whether it is on the screen.
        controls: [...acts.querySelectorAll('button, select')].map((c) => {
            const b = c.getBoundingClientRect();
            return { right: Math.round(b.right), left: Math.round(b.left), w: Math.round(b.width) };
        }),
        // Two lines on a phone, one on a desktop — read off the layout rather
        // than off the class list, so a renamed utility cannot fake it.
        stacked: acts.getBoundingClientRect().top > name.getBoundingClientRect().bottom - 1,
    };
}));

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ executablePath: CHROME });

    /* --------------------------------------------------------- on a phone */
    for (const width of [360, 390]) {
        const { page, errors } = await openTeam(browser, width);

        const doc = await page.evaluate(() => ({
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
        }));
        check(`${width}px: the page does not scroll sideways`,
            doc.scrollW <= doc.clientW + 1, doc);

        const rows = await rowMetrics(page);
        check(`${width}px: every teammate is drawn`, rows.length === 4, rows.length);
        check(`${width}px: no name is cut to make room for the controls`,
            rows.every((r) => !r.truncated), rows.filter((r) => r.truncated).map((r) => r.who));
        // The regression in one number. 30px was what the staff row had.
        check(`${width}px: names get real width, not a sliver`,
            rows.every((r) => r.nameW > 150), rows.map((r) => [r.who, r.nameW]));
        check(`${width}px: every control on every row is on the screen`,
            rows.every((r) => r.controls.every((c) => c.right <= width + 1 && c.left >= -1)),
            rows.map((r) => r.controls.map((c) => c.right)));
        check(`${width}px: the controls sit below the name rather than beside it`,
            rows.every((r) => r.stacked), rows.map((r) => [r.who, r.stacked]));
        // The row that carries the most: role picker, Make owner, and three
        // icon buttons. If anything fits, it has to.
        const robin = rows.find((r) => r.who === 'Robin Vale');
        check(`${width}px: the active staff row carries all five of its controls`,
            robin && robin.controls.length === 5, robin && robin.controls.length);

        // Ninth of ten tabs. If the strip does not scroll, Team is unreachable
        // on a phone no matter how well its contents are laid out.
        const tabs = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('[data-tab]')];
            const strip = btns[0].parentElement;
            return {
                names: btns.map((b) => b.textContent.trim()),
                overflowX: getComputedStyle(strip).overflowX,
                scrollable: strip.scrollWidth > strip.clientWidth,
            };
        });
        check(`${width}px: the tab strip scrolls, so Team can be reached`,
            /auto|scroll/.test(tabs.overflowX) && tabs.scrollable, tabs);
        check(`${width}px: …and Team is one of the tabs`, tabs.names.includes('Team'), tabs.names);

        const ours = errors.filter((e) => !/Failed to load resource|tailwind|lucide|airborne/i.test(e));
        check(`${width}px: no page errors of our own`, ours.length === 0, ours);
        await page.close();
    }

    /* ------------------------------------------ and still fine on a desktop */
    {
        const { page } = await openTeam(browser, 1280);
        const rows = await rowMetrics(page);
        check('1280px: the row is back on one line',
            rows.every((r) => !r.stacked), rows.map((r) => [r.who, r.stacked]));
        check('1280px: still nothing truncated', rows.every((r) => !r.truncated));
        const doc = await page.evaluate(() => ({
            scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        }));
        check('1280px: and no sideways scroll', doc.scrollW <= doc.clientW + 1, doc);
        await page.close();
    }

    await browser.close();
    server.close();

    console.log(`${pass} passed, ${fails.length} failed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
