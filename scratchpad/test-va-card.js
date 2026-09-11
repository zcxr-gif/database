'use strict';
// Offline conformance test: builds cards via the REAL module and validates them
// against Discord's documented webhook/embed limits. No DB, no network.
const path = require('path');
const {
    buildVaEventPayload, isHttpUrl, flightMapImageUrl, normalizeCardOptions,
    resolveAccent, eteTextFor, routeDistanceNm, DEFAULT_CARD_FIELDS,
    extractFlightPlan, planDistanceNm, planRouteText, eventDistanceNm,
    trackUrl, flightLinkId, CARD_LAYOUTS,
} = require(path.join('..', 'vaEventCard.js'));

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  ❌', msg); } };

// Discord limits (https://discord.com/developers/docs/resources/channel#embed-limits)
const LIM = { title: 256, desc: 4096, fields: 25, fname: 256, fval: 1024, author: 256, footer: 2048, total: 6000 };

function validateEmbedPayload(payload, label) {
    console.log('•', label);
    // Top-level webhook shape: must carry at least embeds (we only send embeds).
    check(payload && Array.isArray(payload.embeds) && payload.embeds.length >= 1, 'has embeds[]');
    check(payload.embeds.length <= 10, '≤ 10 embeds');
    const em = payload.embeds[0];

    // Must JSON-serialize cleanly (axios will JSON.stringify it).
    let json;
    try { json = JSON.stringify(payload); } catch (e) { check(false, 'JSON-serializable: ' + e.message); return; }
    check(typeof json === 'string', 'serialized');

    // Length limits.
    if (em.title) check(em.title.length <= LIM.title, `title ≤ ${LIM.title} (got ${em.title.length})`);
    if (em.description) check(em.description.length <= LIM.desc, `description ≤ ${LIM.desc}`);
    check(em.fields.length <= LIM.fields, `≤ ${LIM.fields} fields`);
    check(typeof em.color === 'number' && em.color >= 0 && em.color <= 0xFFFFFF, 'color is a 24-bit int');
    if (em.author) check(em.author.name && em.author.name.length <= LIM.author, 'author.name present & ≤ 256');
    // The Inflight brand mark ALWAYS rides in the footer (text + icon) — never customizable.
    check(em.footer && em.footer.text === 'Powered by Inflight', 'footer = Powered by Inflight (always)');
    check(em.footer && isHttpUrl(em.footer.icon_url), 'footer carries the Inflight logo icon (always)');
    if (em.footer) check(em.footer.text.length <= LIM.footer, 'footer.text ≤ 2048');

    // Fields: non-empty name/value within limits (Discord 400s on empty values).
    let total = (em.title || '').length + (em.description || '').length + (em.author ? em.author.name.length : 0) + (em.footer ? em.footer.text.length : 0);
    for (const f of em.fields) {
        check(typeof f.name === 'string' && f.name.length >= 1 && f.name.length <= LIM.fname, `field name ok: ${f.name}`);
        check(typeof f.value === 'string' && f.value.length >= 1 && f.value.length <= LIM.fval, `field value non-empty ≤ 1024: ${f.name}`);
        total += f.name.length + f.value.length;
    }
    check(total <= LIM.total, `total chars ≤ ${LIM.total} (got ${total})`);

    // Every URL handed to Discord's proxy must be a valid http(s) URL.
    const urls = [];
    if (em.url) urls.push(['title.url', em.url]);
    if (em.image) urls.push(['image.url', em.image.url]);
    if (em.thumbnail) urls.push(['thumbnail.url', em.thumbnail.url]);
    if (em.author && em.author.icon_url) urls.push(['author.icon_url', em.author.icon_url]);
    if (em.footer && em.footer.icon_url) urls.push(['footer.icon_url', em.footer.icon_url]);
    for (const [where, u] of urls) check(isHttpUrl(u), `${where} is valid http(s): ${u}`);

    // timestamp must be ISO-8601.
    check(!em.timestamp || !isNaN(Date.parse(em.timestamp)), 'timestamp is ISO-8601');
    return em;
}

console.log('=== buildVaEventPayload conformance ===\n');

// 1. Full takeoff with all data.
const full = {
    event: 'takeoff', flightId: 'f1', va: { code: 'OCEAN', name: 'Ocean Virtual' },
    callsign: 'Ocean 001VA', username: 'Jane Pilot', server: 'Expert',
    aircraft: { aircraftName: 'Boeing 737-800', liveryName: 'Ocean' },
    departure: 'EGLL', arrival: 'KJFK',
    position: { lat: 43.6777, lon: -79.6248, alt_ft: 4200, gs_kt: 250 }, timestamp: Date.now(),
};
let em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: 'https://cdn.example.com/b738.jpg', vaLogoUrl: 'https://cdn.example.com/ocean.png' }), 'full takeoff + media');
check(em.image && em.image.url === 'https://cdn.example.com/b738.jpg', 'big image = aircraft photo');
check(em.author && em.author.icon_url === 'https://cdn.example.com/ocean.png', 'author icon = VA logo');
check(em.fields.some(f => /ETE/.test(f.name)), 'takeoff shows ETE field');
check(em.fields.some(f => /Distance/.test(f.name)), 'takeoff shows Distance field');

// 2. Landing → gold, and NO ETE (look-ahead only).
em = validateEmbedPayload(buildVaEventPayload({ ...full, event: 'landing' }, {}), 'landing (no media)');
check(em.color === 0xf1c40f, 'landing color = gold');
check(!em.fields.some(f => /ETE/.test(f.name)), 'landing has no ETE field');

// 3. No position at all → no image, still valid.
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: 'X 1', username: 'P', server: 'Casual' }, {}), 'no coordinates');
check(!em.image, 'no aircraft image when none supplied');

// 4. Malformed media URLs (relative path, empty, non-url) must be dropped, not 400.
em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: '/uploads/x.jpg', vaLogoUrl: '' }), 'malformed media URLs dropped');
check(!em.image || isHttpUrl(em.image.url), 'no malformed image leaks through');

// 5. Hostile/overlong input must be clipped, never empty.
const longName = 'A'.repeat(5000);
em = validateEmbedPayload(buildVaEventPayload({ event: 'takeoff', callsign: longName, username: longName, server: longName,
    aircraft: { aircraftName: longName, liveryName: longName }, position: { lat: 1, lon: 1 }, timestamp: Date.now() }, {}), 'overlong fields clipped');

// 6. Empty/garbage event object — must not throw and still be valid.
em = validateEmbedPayload(buildVaEventPayload({}, {}), 'empty event object');
em = validateEmbedPayload(buildVaEventPayload(undefined, undefined), 'undefined args');

// 7. Customization: accent, custom title, compact field selection, photo off.
const opts = normalizeCardOptions({ accent: '1e90ff', title: 'Ocean Ops', showPhoto: false, fields: ['ete', 'pilot', 'callsign'] });
em = validateEmbedPayload(buildVaEventPayload(full, { aircraftImageUrl: 'https://cdn.example.com/b738.jpg' }, opts), 'customized takeoff');
check(em.color === 0x1e90ff, 'custom accent honoured');
check(em.title === 'Ocean Ops', 'custom title honoured');
check(!em.image, 'showPhoto:false drops the aircraft image');
const names = em.fields.map(f => f.name).join(' ');
check(/Departure/.test(names) && /Arrival/.test(names), 'route always shown even when not in field list');
check(/ETE/.test(names) && /Pilot/.test(names) && /Callsign/.test(names), 'only chosen fields present');
check(!/Server/.test(names) && !/Aircraft/.test(names), 'unchosen fields absent');

// 8. normalizeCardOptions hardening.
check(JSON.stringify(normalizeCardOptions({}).fields) === JSON.stringify(DEFAULT_CARD_FIELDS), 'empty opts → default field set');
check(normalizeCardOptions({ accent: 'nope' }).accent === '', 'invalid accent → empty (default colour)');
check(normalizeCardOptions({ fields: ['bogus', 'pilot', 'pilot'] }).fields.join() === 'pilot', 'fields deduped & filtered');
check(normalizeCardOptions({ layout: 'weird' }).layout === 'card', 'unknown layout → card');
check(normalizeCardOptions({}).photoSide === 'right', 'default photoSide = right');
check(normalizeCardOptions({ photoSide: 'left' }).photoSide === 'left', 'photoSide left honoured');
check(normalizeCardOptions({ photoSide: 'up' }).photoSide === 'right', 'invalid photoSide → right');
check(normalizeCardOptions({}).mapStyle === 'dark', 'default mapStyle = dark');
check(normalizeCardOptions({ mapStyle: 'midnight' }).mapStyle === 'midnight', 'mapStyle midnight honoured');
check(normalizeCardOptions({ mapStyle: 'neon' }).mapStyle === 'dark', 'unknown mapStyle → dark');
check(normalizeCardOptions({ mapLine: 'white' }).mapLine === '#ffffff', 'mapLine name → hex');
check(normalizeCardOptions({ mapLine: '#abc' }).mapLine === '#aabbcc', 'mapLine short hex expands');
check(normalizeCardOptions({ mapLine: 'not-a-colour' }).mapLine === '', 'invalid mapLine → empty (uses accent)');

// 9. Derived route figures.
check(routeDistanceNm('EGLL', 'KJFK') > 2500, 'EGLL→KJFK distance resolves (>2500 NM)');
check(/h/.test(eteTextFor(full) || ''), 'takeoff ETE resolves to an h/m string');
check(eteTextFor({ ...full, event: 'landing' }) === null, 'no ETE for landing');
check(eteTextFor({ ...full, position: { gs_kt: 5 } }) === null, 'no ETE when on the ground (gs<40)');

// 10. resolveAccent.
check(resolveAccent(full, normalizeCardOptions({})).int === 0x2ecc71, 'default takeoff accent = green');
check(resolveAccent(full, normalizeCardOptions({ accent: '#ff0000' })).int === 0xff0000, 'accent override wins');

// 11. isHttpUrl unit checks
check(isHttpUrl('https://a.com/x.png'), 'isHttpUrl https ok');
check(isHttpUrl('http://a.com'), 'isHttpUrl http ok');
check(!isHttpUrl('/relative.png'), 'isHttpUrl rejects relative');
check(!isHttpUrl(''), 'isHttpUrl rejects empty');
check(!isHttpUrl('ftp://a.com'), 'isHttpUrl rejects ftp');
check(!isHttpUrl(null), 'isHttpUrl rejects null');

// 12. Coordinate ordering sanity (lon,lat for mapbox; lat,lon for OSM).
process.env.MAPBOX_STATIC_TOKEN = 'pk.test';
check(flightMapImageUrl(43.6777, -79.6248, true).includes('(-79.6248,43.6777)'), 'mapbox marker = lon,lat');
delete process.env.MAPBOX_STATIC_TOKEN;
check(flightMapImageUrl(43.6777, -79.6248, true).includes('center=43.6777,-79.6248'), 'OSM center = lat,lon');
check(flightMapImageUrl(NaN, 5, true) === null, 'no map for NaN coords');

// 13. Isolation: one VA's customization must never bleed into another's card,
// nor mutate the shared defaults. This is the "each embed doesn't take the
// other's style" guarantee — every call resolves its own options object.
console.log('• isolation between VAs / the shared defaults');
const optsA = normalizeCardOptions({ accent: '#ff0000', title: 'VA A', fields: ['pilot'] });
const optsB = normalizeCardOptions({ accent: '#0000ff', title: 'VA B', fields: ['server', 'ete'] });
// Interleave builds; each must reflect ONLY its own options.
const a1 = buildVaEventPayload(full, {}, optsA).embeds[0];
const b1 = buildVaEventPayload(full, {}, optsB).embeds[0];
const a2 = buildVaEventPayload(full, {}, optsA).embeds[0];
check(a1.color === 0xff0000 && a1.title === 'VA A', 'VA A keeps its own accent/title');
check(b1.color === 0x0000ff && b1.title === 'VA B', 'VA B keeps its own accent/title');
check(JSON.stringify(a1) === JSON.stringify(a2), 'VA A card is identical before/after a B render (no bleed)');
check(a1.fields.some(f => /Pilot/.test(f.name)) && !a1.fields.some(f => /Server/.test(f.name)), 'VA A shows only its fields');
check(b1.fields.some(f => /Server/.test(f.name)) && !b1.fields.some(f => /Pilot/.test(f.name)), 'VA B shows only its fields');
// A default render sitting between two custom ones (mirrors central feed +
// partner) must stay default — proving customization can't leak onto it.
const centralMid = buildVaEventPayload(full, {}, normalizeCardOptions({})).embeds[0];
check(centralMid.color === 0x2ecc71, 'default (central-feed) card stays default amid custom renders');
// normalizeCardOptions returns fresh, independent objects; the frozen default
// is never handed out or mutated.
const n1 = normalizeCardOptions({}), n2 = normalizeCardOptions({});
check(n1 !== n2 && n1.fields !== n2.fields, 'each normalize call yields independent objects');
try { n1.fields.push('server'); } catch (e) { /* ignore */ }
check(normalizeCardOptions({}).fields.length === DEFAULT_CARD_FIELDS.length, 'mutating a result never affects future defaults');
check(Object.isFrozen(require(path.join('..', 'vaEventCard.js')).DEFAULT_CARD_OPTIONS), 'DEFAULT_CARD_OPTIONS is frozen');

// 14. The filed flight plan — the route the card actually draws.
console.log('• filed flight plan');
const PLAN = [
    { name: 'EGLL', lat: 51.4775, lon: -0.4614 },
    { name: 'DET', lat: 51.3033, lon: 0.5975 },
    { name: 'GAPLI', lat: 55.0, lon: -15.0 },
    { name: 'KJFK', lat: 40.6398, lon: -73.7789 },
];
const planned = { ...full, flightPlan: { waypoints: PLAN } };
check(extractFlightPlan(planned).length === 4, 'a plan on flightPlan.waypoints is read');
check(extractFlightPlan({ ...full, fpl: { fixes: PLAN } }).length === 4, 'a plan under fpl.fixes is read too');
check(extractFlightPlan({ ...full, waypoints: PLAN.map(w => [w.lat, w.lon]) }).length === 4, 'bare [lat, lon] pairs are read');
check(extractFlightPlan(full).length === 0, 'an event with no plan yields an empty plan, not a throw');
check(extractFlightPlan({ ...full, flightPlan: { waypoints: [PLAN[0]] } }).length === 0, 'a single point is not a route');
// Unusable entries never reach the map.
const dirty = extractFlightPlan({ ...full, flightPlan: { waypoints: [
    PLAN[0], { name: 'ZERO', lat: 0, lon: 0 }, { name: 'NAN', lat: 'x', lon: 2 },
    { name: 'OFF', lat: 120, lon: 5 }, PLAN[0], PLAN[3],
] } });
check(dirty.length === 2 && dirty[1].name === 'KJFK', '(0,0), NaN, out-of-range and repeated fixes are dropped');
// Track distance along the plan, not the straight line between the airports.
const gc = routeDistanceNm('EGLL', 'KJFK');
const track = planDistanceNm(PLAN);
check(track > gc, 'a dog-legged plan measures longer than the great circle');
check(planDistanceNm([PLAN[0]]) === null && planDistanceNm(null) === null, 'no plan means no plan distance');
check(eventDistanceNm(planned) === track, 'the event quotes the FILED distance when there is a plan');
check(eventDistanceNm(full) === gc, 'and falls back to the great circle when there is not');
// The readout, and its middle-elision on a long route.
check(planRouteText(PLAN) === 'EGLL · DET · GAPLI · KJFK', 'the plan reads out as its fixes');
const long = Array.from({ length: 40 }, (_, i) => ({ name: 'FIX' + i, lat: 40 + i / 10, lon: -70 + i / 10 }));
const longTxt = planRouteText(long);
check(longTxt.includes('FIX0') && longTxt.includes('FIX39') && /\+\d+/.test(longTxt),
    'a long plan keeps both ends and elides the middle');
check(planRouteText([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]) === '', 'unnamed fixes have nothing to read out');
// The plan reaches the embed, on a card nobody has customized.
const planEmbed = buildVaEventPayload(planned, {}).embeds[0];
const planField = planEmbed.fields.find(f => /Flight plan/.test(f.name));
check(!!planField && planField.value === 'EGLL · DET · GAPLI · KJFK', 'the embed carries the filed route');
check(planField.inline === false, 'the route field is full width, not squeezed into a column');
check(/\(filed\)/.test((planEmbed.fields.find(f => /Distance/.test(f.name)) || {}).value || ''),
    'the distance says it came from the plan');
// …but never onto a card whose owner chose their fields.
const chosen = buildVaEventPayload(planned, {}, normalizeCardOptions({ fields: ['pilot', 'server'] })).embeds[0];
check(!chosen.fields.some(f => /Flight plan/.test(f.name)), 'a VA that chose its fields does not get the route added');
check(buildVaEventPayload(planned, {}, normalizeCardOptions({ fields: ['plan'] })).embeds[0]
    .fields.some(f => /Flight plan/.test(f.name)), 'a VA that asked for the route gets it');
check(!buildVaEventPayload(full, {}).embeds[0].fields.some(f => /Flight plan/.test(f.name)),
    'no plan filed means no route field at all');

// 15. The link opens THIS flight, not the tracker's front page. A notification a
// VA's members can act on is the entire point of sending it.
console.log('• per-flight deep link');
check(trackUrl({ flightId: 'abc-123' }) === 'https://inflight.info/share/abc-123', 'the link points at the flight');
check(trackUrl({}) === 'https://inflight.info', 'no flight id degrades to the tracker home');
check(trackUrl() === 'https://inflight.info', 'and so does no event at all');
// The id goes into a URL that is posted publicly, so it is checked, not trusted.
check(flightLinkId({ flightId: 'a/../b' }) === '', 'a path-traversing id is refused');
check(flightLinkId({ flightId: 'x y' }) === '', 'an id with a space is refused');
check(flightLinkId({ flightId: 'a'.repeat(200) }) === '', 'an absurdly long id is refused');
check(flightLinkId({ flightId: '6f9a1b2c-1111-2222-3333-444455556666' }) !== '', 'a real GUID flight id is accepted');
const linked = buildVaEventPayload(planned, {}).embeds[0];
check(linked.url === 'https://inflight.info/share/' + full.flightId, 'the embed title links to the flight');
check(linked.description.includes('/share/' + full.flightId), 'and so does the link in the description');
const unlinked = buildVaEventPayload({ ...full, flightId: null }, {}).embeds[0];
check(unlinked.url === 'https://inflight.info', 'without an id the embed still links somewhere valid');

// 16. The 'slick' layout is a real, storable choice — not silently coerced away.
console.log('• card layouts');
check(CARD_LAYOUTS.includes('slick'), 'slick is a layout');
check(normalizeCardOptions({ layout: 'slick' }).layout === 'slick', 'slick survives normalization');
check(normalizeCardOptions({ layout: 'sparkly' }).layout === 'card', 'an unknown layout still falls back to card');
check(buildVaEventPayload(planned, {}, normalizeCardOptions({ layout: 'slick' })).embeds.length === 1,
    'slick still produces a valid embed for the fallback path');

console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED ✅' : failures + ' CHECK(S) FAILED ❌') + ' ===');
process.exit(failures === 0 ? 0 : 1);
