// test-if-beta.js
// Infinite Flight Live is locked in beta for every crew center until
// IF_LIVE_BETA_SLUGS opens it. Driven through a real Express app with the same
// mount path server.js uses, because the thing worth proving is that the gate
// sits in front of EVERY route under it — including ones added later.
//
// Run:  node scripts/test-if-beta.js

const express = require('express');
const http = require('http');
const ifBeta = require('../ifBeta');
const crewSetupGuide = require('../crewSetupGuide');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures++;
};

function appWith(env) {
    const app = express();
    app.use(express.json());
    app.use('/api/crew/:slug/if', ifBeta.middleware(env));
    // Stand-ins for the real routes: reaching one means the gate let it past.
    app.get('/api/crew/:slug/if', (req, res) => res.json({ reached: 'status' }));
    app.get('/api/crew/:slug/if/board', (req, res) => res.json({ reached: 'board' }));
    app.get('/api/crew/:slug/if/airframes', (req, res) => res.json({ reached: 'airframes' }));
    app.post('/api/crew/:slug/if/connect', (req, res) => res.json({ reached: 'connect' }));
    app.post('/api/crew/:slug/if/aircraft/:id/schedules', (req, res) => res.json({ reached: 'schedule' }));
    app.get('/api/crew/if/callback', (req, res) => res.json({ reached: 'callback' }));
    app.post('/api/crew/:slug/verify-if', (req, res) => res.json({ reached: 'verify' }));
    return app;
}

function call(app, method, path) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
                headers: { 'Content-Type': 'application/json' } }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }); });
            });
            req.on('error', (e) => { server.close(); reject(e); });
            req.end(method === 'GET' ? undefined : '{}');
        });
    });
}

(async () => {
    console.log('the switch');
    check('unset is locked', ifBeta.isLocked('ba', {}));
    check('a listed slug is open', ifBeta.isOpen('ba', { IF_LIVE_BETA_SLUGS: 'qtr, BA ' }));
    check('an unlisted slug stays locked', ifBeta.isLocked('ek', { IF_LIVE_BETA_SLUGS: 'qtr,ba' }));
    check('* opens every crew center', ifBeta.isOpen('anything', { IF_LIVE_BETA_SLUGS: '*' }));
    check('an empty slug is never open', ifBeta.isLocked('', { IF_LIVE_BETA_SLUGS: 'ba' }));
    check('state carries the sentence only while locked',
        ifBeta.state('ba', {}).message && !ifBeta.state('ba', { IF_LIVE_BETA_SLUGS: 'ba' }).message);

    console.log('locked');
    const locked = appWith({});
    let r = await call(locked, 'GET', '/api/crew/ba/if');
    check('status answers 423 with the beta code', r.status === 423 && r.body.code === 'if_live_beta' && r.body.beta.locked === true);
    r = await call(locked, 'POST', '/api/crew/ba/if/connect');
    check('connect is refused', r.status === 423);
    r = await call(locked, 'POST', '/api/crew/ba/if/aircraft/x1/schedules');
    check('a nested write is refused', r.status === 423 && !r.body.reached);
    r = await call(locked, 'GET', '/api/crew/ba/if/board');
    check('the pilot board is empty, not an error', r.status === 200 && r.body.connected === false && Array.isArray(r.body.aircraft) && !r.body.aircraft.length);
    r = await call(locked, 'GET', '/api/crew/ba/if/airframes');
    check('the editor’s airframe list is empty, not an error', r.status === 200 && Array.isArray(r.body.airframes) && !r.body.airframes.length);
    r = await call(locked, 'POST', '/api/crew/ba/verify-if');
    check('IFC name verification is not Live, and is untouched', r.status === 200 && r.body.reached === 'verify');

    console.log('open for one crew center');
    const open = appWith({ IF_LIVE_BETA_SLUGS: 'ba' });
    r = await call(open, 'GET', '/api/crew/ba/if');
    check('its status route is reached', r.status === 200 && r.body.reached === 'status');
    r = await call(open, 'POST', '/api/crew/ba/if/connect');
    check('its connect is reached', r.body.reached === 'connect');
    r = await call(open, 'GET', '/api/crew/ek/if');
    check('another crew center is still locked', r.status === 423);

    console.log('setup guide');
    const g = crewSetupGuide.evaluate({ va: { ifOrganizationId: 'org' }, store: {}, ifLocked: true });
    const step = g.steps.find((s) => s.id === 'infinite-flight');
    check('the step is shown, blocked, and marked beta', step && step.state === 'blocked' && step.beta === true);
    check('it is never the next thing to do', g.next !== 'infinite-flight');
    const g2 = crewSetupGuide.evaluate({ va: { ifOrganizationId: 'org', ifOrganizationName: 'X' }, store: {} });
    check('unlocked, it grades as before', g2.steps.find((s) => s.id === 'infinite-flight').state === 'done');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
