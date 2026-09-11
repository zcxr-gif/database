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

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
