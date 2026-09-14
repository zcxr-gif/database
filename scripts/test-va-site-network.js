'use strict';
/*
 * The network page, the staff cards and the footer — checked in a real browser,
 * against a real crew-feed.js reading a fake crew centre.
 *
 * WHY A BROWSER. Every one of these sections is markup the SERVER writes and
 * the FEED fills in: a template with a {{field}} the feed does not send, or a
 * feed sending a field no template reads, is a section that renders perfectly
 * in isolation and is empty on a real site. The only place the two halves meet
 * is a page, so the assertions below are taken from one.
 *
 * The crew centre is stubbed at the network layer rather than by loading a
 * modified crew-feed.js: what runs here is the same file the platform serves,
 * so a change to either side that breaks the contract fails this suite.
 *
 *   npm i --no-save playwright-core
 *   CHROMIUM=/path/to/chrome node scripts/test-va-site-network.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (err) {
    console.log('playwright-core is not installed — skipping the browser checks.');
    console.log('  npm i --no-save playwright-core');
    process.exit(0);
}

function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    for (const root of ['/opt/pw-browsers']) {
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
const builder = require('../vaSiteBuilder.js');

const VA = { slug: 'demo', name: 'Meridian Virtual Airways', callsign: 'MERIDIAN' };
const PHONE = { width: 390, height: 780 };
const DESK = { width: 1280, height: 900 };

/* crew-feed.js is the tracker's file, not this repo's. It is read from a sibling
 * checkout when there is one; without it the feed half of these checks cannot
 * run and the suite says so rather than passing vacuously. */
const FEED = [
    path.join(__dirname, '..', '..', 'tracker', 'crew-feed.js'),
    path.join(__dirname, '..', '..', 'inflight-tracker', 'crew-feed.js'),
].find(p => fs.existsSync(p));

let failures = 0;
function ok(name, pass, detail) {
    if (pass) { console.log('  PASS  ' + name); return; }
    failures++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

/* ---------------------------------------------------------------------------
 * THE FAKE CREW CENTRE.
 *
 * Small on purpose, and awkward on purpose: a sector over the antimeridian
 * (which the map has to cut rather than draw back across the world), a
 * codeshare, a staff member with no Community handle, and a role message on
 * the first role only. Each of those is a branch in the code under test.
 * ------------------------------------------------------------------------ */
const AIRPORTS = {
    EGLL: [51.4775, -0.4614], KJFK: [40.6398, -73.7789], OMDB: [25.2528, 55.3644],
    RJTT: [35.5523, 139.7800], KLAX: [33.9425, -118.4081], YSSY: [-33.9461, 151.1772],
    VIDP: [28.5665, 77.1031], WSSS: [1.3592, 103.9894],
};
const SECTORS = [
    ['EGLL', 'KJFK', 'MR100', 'Boeing 777-300ER', 3008],
    ['EGLL', 'OMDB', 'MR210', 'Boeing 787-9', 2985],
    ['EGLL', 'VIDP', 'MR232', 'Boeing 787-9', 3676],
    ['KJFK', 'EGLL', 'MR101', 'Boeing 777-300ER', 3008],
    ['KLAX', 'YSSY', 'MR880', 'Airbus A350-900', 6508],
    ['KLAX', 'RJTT', 'MR820', 'Airbus A350-900', 4737],
    ['OMDB', 'WSSS', 'MR440', 'Airbus A330-300', 3199],
    ['RJTT', 'KLAX', 'MR821', 'Airbus A350-900', 4737],
    ['VIDP', 'WSSS', 'MR470', 'Airbus A320', 1655],
    ['WSSS', 'YSSY', 'MR610', 'Boeing 787-9', 3355],
    ['YSSY', 'KLAX', 'MR881', 'Airbus A350-900', 6508],
    ['OMDB', 'EGLL', 'MR211', 'Boeing 787-9', 2985],
    ['KJFK', 'KLAX', 'MR330', 'Airbus A321', 2144],
    ['EGLL', 'RJTT', 'MR700', 'Boeing 777-300ER', 5218],
];

const routesBody = SECTORS.map(([o, d, f, ac, nm], i) => ({
    id: String(i + 1), origin: o, destination: d, flightNumber: f, aircraft: ac,
    distanceNm: nm, active: true,
    kind: i === 4 ? 'codeshare' : 'own',
    partnerName: i === 4 ? 'Southern Cross Virtual' : '',
}));

const STUB = {
    '/api/va-ads/by-slug/demo': {
        slug: 'demo', code: 'MERIDIAN', name: VA.name,
        tagline: 'Long haul, properly flown.',
        country: 'GB',
        logo: 'https://cdn.example.test/logo.png',
        banner: '', website: '', accent: '#14375e',
        ranks: [
            { name: 'Cadet', minHours: 0, color: '#64748b' },
            { name: 'First Officer', minHours: 100, color: '#4f46e5' },
            { name: 'Captain', minHours: 300, color: '#d97706' },
        ],
        roles: [
            { name: 'Chief Executive Officer', color: '#b45309', staff: true, message: 'We started with four pilots and one route. Come and fly the fifteenth.' },
            { name: 'Chief Operating Officer', color: '#0f766e', staff: true, message: '' },
            { name: 'Head of Events', color: '#db2777', staff: true, message: '' },
        ],
        fleet: [
            { type: 'Boeing 787-9', name: 'Meridian', image: 'https://cdn.example.test/789.png' },
            { type: 'Airbus A350-900', name: 'Meridian', image: '' },
        ],
        join: { mode: 'application', minGrade: 3, callsignPrefix: 'MR', discordInvite: 'https://discord.gg/meridian' },
        social: { handle: '', posts: [] },
        supabase: { url: '', anonKey: '', connected: false },
    },
    '/api/crew/demo/routes': { routes: routesBody },
    '/api/crew/demo/route-map': {
        airports: Object.keys(AIRPORTS).map(icao => ({
            icao, lat: AIRPORTS[icao][0], lon: AIRPORTS[icao][1],
            dep: 1, arr: 1, routes: SECTORS.filter(s => s[0] === icao || s[1] === icao).length,
        })),
        routes: routesBody.map(r => ({
            ...r, mapped: true,
            o: AIRPORTS[r.origin], d: AIRPORTS[r.destination],
        })),
        stats: { unmapped: 2 },
    },
    '/api/crew/demo/staff': {
        staff: [
            {
                name: 'Ravi Bhatia', callsign: 'MR001', role: 'Chief Executive Officer',
                roleColor: '#b45309', rank: 'Captain', rankColor: '#d97706', hours: 812,
                ifc: 'ravibhatia', ifcUrl: 'https://community.infiniteflight.com/u/ravibhatia/summary',
                message: 'We started with four pilots and one route. Come and fly the fifteenth.',
                lead: true, status: 'active',
            },
            {
                name: 'Aisha Khan', callsign: 'MR002', role: 'Chief Operating Officer',
                roleColor: '#0f766e', rank: 'Captain', rankColor: '#d97706', hours: 604,
                ifc: 'aishak', ifcUrl: 'https://community.infiniteflight.com/u/aishak/summary',
                message: '', lead: false, status: 'active',
            },
            {
                // No Community account linked: the handle and the link are both
                // empty, and the card must still be a card.
                name: 'Tom Reyes', callsign: 'MR014', role: 'Head of Events',
                roleColor: '#db2777', rank: 'First Officer', rankColor: '#4f46e5', hours: 180,
                ifc: '', ifcUrl: '', message: '', lead: false, status: 'active',
            },
        ],
    },
    '/api/crew/demo/stats': { pilots: 62, hours: 9400, routes: SECTORS.length, destinations: 8 },
    /* The roster, as the crew centre serves it. Awkward on purpose: somebody on
     * leave (who stays, and is said to be), somebody inactive (who does not
     * appear at all), and a pilot at zero hours whose hours cell must be empty
     * rather than "0 h". */
    '/api/crew/demo/roster': {
        roster: [
            { id: '1', name: 'Ravi Bhatia', callsign: 'MR001', hours: 812, role: 'Chief Executive Officer', status: 'active', rank: { name: 'Captain', color: '#d97706' } },
            { id: '2', name: 'Aisha Khan', callsign: 'MR002', hours: 604, role: 'Chief Operating Officer', status: 'active', rank: { name: 'Captain', color: '#d97706' } },
            { id: '3', name: 'Tom Reyes', callsign: 'MR014', hours: 180, role: 'Head of Events', status: 'active', rank: { name: 'First Officer', color: '#4f46e5' } },
            { id: '4', name: 'Lena Ortiz', callsign: 'MR031', hours: 96, role: '', status: 'loa', rank: { name: 'First Officer', color: '#4f46e5' } },
            { id: '5', name: 'Sam Park', callsign: 'MR040', hours: 0, role: '', status: 'active', rank: { name: 'Cadet', color: '#64748b' } },
            { id: '6', name: 'Gone Away', callsign: 'MR099', hours: 300, role: '', status: 'inactive', rank: { name: 'Captain', color: '#d97706' } },
        ],
    },
};

function serve(files) {
    const byPath = new Map(files.map(f => ['/' + f.path, f]));
    if (FEED) byPath.set('/crew-feed.js', { content: fs.readFileSync(FEED, 'utf8') });
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

/* Everything off-origin is answered here: the stubbed crew centre as JSON, and
 * every other address (fonts, the logo, an aircraft picture) aborted, so no
 * measurement below is waiting on a network this machine may not have. */
async function wire(page, stub) {
    const answers = stub || STUB;
    await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('http://127.0.0.1:')) return route.continue();
        const hit = Object.keys(answers).find(p => url.includes(p));
        if (hit) {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' },
                body: JSON.stringify(answers[hit]),
            });
        }
        return route.abort();
    });
}

async function run() {
    const exe = findChromium();
    if (!exe) {
        console.log('no Chromium found — skipping. Set CHROMIUM=/path/to/chrome to run these.');
        process.exit(0);
    }
    if (!FEED) {
        console.log('crew-feed.js not found beside this checkout — skipping.');
        console.log('  expected ../tracker/crew-feed.js');
        process.exit(0);
    }
    const browser = await chromium.launch({ executablePath: exe });

    // The feed is served from this origin so the stub above answers its calls
    // and no measurement waits on inflight.info.
    const files = templates.renderTemplate('flightline', VA, { feedSrc: '/crew-feed.js' });
    const server = await serve(files);
    const base = 'http://127.0.0.1:' + server.address().port + '/';

    /* ======================================================================
     * 1. THE ROUTE TABLE
     * ==================================================================== */
    console.log('\nThe route table');
    {
        const page = await browser.newPage({ viewport: DESK });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await wire(page);
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('[data-routes-body] tr').length > 1, null, { timeout: 5000 }).catch(() => {});

        const rows = await page.locator('[data-routes-body] tr').count();
        ok('a page of sectors is drawn', rows === 12, rows + ' rows drawn, expected a page of 12');

        const count = (await page.locator('[data-routes-count]').innerText()).trim();
        ok('the total is said', count === SECTORS.length + ' routes', 'said: "' + count + '"');

        const at = (await page.locator('[data-routes-at]').innerText()).trim();
        ok('the pager says where you are', at === 'Page 1 of 2', 'said: "' + at + '"');
        ok('the pager is offered', await page.locator('[data-routes-pager]').isVisible());
        ok('there is no previous page from the first', await page.locator('[data-routes-prev]').isDisabled());

        await page.locator('[data-routes-next]').click();
        await page.waitForTimeout(150);
        ok('the second page holds the rest',
            (await page.locator('[data-routes-body] tr').count()) === SECTORS.length - 12);
        ok('and there is no next page from the last', await page.locator('[data-routes-next]').isDisabled());

        // The search: enabled by site.js, and filtering what is already held.
        const find = page.locator('[data-routes-find]');
        ok('the search box is enabled once the script has run', await find.isEnabled());
        await find.fill('kjfk');
        await page.waitForTimeout(300);
        const hits = await page.locator('[data-routes-body] tr').count();
        const expect = SECTORS.filter(s => s[0] === 'KJFK' || s[1] === 'KJFK').length;
        ok('searching an airport narrows the table', hits === expect, hits + ' rows, expected ' + expect);
        const narrowed = (await page.locator('[data-routes-count]').innerText()).trim();
        ok('and says how much of the network is showing',
            narrowed === expect + ' of ' + SECTORS.length + ' routes', 'said: "' + narrowed + '"');

        await find.fill('boeing 787');
        await page.waitForTimeout(300);
        ok('searching an aircraft works too',
            (await page.locator('[data-routes-body] tr').count())
                === SECTORS.filter(s => /Boeing 787/.test(s[3])).length);

        await find.fill('zzzz');
        await page.waitForTimeout(300);
        ok('nothing matching says so rather than emptying the table',
            (await page.locator('.routes__none').count()) === 1);

        await find.fill('');
        await page.waitForTimeout(300);
        const share = await page.locator('.routes__share').first().innerText().catch(() => '');
        ok('a codeshare is marked as somebody else’s metal',
            share.trim() === 'Southern Cross Virtual', 'said: "' + share + '"');

        ok('nothing threw', errors.length === 0, errors.join('\n        '));
        await page.close();
    }

    /* ======================================================================
     * 2. THE ROUTE MAP
     * ==================================================================== */
    console.log('\nThe route map');
    {
        const page = await browser.newPage({ viewport: DESK });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await wire(page);
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.netmap__arc').length > 0, null, { timeout: 5000 }).catch(() => {});

        ok('the coastlines are drawn', (await page.locator('.netmap__land').count()) === 1);
        const arcs = await page.locator('.netmap__arc').count();
        // One path per sector, plus one extra for each sector cut at the
        // antimeridian — so never fewer than the sectors themselves.
        ok('every sector is drawn', arcs >= SECTORS.length, arcs + ' paths for ' + SECTORS.length + ' sectors');

        const dots = await page.locator('.netmap__dot').count();
        ok('one dot per airport, not one per sector',
            dots === Object.keys(AIRPORTS).length, dots + ' dots for ' + Object.keys(AIRPORTS).length + ' airports');

        const labelled = await page.locator('.netmap__label').count();
        ok('the airports are named', labelled > 0, 'no labels placed');

        /* This airline flies London to Sydney by way of Los Angeles, so its
           network really is most of the width of the world and a crop that is
           not would be cutting sectors off. What the crop must still lose is
           the empty top and bottom — the polar caps and Antarctica, which is
           where a full world map spends a fifth of its height. */
        const viewBox = await page.locator('.netmap__svg').getAttribute('viewBox');
        const vb = String(viewBox || '').split(' ').map(Number);
        ok('the map is cropped to what is drawn rather than to the whole world',
            vb.length === 4 && vb[3] > 0 && vb[3] < 1014 * 0.9,
            'viewBox: ' + viewBox);

        const note = (await page.locator('[data-crew-map-note]').innerText()).trim();
        ok('what is on the map is said under it', /^14 sectors/.test(note), 'said: "' + note + '"');
        ok('and so is what could not be placed', /2 we have no coordinates for/.test(note),
            'said: "' + note + '"');

        // The whole point of cutting an arc at the antimeridian: no single
        // drawn path may span the width of the world.
        const widest = await page.evaluate(() => {
            let worst = 0;
            document.querySelectorAll('.netmap__arc').forEach((p) => {
                const b = p.getBBox();
                if (b.width > worst) worst = b.width;
            });
            return worst;
        });
        ok('no arc runs back across the whole map', widest < 2000 * 0.75,
            'the widest drawn path is ' + Math.round(widest) + ' map units');

        ok('nothing threw', errors.length === 0, errors.join('\n        '));
        await page.close();
    }

    /* ----------------------------------------------------------------------
     * ...AND THE SAME MAP FOR AN AIRLINE THAT FLIES ONE CORNER OF IT.
     *
     * The crop is the difference between a regional airline's map and a
     * picture of the Pacific with four dots in one corner of it. Asserted on
     * its own network, because a global one cannot show the difference.
     * -------------------------------------------------------------------- */
    {
        const REGIONAL = ['EGLL', 'OMDB', 'VIDP'];
        const legs = routesBody.filter(r => REGIONAL.includes(r.origin) && REGIONAL.includes(r.destination));
        const stub = Object.assign({}, STUB, {
            '/api/crew/demo/route-map': {
                airports: REGIONAL.map(icao => ({ icao, lat: AIRPORTS[icao][0], lon: AIRPORTS[icao][1], dep: 1, arr: 1, routes: 2 })),
                routes: legs.map(r => ({ ...r, mapped: true, o: AIRPORTS[r.origin], d: AIRPORTS[r.destination] })),
                stats: { unmapped: 0 },
            },
        });
        const page = await browser.newPage({ viewport: DESK });
        await wire(page, stub);
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.netmap__arc').length > 0, null, { timeout: 5000 }).catch(() => {});
        const vb = String(await page.locator('.netmap__svg').getAttribute('viewBox') || '').split(' ').map(Number);
        ok('a regional network is cropped to its region',
            vb.length === 4 && vb[2] < 2000 * 0.45 && vb[3] < 1014 * 0.45,
            'viewBox: ' + vb.join(' '));
        await page.close();
    }

    /* ======================================================================
     * 3. WHO RUNS IT
     * ==================================================================== */
    console.log('\nThe staff cards');
    {
        const page = await browser.newPage({ viewport: DESK });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await wire(page);
        await page.goto(base + 'join.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.person').length > 1, null, { timeout: 5000 }).catch(() => {});

        ok('one card per staff member', (await page.locator('.person').count()) === 3);
        ok('the name is on it',
            (await page.locator('.person').first().locator('.person__name').innerText()).trim() === 'Ravi Bhatia');
        ok('and the role', (await page.locator('.person__role').first().innerText()).trim() === 'Chief Executive Officer');
        ok('and the rank they fly at', (await page.locator('.person__rank').first().innerText()).trim() === 'Captain');

        const href = await page.locator('.person__ifc').first().getAttribute('href');
        ok('the Community handle links to their profile',
            href === 'https://community.infiniteflight.com/u/ravibhatia/summary', 'href: ' + href);
        ok('and reads as a handle',
            (await page.locator('.person__ifc').first().innerText()).trim() === '@ravibhatia');

        ok('the chief executive is featured',
            (await page.locator('.person.is-lead').count()) === 1);
        const word = (await page.locator('.person.is-lead .person__word').innerText()).trim();
        ok('and their word is on the page', /four pilots and one route/.test(word), 'said: "' + word + '"');

        /* A staff member with no Community account must not be left with an
         * empty link, and a role with no message must not leave an empty line
         * holding the card open. */
        const third = page.locator('.person').nth(2);
        ok('a staff member with no Community account still gets a card',
            (await third.locator('.person__name').innerText()).trim() === 'Tom Reyes');
        ok('and no dead link where their handle would be',
            (await third.locator('.person__ifc').count()) === 0);
        const hasEmptyWord = await page.evaluate(() => {
            const els = [...document.querySelectorAll('.person__word, .person__rank, .person__role')];
            return els.some(el => !el.textContent.trim() && el.getBoundingClientRect().height > 0);
        });
        ok('nothing empty is taking up room on a card', hasEmptyWord === false);

        ok('nothing threw', errors.length === 0, errors.join('\n        '));
        await page.close();
    }

    /* ======================================================================
     * 3b. THE CREW
     *
     * The same table machinery as the routes, pointed at the roster — so what
     * is worth asserting here is not the paging (already proven) but what the
     * roster is allowed to say: who is on it, who is not, and what an empty
     * figure looks like.
     * ==================================================================== */
    console.log('\nThe crew table');
    {
        const page = await browser.newPage({ viewport: DESK });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await wire(page);
        await page.goto(base + 'join.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('[data-crew-table="roster"] [data-routes-body] tr').length > 1, null, { timeout: 5000 }).catch(() => {});

        const host = page.locator('[data-crew-table="roster"]');
        const rows = await host.locator('[data-routes-body] tr').count();
        ok('the pilots are listed', rows === 5, rows + ' rows, expected the 5 who are still flying');

        const count = (await host.locator('[data-routes-count]').innerText()).trim();
        ok('and counted as pilots, not as routes', count === '5 pilots', 'said: "' + count + '"');

        const first = (await host.locator('[data-routes-body] tr').first().innerText()).replace(/\s+/g, ' ').trim();
        ok('most hours first', /^Ravi Bhatia/.test(first), 'first row: ' + first);
        ok('with their rank', /Captain/.test(first), 'first row: ' + first);
        ok('and their hours', /812 h/.test(first), 'first row: ' + first);

        const all = (await host.locator('[data-routes-body]').innerText()).replace(/\s+/g, ' ');
        ok('a pilot who has left is not on the list', !/Gone Away/.test(all), all);
        ok('a pilot on leave is, and is said to be', /Lena Ortiz On leave/.test(all), all);
        // Zero hours is a true figure and an unhelpful one to print: crew-feed
        // leaves it empty rather than writing "0 h" against somebody's name.
        // Read off that pilot's own row — "180 h" ends in the same three
        // characters, so a search of the whole table would pass either way.
        const newcomer = await page.evaluate(() => {
            const tr = [...document.querySelectorAll('[data-crew-table="roster"] [data-routes-body] tr')]
                .find(r => /Sam Park/.test(r.textContent));
            return tr ? [...tr.cells].map(c => c.textContent.trim()) : null;
        });
        ok('a pilot with no hours yet has an empty cell, not a nought',
            !!newcomer && newcomer[3] === '', newcomer ? JSON.stringify(newcomer) : 'that pilot is not on the list');

        await host.locator('[data-routes-find]').fill('captain');
        await page.waitForTimeout(300);
        ok('searching a rank narrows the crew',
            (await host.locator('[data-routes-body] tr').count()) === 2);

        ok('nothing threw', errors.length === 0, errors.join('\n        '));
        await page.close();
    }

    /* ======================================================================
     * 4. THE FOOTER
     * ==================================================================== */
    console.log('\nThe footer');
    {
        const page = await browser.newPage({ viewport: DESK });
        await wire(page);
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => {
            const el = document.querySelector('.foot__origin');
            return !el || !el.hasAttribute('hidden');
        }, null, { timeout: 5000 }).catch(() => {});

        const origin = (await page.locator('.foot__origin').innerText()).trim();
        ok('the country of origin is in the footer', /United Kingdom/.test(origin), 'said: "' + origin + '"');
        ok('with its flag', /🇬🇧/.test(origin), 'said: "' + origin + '"');

        ok('the links are in columns', (await page.locator('.foot__col').count()) === 2);
        ok('the airline’s own pages are listed',
            (await page.locator('.foot__col').first().locator('a').count()) === 4);
        ok('the Discord invite is offered once the feed has one',
            (await page.locator('.foot__col a[data-crew-brand="discord"]').getAttribute('href'))
                === 'https://discord.gg/meridian');

        const year = (await page.locator('.foot__copy [data-year]').innerText()).trim();
        ok('the year is the year now', year === String(new Date().getFullYear()), 'said: "' + year + '"');

        // The tagline replaces the sentence the template shipped with.
        const blurb = (await page.locator('.foot__blurb').innerText()).trim();
        ok('the airline’s own line is used where it has one',
            blurb === 'Long haul, properly flown.', 'said: "' + blurb + '"');

        await page.close();
    }

    /* ======================================================================
     * 5. THE AEROPLANE FITS ITS CARD
     *
     * The complaint this fixes: a livery render is three or four times as wide
     * as it is tall, and a 16:10 well filled with one cuts the nose and the
     * tail off it. The assertion is a measurement — the drawn picture is INSIDE
     * its well on both axes — rather than a string match on object-fit, because
     * a stylesheet can say contain and still be overridden by a design.
     * ==================================================================== */
    console.log('\nThe fleet cards');
    {
        const page = await browser.newPage({ viewport: DESK });
        await wire(page);
        // A wide aeroplane, drawn rather than fetched: the same shape a livery
        // render is, with nothing to download.
        await page.route('**/cdn.example.test/789.png', (route) => route.fulfill({
            status: 200,
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300">'
                + '<rect width="1200" height="300" fill="#14375e"/></svg>',
        }));
        await page.goto(base + 'fleet.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.card__media img').length > 1, null, { timeout: 5000 }).catch(() => {});

        const fit = await page.evaluate(() => {
            const art = document.querySelector('.card__media img:not(.card__media-bg)');
            if (!art) return null;
            const wellEl = art.closest('.card__media');
            const well = wellEl.getBoundingClientRect();
            const box = art.getBoundingClientRect();
            const bg = wellEl.querySelector('.card__media-bg');
            const cs = getComputedStyle(art);
            return {
                objectFit: cs.objectFit, wellW: well.width, wellH: well.height,
                natW: art.naturalWidth, natH: art.naturalHeight,
                // Where the picture actually LANDED, and how the ground behind
                // it is laid out.
                art: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
                well: { top: well.top, bottom: well.bottom, left: well.left, right: well.right },
                bg: bg ? { position: getComputedStyle(bg).position, objectFit: getComputedStyle(bg).objectFit } : null,
            };
        });
        ok('the picture is contained, not cropped', fit && fit.objectFit === 'contain',
            fit ? 'object-fit: ' + fit.objectFit : 'no fleet picture drawn');
        ok('a wide livery keeps both its ends',
            !!fit && fit.natW / fit.natH > 2 && fit.wellW / fit.wellH < 2,
            fit ? 'picture ' + fit.natW + 'x' + fit.natH + ' in a well ' + Math.round(fit.wellW) + 'x' + Math.round(fit.wellH) : '');
        /* THE MEASUREMENT THE COMMENT ABOVE HAS ALWAYS PROMISED.
         *
         * object-fit alone was never enough, and the gap let a real bug through:
         * `.card__media img` out-specified `.card__media-bg`, so the blurred
         * ground never got its `position: absolute`, stayed in the flow, and
         * pushed the aeroplane a full well-height down and out of an
         * `overflow: hidden` box. Every assertion above still passed — the
         * picture was contained and the ratios were right — while the card
         * showed a blurred ghost and no aircraft at all.
         *
         * So: the drawn picture is inside its well, on both axes. */
        ok('…and the picture is actually in the well, not pushed out of it',
            !!fit && fit.art.top >= fit.well.top - 1 && fit.art.bottom <= fit.well.bottom + 1
                && fit.art.left >= fit.well.left - 1 && fit.art.right <= fit.well.right + 1,
            fit ? 'picture ' + JSON.stringify(fit.art) + ' in well ' + JSON.stringify(fit.well) : '');
        ok('the well has a ground made of the picture itself',
            (await page.locator('.card__media-bg').count()) > 0);
        ok('…and that ground is behind the picture rather than beside it',
            !!fit && !!fit.bg && fit.bg.position === 'absolute' && fit.bg.objectFit === 'cover',
            fit && fit.bg ? JSON.stringify(fit.bg) : 'no ground');

        await page.close();
    }

    /* ======================================================================
     * 6. THE NETWORK PAGE ON A PHONE
     *
     * A table of five columns and a map wider than the world are the two things
     * most likely to widen a page. Neither may.
     * ==================================================================== */
    console.log('\nThe network page on a phone');
    {
        const page = await browser.newPage({ viewport: PHONE });
        await wire(page);
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.netmap__arc').length > 0, null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);

        const over = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
        }));
        ok('the page cannot be scrolled sideways', over.scroll <= over.client + 1,
            'scrollWidth ' + over.scroll + ' vs ' + over.client);

        // Each of them scrolls inside its own box instead.
        ok('the table scrolls within itself',
            await page.evaluate(() => {
                const w = document.querySelector('.routes__wrap');
                return !!w && getComputedStyle(w).overflowX === 'auto';
            }));
        ok('and so does the map',
            await page.evaluate(() => {
                const w = document.querySelector('.netmap__scroll');
                return !!w && getComputedStyle(w).overflowX === 'auto';
            }));
        await page.close();
    }

    /* ======================================================================
     * THE ROUTE MAP ZOOMS
     *
     * The map crops itself to the network, which is what stops an airline that
     * flies six sectors in Norway getting a picture of the Atlantic. It is also
     * why it reads SMALL for one that flies everywhere: the world fitted into a
     * band the height of a paragraph is every base as a two-pixel dot.
     *
     * So the fitted crop is the floor. What is under test is that the picture
     * grows inside its box — and that the SECTION does not, because a map that
     * shoves the rest of the page down when you press + is worse than a small
     * one.
     * ==================================================================== */
    console.log('\nThe route map zooms');
    {
        const page = await browser.newPage({ viewport: DESK });
        await wire(page);
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForSelector('.netmap__zoom button', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(250);

        const read = () => page.evaluate(() => {
            const host = document.querySelector('.netmap');
            if (!host) return null;
            const sc = host.querySelector('.netmap__scroll');
            const svg = host.querySelector('.netmap__svg');
            return {
                svgH: svg.getBoundingClientRect().height,
                sectionH: host.closest('section').getBoundingClientRect().height,
                scH: sc.clientHeight, scrollH: sc.scrollHeight,
                labels: host.querySelectorAll('.netmap__label').length,
                outDead: host.querySelector('[data-map-zoom="out"]').disabled,
            };
        });

        const fitted = await read();
        ok('the map offers zoom controls', (await page.locator('.netmap__zoom button').count()) === 3);
        ok('…which say so when there is nothing left to do', !!fitted && fitted.outDead);

        await page.click('[data-map-zoom="in"]');
        await page.waitForTimeout(350);
        const zoomed = await read();
        ok('pressing + makes the drawn map bigger',
            !!zoomed && zoomed.svgH > fitted.svgH * 1.3, JSON.stringify({ was: fitted.svgH, now: zoomed.svgH }));
        ok('…inside its own box, so the page below does not move',
            !!zoomed && Math.abs(zoomed.sectionH - fitted.sectionH) < 2,
            JSON.stringify({ was: fitted.sectionH, now: zoomed.sectionH }));
        ok('…and the box now scrolls up and down as well as across',
            !!zoomed && zoomed.scrollH > zoomed.scH + 2, JSON.stringify(zoomed));
        /* Zooming REDRAWS rather than magnifying: labels are placed by
           collision, so the airports with no name are the ones that had no room
           for one. More room, more names — which is what zooming into a map is
           for. */
        ok('…and names at least as many airports as before',
            !!zoomed && zoomed.labels >= fitted.labels,
            JSON.stringify({ was: fitted.labels, now: zoomed.labels }));

        await page.click('[data-map-zoom="reset"]');
        await page.waitForTimeout(350);
        const back = await read();
        ok('Fit puts the whole network back',
            !!back && Math.abs(back.svgH - fitted.svgH) < 2, JSON.stringify({ fitted: fitted.svgH, back: back.svgH }));

        // The edge fade is on the scroller, not the map: on the map it took the
        // controls out with the coastline.
        ok('the zoom controls are not faded out by the pan hint',
            await page.evaluate(() => {
                const host = document.querySelector('.netmap');
                const m = getComputedStyle(host).maskImage;
                const b = host.querySelector('[data-map-zoom="reset"]').getBoundingClientRect();
                const r = host.getBoundingClientRect();
                return (m === 'none' || !m) && b.right <= r.right + 1 && b.width > 0;
            }));
        await page.close();
    }

    /* ======================================================================
     * 7. THE SAME SECTIONS, BUILT IN THE BUILDER
     *
     * The builder writes its own markup for every one of these. A block that
     * renders in a template and not in the builder is the whole reason both
     * halves exist in one file per section.
     * ==================================================================== */
    console.log('\nThe builder’s own copy of them');
    {
        const doc = builder.starterDoc('flightline', VA);
        const bfiles = builder.renderSite(doc, { va: VA, templateId: 'flightline', feedSrc: '/crew-feed.js' });
        const bserver = await serve(bfiles);
        const bbase = 'http://127.0.0.1:' + bserver.address().port + '/';
        const page = await browser.newPage({ viewport: DESK });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await wire(page);
        await page.goto(bbase + 'network.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.netmap__arc').length > 0, null, { timeout: 5000 }).catch(() => {});

        ok('the builder draws the same map', (await page.locator('.netmap__arc').count()) >= SECTORS.length);
        ok('and the same table', (await page.locator('[data-routes-body] tr').count()) === 12);
        ok('and serves map.js beside it', bfiles.some(f => f.path === 'map.js'));

        await page.goto(bbase + 'join.html', { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelectorAll('.person').length > 1, null, { timeout: 5000 }).catch(() => {});
        ok('and the same staff cards', (await page.locator('.person').count()) === 3);
        ok('nothing threw', errors.length === 0, errors.join('\n        '));

        await page.close();
        bserver.close();
    }

    /* ======================================================================
     * 8. A QUIET CREW CENTRE
     *
     * Every one of these sections says it only makes sense with real rows in
     * it. A crew centre that answers with nothing must take them off the page
     * rather than leave a heading over an empty rectangle.
     * ==================================================================== */
    console.log('\nA crew centre with nothing in it');
    {
        const page = await browser.newPage({ viewport: DESK });
        await page.route('**/*', (route) => {
            const url = route.request().url();
            if (url.startsWith('http://127.0.0.1:')) return route.continue();
            if (/\/api\//.test(url)) {
                return route.fulfill({
                    status: 200, contentType: 'application/json',
                    headers: { 'access-control-allow-origin': '*' },
                    body: JSON.stringify({ routes: [], staff: [], airports: [] }),
                });
            }
            return route.abort();
        });
        await page.goto(base + 'network.html', { waitUntil: 'load' });
        await page.waitForTimeout(600);
        ok('the map section goes rather than standing empty',
            (await page.locator('.netmap').count()) === 0);
        ok('and so does the table',
            (await page.locator('.routes').count()) === 0);
        await page.close();
    }

    await browser.close();
    server.close();

    console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
