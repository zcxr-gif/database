'use strict';
// Conformance test for the two photo UIs the bot renders: the admin review card
// (buildAircraftReview) and the staff photo manager (buildPhotoManager).
//
// Both build Discord component payloads, and Discord's limits are hard: 5 rows
// per message, 5 buttons per row, 25 options per select, 10 embeds, 80-char
// button labels, 100-char custom ids. A payload that breaks one of them doesn't
// degrade — the message fails to send, which on the review card means a
// submission silently never reaches an admin. So this file renders every shape
// the code can produce, checks each payload against those limits, and asserts
// the buttons and options that come out are the right ones.
//
// The builders here are minimal local stand-ins that mirror the discord.js
// payload shapes (row = type 1, button = type 2, select = type 3), which keeps
// this runnable with no node_modules like every other test in scratchpad/. The
// limits above are therefore asserted explicitly below rather than inherited
// from the library.
//
// The two functions live inside the bot's client closure and are not exported,
// so they are lifted out of bot.js by name along with the helpers they close
// over. Brittle on purpose: a rename fails here with "could not find".
//
// Run:  node scratchpad/test-photo-components.js

const fs = require('fs');
const path = require('path');

const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 };
class EmbedBuilder {
    constructor() { this.data = {}; }
    setTitle(t) { this.data.title = t; return this; }
    setDescription(d) { this.data.description = d; return this; }
    setColor(c) { this.data.color = c; return this; }
    setImage(url) { this.data.image = { url }; return this; }
    setThumbnail(url) { this.data.thumbnail = { url }; return this; }
    setFooter(f) { this.data.footer = f; return this; }
    setTimestamp() { this.data.timestamp = new Date().toISOString(); return this; }
    addFields(...f) { this.data.fields = [...(this.data.fields || []), ...f.flat()]; return this; }
    toJSON() { return this.data; }
}
class ButtonBuilder {
    constructor() { this.data = { type: 2 }; }
    setCustomId(id) { this.data.custom_id = id; return this; }
    setLabel(l) { this.data.label = l; return this; }
    setStyle(s) { this.data.style = s; return this; }
    setEmoji(e) { this.data.emoji = { name: e }; return this; }
    setDisabled(d) { this.data.disabled = d; return this; }
    toJSON() { return this.data; }
}
class StringSelectMenuOptionBuilder {
    constructor() { this.data = {}; }
    setLabel(l) { this.data.label = l; return this; }
    setDescription(d) { this.data.description = d; return this; }
    setValue(v) { this.data.value = v; return this; }
    toJSON() { return this.data; }
}
class StringSelectMenuBuilder {
    constructor() { this.data = { type: 3, options: [] }; }
    setCustomId(id) { this.data.custom_id = id; return this; }
    setPlaceholder(p) { this.data.placeholder = p; return this; }
    addOptions(...o) { this.data.options.push(...o.flat()); return this; }
    toJSON() { return { ...this.data, options: this.data.options.map(o => o.toJSON()) }; }
}
class ActionRowBuilder {
    constructor() { this.components = []; }
    addComponents(...c) { this.components.push(...c.flat()); return this; }
    toJSON() { return { type: 1, components: this.components.map(c => c.toJSON()) }; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

// `const <name> = ...;` up to the semicolon that ends the statement, tracking
// depth so a one-line arrow and a multi-line body both read correctly.
function lift(name) {
    const start = SRC.indexOf(`const ${name} = `);
    if (start === -1) throw new Error(`could not find ${name} in bot.js`);
    let depth = 0;
    let inLine = false, inBlock = false, quote = '';
    for (let i = start; i < SRC.length; i++) {
        const c = SRC[i], next = SRC[i + 1];
        if (inLine) { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = '';
            continue;
        }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (c === ';' && depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`could not find the end of ${name} in bot.js`);
}

const NAMES = [
    'THEME', 'BRAND_FOOTER', 'SUB_STATE', 'themedEmbed', 'MAX_AIRCRAFT_IMAGES',
    'getEntryImages', 'getEntryContributors', 'buildAircraftReview', 'buildPhotoManager',
];
const DEPS = {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
};
// eslint-disable-next-line no-new-func
const H = new Function(...Object.keys(DEPS),
    `${NAMES.map(lift).join('\n')}\nreturn { ${NAMES.join(', ')} };`
)(...Object.values(DEPS));

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};
const ok = (label, cond, detail) => {
    if (cond) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, detail ? `\n      ${detail}` : '');
};

// Discord's own ceilings. Exceeding one rejects the whole message.
const LIMITS = { rows: 5, buttonsPerRow: 5, selectOptions: 25, embeds: 10, label: 80, customId: 100 };

// Renders the payload through the real builders and reports anything Discord
// would reject, plus the button ids/labels for the assertions below.
function inspect(payload) {
    const rows = payload.components.map(r => r.toJSON());
    const embeds = payload.embeds.map(e => e.toJSON());
    const problems = [];
    if (rows.length > LIMITS.rows) problems.push(`${rows.length} rows`);
    if (embeds.length > LIMITS.embeds) problems.push(`${embeds.length} embeds`);
    const buttons = [];
    const selects = [];
    for (const row of rows) {
        const kids = row.components || [];
        const buttonsInRow = kids.filter(c => c.type === 2);
        const selectsInRow = kids.filter(c => c.type === 3);
        if (buttonsInRow.length > LIMITS.buttonsPerRow) problems.push(`${buttonsInRow.length} buttons in a row`);
        if (selectsInRow.length && kids.length > 1) problems.push('a select sharing a row');
        for (const b of buttonsInRow) {
            if ((b.label || '').length > LIMITS.label) problems.push(`label too long: ${b.label}`);
            if ((b.custom_id || '').length > LIMITS.customId) problems.push(`custom_id too long: ${b.custom_id}`);
            buttons.push(b);
        }
        for (const s of selectsInRow) {
            if ((s.options || []).length > LIMITS.selectOptions) problems.push(`${s.options.length} select options`);
            if ((s.custom_id || '').length > LIMITS.customId) problems.push(`custom_id too long: ${s.custom_id}`);
            selects.push(s);
        }
    }
    return { rows, embeds, buttons, selects, problems, ids: buttons.map(b => b.custom_id), labels: buttons.map(b => b.label) };
}

const USER = '111111111111111111';
const entryWith = (n) => ({
    _id: '0123456789abcdef01234567',
    aircraftType: 'A350-900',
    liveryName: 'Qatar Airways',
    tailNumber: 'A7-ALA',
    contributorName: 'Legacy Contributor',
    contributorId: '999',
    imageUrls: Array.from({ length: n }, (_, i) => `https://cdn.example/p${i + 1}.webp`),
    imageContributors: Array.from({ length: n }, (_, i) => ({ name: `Pilot ${i + 1}`, id: String(i + 1) })),
});
const review = (n) => inspect((() => {
    const embed = new EmbedBuilder();
    const built = H.buildAircraftReview(embed, n === 0 ? null : entryWith(n), USER);
    return { embeds: [embed, ...built.extraEmbeds], components: built.components };
})());

console.log('\nbuildAircraftReview — a payload Discord will accept');
for (let n = 0; n <= 3; n++) {
    const r = review(n);
    ok(`${n} photo(s) on record renders cleanly`, r.problems.length === 0, r.problems.join('; '));
}

console.log('\nbuildAircraftReview — the choices offered at each image count');
// Nothing on record: a single approve, no slot to argue about.
T('an empty record offers one approve button', review(0).ids, [`approve_add_1_${USER}`, `edit_admin_${USER}`, `reject_${USER}`]);
// One photo: replace it (destructive), add a second, or insert ahead of it.
// With nothing after Photo 1, "1 → 2" is the only place it can go, so there is
// no second insert variant.
T('one photo offers replace, add and a single insert', review(1).ids, [
    `approve_replace_1_${USER}`, `approve_add_2_${USER}`,
    `approve_insert_1_${USER}`,
    `edit_admin_${USER}`, `reject_${USER}`,
]);
// Two photos: inserting at Photo 1 can send the old primary down one (1 → 2) or
// all the way to the back (1 → 3) — the ambiguous case, and the only one that
// needs both buttons.
T('two photos offer both destinations for the displaced primary', review(2).ids, [
    `approve_replace_1_${USER}`, `approve_replace_2_${USER}`, `approve_add_3_${USER}`,
    `approve_insert_1_${USER}`, `approve_insertend_1_${USER}`, `approve_insert_2_${USER}`,
    `edit_admin_${USER}`, `reject_${USER}`,
]);
T('…and say where the displaced photo lands', review(2).labels.filter(l => l.startsWith('Insert')), [
    'Insert as Photo 1 (1 → 2)', 'Insert as Photo 1 (1 → 3)', 'Insert as Photo 2 (2 → 3)',
]);
// Full record: every insert would push Photo 3 out, so none is offered and
// Replace is the only way in — the card says so rather than hiding it.
T('a full record offers no insert at all',
    review(3).ids.filter(id => id.includes('insert')), []);
ok('a full record explains why only Replace is left',
    /All 3 slots are full/.test(review(3).embeds[0].description), review(3).embeds[0].description);
ok('a record with room explains that insert keeps the photo',
    /Nothing is deleted/.test(review(1).embeds[0].description), review(1).embeds[0].description);
// The comparison embeds are how an admin sees what they are about to overwrite.
T('every existing photo gets a comparison embed', review(3).embeds.length, 4);
ok('a comparison embed warns that replacing deletes',
    /deletes this image/.test(review(2).embeds[1].footer.text), review(2).embeds[1].footer.text);

console.log('\nbuildPhotoManager — the staff reorder surface');
for (let n = 1; n <= 3; n++) {
    const m = inspect(H.buildPhotoManager(entryWith(n)));
    ok(`${n} photo(s) renders cleanly`, m.problems.length === 0, m.problems.join('; '));
}
const one = inspect(H.buildPhotoManager(entryWith(1)));
// One photo: no reorder (nothing to swap with) and no removal (dropping it
// would leave the record with no image at all).
T('a single-photo record offers no reorder or removal select', one.selects.length, 0);
T('…but can still be refreshed', one.ids, ['photos_refresh_0123456789abcdef01234567']);
ok('…and says why', /cannot be removed here/.test(one.embeds[0].description), one.embeds[0].description);

const three = inspect(H.buildPhotoManager(entryWith(3)));
T('a three-photo record offers a move and a remove select', three.selects.map(s => s.custom_id), [
    'photos_move_0123456789abcdef01234567', 'photos_del_0123456789abcdef01234567',
]);
// Every ordered pair of slots, so any photo can reach any position in one step.
T('every from → to move is offered', three.selects[0].options.map(o => o.value),
    ['1:2', '1:3', '2:1', '2:3', '3:1', '3:2']);
T('one removal option per photo', three.selects[1].options.map(o => o.value), ['1', '2', '3']);
T('the primary slot is marked', three.embeds[1].title, '⭐ Photo 1 (primary)');
// Per-slot credit is what makes a reorder safe to reason about: the manager
// shows whose photo each slot holds, not just the record's top-level name.
T('each slot shows its own contributor', three.embeds.slice(1).map(e => e.description),
    ['Contributor: Pilot 1', 'Contributor: Pilot 2', 'Contributor: Pilot 3']);
// A legacy record (imageUrl only, no per-image credit) must still render.
const legacy = inspect(H.buildPhotoManager({
    _id: '0123456789abcdef01234567', aircraftType: 'C172', liveryName: 'Generic',
    contributorName: 'Old Timer', contributorId: '7', imageUrl: 'https://cdn.example/legacy.webp',
}));
ok('a legacy single-image record renders', legacy.problems.length === 0, legacy.problems.join('; '));
T('…crediting its top-level contributor', legacy.embeds[1].description, 'Contributor: Old Timer');

// ---------------------------------------------------------------------------
// The aircraft picker: two paged dropdowns (aircraft, then its liveries) that
// replaced typing the type and livery into a modal. Its whole reason to exist
// is that the lists are longer than a Discord select can hold, so the paging
// maths and the 25-option cap are the things worth pinning down.
// ---------------------------------------------------------------------------
const PICK_NAMES = ['PICKER_PAGE_SIZE', 'parsePickerCustomId', 'filterByQuery', 'pickerChoices', 'renderPicker', 'renderPickerConfirm', 'isListedAircraft'];
// Stub the two API-backed lists: 60 aircraft (3 pages) and a per-aircraft
// livery list, so the paging is exercised without touching the network.
const AIRCRAFT = Array.from({ length: 60 }, (_, i) => ({ name: `Plane ${String(i + 1).padStart(2, '0')}`, id: `id${i + 1}` }));
const LIVERIES = {
    id1: Array.from({ length: 30 }, (_, i) => `Livery ${String(i + 1).padStart(2, '0')}`),
    id2: ['Generic', 'Delta Air Lines', 'Qatar Airways'],
    id3: [],
};
const P = new Function(...Object.keys(DEPS), 'fetchAircraftMetadata', 'fetchLiveriesForAircraft',
    `${PICK_NAMES.map(lift).join('\n')}\nreturn { ${PICK_NAMES.join(', ')} };`
)(...Object.values(DEPS),
    async () => AIRCRAFT,
    async (id) => LIVERIES[id] || []);

const session = (over = {}) => ({ id: 'abc123', step: 'type', type: null, query: '', page: 0, intro: '', ...over });
const renderConfirm = (over) => {
    const payload = P.renderPickerConfirm(session(over));
    return { content: payload.content, view: inspect({ embeds: [], components: payload.components }) };
};
const picker = async (over) => {
    const s = session(over);
    const payload = await P.renderPicker(s);
    const view = inspect({ embeds: [], components: payload.components });
    const select = view.selects[0] || null;
    return { s, content: payload.content, view, select, options: select ? select.options.map(o => o.value) : [] };
};

console.log('\nparsePickerCustomId — reading a control back');
T('a page button carries its page', P.parsePickerCustomId('pick_page_abc123_2'), { action: 'page', sessionId: 'abc123', page: 2 });
T('page 0 parses as 0, not as missing', P.parsePickerCustomId('pick_page_abc123_0'), { action: 'page', sessionId: 'abc123', page: 0 });
T('a search button is just an id', P.parsePickerCustomId('pick_search_abc123'), { action: 'search', sessionId: 'abc123', page: null });
T('so is back', P.parsePickerCustomId('pick_back_abc123'), { action: 'back', sessionId: 'abc123', page: null });
T('a foreign id is ignored', P.parsePickerCustomId('approve_add_1_123'), null);
T('a truncated id is ignored', P.parsePickerCustomId('pick_page_'), null);
T('null is handled', P.parsePickerCustomId(null), null);

console.log('\nfilterByQuery — the search box');
T('matches anywhere in the name', P.filterByQuery(['Boeing 737', 'Airbus A320'], '73'), ['Boeing 737']);
T('is case-insensitive', P.filterByQuery(['Delta Air Lines'], 'delta'), ['Delta Air Lines']);
T('an empty query keeps everything', P.filterByQuery(['a', 'b'], ''), ['a', 'b']);
T('whitespace is not a query', P.filterByQuery(['a', 'b'], '   '), ['a', 'b']);

(async () => {
    console.log('\nrenderPicker — step 1, the aircraft list');
    const first = await picker();
    ok('page 1 renders cleanly', first.view.problems.length === 0, first.view.problems.join('; '));
    T('a page holds exactly the select limit', first.options.length, P.PICKER_PAGE_SIZE);
    T('it starts at the first aircraft', first.options[0], 'Plane 01');
    // 60 aircraft over pages of 25 is 3 pages: the count and the page number are
    // the only way a user knows there is more than what they can see.
    ok('the header counts the options and the pages', /60 options .* page 1 of 3/.test(first.content), first.content);
    T('Prev is disabled on the first page', first.view.buttons[0].disabled, true);
    T('Next is live when there is more', Boolean(first.view.buttons[1].disabled), false);
    T('step 1 has no Back button', first.view.labels.includes('Back'), false);
    // The escape hatch for an aircraft the list doesn't carry yet, and it is on
    // the very first screen — not buried behind an empty search.
    T('typing it by hand is always offered', first.view.labels.includes('Not listed? Type it'), true);

    const last = await picker({ page: 2 });
    T('the last page holds the remainder', last.options.length, 10);
    T('…ending at the last aircraft', last.options[9], 'Plane 60');
    T('Next is disabled on the last page', last.view.buttons[1].disabled, true);
    // A page number from a stale control must not render an empty dropdown.
    const clamped = await picker({ page: 99 });
    T('a page past the end is clamped back', clamped.s.page, 2);
    T('…and still shows options', clamped.options.length, 10);

    const searched = await picker({ query: 'ane 1' });
    T('a search narrows the list', searched.options, ['Plane 10', 'Plane 11', 'Plane 12', 'Plane 13', 'Plane 14', 'Plane 15', 'Plane 16', 'Plane 17', 'Plane 18', 'Plane 19']);
    ok('…and says what it matched', /matching \*\*ane 1\*\*/.test(searched.content), searched.content);
    ok('the search button shows the active query',
        searched.view.labels.some(l => l === 'Search: ane 1'), searched.view.labels.join(' | '));

    const none = await picker({ query: 'Concorde' });
    T('a search with no matches drops the dropdown', none.select, null);
    ok('…and says so instead of rendering nothing', /Nothing matches/.test(none.content), none.content);
    ok('…leaving the controls to recover with', none.view.labels.includes('Not listed? Type it'), none.view.labels.join(' | '));

    console.log('\nrenderPicker — step 2, that aircraft\'s liveries');
    const liveries = await picker({ step: 'livery', type: 'Plane 01' });
    ok('renders cleanly', liveries.view.problems.length === 0, liveries.view.problems.join('; '));
    T('the dropdown holds the aircraft\'s liveries', liveries.options.length, P.PICKER_PAGE_SIZE);
    T('…paged like the aircraft list', (await picker({ step: 'livery', type: 'Plane 01', page: 1 })).options.length, 5);
    ok('the header names the aircraft being liveried',
        /Step 2 of 2 .* \*\*Plane 01\*\*/.test(liveries.content), liveries.content);
    T('step 2 offers Back to the aircraft list', liveries.view.labels.includes('Back'), true);
    T('a short livery list fits one page',
        (await picker({ step: 'livery', type: 'Plane 02' })).options, ['Generic', 'Delta Air Lines', 'Qatar Airways']);
    // An aircraft the API has no liveries for still has to leave a way forward.
    const empty = await picker({ step: 'livery', type: 'Plane 03' });
    T('an aircraft with no liveries drops the dropdown', empty.select, null);
    T('…and can still be typed by hand', empty.view.labels.includes('Not listed? Type it'), true);
    // An aircraft that isn't in the metadata at all (a stale session, a name the
    // API dropped) must not throw on the way to the livery step.
    const unknown = await picker({ step: 'livery', type: 'Not A Real Plane' });
    T('an unknown aircraft renders an empty step 2', unknown.select, null);

    // An aircraft that isn't in the list yet — a new release, something the API
    // hasn't caught up with — has to be submittable under its real name. The
    // normalizer matches by substring and then fuzzily, so left alone it would
    // rewrite "Plane 61" into a listed aircraft that merely reads like it. The
    // confirm step is where the submitter overrules that.
    console.log('\nrenderPickerConfirm — typed a name the normalizer wants to rewrite');
    const confirm = renderConfirm({
        raw: { type: 'Plane 61 Neo', livery: 'Brand New Air' },
        match: { type: 'Plane 06', livery: 'Livery 01' },
    });
    ok('renders cleanly', confirm.view.problems.length === 0, confirm.view.problems.join('; '));
    T('both readings are offered, plus a way back to the form',
        confirm.view.ids, ['pick_usematch_abc123', 'pick_usemine_abc123', 'pick_manual_abc123']);
    T('…labelled with the actual names', confirm.view.labels.slice(0, 2), ['Use Plane 06', 'Keep Plane 61 Neo']);
    ok('the two readings are shown side by side',
        /You typed: \*\*Plane 61 Neo\*\* — \*\*Brand New Air\*\*/.test(confirm.content)
        && /Closest match: \*\*Plane 06\*\* — \*\*Livery 01\*\*/.test(confirm.content), confirm.content);
    ok('…and it says outright that keeping your own wording is the right call for something new',
        /isn't in the list yet, keep your own wording/.test(confirm.content), confirm.content);
    // A long aircraft name must not blow the 80-char button label cap.
    const longName = renderConfirm({
        raw: { type: 'A'.repeat(120), livery: 'x' },
        match: { type: 'B'.repeat(120), livery: 'y' },
    });
    ok('a very long name still renders', longName.view.problems.length === 0, longName.view.problems.join('; '));

    console.log('\nisListedAircraft — what gets flagged for the admin');
    T('a name straight off the list is not flagged', await P.isListedAircraft('Plane 01'), true);
    T('…case and padding don\'t change that', await P.isListedAircraft('  plane 01 '), true);
    // The flag is what tells an admin "this name is the submitter's, not the
    // game's" — so anything the metadata doesn't carry has to come back false.
    T('a new aircraft is flagged', await P.isListedAircraft('Plane 61 Neo'), false);
    T('a near-miss is flagged rather than assumed', await P.isListedAircraft('Plane 0'), false);
    T('empty is flagged', await P.isListedAircraft(''), false);
    T('null is handled', await P.isListedAircraft(null), false);

    console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
    process.exit(failures ? 1 : 0);
})();
