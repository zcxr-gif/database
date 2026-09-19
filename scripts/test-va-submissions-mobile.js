/*
 * scripts/test-va-submissions-mobile.js
 *
 * THE STAFF-SIDE VA PARTNERSHIP PORTAL, ON A PHONE AND IN THE DARK.
 *
 * The oversight panel at /va-submissions was the one page in the staff hub that
 * never went dark: it shipped `darkMode: 'class'` and every `dark:` variant the
 * other panels use, and nothing ever put the class on <html>. So the variants
 * were dead CSS and the page came up white next to a hub that was black.
 *
 * It also panned sideways on a phone. Five tabs, laid out in a plain flex row,
 * are wider than a 390px screen; a flex row does not scroll, it stretches, so
 * the tab strip made the DOCUMENT wider than the viewport and the whole page
 * moved under the thumb — header, cards and all.
 *
 * Neither of those is visible to a test that asserts on the DOM: the elements
 * were all present and all reachable. They need a browser, a phone-sized
 * viewport and the real stylesheet, so the properties here are measured:
 *
 *   • the page never scrolls sideways, on any tab
 *   • the tab strip itself scrolls, so Activity — fifth of five — is reachable
 *   • dark mode is on by default and survives a toggle
 *   • no control on an account row leaves the screen, and no account name is
 *     truncated to make room for the buttons beside it
 *   • the account editor, search and filters all fit the width too
 *   • and the desktop layout still puts a row on one line, so none of this was
 *     bought by making the wide view worse
 *
 * THE STYLESHEET. Layout is the whole subject, so the page needs its CSS, and
 * the CDN build is not reachable from a test runner. A locally built copy of
 * the same Tailwind output is served in its place and checked in beside this
 * file, the same arrangement test-va-portal-mobile.js uses. Regenerate it when
 * the page starts using a utility class it never has before; a missing class
 * shows up here as a layout wrong in a way no browser would actually render:
 *
 *   npm i --no-save tailwindcss@3.4.17
 *   echo "module.exports={darkMode:'class',content:['./va-submissions.html'],theme:{extend:{screens:{xs:'400px'}}}}" > /tmp/tw.config.js
 *   printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/tw.css
 *   npx tailwindcss -c /tmp/tw.config.js -i /tmp/tw.css -o scripts/va-submissions-tailwind.css --minify
 *
 * Run:  node scripts/test-va-submissions-mobile.js
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
const CSS = path.join(__dirname, 'va-submissions-tailwind.css');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';

let chromium;
try { ({ chromium } = require('playwright-core')); } catch {
    console.log('playwright-core not installed — skipping');
    process.exit(0);
}
if (!fs.existsSync(CHROME)) { console.log(`no chromium at ${CHROME} — skipping`); process.exit(0); }
if (!fs.existsSync(CSS)) { console.log('va-submissions-tailwind.css missing — skipping (see the header)'); process.exit(0); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? '/va-submissions.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(''); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});

const VA = '507f1f77bcf86cd799439011';
const VA2 = '507f1f77bcf86cd799439012';
const VAS = [
    { id: VA, name: 'Ocean Virtual', callsign: 'OCN' },
    { id: VA2, name: 'Meridian Air Group International', callsign: 'MER' },
];
// Shaped like a real page of accounts: the owner, a staff member (the row that
// carries every control), a disabled one, and a long-named pilot on a second
// VA. The long names are there because short ones hide a truncation bug.
const ACCOUNTS = [
    { id: 'o1', username: 'ocean-virtual', displayName: 'Antony Fairweather', role: 'owner', vaAdId: VA, vaName: 'Ocean Virtual', active: true, createdVia: 'bot', lastLoginAt: '2026-09-18T12:18:00Z', mustChangePassword: false },
    { id: 's1', username: 'robin', displayName: 'Robin Vale', role: 'staff', vaAdId: VA, vaName: 'Ocean Virtual', active: true, createdVia: 'owner', lastLoginAt: null, mustChangePassword: true },
    { id: 's2', username: 'kim-arda-whitfield', displayName: 'Kim Arda-Whitfield', role: 'staff', vaAdId: VA, vaName: 'Ocean Virtual', active: false, createdVia: 'staff', lastLoginAt: null, mustChangePassword: false },
    { id: 'p1', username: 'meridian-air-group', displayName: 'Jules Pike-Hollingsworth', role: 'pilot', vaAdId: VA2, vaName: 'Meridian Air Group International', active: true, createdVia: 'owner', lastLoginAt: '2026-09-01T08:00:00Z', mustChangePassword: false },
];

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) { pass++; } else { fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw)})`)); }
};

async function open(browser, width) {
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
        if (u.endsWith('/admin/vas')) return json({ vas: VAS });
        if (u.endsWith('/admin/accounts')) return json({ accounts: ACCOUNTS });
        if (u.endsWith('/admin/submissions')) return json({ submissions: [] });
        if (u.endsWith('/admin/events')) return json({ events: [] });
        if (u.endsWith('/admin/warnings')) return json({ warnings: [] });
        if (u.endsWith('/admin/activity')) return json({ activity: [] });
        if (u.endsWith('/admin/tos')) {
            return json({
                tos: { version: '1.2', effectiveDate: '2026-01-01' },
                levels: [{ key: 'verbal', label: 'Verbal', meaning: 'A quiet word.', palette: 'amber' }],
            });
        }
        return json({});
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/va-submissions.html`);
    await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
    return { page, errors };
}

/** Does the DOCUMENT extend past the viewport? This is the "it pans" bug. */
const pansSideways = (page) => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
}));

/** Name width, action width and whether the name had to be cut, per account row. */
const rowMetrics = (page) => page.evaluate(() => [...document.querySelectorAll('#acctList > div')].map((row) => {
    const head = row.firstElementChild;
    const name = head.firstElementChild;
    const acts = head.lastElementChild;
    const title = name.querySelector('p');
    const ab = acts.getBoundingClientRect();
    return {
        name: title.textContent.trim().slice(0, 24),
        nameWidth: Math.round(name.getBoundingClientRect().width),
        actionsRight: Math.round(ab.right),
        // A name wider than the box holding it is a name the reader cannot read.
        clipped: title.scrollWidth > title.clientWidth + 1,
    };
}));

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ executablePath: CHROME });

    /* ------------------------------------------------------------ a phone */
    {
        const { page, errors } = await open(browser, 390);

        check('the page loads without throwing', errors.length === 0, errors);

        // --- dark mode ---
        const dark = await page.evaluate(() => ({
            onHtml: document.documentElement.classList.contains('dark'),
            bg: getComputedStyle(document.body).backgroundColor,
        }));
        check('the panel comes up dark like the rest of the hub', dark.onHtml, dark);
        // zinc-950 is (9,9,11); anything near white means the variants are dead.
        check('…and the body actually paints dark', /^rgb\(\s*9,\s*9,\s*11\s*\)$/.test(dark.bg), dark.bg);

        // The body carries `transition-colors duration-300`, so the computed
        // background is still mid-fade for a moment after the class flips.
        await page.evaluate(() => toggleTheme());
        await page.waitForTimeout(500);
        const light = await page.evaluate(() => ({
            onHtml: document.documentElement.classList.contains('dark'),
            saved: localStorage.getItem('theme'),
            bg: getComputedStyle(document.body).backgroundColor,
        }));
        check('the toggle turns it light', !light.onHtml && light.saved === 'light', light);
        check('…and the light theme paints light', !/^rgb\(\s*9,\s*9,\s*11\s*\)$/.test(light.bg), light.bg);
        await page.evaluate(() => toggleTheme());
        await page.waitForTimeout(400);

        // --- the tab strip ---
        const strip = await page.evaluate(() => {
            // No .hscroll at all means the strip is a plain flex row again,
            // which is the bug; report it rather than throwing.
            const el = document.querySelector('.hscroll');
            if (!el) return { scrolls: false, within: false, lastReachable: false, lastLabel: 'none', missing: true };
            const tabs = [...el.querySelectorAll('.tab')];
            const last = tabs[tabs.length - 1];
            el.scrollLeft = el.scrollWidth;
            return {
                scrolls: el.scrollWidth > el.clientWidth + 1,
                within: Math.round(el.getBoundingClientRect().width) <= document.documentElement.clientWidth,
                lastReachable: last.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
                lastLabel: last.textContent.trim(),
            };
        });
        check('the tab strip scrolls rather than stretching the page', strip.scrolls, strip);
        check('…stays inside the screen itself', strip.within, strip);
        check(`…and the last tab (${strip.lastLabel}) can be scrolled to`, strip.lastReachable, strip);

        // --- every tab, measured for sideways pan ---
        for (const tab of ['submissions', 'events', 'warnings', 'accounts', 'activity']) {
            await page.evaluate((t) => switchTab(t), tab);
            await page.waitForTimeout(250);
            const w = await pansSideways(page);
            check(`the ${tab} tab does not pan sideways`, w.doc <= w.view + 1 && w.body <= w.view + 1, w);
        }

        // --- account rows ---
        await page.evaluate(() => switchTab('accounts'));
        await page.waitForTimeout(300);
        const rows = await rowMetrics(page);
        check('every account is rendered', rows.length === ACCOUNTS.length, rows.length);
        const view = await page.evaluate(() => document.documentElement.clientWidth);
        check('no row pushes its buttons off the screen',
            rows.every((r) => r.actionsRight <= view + 1), rows.map((r) => r.actionsRight));
        check('no account name is cut to make room for them',
            rows.every((r) => !r.clipped), rows.filter((r) => r.clipped).map((r) => r.name));
        check('and each name still gets a readable share of the row',
            rows.every((r) => r.nameWidth >= 140), rows.map((r) => [r.name, r.nameWidth]));

        // --- the editor, which is where ownership actually moves ---
        await page.evaluate(() => toggleAcctEditor('s1'));
        await page.waitForTimeout(200);
        const editor = await page.evaluate(() => {
            const has = (sel) => !!document.querySelector(sel);
            const w = document.documentElement.clientWidth;
            const fields = [...document.querySelectorAll('#acctList [data-ac-name], #acctList [data-ac-user], #acctList [data-ac-role], #acctList [data-ac-pass]')];
            return {
                name: has('[data-ac-name="s1"]'),
                user: has('[data-ac-user="s1"]'),
                role: has('[data-ac-role="s1"]'),
                pass: has('[data-ac-pass="s1"]'),
                promote: [...document.querySelectorAll('#acctList button')].some((b) => /make owner/i.test(b.textContent)),
                fieldsInside: fields.every((f) => f.getBoundingClientRect().right <= w + 1),
                doc: document.documentElement.scrollWidth, view: w,
            };
        });
        check('a staff row opens an editor for their details',
            editor.name && editor.user && editor.role && editor.pass, editor);
        check('…offering to hand the VA to them', editor.promote, editor);
        check('…with every field inside the screen', editor.fieldsInside, editor);
        check('…and still no sideways pan', editor.doc <= editor.view + 1, editor);

        // --- the owner row does NOT offer to promote itself ---
        await page.evaluate(() => { toggleAcctEditor('s1'); toggleAcctEditor('o1'); });
        await page.waitForTimeout(200);
        const ownerRow = await page.evaluate(() => ({
            promote: [...document.querySelectorAll('#acctList button')].some((b) => /make owner/i.test(b.textContent)),
            role: document.querySelector('[data-ac-role="o1"]').value,
        }));
        check('the sitting owner is not offered ownership again', !ownerRow.promote, ownerRow);
        check('…and their role reads owner', ownerRow.role === 'owner', ownerRow);
        await page.evaluate(() => toggleAcctEditor('o1'));

        // --- search, which is the other thing the tab had no way to do ---
        const found = await page.evaluate(() => {
            document.getElementById('aq').value = 'kim';
            renderAccounts();
            return {
                rows: document.querySelectorAll('#acctList > div').length,
                text: document.getElementById('acctList').textContent,
                count: document.getElementById('acctCount').textContent,
            };
        });
        check('searching narrows to the one person', found.rows === 1 && /Kim Arda-Whitfield/.test(found.text), found);
        check('…and says how many of how many', /1 of 4/.test(found.count), found.count);

        const byVa = await page.evaluate((va2) => {
            document.getElementById('aq').value = '';
            document.getElementById('aVa').value = va2;
            renderAccounts();
            return document.getElementById('acctList').textContent;
        }, VA2);
        check('filtering by VA keeps only that VA', /Jules Pike/.test(byVa) && !/Robin Vale/.test(byVa));

        const byState = await page.evaluate(() => {
            document.getElementById('aVa').value = '';
            document.getElementById('aState').value = 'disabled';
            renderAccounts();
            return document.getElementById('acctList').textContent;
        });
        check('filtering by state finds the disabled account', /Kim Arda-Whitfield/.test(byState) && !/Robin Vale/.test(byState));

        const none = await page.evaluate(() => {
            document.getElementById('aq').value = 'nobody-by-that-name';
            renderAccounts();
            return document.getElementById('acctList').textContent;
        });
        check('…and says so plainly when nothing matches', /No account matches/.test(none), none.slice(0, 60));

        await page.close();
    }

    /* ---------------------------------------------------------- a desktop */
    {
        const { page } = await open(browser, 1280);
        await page.evaluate(() => switchTab('accounts'));
        await page.waitForTimeout(300);
        const wide = await page.evaluate(() => [...document.querySelectorAll('#acctList > div')].map((row) => {
            const head = row.firstElementChild;
            return { lines: Math.round(head.getBoundingClientRect().height), top: Math.round(head.firstElementChild.getBoundingClientRect().top) === Math.round(head.lastElementChild.getBoundingClientRect().top) };
        }));
        // Two text lines and their padding; a wrapped row is markedly taller.
        check('a row is still one line on a wide screen', wide.every((w) => w.lines < 70), wide);
        const w = await pansSideways(page);
        check('and the desktop view does not pan either', w.doc <= w.view + 1, w);
        await page.close();
    }

    await browser.close();
    server.close();

    console.log(`${pass} passed, ${fails.length} failed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
