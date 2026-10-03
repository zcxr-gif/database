'use strict';

/*
 * The VA portal pilot list and the crew center roster stay one list.
 *
 *   node scripts/test-crew-roster-sync.js
 *
 * No database: VaPilot is an in-memory stand-in with the handful of query
 * shapes vaPilots.js uses, and the crew center is the real LegacyStore over
 * in-memory CrewMember/CrewPirep models, so the roster-change events under test
 * are the ones crewStore actually emits.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const crewStore = require('../crewStore');
const crewRosterSync = require('../crewRosterSync');

const VA_ID = new mongoose.Types.ObjectId();
const OTHER_VA = new mongoose.Types.ObjectId();

// --- in-memory models -------------------------------------------------------

const chain = (value) => {
    const q = { select: () => q, sort: () => q, skip: () => q, limit: () => q, lean: () => q, then: (a, b) => Promise.resolve(value()).then(a, b) };
    return q;
};
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.map(String).includes(String(doc[k]));
    return String(doc[k]) === String(v);
});

function collection() {
    const rows = [];
    return {
        rows,
        find: (f) => chain(() => rows.filter((r) => matches(r, f))),
        findOne: (f) => chain(() => rows.find((r) => matches(r, f)) || null),
        findById: (id) => chain(() => rows.find((r) => String(r._id) === String(id)) || null),
        countDocuments: async (f) => rows.filter((r) => matches(r, f)).length,
        insertMany: async (docs) => { for (const d of docs) rows.push({ _id: new mongoose.Types.ObjectId(), ...d }); },
        create: async (d) => { const doc = { _id: new mongoose.Types.ObjectId(), ...d }; rows.push(doc); return doc; },
        deleteOne: async (f) => { const i = rows.findIndex((r) => matches(r, f)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
        deleteMany: async (f) => { let n = 0; for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], f)) { rows.splice(i, 1); n++; } return { deletedCount: n }; },
        findOneAndDelete: (f) => chain(() => { const i = rows.findIndex((r) => matches(r, f)); return i >= 0 ? rows.splice(i, 1)[0] : null; }),
    };
}

const VaPilot = collection();
const VirtualAirlineAd = collection();
const CrewMember = collection();
const CrewPirep = collection();
VirtualAirlineAd.rows.push({ _id: VA_ID, slug: 'testva', name: 'Test VA' });

crewStore.configure({ CrewMember, CrewPirep });
crewRosterSync.configure({ VaPilot, VirtualAirlineAd });
crewStore.onRosterChange(crewRosterSync.onCrewRosterChange);

// The legacy store is handed out only to a VA with managed data; for the test
// it always is.
const store = new crewStore.LegacyStore({ _id: VA_ID, slug: 'testva' });
crewStore.forVaOrNull = async () => store;

const vaPilots = require('../vaPilots');
const portal = () => VaPilot.rows.filter((r) => String(r.vaAdId) === String(VA_ID)).map((r) => r.username).sort();
const crew = () => CrewMember.rows.map((m) => m.ifcName || m.name).sort();
// Roster-change listeners run detached; let them land.
const settle = () => new Promise((r) => setTimeout(r, 10));

(async () => {
    // Crew center add -> portal.
    await store.createMember({ name: 'Jane Doe', ifcName: 'Jane_Doe', callsign: 'TST001' });
    await settle();
    assert.deepStrictEqual(portal(), ['Jane_Doe'], 'crew center add reaches the portal list');

    // Portal add -> crew center; a separator variant of an existing pilot is
    // the same pilot, not a second one.
    await vaPilots.addPilots(VaPilot, VA_ID, 'NewPilot, jane doe', 'owner');
    const pushed = await crewRosterSync.pushAdds(VA_ID, 'NewPilot, jane doe');
    await settle();
    assert.strictEqual(pushed.created, 1, 'only the genuinely new pilot is created');
    assert.deepStrictEqual(crew(), ['Jane_Doe', 'NewPilot']);
    const created = CrewMember.rows.find((m) => m.ifcName === 'NewPilot');
    assert.strictEqual(created.status, 'active');
    assert.strictEqual(created.callsign, '', 'no callsign is guessed');
    // The echo of that create is a no-op on the portal side.
    assert.deepStrictEqual(portal(), ['Jane_Doe', 'NewPilot', 'jane doe'].sort());

    // Portal remove -> crew center purge (flights included).
    CrewPirep.rows.push({ _id: new mongoose.Types.ObjectId(), vaAdId: VA_ID, memberId: created._id });
    const row = VaPilot.rows.find((r) => r.username === 'NewPilot');
    const out = await vaPilots.removePilot(VaPilot, VA_ID, row._id);
    assert.strictEqual(out.username, 'NewPilot', 'removePilot reports who it removed');
    const purged = await crewRosterSync.pushRemovals(VA_ID, [out.username]);
    await settle();
    assert.strictEqual(purged.purged, 1);
    assert.deepStrictEqual(crew(), ['Jane_Doe']);
    assert.strictEqual(CrewPirep.rows.length, 0, 'their flights go with them');

    // Crew center purge -> portal, every spelling of them.
    const jane = CrewMember.rows.find((m) => m.ifcName === 'Jane_Doe');
    await store.purgeMember(jane._id);
    await settle();
    assert.deepStrictEqual(portal(), [], 'crew center removal clears every variant from the portal list');

    // Another VA's list is never touched.
    VaPilot.rows.push({ _id: new mongoose.Types.ObjectId(), vaAdId: OTHER_VA, username: 'Jane_Doe', usernameLower: 'jane_doe' });
    await store.createMember({ name: 'Jane_Doe', ifcName: 'Jane_Doe' });
    await settle();
    const j2 = CrewMember.rows.find((m) => m.ifcName === 'Jane_Doe');
    await store.purgeMember(j2._id);
    await settle();
    assert.strictEqual(VaPilot.rows.filter((r) => String(r.vaAdId) === String(OTHER_VA)).length, 1);

    // Reconcile: lists that predate the sync become each other's union.
    crewStore.onRosterChange(null);  // seed both sides without the listener
    await store.createMember({ name: 'Crew Only', ifcName: 'CrewOnly' });
    await vaPilots.addPilots(VaPilot, VA_ID, ['PortalOnly'], 'owner');
    crewStore.onRosterChange(crewRosterSync.onCrewRosterChange);
    const rec = await crewRosterSync.reconcile(VA_ID);
    await settle();
    assert.deepStrictEqual(rec, { crewCenter: true, toPortal: 1, toCrewCenter: 1 });
    assert.deepStrictEqual(portal(), ['CrewOnly', 'PortalOnly']);
    assert.deepStrictEqual(crew(), ['CrewOnly', 'PortalOnly']);

    // A VA with no crew center: the portal still works, nothing is pushed.
    crewStore.forVaOrNull = async () => null;
    assert.deepStrictEqual(await crewRosterSync.pushAdds(VA_ID, ['Someone']), { crewCenter: false, created: 0, failed: 0 });
    assert.deepStrictEqual(await crewRosterSync.pushRemovals(VA_ID, ['CrewOnly']), { crewCenter: false, purged: 0, failed: 0 });

    console.log('crew roster sync: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
