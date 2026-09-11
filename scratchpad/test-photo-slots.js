'use strict';
// Conformance test for WHERE an approved aircraft photo lands, and for what
// that placement costs the photos already on record.
//
// An aircraft holds up to 3 photos. A review card used to offer two choices:
//
//   • Replace Photo N — the new photo takes the slot and the photo that was
//     there is deleted from S3
//   • Add Photo N     — appended after the last photo
//
// So an admin who wanted a better shot to become the PRIMARY photo had to
// replace Photo 1, which threw the previous primary away even when slots 2 and
// 3 were sitting empty. 'insert' is the third choice: the new photo takes the
// slot and the photos at/after it slide down one (1 → 2, 2 → 3). Nothing is
// deleted, and the credit for each shifted photo moves with it.
//
// The one case an insert must NOT do is run on a full record, where the slide
// would push Photo 3 off the end — that is the very loss it exists to prevent.
// The record can fill up between the card being rendered and the button being
// clicked (another admin approves a duplicate submission first), so the mode is
// resolved against the LIVE image count, and 'full' tells the handler to abort.
//
// The helpers live inside the bot's client closure and are not exported, so
// they are lifted out of bot.js by name. Brittle on purpose: a rename fails
// here with "could not find" rather than quietly stopping the test.
//
// Run:  node scratchpad/test-photo-slots.js

const fs = require('fs');
const path = require('path');

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

const NAMES = ['MAX_AIRCRAFT_IMAGES', 'resolveAircraftSlot', 'applyAircraftPlacement', 'moveAircraftPhoto'];
// eslint-disable-next-line no-new-func
const H = new Function(`${NAMES.map(lift).join('\n')}\nreturn { ${NAMES.join(', ')} };`)();

let failures = 0;
const T = (label, got, expected) => {
    if (JSON.stringify(got) === JSON.stringify(expected)) { console.log('  ✓', label); return; }
    failures++;
    console.log('  ✗', label, '\n      got:', JSON.stringify(got), '\n      want:', JSON.stringify(expected));
};

T('an aircraft holds three photos', H.MAX_AIRCRAFT_IMAGES, 3);

console.log('\nresolveAircraftSlot — insert (the non-destructive choice)');
T('insert at 1 with one photo on record shifts it to 2',
    H.resolveAircraftSlot('insert', 1, 1), { slotIndex: 0, mode: 'insert' });
T('insert at 1 with two photos on record shifts both down',
    H.resolveAircraftSlot('insert', 1, 2), { slotIndex: 0, mode: 'insert' });
T('insert at 2 with two photos on record shifts only the second',
    H.resolveAircraftSlot('insert', 2, 2), { slotIndex: 1, mode: 'insert' });
// The record filled up after the card was rendered. Sliding would now push
// Photo 3 out of the database, so the handler is told to abort instead.
T('insert on a full record is refused, not silently destructive',
    H.resolveAircraftSlot('insert', 1, 3), { slotIndex: 0, mode: 'full' });
T('…at any slot of a full record', H.resolveAircraftSlot('insert', 2, 3), { slotIndex: 1, mode: 'full' });
// Nothing to displace: inserting past the last photo is an append.
T('insert past the last photo is an append', H.resolveAircraftSlot('insert', 3, 1), { slotIndex: 1, mode: 'append' });
T('insert on an empty record is an append', H.resolveAircraftSlot('insert', 1, 0), { slotIndex: 0, mode: 'append' });

console.log('\nresolveAircraftSlot — insertend (the displaced photo goes to the back)');
// "Make this the primary and send the old primary to the back" rather than
// sliding it one place down.
T('insertend at 1 with two photos sends the displaced one to the end',
    H.resolveAircraftSlot('insertend', 1, 2), { slotIndex: 0, mode: 'insertEnd' });
// With nothing after the displaced photo, "down one" already IS the back, so
// the two collapse to the same move and the card offers only one button.
T('insertend collapses to a plain insert when the displaced photo is last',
    H.resolveAircraftSlot('insertend', 1, 1), { slotIndex: 0, mode: 'insert' });
T('…and at the last slot of a two-photo record',
    H.resolveAircraftSlot('insertend', 2, 2), { slotIndex: 1, mode: 'insert' });
T('insertend on a full record is refused like any other insert',
    H.resolveAircraftSlot('insertend', 1, 3), { slotIndex: 0, mode: 'full' });
T('insertend past the last photo is an append',
    H.resolveAircraftSlot('insertend', 3, 1), { slotIndex: 1, mode: 'append' });

console.log('\nresolveAircraftSlot — add / replace / legacy are unchanged');
T('add on an empty record takes slot 1', H.resolveAircraftSlot('add', 1, 0), { slotIndex: 0, mode: 'append' });
// The button said "Add Photo 1" when the record was empty; by click time a
// duplicate had been approved. Appending (not overwriting slot 1) is the fix
// this re-check exists for.
T('add rendered against an empty record appends to the live one',
    H.resolveAircraftSlot('add', 1, 2), { slotIndex: 2, mode: 'append' });
T('add on a full record falls back to overwriting the last slot',
    H.resolveAircraftSlot('add', 3, 3), { slotIndex: 2, mode: 'replace' });
T('replace targets its slot', H.resolveAircraftSlot('replace', 2, 3), { slotIndex: 1, mode: 'replace' });
T('replace of a photo that is gone appends instead',
    H.resolveAircraftSlot('replace', 3, 1), { slotIndex: 1, mode: 'append' });
T('a legacy button with no action infers a replace',
    H.resolveAircraftSlot(null, 1, 2), { slotIndex: 0, mode: 'replace' });
T('a legacy button past the last photo infers an append',
    H.resolveAircraftSlot(null, 2, 1), { slotIndex: 1, mode: 'append' });

console.log('\napplyAircraftPlacement — what happens to the photos already there');
const NEW = 'new.webp';
const NEWBIE = { name: 'Newbie', id: '2' };
const run = (imgs, action, slot) => {
    const images = imgs.slice();
    const contributors = imgs.map((u, i) => ({ name: `C${i + 1}`, id: String(i + 1) }));
    const placement = H.resolveAircraftSlot(action, slot, images.length);
    const replaced = H.applyAircraftPlacement(images, contributors, placement, NEW, NEWBIE);
    return { images, credits: contributors.map(c => c.name), replaced, mode: placement.mode };
};

// The headline case: a better shot becomes Photo 1 and the old primary lives on
// as Photo 2 instead of being deleted from the bucket.
T('insert at 1 demotes the current primary rather than deleting it',
    run(['a.webp'], 'insert', 1),
    { images: [NEW, 'a.webp'], credits: ['Newbie', 'C1'], replaced: null, mode: 'insert' });
T('insert at 1 with two photos pushes 1 → 2 and 2 → 3',
    run(['a.webp', 'b.webp'], 'insert', 1),
    { images: [NEW, 'a.webp', 'b.webp'], credits: ['Newbie', 'C1', 'C2'], replaced: null, mode: 'insert' });
T('insert at 2 leaves the primary alone and pushes 2 → 3',
    run(['a.webp', 'b.webp'], 'insert', 2),
    { images: ['a.webp', NEW, 'b.webp'], credits: ['C1', 'Newbie', 'C2'], replaced: null, mode: 'insert' });
// A null `replaced` is what keeps the caller from deleting anything from S3.
T('an insert never reports a photo to delete', run(['a.webp', 'b.webp'], 'insert', 1).replaced, null);

T('replace overwrites its slot and reports the old URL for deletion',
    run(['a.webp', 'b.webp'], 'replace', 1),
    { images: [NEW, 'b.webp'], credits: ['Newbie', 'C2'], replaced: 'a.webp', mode: 'replace' });
T('replacing photo 2 does not disturb photo 1 or its credit',
    run(['a.webp', 'b.webp'], 'replace', 2),
    { images: ['a.webp', NEW], credits: ['C1', 'Newbie'], replaced: 'b.webp', mode: 'replace' });
// The "first to 3rd" case: the new shot becomes the primary and the old primary
// goes to the back, with the middle photo moving up to fill the gap.
T('insertend at 1 puts the new photo first and the old primary last',
    run(['a.webp', 'b.webp'], 'insertend', 1),
    { images: [NEW, 'b.webp', 'a.webp'], credits: ['Newbie', 'C2', 'C1'], replaced: null, mode: 'insertEnd' });
T('an insertend never reports a photo to delete', run(['a.webp', 'b.webp'], 'insertend', 1).replaced, null);

T('add appends and deletes nothing',
    run(['a.webp'], 'add', 2),
    { images: ['a.webp', NEW], credits: ['C1', 'Newbie'], replaced: null, mode: 'append' });
T('the first photo of an aircraft just appends',
    run([], 'add', 1),
    { images: [NEW], credits: ['Newbie'], replaced: null, mode: 'append' });

console.log('\nmoveAircraftPhoto — reordering a record that is already saved (/photos)');
const reorder = (imgs, from, to) => {
    const images = imgs.slice();
    const contributors = imgs.map((u, i) => ({ name: `C${i + 1}`, id: String(i + 1) }));
    const moved = H.moveAircraftPhoto(images, contributors, from - 1, to - 1);
    return { moved, images, credits: contributors.map(c => c.name) };
};
const THREE = ['a.webp', 'b.webp', 'c.webp'];
T('promoting Photo 3 to primary shifts the others down',
    reorder(THREE, 3, 1), { moved: true, images: ['c.webp', 'a.webp', 'b.webp'], credits: ['C3', 'C1', 'C2'] });
T('demoting Photo 1 to the back pulls the others up',
    reorder(THREE, 1, 3), { moved: true, images: ['b.webp', 'c.webp', 'a.webp'], credits: ['C2', 'C3', 'C1'] });
T('a one-place move swaps neighbours',
    reorder(THREE, 1, 2), { moved: true, images: ['b.webp', 'a.webp', 'c.webp'], credits: ['C2', 'C1', 'C3'] });
T('credit travels with the photo, never with the slot',
    reorder(THREE, 2, 1).credits[0], 'C2');
// A refused move means the caller re-renders instead of writing: the record is
// left exactly as it was.
T('moving a photo onto itself is refused', reorder(THREE, 2, 2), { moved: false, images: THREE, credits: ['C1', 'C2', 'C3'] });
T('a slot past the end is refused', reorder(THREE, 4, 1).moved, false);
T('a slot before the start is refused', reorder(THREE, 0, 1).moved, false);
T('a non-integer slot is refused', H.moveAircraftPhoto(THREE.slice(), [], NaN, 0), false);
T('a single-photo record has no move to make', reorder(['a.webp'], 1, 1).moved, false);
// Reordering is lossless by construction — it is the answer to "we don't want
// to trash something".
for (let from = 1; from <= 3; from++) {
    for (let to = 1; to <= 3; to++) {
        const { images } = reorder(THREE, from, to);
        if (images.length !== 3 || !THREE.every(u => images.includes(u))) {
            failures++;
            console.log('  ✗', `move ${from} → ${to} lost or duplicated a photo:`, JSON.stringify(images));
        }
    }
}

console.log('\nno placement ever overflows the record');
for (const action of ['insert', 'insertend', 'add', 'replace', null]) {
    for (let count = 0; count <= 3; count++) {
        for (let slot = 1; slot <= 3; slot++) {
            const images = Array.from({ length: count }, (_, i) => `p${i}.webp`);
            const contributors = images.map((_, i) => ({ name: `C${i}`, id: String(i) }));
            const placement = H.resolveAircraftSlot(action, slot, count);
            if (placement.mode === 'full') continue; // refused: the handler aborts
            H.applyAircraftPlacement(images, contributors, placement, NEW, NEWBIE);
            if (images.length > H.MAX_AIRCRAFT_IMAGES || images.length !== contributors.length) {
                failures++;
                console.log('  ✗', `${action}/${slot} on ${count} photo(s) →`, JSON.stringify(images));
            }
            // Whatever mode ran, the new photo must actually be on record.
            if (!images.includes(NEW)) {
                failures++;
                console.log('  ✗', `${action}/${slot} on ${count} photo(s) lost the submitted photo`);
            }
        }
    }
}
console.log(failures ? '  ✗ see above' : '  ✓ every action/slot/count combination stays within 3 aligned slots');

// An insert is only ever offered while a slot is free, and in that window it
// must be lossless: every photo that was on record is still on record.
console.log('\nan offered insert never loses a photo');
for (const action of ['insert', 'insertend']) {
    for (let count = 1; count <= 2; count++) {
        for (let slot = 1; slot <= count; slot++) {
            const before = Array.from({ length: count }, (_, i) => `p${i}.webp`);
            const { images } = run(before, action, slot);
            const kept = before.every(u => images.includes(u));
            if (!kept) { failures++; console.log('  ✗', `${action} at ${slot} on ${count} photo(s) dropped one`); }
        }
    }
}
console.log(failures ? '  ✗ see above' : '  ✓ every insert the card offers keeps all existing photos');

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
