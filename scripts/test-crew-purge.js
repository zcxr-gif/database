// test-crew-purge.js
// What "remove this pilot" actually removes.
//
// purgeMember is not a pure function — it talks to a store — so this stands a
// fake PostgREST layer under the real SupabaseStore and asserts the CONTRACT
// rather than the SQL: which tables are touched, in what order, that they are
// scoped to one pilot at one airline, and what happens when a table is missing
// or refuses.
//
// Every one of those is a rule somebody could break by reordering a list, and
// one of them (the login going, always) is the difference between a pilot who
// was removed and a pilot who was told they were removed and can still sign in.
//
// Run:  node scripts/test-crew-purge.js
'use strict';

/* crewStore requires axios at load time and this test never makes a request —
 * it replaces the client wholesale. So where the dependency is not installed
 * (a checkout with no node_modules, which is how several of the other scripts
 * in here fail to start), a stub is put in its place just far enough to let
 * the module load. Where axios IS installed, nothing is patched and the real
 * one loads, so this cannot hide a genuine import problem. */
(function shimAxiosIfAbsent() {
    try { require.resolve('axios'); return; } catch (_) { /* not installed */ }
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'axios') {
            const nope = () => Promise.reject(new Error('axios is stubbed in this test'));
            nope.default = nope;
            return nope;
        }
        return load.apply(this, arguments);
    };
})();

let pass = 0;
const fails = [];
const check = (what, ok) => { if (ok) pass++; else fails.push(what); };

const crewStore = require('../crewStore');
const { CrewStoreError, SupabaseStore } = crewStore;

/** A stand-in for the PostgREST client, recording what it was asked to do. */
function fakeDb({ missing = [], refuses = [], rows = {} } = {}) {
    const calls = [];
    // The REAL error class, because purgeMember distinguishes a missing table
    // from a broken one with `instanceof` — a look-alike would take the wrong
    // branch and the test would pass while the code was wrong.
    const err = (code, status) => new CrewStoreError(code, { status, code });
    return {
        calls,
        dropped: new Set(),
        removeReturning(table, params) {
            calls.push({ table, params, returning: true });
            if (missing.includes(table)) return Promise.reject(err('store_schema_missing', 502));
            if (refuses.includes(table)) return Promise.reject(err('store_unreachable', 502));
            return Promise.resolve(rows[table] || []);
        },
        remove(table, params) {
            calls.push({ table, params, returning: false });
            if (missing.includes(table)) return Promise.reject(err('store_schema_missing', 502));
            if (refuses.includes(table)) return Promise.reject(err('store_unreachable', 502));
            return Promise.resolve(null);
        },
    };
}

/** A SupabaseStore with its client swapped out. The constructor wants a VA
 *  record and a connection; neither is reachable here and neither is what is
 *  under test, so the prototype is used directly with the two fields
 *  purgeMember actually reads. */
function storeWith(db) {
    const store = Object.create(SupabaseStore.prototype);
    store.slug = 'testva';
    store.db = db;
    return store;
}

const TABLES = [
    'crew_shop_orders', 'crew_training_requests', 'crew_bookings',
    'crew_event_signups', 'crew_notifications', 'crew_pireps',
    'crew_accounts', 'crew_members',
];

/* ------------------------------------------------------- the ordinary case */
(async () => {
    {
        const db = fakeDb({ rows: { crew_pireps: [1, 2, 3], crew_accounts: [1] } });
        const store = storeWith(db);
        const out = await store.purgeMember('m1');

        const touched = db.calls.map((c) => c.table);
        check('every table that holds a pilot is cleared',
            TABLES.every((t) => touched.includes(t)));
        check('…the roster row goes last, so a half-run leaves a pilot rather than orphans',
            touched[touched.length - 1] === 'crew_members');
        check('…and the login goes immediately before it',
            touched[touched.length - 2] === 'crew_accounts');
        check('nothing is touched outside this airline',
            db.calls.every((c) => c.params.va_slug === 'eq.testva'));
        check('nothing is touched belonging to another pilot',
            db.calls.slice(0, -1).every((c) => c.params.member_id === 'eq.m1')
            // The roster row is matched by id, not by member_id.
            && db.calls[db.calls.length - 1].params.id === 'eq.m1');
        check('what was removed is counted, not guessed',
            out.ok === true && out.removed.crew_pireps === 3
            && out.removed.crew_accounts === 1 && out.removed.crew_members === 1);
        check('…and nothing is reported as failed when nothing failed',
            Array.isArray(out.failed) && out.failed.length === 0);
    }

    /* ------------------------------------------------ a project behind on SQL */
    {
        // A pre-v15 project has no shop and a pre-v6 one has no signups. There
        // is nothing of this pilot's in a table that does not exist, so the
        // purge must not stop — refusing to remove somebody because their VA
        // has not re-run the SQL is the wrong answer to the wrong question.
        const db = fakeDb({ missing: ['crew_shop_orders', 'crew_event_signups', 'crew_training_requests'] });
        const store = storeWith(db);
        const out = await store.purgeMember('m1');
        check('a table the project has not got is counted as zero, not as a failure',
            out.ok === true && out.removed.crew_shop_orders === 0 && out.failed.length === 0);
        check('…and the run carries on to the roster row',
            db.calls.map((c) => c.table).includes('crew_members'));
    }

    /* ------------------------------------------------------ a table that fails */
    {
        const db = fakeDb({ refuses: ['crew_bookings'] });
        const store = storeWith(db);
        const out = await store.purgeMember('m1');
        check('a table that refuses is named rather than swallowed',
            out.failed.includes('crew_bookings'));
        check('…and does not stop the login or the roster row going',
            db.calls.map((c) => c.table).includes('crew_accounts')
            && db.calls.map((c) => c.table).includes('crew_members'));
    }

    /* ----------------------------------------- the one failure worth throwing */
    {
        // Everything else left behind is clutter. A login left behind is a
        // person who was told they were gone and can still sign in.
        const db = fakeDb({ refuses: ['crew_accounts'] });
        const store = storeWith(db);
        let threw = false;
        try { await store.purgeMember('m1'); } catch (_) { threw = true; }
        check('a login that could not be deleted fails the whole purge', threw);
        check('…and the roster row is left, so the pilot is not half-gone',
            !db.calls.map((c) => c.table).includes('crew_members'));
    }

    /* --------------------------------------------------------- a missing id */
    {
        const db = fakeDb();
        const store = storeWith(db);
        const out = await store.purgeMember('');
        check('no id deletes nothing at all',
            out.ok === false && db.calls.length === 0);
    }

    console.log('');
    if (fails.length) {
        fails.forEach((f) => console.log('  FAIL ', f));
        console.log(`\n${pass} passed, ${fails.length} failed`);
        process.exit(1);
    }
    console.log(`${pass} passed`);
})();
