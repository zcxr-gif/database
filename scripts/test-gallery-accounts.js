// test-gallery-accounts.js
// The rules that decide which gallery photos belong to a tracker account.
//
// The interesting properties are all about what claiming must NOT do, because
// the match is on a name somebody typed years before they had an account:
//
//   * a slot another account already holds is never taken, whatever name is on it
//   * a name matches whole, not as a prefix — "Ian" must not take "Ian Simpson"
//   * matching ignores case and surrounding space, because credits were typed
//   * a legacy record (no per-image credits) claims its single top-level credit,
//     and only when no account holds it
//   * the top-level mirrors follow slot 0, as they do everywhere else
//   * photos are counted by slot, not by record: one record can hold three
//     photos belonging to three people
//
// Run:  node scripts/test-gallery-accounts.js

const assert = require('assert');
const accounts = require('../galleryAccounts');

let passed = 0;
const test = (name, fn) => {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err.message}`);
        process.exitCode = 1;
    }
};

const IAN = {
    pilotId: 'uuid-ian',
    handle: 'ian',
    displayName: 'Ian Simpson',
    ifUsername: 'ian_simpson',
};
const OTHER = { pilotId: 'uuid-other', handle: 'bm485', displayName: 'BM485', ifUsername: 'BM485' };

const slot = (over = {}) => ({ name: 'Ian Simpson', id: null, pilotId: null, ifUsername: null, ...over });

console.log('identityNames');

test('collects IF username, display name and handle, lowercased', () => {
    assert.deepStrictEqual(accounts.identityNames(IAN).sort(), ['ian', 'ian simpson', 'ian_simpson']);
});

test('drops blanks, duplicates and single characters', () => {
    const names = accounts.identityNames({ ifUsername: 'Zed', displayName: 'zed', handle: 'z' });
    assert.deepStrictEqual(names, ['zed']);
});

console.log('planClaim');

test('claims a free slot whose credit matches', () => {
    const docs = [{ _id: 'a', imageContributors: [slot()] }];
    const { claimed, writes } = accounts.planClaim(docs, IAN);
    assert.strictEqual(claimed, 1);
    assert.strictEqual(writes.length, 1);
    const set = writes[0].updateOne.update.$set;
    assert.strictEqual(set.imageContributors[0].pilotId, 'uuid-ian');
    assert.strictEqual(set.imageContributors[0].ifUsername, 'ian_simpson');
    // slot 0 claimed, so the legacy mirrors follow it
    assert.strictEqual(set.contributorPilotId, 'uuid-ian');
    assert.strictEqual(set.contributorIfUsername, 'ian_simpson');
});

test('never takes a slot another account already holds', () => {
    const docs = [{ _id: 'a', imageContributors: [slot({ pilotId: OTHER.pilotId, ifUsername: 'BM485' })] }];
    const { claimed, writes } = accounts.planClaim(docs, IAN);
    assert.strictEqual(claimed, 0);
    assert.strictEqual(writes.length, 0);
});

test('matches the whole credit, not a prefix', () => {
    const shortName = { pilotId: 'uuid-i', handle: 'i2', displayName: 'Ian', ifUsername: 'Ian' };
    const docs = [{ _id: 'a', imageContributors: [slot({ name: 'Ian Simpson' })] }];
    assert.strictEqual(accounts.planClaim(docs, shortName).claimed, 0);
});

test('ignores case and surrounding space', () => {
    const docs = [{ _id: 'a', imageContributors: [slot({ name: '  IAN SIMPSON ' })] }];
    assert.strictEqual(accounts.planClaim(docs, IAN).claimed, 1);
});

test('claims only the matching slots of a shared record', () => {
    const docs = [{
        _id: 'a',
        imageContributors: [
            slot({ name: 'Tamás Martényi' }),
            slot({ name: 'ian_simpson' }),
            slot({ name: 'BM485' }),
        ],
    }];
    const { claimed, writes } = accounts.planClaim(docs, IAN);
    assert.strictEqual(claimed, 1);
    const set = writes[0].updateOne.update.$set;
    assert.strictEqual(set.imageContributors[0].pilotId, null);
    assert.strictEqual(set.imageContributors[1].pilotId, 'uuid-ian');
    assert.strictEqual(set.imageContributors[2].pilotId, null);
    // slot 0 is somebody else's, so the mirrors must not move
    assert.strictEqual(set.contributorPilotId, undefined);
});

test('claims a legacy record through its top-level credit', () => {
    const docs = [{ _id: 'a', contributorName: 'Ian Simpson', imageContributors: [] }];
    const { claimed, writes } = accounts.planClaim(docs, IAN);
    assert.strictEqual(claimed, 1);
    assert.deepStrictEqual(writes[0].updateOne.update.$set, {
        contributorPilotId: 'uuid-ian',
        contributorIfUsername: 'ian_simpson',
    });
});

test('leaves a legacy record that another account already holds', () => {
    const docs = [{ _id: 'a', contributorName: 'Ian Simpson', contributorPilotId: OTHER.pilotId, imageContributors: [] }];
    assert.strictEqual(accounts.planClaim(docs, IAN).claimed, 0);
});

test('an account with no usable name claims nothing', () => {
    const docs = [{ _id: 'a', imageContributors: [slot()] }];
    assert.strictEqual(accounts.planClaim(docs, { pilotId: 'x' }).claimed, 0);
});

test('an identity without a pilotId claims nothing', () => {
    const docs = [{ _id: 'a', imageContributors: [slot()] }];
    assert.strictEqual(accounts.planClaim(docs, { displayName: 'Ian Simpson' }).claimed, 0);
});

test('a second run claims nothing more', () => {
    const docs = [{ _id: 'a', imageContributors: [slot()] }];
    const first = accounts.planClaim(docs, IAN);
    const after = [{ _id: 'a', imageContributors: first.writes[0].updateOne.update.$set.imageContributors }];
    assert.strictEqual(accounts.planClaim(after, IAN).claimed, 0);
});

console.log('countOwnedPhotos');

test('counts slots, not records', () => {
    const docs = [
        { imageContributors: [slot({ pilotId: 'uuid-ian' }), slot({ pilotId: 'uuid-ian' }), slot({ pilotId: 'uuid-other' })] },
        { imageContributors: [slot({ pilotId: 'uuid-other' })] },
    ];
    assert.strictEqual(accounts.countOwnedPhotos(docs, 'uuid-ian'), 2);
});

test('counts a legacy record as one photo', () => {
    const docs = [{ contributorPilotId: 'uuid-ian', imageContributors: [] }];
    assert.strictEqual(accounts.countOwnedPhotos(docs, 'uuid-ian'), 1);
});

console.log('creditName');

test('prefers the IF username, then the display name, then the handle', () => {
    assert.strictEqual(accounts.creditName(IAN), 'ian_simpson');
    assert.strictEqual(accounts.creditName({ displayName: 'Ian', handle: 'ian' }), 'Ian');
    assert.strictEqual(accounts.creditName({ handle: 'ian' }), 'ian');
    assert.strictEqual(accounts.creditName(null), null);
});

console.log(`\n${passed} passed`);
