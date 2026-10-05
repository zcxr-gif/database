// test-crew-webhook-feeds.js
// Where each Discord feed posts (crewFeeds.js), and the announcement banner
// (crewAnnounceBanner.js).
//
// WHAT THIS FILE IS DEFENDING
//
//   * every feed that existed before the split still posts to the main webhook
//     when it has no channel of its own — nobody silently loses notices
//   * the new automatic feeds (roster, awards, library, shop) post NOWHERE until
//     given a channel: a VA with one old webhook must not suddenly get every
//     join and shop order in it
//   * a notice that moved feeds (schedules, quiz results) goes to its new home
//     when that has a channel, and otherwise exactly where it used to
//   * nothing that is not a Discord webhook is ever returned to post to
//   * the banner draws every style, with or without a logo, at the size Discord
//     shows best, without touching the network
//
// Run:  node scripts/test-crew-webhook-feeds.js
const assert = require('assert');
const sharp = require('sharp');
const crewFeeds = require('../crewFeeds');
const banner = require('../crewAnnounceBanner');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const MAIN = 'https://discord.com/api/webhooks/1/main';
const OWN = (f) => `https://discord.com/api/webhooks/2/${f}`;
const valid = (u) => /^https:\/\/discord\.com\/api\/webhooks\//.test(u);
const hook = (doc, feed, o) => crewFeeds.hookFrom(doc, feed, { isValid: valid, ...(o || {}) });

(async () => {
    console.log('\nFeeds — where each one posts');

    await ok('the old feeds fall back to the main webhook', () => {
        for (const f of ['recruitment', 'pireps', 'routes', 'events', 'retention']) {
            assert.strictEqual(hook({ crewWebhookUrl: MAIN }, f), MAIN, f);
        }
    });

    await ok('announcements fall back to the main webhook too', () => {
        assert.strictEqual(hook({ crewWebhookUrl: MAIN }, 'announcements'), MAIN);
    });

    await ok('the new automatic feeds are off until given a channel', () => {
        for (const f of ['roster', 'awards', 'library', 'shop']) {
            assert.strictEqual(hook({ crewWebhookUrl: MAIN }, f), '', f);
        }
    });

    await ok('a feed with its own channel uses it', () => {
        for (const f of crewFeeds.FEEDS) {
            assert.strictEqual(hook({ crewWebhookUrl: MAIN, crewWebhooks: { [f]: OWN(f) } }, f), OWN(f), f);
        }
    });

    await ok('a moved notice goes to its new home when that has a channel', () => {
        const doc = { crewWebhookUrl: MAIN, crewWebhooks: { library: OWN('library'), events: OWN('events') } };
        assert.strictEqual(hook(doc, 'library', { fallbackFeed: 'events' }), OWN('library'));
    });

    await ok('…and where it always went when it does not', () => {
        assert.strictEqual(hook({ crewWebhookUrl: MAIN, crewWebhooks: { events: OWN('events') } }, 'library', { fallbackFeed: 'events' }), OWN('events'));
        assert.strictEqual(hook({ crewWebhookUrl: MAIN }, 'awards', { fallbackFeed: 'recruitment' }), MAIN);
    });

    await ok('nothing that is not a webhook is ever handed back', () => {
        assert.strictEqual(hook({ crewWebhookUrl: 'https://evil.example/x' }, 'recruitment'), '');
        assert.strictEqual(hook({ crewWebhooks: { shop: 'http://169.254.169.254/' } }, 'shop'), '');
        assert.strictEqual(hook(null, 'recruitment'), '');
    });

    await ok('an unknown feed name never reads an arbitrary field', () => {
        assert.strictEqual(hook({ crewWebhookUrl: MAIN, crewWebhooks: { constructor: OWN('x') } }, 'constructor'), MAIN);
    });

    await ok('the settings screen is told which rows are off rather than on the main channel', () => {
        const st = crewFeeds.states({ crewWebhookUrl: MAIN, crewWebhooks: { shop: OWN('shop') } }, { mask: (u) => (u ? 'masked' : '') });
        assert.deepStrictEqual(st.pireps, { configured: false, hint: '', usingDefault: true, optIn: false });
        assert.deepStrictEqual(st.roster, { configured: false, hint: '', usingDefault: false, optIn: true });
        assert.deepStrictEqual(st.shop, { configured: true, hint: 'masked', usingDefault: false, optIn: true });
        assert.strictEqual(st.announcements.usingDefault, true);
    });

    console.log('\nBanner — the picture at the top of an announcement');

    const noNet = async () => { throw new Error('the banner must not need the network here'); };

    await ok('draws every style at 1200×500', async () => {
        for (const style of banner.STYLES) {
            const png = await banner.render({ style, title: 'Summer fly-in', body: 'Saturday 18:00Z.', name: 'Meridian Virtual', accent: '#14375E', fetch: noNet });
            const meta = await sharp(png).metadata();
            assert.strictEqual(meta.format, 'png', style);
            assert.deepStrictEqual([meta.width, meta.height], [banner.W, banner.H], style);
        }
    });

    await ok('an unknown style is an ordinary notice, not an error', async () => {
        assert.strictEqual(banner.styleOf('<script>'), 'notice');
        const png = await banner.render({ style: 'nope', title: 'x', fetch: noNet });
        assert.ok(png.length > 1000);
    });

    await ok('a logo that will not download still draws (initials)', async () => {
        const png = await banner.render({ title: 'x', name: 'Meridian', logoUrl: 'https://cdn.example/logo.png', fetch: async () => null });
        assert.ok(png.length > 1000);
    });

    await ok('a logo that does download is drawn on the card', async () => {
        const logo = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } }).png().toBuffer();
        const png = await banner.render({ title: 'x', name: 'Meridian', logoUrl: 'https://cdn.example/logo.png', fetch: async () => logo });
        const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        const at = (x, y) => data[(y * info.width + x) * info.channels];
        assert.ok(at(114, 98) > 200, 'expected the red logo inside the plate');
    });

    await ok('text that could break the SVG is escaped, not interpreted', async () => {
        const png = await banner.render({ title: '</text><script>alert(1)</script> & "quotes"', body: '<b>bold</b>', name: 'A & B <VA>', fetch: noNet });
        assert.ok(png.length > 1000);
    });

    await ok('a long headline is wrapped to two lines with an ellipsis', () => {
        const h = banner.headline('This is a really long headline about the crew center being offline for scheduled maintenance this weekend');
        assert.strictEqual(h.lines.length, 2);
        assert.ok(h.lines[1].endsWith('…'), h.lines[1]);
        for (const l of h.lines) assert.ok(l.length <= h.perLine, l);
    });

    await ok('a short headline is drawn large on one line', () => {
        const h = banner.headline('Summer fly-in');
        assert.deepStrictEqual(h.lines, ['Summer fly-in']);
        assert.strictEqual(h.size, 72);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
