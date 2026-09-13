'use strict';
/*
 * The menu and the motion, checked in a real browser.
 *
 * The bug this exists for could not be caught by reading the CSS: the panel was
 * correct in every declaration and wrong in its containing block, which only a
 * layout engine can tell you. So every assertion here is a MEASUREMENT taken
 * from Chromium rather than a string match on a stylesheet.
 */
const http = require('http');
const path = require('path');
/* playwright-core and a Chromium are DEV-ONLY and deliberately not a
 * dependency of this package: nothing the server does needs a browser. Where
 * they are absent this file says so and exits 0 rather than failing a build
 * over a tool it chose not to require.
 *
 *   npm i --no-save playwright-core
 *   CHROMIUM=/path/to/chrome node scripts/test-va-site-motion.js
 */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (err) {
    console.log('playwright-core is not installed — skipping the browser checks.');
    console.log('  npm i --no-save playwright-core');
    process.exit(0);
}

const fs = require('fs');
function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    const roots = ['/opt/pw-browsers'];
    for (const root of roots) {
        let names = [];
        try { names = fs.readdirSync(root); } catch (err) { continue; }
        for (const name of names) {
            const guess = root + '/' + name + '/chrome-linux/chrome';
            if (fs.existsSync(guess)) return guess;
        }
    }
    return null;
}
const templates = require('../vaSiteTemplates.js');

const VA = { slug: 'demo', name: 'Meridian Virtual Airways', callsign: 'MERIDIAN' };
const PHONE = { width: 390, height: 780 };

let failures = 0;
function ok(name, pass, detail) {
    if (pass) { console.log('  PASS  ' + name); return; }
    failures++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

/* The rendered site, served over http so that relative stylesheet links and the
 * deferred script behave the way they do in production. file:// would pass this
 * suite with a CSP and a module-loading story it does not have. */
function serve(files) {
    const byPath = new Map(files.map(f => ['/' + f.path, f]));
    const type = p => (p.endsWith('.css') ? 'text/css'
        : p.endsWith('.js') ? 'text/javascript'
        : p.endsWith('.md') ? 'text/plain' : 'text/html');
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p.endsWith('/')) p += 'index.html';
        const hit = byPath.get(p);
        if (!hit) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'content-type': type(p) });
        res.end(hit.content);
    });
    return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

async function run() {
    /* Nothing off-origin. theme.css imports a Google font, which cannot resolve
     * in here — and a suite that waits for it is a suite measuring the network
     * rather than the layout. Blocking it also proves the fallback stacks are
     * real: every measurement below is taken with no webfont at all. */
    const blockExternal = async (page) => {
        await page.route('**/*', (route) =>
            route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    };

    const exe = findChromium();
    if (!exe) {
        console.log('no Chromium found — skipping. Set CHROMIUM=/path/to/chrome to run these.');
        process.exit(0);
    }
    const browser = await chromium.launch({ executablePath: exe });

    /* ======================================================================
     * 1. THE MENU, on every design.
     *
     * The fault was in the shared base stylesheet, so it was in all of them —
     * and a fix that only holds for the default design is not a fix. Livery is
     * the one that matters most: it paints the bar in the accent, so it is the
     * design most likely to be broken by moving the bar's paint onto a
     * pseudo-element.
     * ==================================================================== */
    for (const id of Object.keys(templates.TEMPLATES)) {
        console.log('\n' + templates.TEMPLATES[id].name);
        const files = templates.renderTemplate(id, VA);
        const server = await serve(files);
        const base = 'http://127.0.0.1:' + server.address().port + '/';
        const page = await browser.newPage({ viewport: PHONE });
        await blockExternal(page);
        await page.goto(base, { waitUntil: 'load' });

        const burger = page.locator('.bar__burger');
        ok('the burger is offered on a phone', await burger.isVisible());

        await burger.click();
        await page.waitForTimeout(450);

        /* THE REGRESSION ITSELF.
           With backdrop-filter on .bar, the panel's containing block was the
           header rather than the viewport, so this came back as about 56 —
           a menu cut off below its first link. */
        const panel = await page.locator('#siteNav').boundingBox();
        ok('the panel is the height of the screen, not the height of the header',
            panel.height >= PHONE.height - 2,
            'panel height ' + Math.round(panel.height) + 'px, viewport ' + PHONE.height + 'px');

        const clientW = await page.evaluate(() => document.documentElement.clientWidth);
        ok('the panel is against the right edge',
            Math.round(panel.x + panel.width) === clientW,
            'right edge at ' + Math.round(panel.x + panel.width) + ', page is ' + clientW + ' wide');

        /* Every link has to be ON the panel. A panel of the right height whose
           links have been scrolled out from under the header is the same
           complaint with a different cause. */
        const links = await page.locator('#siteNav a').all();
        let offPanel = [];
        for (const a of links) {
            const b = await a.boundingBox();
            if (!b || b.y < panel.y || b.y + b.height > panel.y + panel.height + 1) {
                offPanel.push((await a.innerText()).trim() + '@' + (b ? Math.round(b.y) : 'none'));
            }
        }
        ok('every link in the menu is inside the panel', offPanel.length === 0, offPanel.join(', '));

        /* The first link must clear the header, or it opens underneath the
           airline's own wordmark. This VA's name is deliberately long. */
        const barBox = await page.locator('.bar').boundingBox();
        const firstLink = await page.locator('#siteNav a').first().boundingBox();
        ok('the first link clears the header',
            firstLink.y >= barBox.y + barBox.height,
            'link at ' + Math.round(firstLink.y) + ', header ends at ' + Math.round(barBox.y + barBox.height));

        /* THE OTHER HALF OF THE BUG: the panel is pinned to the right edge and
           so is the button, so the panel used to slide over the only control
           that closes it. What is under that point must still be the button. */
        const bb = await burger.boundingBox();
        const onTop = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return el ? (el.closest('.bar__burger') ? 'burger' : el.className || el.tagName) : 'nothing';
        }, [bb.x + bb.width / 2, bb.y + bb.height / 2]);
        ok('the close button is on top of the panel it opened', onTop === 'burger',
            'the point over the button hits: ' + onTop);

        // And it actually closes when pressed, rather than only looking pressable.
        await burger.click();
        await page.waitForTimeout(450);
        ok('pressing it again shuts the menu',
            (await page.locator('#siteNav').getAttribute('data-open')) === null);
        ok('the page can scroll again',
            (await page.evaluate(() => document.documentElement.hasAttribute('data-nav-open'))) === false);

        await page.close();
        server.close();
    }

    /* ======================================================================
     * 2. THE BREAKPOINT BAND.
     *
     * The stylesheet gave up the panel at 54rem and the script closed it at
     * 54.0625rem. A window resized into the sixteenth of a rem between them
     * kept the scroll lock with no menu on screen — the site simply stopped
     * scrolling. 864px is inside that band.
     * ==================================================================== */
    console.log('\nResizing out of the panel layout');
    {
        const files = templates.renderTemplate('flightline', VA);
        const server = await serve(files);
        const page = await browser.newPage({ viewport: PHONE });
        await blockExternal(page);
        await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
        await page.locator('.bar__burger').click();
        await page.waitForTimeout(300);
        ok('the menu is open to begin with',
            (await page.evaluate(() => document.documentElement.hasAttribute('data-nav-open'))) === true);

        /* 864px is 54rem exactly, and max-width is inclusive — so that is still
           the narrow layout and a menu left open there is correct. The failure
           this guards against is the layout and the script disagreeing about
           where narrow ends, which is what left a locked page with no menu on
           it. Asserted directly: at every width, the panel being laid out as a
           panel and the script believing it is one must be the same answer. */
        for (const width of [820, 864, 865, 900, 1100]) {
            await page.setViewportSize({ width, height: 780 });
            await page.waitForTimeout(300);
            const state = await page.evaluate(() => ({
                cssSaysPanel: getComputedStyle(document.getElementById('siteNav')).position === 'fixed',
                jsSaysPanel: window.matchMedia('(max-width: 54rem)').matches,
                locked: document.documentElement.hasAttribute('data-nav-open'),
            }));
            ok('at ' + width + 'px the layout and the script agree what narrow means',
                state.cssSaysPanel === state.jsSaysPanel, JSON.stringify(state));
            ok('at ' + width + 'px the page is only ever locked behind a real panel',
                !state.locked || state.cssSaysPanel, JSON.stringify(state));
        }
        // And once it is genuinely a desktop, the lock is gone for good.
        ok('widened past the breakpoint, the page scrolls again',
            (await page.evaluate(() => document.documentElement.hasAttribute('data-nav-open'))) === false);
        await page.close();
        server.close();
    }

    /* ======================================================================
     * 3. MOTION.
     * ==================================================================== */
    console.log('\nMotion');
    {
        // Standard: sections arrive, rows arrive in sequence, figures count.
        const files = templates.renderTemplate('flightline', VA, { theme: { motion: 'standard' } });
        const server = await serve(files);
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await blockExternal(page);
        await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });

        ok('the preset reaches the page',
            (await page.evaluate(() => document.documentElement.getAttribute('data-motion'))) === 'standard');

        const below = await page.evaluate(() =>
            document.querySelectorAll('main > section[data-reveal]').length);
        ok('sections below the fold are waiting to arrive', below > 0, 'marked ' + below);

        const above = await page.evaluate(() => {
            const s = document.querySelector('main > section');
            return s.hasAttribute('data-reveal');
        });
        ok('a section already on screen is never hidden', above === false);

        // The queue positions are real numbers in ascending order.
        /* The join page, because that is where the multi-item lists are: the
           four numbered steps and the three ways to get in touch. Most blocks
           on a homepage ship a single fallback row, and one item in a queue
           proves nothing about ordering. */
        await page.goto('http://127.0.0.1:' + server.address().port + '/join.html', { waitUntil: 'load' });
        await page.waitForTimeout(300);

        /* The first list long enough to HAVE a sequence. Most blocks ship a
           single fallback row — that is one item, and one item in a queue tells
           you nothing about ordering. .rows also ships a <template> as its
           first child (the shape the feed stamps out), which is not a row and
           must not be given a place. */
        const queue = await page.evaluate(() => {
            const hosts = document.querySelectorAll(
                'main > section[data-reveal] .rows, main > section[data-reveal] .cards,' +
                'main > section[data-reveal] .tiles, main > section[data-reveal] .steps');
            for (const host of hosts) {
                const items = [...host.querySelectorAll(':scope > li')];
                if (items.length < 2) continue;
                return {
                    count: items.length,
                    index: items.map(li => li.style.getPropertyValue('--i')),
                    templatesQueued: [...host.querySelectorAll(':scope > template')]
                        .filter(t => t.hasAttribute('data-reveal-item')).length,
                };
            }
            return null;
        });
        ok('a list is given its places in the queue, in order',
            queue && queue.index.every((v, i) => v === String(Math.min(i, 12))),
            JSON.stringify(queue));
        ok('the row template is not given a place in the queue',
            queue && queue.templatesQueued === 0, JSON.stringify(queue));

        // Scroll to the bottom and confirm everything actually resolved — an
        // animation that never finishes is a page with holes in it.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2200);
        const stuck = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('main > section[data-reveal]').forEach(s => {
                if (getComputedStyle(s).opacity !== '1') out.push(s.className || 'section');
            });
            document.querySelectorAll('[data-reveal-item]').forEach(i => {
                if (getComputedStyle(i).opacity !== '1') out.push('item');
            });
            return out;
        });
        ok('nothing is left invisible once it has been reached', stuck.length === 0, stuck.join(', '));
        await page.close();
        server.close();
    }

    {
        // Still: nothing is marked, nothing is hidden, and the page is complete
        // before a line of script runs.
        const files = templates.renderTemplate('terminal', VA, { theme: { motion: 'none' } });
        const server = await serve(files);
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await blockExternal(page);
        await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
        ok('Still sets no motion attribute',
            (await page.evaluate(() => document.documentElement.getAttribute('data-motion'))) === null);
        ok('Still hides nothing at all',
            (await page.evaluate(() => document.querySelectorAll('[data-reveal]').length)) === 0);
        const hidden = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('main > section').forEach(s => {
                if (getComputedStyle(s).opacity !== '1') out.push(s.className);
            });
            return out;
        });
        ok('every section is visible on a Still site', hidden.length === 0, hidden.join(', '));
        await page.close();
        server.close();
    }

    {
        /* THE COUNT-UP, and the promise it must not break: it may never leave a
         * number on the page that is not the one it was given. The feed is
         * simulated by writing a value in the way crew-feed.js does. */
        const files = templates.renderTemplate('horizon', VA, { theme: { motion: 'standard' } });
        const server = await serve(files);
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await blockExternal(page);
        await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });

        await page.evaluate(() => {
            const cells = document.querySelectorAll('.figures [data-crew-stat]');
            cells[0].textContent = '1,284';    // grouped
            cells[1].textContent = '96500';    // plain
            if (cells[2]) cells[2].textContent = '—';        // never answered
            if (cells[3]) cells[3].textContent = 'coming soon'; // not a number
        });
        await page.waitForTimeout(2600);

        const after = await page.evaluate(() =>
            [...document.querySelectorAll('.figures [data-crew-stat]')].map(e => e.textContent.trim()));
        ok('a grouped figure lands on its own value, comma and all', after[0] === '1,284', after[0]);
        ok('an ungrouped figure lands on its own value', after[1] === '96500', after[1]);
        ok('a figure the crew centre never sent is left exactly as it was', after[2] === '—', after[2]);
        ok('text that is not a number is never touched', after[3] === 'coming soon', after[3]);
        ok('no figure is left mid-count',
            (await page.evaluate(() => document.querySelectorAll('[data-counting]').length)) === 0);
        await page.close();
        server.close();
    }

    /* ======================================================================
     * 4. THE DESIGNS THAT DRAW OUTSIDE THE TEXT MEASURE render and lay out, on
     * a phone and on a desktop. A design whose page scrolls sideways on a phone
     * is a design nobody can use, and every one of these puts something —
     * a punched ticket edge, a route spine, a floating panel — past the box the
     * words are held in.
     * ==================================================================== */
    console.log('\nThe new designs');
    for (const id of ['boardingpass', 'flightdeck', 'atlas', 'aurora']) {
        const files = templates.renderTemplate(id, VA);
        const server = await serve(files);
        for (const vp of [PHONE, { width: 1280, height: 900 }]) {
            const page = await browser.newPage({ viewport: vp });
            await blockExternal(page);
            const oops = [];
            page.on('pageerror', e => oops.push(e.message));
            await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(600);

            /* Measured by TRYING to scroll sideways rather than by reading
               scrollWidth. The two disagree: the base stylesheet clips the
               document, so a page can report content past its own edge and
               still be immovable. What a visitor experiences is whether it
               moves, so that is what is asked — and the overflow figure comes
               along for the report, because content past the edge is still
               worth knowing about even when it cannot be reached. */
            const scroll = await page.evaluate(() => {
                window.scrollTo(9999, 0);
                const moved = window.scrollX;
                window.scrollTo(0, 0);
                return { moved, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
            ok(id + ' @' + vp.width + ' cannot be scrolled sideways', scroll.moved === 0,
                'moved ' + scroll.moved + 'px');
            ok(id + ' @' + vp.width + ' draws nothing past its own edge', scroll.over <= 1,
                'overflow ' + scroll.over + 'px');
            ok(id + ' @' + vp.width + ' throws nothing', oops.length === 0, oops.join(' | '));
            await page.close();
        }
        server.close();
    }

    /* ======================================================================
     * 5. THE SHOWREEL'S FILM.
     *
     * Everything worth testing here is about what is NOT downloaded. The
     * section is finished without a film — a sky, two contrails and the
     * airline's own aeroplane — so the only way to get this wrong is to fetch
     * a video for somebody who should not have been given one, and that is
     * invisible from the rendered page. So it is measured at the REQUEST: what
     * the browser actually asked the server for.
     *
     * The address is served as a 404 on purpose. A real .mp4 would test a
     * decoder; the four cases below are about the decision to ask for it at
     * all, and the 404 doubles as the dead-address case — the film must stay
     * hidden rather than becoming a black rectangle over the aircraft.
     * ==================================================================== */
    console.log('\nThe showreel');
    {
        // The film's address is same-origin so blockExternal lets it through —
        // and it is a path the little server above does not serve, which is
        // exactly the rotted address a VA ends up with two years on.
        const withFilm = (theme) => templates.renderTemplate('aurora', VA, { theme }).map(f => (
            f.path === 'index.html'
                ? { ...f, content: f.content.replace('data-reel-film data-src=""', 'data-reel-film data-src="film.mp4"') }
                : f
        ));

        const asked = async (files, opts) => {
            const server = await serve(files);
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...opts });
            await blockExternal(page);
            const wanted = [];
            page.on('request', (r) => { if (r.url().endsWith('film.mp4')) wanted.push(r.url()); });
            await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
            await page.waitForTimeout(700);
            const state = await page.evaluate(() => {
                const film = document.querySelector('[data-reel-film]');
                return {
                    film: !!film,
                    hidden: !film || film.hasAttribute('hidden'),
                    holds: document.querySelectorAll('.reel__hold').length,
                    ship: !!document.querySelector('.reel__ship'),
                    sky: !!document.querySelector('.reel__sky'),
                };
            });
            await page.close();
            server.close();
            return { wanted, ...state };
        };

        // A: the design as it ships. No address, so nothing to fetch — and the
        // stage still has every layer that does not depend on the VA.
        const plain = await asked(templates.renderTemplate('aurora', VA), {});
        ok('with no film, nothing is requested', plain.wanted.length === 0, plain.wanted.join(' '));
        ok('with no film, the video stays hidden', plain.hidden);
        ok('with no film, there is no pause button', plain.holds === 0);
        ok('the stage is drawn either way', plain.sky && plain.ship);

        // B: an address, and it rots. Asked for once, and the failure costs the
        // page nothing.
        const dead = await asked(withFilm(), {});
        ok('a film is fetched when there is one', dead.wanted.length === 1, dead.wanted.join(' '));
        ok('an address that 404s leaves the film hidden', dead.hidden);
        ok('and leaves no pause button over the aeroplane', dead.holds === 0);

        // C: the airline chose Still. An ambient loop is the thing that choice
        // is about, so the film is never asked for.
        const still = await asked(withFilm({ motion: 'none' }), {});
        ok('a Still site never fetches the film', still.wanted.length === 0, still.wanted.join(' '));

        // D: the visitor asked their system for less movement. Not the
        // airline's decision to overrule.
        const quiet = await asked(withFilm(), { reducedMotion: 'reduce' });
        ok('reduced motion never fetches the film', quiet.wanted.length === 0, quiet.wanted.join(' '));
    }

    await browser.close();
    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
    process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
