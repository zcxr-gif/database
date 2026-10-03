'use strict';

/*
 * crewRosterSync.js
 * One list of pilots, kept in two places.
 *
 * A VA has two rosters that used to know nothing of each other:
 *
 *   the VA portal's pilot list   Infinite Flight usernames in our VaPilot
 *                                collection (vaPilots.js). Drives flight-event
 *                                attribution and the public roster API.
 *   the crew center roster       crew_members in the VA's own data store
 *                                (crewStore.js). The pilots who fly, log hours
 *                                and sign in.
 *
 * A VA adding somebody in one place expected them in the other, and removing
 * somebody in one place expected them gone from both. This module is the
 * bridge, in both directions:
 *
 *   crew center -> portal   crewStore emits 'added'/'removed' for every roster
 *                           row it creates or purges, whichever path did it
 *                           (staff add, join form, accepted application, CSV
 *                           import, retention sweep, a pilot leaving). See
 *                           onCrewRosterChange.
 *   portal -> crew center   The portal and staff roster routes call pushAdds /
 *                           pushRemovals after changing VaPilot.
 *
 * REMOVAL IS A PURGE. Taking a pilot off the portal list removes them from the
 * crew center with the same verb staff use there (`purgeMember`): their flight
 * reports, bookings, signups and login go with them. That is what the VA asked
 * for — one roster, one meaning of "removed".
 *
 * IDENTITY. The two sides are matched by IFC username: a crew member's
 * `ifcName`, or their `name` when no IFC name was recorded, against the portal
 * username. Both sides go through rosterMatchKeys so "John_Doe", "john doe" and
 * "johndoe" are the same pilot, exactly as flight attribution already treats
 * them.
 *
 * ECHOES ARE HARMLESS BY CONSTRUCTION. A portal add creates a crew member,
 * whose 'added' event re-adds the username to the portal — a no-op, because
 * addPilots de-dupes. A portal removal purges the member, whose 'removed' event
 * deletes portal rows that are already gone. Nothing here needs a "this one
 * came from me" flag, and nothing loops.
 *
 * Everything is best-effort: a VA with no crew center (no data store) has
 * nothing to sync, and a crew center that is down must not fail a portal edit.
 * Failures are logged and reported as counts, never thrown at the caller.
 */

const crewStore = require('./crewStore');
const vaPilots = require('./vaPilots');

let VaPilot = null;
let VirtualAirlineAd = null;

function configure(models) {
    VaPilot = (models && models.VaPilot) || null;
    VirtualAirlineAd = (models && models.VirtualAirlineAd) || null;
}

const ready = () => !!(VaPilot && VirtualAirlineAd);

// The IFC username a crew member stands for on the portal list.
const handleOf = (member) => String((member && (member.ifcName || member.name)) || '')
    .trim().replace(/^@+/, '').trim();

const keysOf = (raw) => vaPilots.rosterMatchKeys(raw);

const intersects = (keys, set) => keys.some((k) => set.has(k));

// Open the VA's crew center store, or null when it has none. The VA document
// has to be read with crewStore.SELECT — the service key is select:false.
async function openStore(vaAdId) {
    if (!ready() || !vaAdId) return null;
    const va = await VirtualAirlineAd.findById(vaAdId).select(crewStore.SELECT).lean();
    if (!va) return null;
    return crewStore.forVaOrNull(va);
}

// Usernames currently on a VA's portal list, as stored.
async function portalUsernames(vaAdId) {
    if (!ready() || !vaAdId) return [];
    const rows = await VaPilot.find({ vaAdId }).select('username').lean();
    return rows.map((r) => r.username);
}

// --- crew center -> portal --------------------------------------------------

/**
 * The listener crewStore calls for every roster row it creates or removes.
 * Wired once in server.js via crewStore.onRosterChange.
 */
async function onCrewRosterChange(event, vaAdId, member) {
    if (!ready() || !vaAdId) return;
    const handle = handleOf(member);
    if (!handle) return;
    if (event === 'added') {
        await vaPilots.addPilots(VaPilot, vaAdId, [handle], 'Crew center');
    } else if (event === 'removed') {
        await VaPilot.deleteMany({ vaAdId, usernameLower: { $in: keysOf(handle) } });
    }
}

// --- portal -> crew center --------------------------------------------------

/**
 * Put every username in `input` on the crew center roster, skipping anybody
 * already there. `input` takes whatever addPilots takes (array, blob, JSON).
 * Returns { crewCenter, created, failed } — crewCenter false when the VA has no
 * crew center to sync into.
 */
async function pushAdds(vaAdId, input, { store = null } = {}) {
    const out = { crewCenter: false, created: 0, failed: 0 };
    try {
        const parsed = vaPilots.parsePilotUsernames(input);
        if (!parsed.length) return out;
        store = store || await openStore(vaAdId);
        if (!store) return out;
        out.crewCenter = true;

        const members = await store.listMembers({ limit: 5000 });
        const taken = new Set();
        for (const m of members) for (const k of keysOf(handleOf(m))) taken.add(k);

        for (const { username } of parsed) {
            const keys = keysOf(username);
            if (!keys.length || intersects(keys, taken)) continue;
            try {
                await store.createMember({
                    name: username,
                    // Left for staff to issue in their own numbering, as the
                    // staff-portal path does: guessing one risks handing out a
                    // number another pilot already flies.
                    callsign: '',
                    hours: 0, role: '', aircraft: [], status: 'active',
                    ifUserId: '', ifcName: username,
                });
                for (const k of keys) taken.add(k);
                out.created++;
            } catch (err) {
                out.failed++;
                console.warn(`roster sync: could not add ${username} to crew center ${vaAdId}:`, err && err.message);
            }
        }
    } catch (err) {
        console.warn(`roster sync: crew center add failed for ${vaAdId}:`, err && err.message);
        out.failed++;
    }
    return out;
}

/**
 * Purge every crew member who matches one of `usernames` (strings). Returns
 * { crewCenter, purged, failed }.
 */
async function pushRemovals(vaAdId, usernames) {
    const out = { crewCenter: false, purged: 0, failed: 0 };
    // A reconcile that ran while this is still purging would read the pilots
    // not yet reached and copy them straight back onto the portal list. The
    // portal reloads its list the moment Clear all answers, so hold it off.
    holdReconcile(vaAdId);
    try {
        const gone = new Set();
        for (const u of usernames || []) for (const k of keysOf(u)) gone.add(k);
        if (!gone.size) return out;
        const store = await openStore(vaAdId);
        if (!store) return out;
        out.crewCenter = true;

        const members = await store.listMembers({ limit: 5000 });
        for (const m of members) {
            if (!intersects(keysOf(handleOf(m)), gone)) continue;
            try {
                await store.purgeMember(m._id);
                out.purged++;
            } catch (err) {
                out.failed++;
                console.warn(`roster sync: could not remove ${handleOf(m)} from crew center ${vaAdId}:`, err && err.message);
            }
        }
    } catch (err) {
        console.warn(`roster sync: crew center removal failed for ${vaAdId}:`, err && err.message);
        out.failed++;
    }
    return out;
}

// --- both ways --------------------------------------------------------------

/**
 * Make the two lists the union of each other. Brings VAs whose rosters predate
 * the sync into line, and heals anything a failed push left behind. Returns
 * { crewCenter, toPortal, toCrewCenter }.
 */
async function reconcile(vaAdId) {
    const out = { crewCenter: false, toPortal: 0, toCrewCenter: 0 };
    if (!ready() || !vaAdId) return out;
    const store = await openStore(vaAdId);
    if (!store) return out;
    out.crewCenter = true;

    const handles = (await store.listMembers({ limit: 5000 })).map(handleOf).filter(Boolean);
    if (handles.length) {
        const added = await vaPilots.addPilots(VaPilot, vaAdId, handles, 'Crew center');
        out.toPortal = added.added;
    }
    const pushed = await pushAdds(vaAdId, await portalUsernames(vaAdId), { store });
    out.toCrewCenter = pushed.created;
    return out;
}

// Reconcile at most once per VA per window, per process. The portal's roster
// list calls this on every load; the window keeps that from becoming a full
// read of the crew center each time.
const RECONCILE_EVERY_MS = 10 * 60 * 1000;
const lastReconciled = new Map();

function holdReconcile(vaAdId) {
    if (vaAdId) lastReconciled.set(String(vaAdId), Date.now());
}

function reconcileDue(vaAdId) {
    const key = String(vaAdId || '');
    if (!key) return false;
    const at = lastReconciled.get(key) || 0;
    if (Date.now() - at < RECONCILE_EVERY_MS) return false;
    lastReconciled.set(key, Date.now());
    return true;
}

/**
 * Reconcile when due, waiting at most `waitMs` so a big first sync never holds
 * a page load hostage — it carries on in the background past that.
 */
async function reconcileIfDue(vaAdId, { waitMs = 4000 } = {}) {
    if (!ready() || !reconcileDue(vaAdId)) return null;
    const run = reconcile(vaAdId).catch((err) => {
        console.warn(`roster sync: reconcile failed for ${vaAdId}:`, err && err.message);
        return null;
    });
    return Promise.race([run, new Promise((r) => setTimeout(() => r(null), waitMs))]);
}

module.exports = {
    configure,
    onCrewRosterChange,
    pushAdds,
    pushRemovals,
    portalUsernames,
    reconcile,
    reconcileIfDue,
    handleOf,
    RECONCILE_EVERY_MS,
};
