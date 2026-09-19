'use strict';

/*
 * crewStore.js
 * Where a VA's crew data actually lives.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * --------------------------------------
 * A VA's operational data belongs to the VA and is stored in the VA's own
 * Supabase project — never in ours. Inflight keeps only what it needs to run
 * the platform: the VA's *staff* logins, and the VA's directory/branding
 * metadata (name, slug, colours, fleet definitions, rank ladder, join
 * requirements). Rosters, flight reports, applications, applicant emails,
 * events and pilot accounts are created in, read from and deleted from the VA's
 * project.
 *
 * Two adapters implement one interface — with one exception, events, which the
 * legacy adapter refuses rather than implements (see LegacyStore.events for why
 * a retiring storage path is not given new features):
 *
 *   SupabaseStore  The real one. Talks PostgREST to the VA's project with their
 *                  service key. See supabase/crew-center-schema.sql for the
 *                  tables it expects.
 *   LegacyStore    Read/write against our old Mongo collections. It exists for
 *                  exactly one reason: VAs onboarded before bring-your-own-data
 *                  still have rows here, and they must keep working until they
 *                  have migrated. It is never handed to a VA that has never had
 *                  managed data — those get a clear "connect your data store"
 *                  error instead (see forVa + REQUIRE_OWN_STORE).
 *
 * SHAPE PARITY
 * ------------
 * Both adapters return plain objects in the SAME shape the Mongo documents used
 * (`_id`, camelCase fields, Date instances for timestamps). That is deliberate:
 * the route handlers, the public serialisers (publicMember/publicRoute/
 * publicPirep) and the Discord/email notifiers were all written against that
 * shape and none of them had to learn about Postgres.
 *
 * Env:
 *   CREW_STORE_REQUIRE_OWN   'false' lets a VA with no Supabase connection fall
 *                            back to managed Mongo storage indefinitely. The
 *                            default (unset/'true') is the policy: a VA with no
 *                            connection and no legacy rows cannot store data.
 *   CREW_STORE_TIMEOUT_MS    per-request timeout to the VA's project (default 8000).
 */

const axios = require('axios');
// v11. Pulled in for their vocabularies only — the closed lists of kinds,
// sources and statuses a column's check constraint will accept. Keeping the
// lists in the decision modules and reading them here means a value the schema
// refuses cannot be introduced by editing one file: a write that would fail the
// constraint is coerced to the default before it leaves. Neither module requires
// this one, so there is no cycle.
const crewDocs = require('./crewDocs');
const crewInbox = require('./crewInbox');
const crewLinks = require('./crewLinks');

const TIMEOUT_MS = parseInt(process.env.CREW_STORE_TIMEOUT_MS, 10) || 8000;
const REQUIRE_OWN_STORE = String(process.env.CREW_STORE_REQUIRE_OWN || 'true').toLowerCase() !== 'false';

// The schema version this code is written against. A project reporting an older
// version still works for everything that existed then — every column we read
// has existed since v1 — but the health endpoint flags it so the VA knows to
// re-run the SQL. Pilot logins (crew_accounts) arrived in v3 and are the one
// feature that genuinely needs the newer schema; see accountsSupported().
const EXPECTED_SCHEMA_VERSION = 22;

// The version that introduced crew_accounts.
const ACCOUNTS_SCHEMA_VERSION = 3;

// The version that introduced crew_events + crew_event_signups. Like accounts,
// events are a whole feature a pre-v6 project simply has not got — there are no
// columns to degrade, so the crew center names the missing thing instead of
// reporting a broken store over a VA whose roster and routes work fine.
const EVENTS_SCHEMA_VERSION = 6;

// The version that introduced crew_schedules + crew_bookings. Same story as
// events: a pre-v8 project has no schedule tables at all, so the crew center
// names the missing feature rather than reporting a broken store over a VA
// whose roster, routes, flights and events are all answering.
const SCHEDULES_SCHEMA_VERSION = 8;

// The version that introduced crew_storage_usage(). Reported separately for the
// same reason as the others: the storage screen is a whole feature an older
// project cannot answer, and "your database is behind" is a better sentence
// there than a broken panel.
const STORAGE_SCHEMA_VERSION = 9;

// The version that introduced crew_documents. Same story as events and
// schedules: a pre-v11 project has no library table at all, so the crew center
// names the missing feature rather than reporting a broken store over a VA whose
// everything else is answering.
const DOCUMENTS_SCHEMA_VERSION = 11;

// The version that introduced crew_notifications. Reported separately from
// documents even though the two shipped together, because they fail
// independently in the one case that matters: a VA who ran a partial script. A
// library that works while the inbox does not should say exactly that.
const NOTIFICATIONS_SCHEMA_VERSION = 11;

// The version that introduced crew_links and crew_link_open(). Its own constant
// for the same reason the others have one: the links board is a whole feature a
// pre-v12 project has not got, and the panel offers the update button itself
// rather than reporting a broken store over a VA whose everything else answers.
const LINKS_SCHEMA_VERSION = 12;

// The version that added the Infinite Flight link columns to crew_schedules.
// NOT its own feature constant in the mould of the ones above, because it is
// not its own feature: the Live panel works perfectly on a v12 project — the
// fleet, the positions and the Live schedules all come from Infinite Flight, not
// from the VA's Postgres. What a v12 project cannot do is REMEMBER which of its
// own departures it pushed, so the columns sit in LATE_COLUMNS and the push
// degrades to "sent, but we cannot record it here yet" instead of failing.
const IF_LINK_SCHEMA_VERSION = 13;

// The version that introduced crew_training_requests. Its own constant, like
// events and the links board: check-rides are a whole feature a pre-v14 project
// has not got a table for, so the training panel names the missing thing and
// offers the update button itself rather than reporting a broken store over a
// VA whose roster, routes and flights are all answering perfectly.
const TRAINING_SCHEMA_VERSION = 14;

// The version that introduced the leave columns on crew_members. Its own
// constant even though `status = 'loa'` is as old as the roster: the flag has
// always been there, and what a pre-v15 project cannot hold is the date a pilot
// is coming back — which is the whole of what makes leave something a pilot can
// set for themselves rather than a label staff maintain.
const LEAVE_SCHEMA_VERSION = 15;

// The version that introduced crew_shop_items, crew_shop_orders, the wallet
// columns and the four functions that move a balance. One constant for the lot,
// unlike the library and the inbox: a shop with a shelf and no wallet is not a
// half-working shop, it is a broken one, and there is no useful sentence to say
// about a project that has one and not the other.
const SHOP_SCHEMA_VERSION = 15;

// The version that added the Discord columns to crew_accounts. NOT its own
// feature constant in the mould of events or the links board, and for the same
// reason IF_LINK is not: signing in still works perfectly on a v15 project —
// every pilot has a password, and that is the door Discord is a second key to.
// What a v15 project cannot do is REMEMBER which Discord account belongs to
// which login, so the columns sit in LATE_COLUMNS and linking degrades to "your
// database needs updating first" instead of taking the login with it.
const DISCORD_SCHEMA_VERSION = 16;

// The version that gave a staff member's central account a pilot row of its own
// (crew_accounts.portal_account_id) and gave every account a record of which
// version of the pilot terms it has agreed to. Same shape as Discord above and
// for the same reason: a v16 project signs in, flies and manages exactly as it
// did — what it cannot do is REMEMBER either fact, so both sit in LATE_COLUMNS
// and the two features that need them say the database is behind instead of
// taking anything else down with them.
const STAFF_PILOT_SCHEMA_VERSION = 17;

// The version that added the two shelf columns to crew_shop_items and the two
// edit-audit columns to crew_pireps. NOT its own feature constant, and for the
// same reason IF_LINK and Discord are not: the shop, the shelf and the logbook
// all work exactly as they did on a v17 project. What a v17 project cannot do
// is REMEMBER which shelf an item sits on, that it is a flagship, or who last
// corrected a flight's hours by hand — so all four sit in LATE_COLUMNS and the
// features degrade to "drawn as an ordinary tile" and "corrected, but we cannot
// record who did it here yet" rather than failing the write.
const SHOP_SHELVES_SCHEMA_VERSION = 18;

// The version that added the five reset columns to crew_accounts. Its own
// feature constant in the mould of events and the links board rather than a
// silent LATE_COLUMNS entry, because "a pilot can get back in without asking a
// human" is a whole feature a v18 project has not got — and the honest answer
// to a pilot on one is that there is nothing coming and they should message
// their staff, which is a different sentence from "check your inbox". See
// LATE_COLUMNS: these columns are NOT droppable, for the reason discord_id is
// not.
const PASSWORD_RESET_SCHEMA_VERSION = 19;

// The version that introduced crew_staff_applications. Its own constant like
// events, the links board and check-rides, and for the same reason: a pilot
// applying for a job on the team is a whole feature a pre-v20 project has not
// got a table for. The hiring panel names the missing thing and offers the
// update button itself, rather than reporting a broken store over a VA whose
// roster, routes and flights are all answering perfectly.
const STAFF_APPS_SCHEMA_VERSION = 20;

// The version that introduced crew_quiz_attempts. Its own constant like events,
// the links board, check-rides and the hiring queue, and for the same reason: a
// pilot sitting a quiz is a whole feature a pre-v22 project has not got a table
// for, and — because the crew centre's entry gate is read off those rows — a VA
// on an older project must be told the gate cannot hold rather than shown a
// door it has nowhere to record anybody walking through.
const QUIZZES_SCHEMA_VERSION = 22;

// ---------------------------------------------------------------------------
// Columns that arrived after the first release
//
// A VA installs the schema once and, unless something tells them to, never
// thinks about it again. The code moves on: v4 gave an application an
// invitation, v5 split the network into own/codeshare and gated routes on rank.
// A project still on v3 has none of those columns, and PostgREST refuses a
// write that mentions one — it fails the WHOLE row rather than the column, so
// "add a route" returned a bare 502 on every VA who had not re-run the SQL.
// That is our schema drift, showing up as their outage.
//
// So writes degrade instead of failing: a column the project has not got is
// dropped and the write is retried, the store records that it did so, and the
// handler tells the VA what did not make it (see `drift` below and the
// database-update banner in the dashboard). The pilot still gets added; the
// codeshare flag is what waits for the upgrade.
//
// ONLY columns listed here may be dropped. Every one of them is additive and
// carries a default, so a row written without it is a valid row on the old
// shape — which is precisely what makes dropping it safe. Anything else that
// goes missing is a real fault and still fails loudly.
//
// This is the mirror of the `alter table ... add column if not exists` block in
// supabase/crew-center-schema.sql. Add a column there, add it here.
// ---------------------------------------------------------------------------
const LATE_COLUMNS = {
    // v21. A gate is decoration on a leg that is otherwise complete: drop it and
    // the route is still the route, flown between the same two airports. Exactly
    // the test in the note above, and the reason the stands are droppable where
    // the Discord columns below are not.
    crew_routes: new Set(['kind', 'partner_name', 'partner_logo', 'min_rank', 'departure_gate', 'arrival_gate']),
    crew_members: new Set(['checks_passed', 'retention_warned_at']),
    crew_events: new Set(['route_id']),
    crew_pireps: new Set(['event_id', 'schedule_id', 'edited_at', 'edited_by']),
    // v18. Both are presentation: an item written without them is a perfectly
    // ordinary tile on an ungrouped shelf, which is what every item on every
    // shelf was until this shipped. Exactly the test in the note above.
    crew_shop_items: new Set(['item_group', 'tier']),
    crew_schedules: new Set(['if_schedule_id', 'if_aircraft_id', 'if_synced_at', 'if_registration']),
    /* THE DISCORD COLUMNS ARE NOT IN HERE, AND THAT IS THE POINT OF THE RULE
     * ABOVE RATHER THAN AN EXCEPTION TO IT.
     *
     * A droppable column has to pass one test: a row written without it is a
     * valid row on the old shape. `crew_routes.kind` passes — the route is
     * still added, and it is the codeshare flag that waits for the upgrade.
     *
     * `discord_id` fails it, because on a link the column IS the write. Nothing
     * else in that patch matters; drop it and the update succeeds, writes
     * nothing, and the pilot is told "Discord linked. You can use it to sign in
     * from now on." They then cannot, ever, and nothing anywhere says why —
     * the one failure mode worse than an error is a confirmation that is not
     * true. The other three go with it: a username and an avatar with no id
     * against them are a link that does not exist.
     *
     * So a VA on a pre-v16 schema now gets `store_schema_outdated` from the
     * link, which the callback prints as "your database needs updating" with
     * the button that fixes it. `portal_account_id` and the terms columns stay
     * droppable: those writes carry other fields that are worth keeping.
     *
     * THE v19 RESET COLUMNS ARE NOT IN HERE EITHER, and it is the same failure
     * twice over. On a reset request the column IS the write: drop
     * `reset_token_hash` and the update succeeds, stores nothing, and the pilot
     * is told a way back in is on its way. Drop `reset_needs_staff` and the
     * request never reaches the Logins tab, so the staff half does not happen
     * either. Both are a confirmation that is not true, which is the one
     * failure mode worse than an error. */
    crew_accounts: new Set(['portal_account_id', 'terms_version', 'terms_accepted_at']),
    crew_applications: new Set([
        'discord_invite', 'invite_username', 'invite_password',
        'invite_issued_at', 'invite_claimed_at', 'invite_revoked_at', 'invite_account_id',
    ]),
};

// What each dropped column costs, in words a VA reads rather than column names.
const DRIFT_LABELS = {
    'crew_members.checks_passed': 'check-ride sign-offs',
    'crew_members.retention_warned_at': 'roster sweep warnings',
    'crew_events.route_id': 'events tied to a route',
    'crew_pireps.event_id': 'flights logged against an event',
    'crew_pireps.schedule_id': 'flights logged against a scheduled departure',
    'crew_pireps.edited_at': 'a record of hours edited by staff',
    'crew_pireps.edited_by': 'a record of hours edited by staff',
    'crew_shop_items.item_group': 'shelves in the shop',
    'crew_shop_items.tier': 'the shop’s showcase and flagship items',
    'crew_schedules.if_schedule_id': 'departures pushed to Infinite Flight',
    'crew_schedules.if_aircraft_id': 'departures pushed to Infinite Flight',
    'crew_schedules.if_synced_at': 'departures pushed to Infinite Flight',
    'crew_schedules.if_registration': 'the aircraft a departure is flown by',
    'crew_routes.kind': 'codeshare routes',
    'crew_routes.partner_name': 'codeshare partner names',
    'crew_routes.partner_logo': 'codeshare partner logos',
    'crew_routes.min_rank': 'rank-gated routes',
    'crew_routes.departure_gate': 'the gates a route is flown between',
    'crew_routes.arrival_gate': 'the gates a route is flown between',
    // No crew_accounts.discord_* here: they are not droppable, so nothing can
    // ever report them as dropped. See LATE_COLUMNS.
    'crew_accounts.portal_account_id': 'a staff member’s own pilot account',
    'crew_accounts.terms_version': 'the pilot terms a pilot has agreed to',
    'crew_accounts.terms_accepted_at': 'the pilot terms a pilot has agreed to',
    'crew_applications.discord_invite': 'Discord invites on acceptances',
    'crew_applications.invite_username': 'saved pilot invitations',
    'crew_applications.invite_password': 'saved pilot invitations',
    'crew_applications.invite_issued_at': 'saved pilot invitations',
    'crew_applications.invite_claimed_at': 'saved pilot invitations',
    'crew_applications.invite_revoked_at': 'saved pilot invitations',
    'crew_applications.invite_account_id': 'saved pilot invitations',
    // v20. Not a column — the only entry here that is not. `kind` is an inline
    // CHECK constraint, and a project provisioned before the value being
    // written was added refuses it; createAnnouncement posts the notice as a
    // plain one rather than losing it, and records the downgrade here so a
    // response that carries drift can say what was lost. See its note.
    'crew_announcements.kind': 'the icon on a generated notice',
};

const isLateColumn = (table, col) => !!(LATE_COLUMNS[table] && LATE_COLUMNS[table].has(col));

// Remembered per project, not per request: a VA on an old schema would
// otherwise spend one wasted round trip per missing column on every single
// write. The TTL is what lets an upgrade take effect on its own — and
// forgetSchemaDrift() below clears it the moment we install a schema ourselves,
// so the dashboard's "Update database" button never leaves the VA looking at
// stale degradation.
const MISSING_TTL_MS = 10 * 60 * 1000;
const _missingColumns = new Map();   // `${base}|${table}` -> { at, cols:Set }

function missingFor(base, table) {
    const hit = _missingColumns.get(`${base}|${table}`);
    if (!hit) return null;
    if (Date.now() - hit.at > MISSING_TTL_MS) { _missingColumns.delete(`${base}|${table}`); return null; }
    return hit.cols;
}
function noteMissing(base, table, col) {
    const cols = missingFor(base, table);
    if (cols) { cols.add(col); return; }
    _missingColumns.set(`${base}|${table}`, { at: Date.now(), cols: new Set([col]) });
}
/** Forget what a project was missing — call after installing a schema on it. */
function forgetSchemaDrift(url) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!base) { _missingColumns.clear(); return; }
    for (const key of [..._missingColumns.keys()]) {
        if (key.startsWith(`${base}/rest/v1|`)) _missingColumns.delete(key);
    }
}

// Mongo models, injected by server.js so this module doesn't reach into the
// app's DB wiring. Only the legacy adapter touches them.
let models = null;

function configure(m) { models = m || null; }

// ---------------------------------------------------------------------------
// Errors
//
// Handlers map `status` straight onto the HTTP reply, so a failure inside the
// VA's project surfaces as something the VA can act on ("your data store is
// unreachable") rather than a generic 500 that looks like our bug.
// ---------------------------------------------------------------------------
class CrewStoreError extends Error {
    constructor(message, { status = 502, code = 'store_error', detail = '' } = {}) {
        super(message);
        this.name = 'CrewStoreError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

// Postgres' SQLSTATE for a write attempted in a read-only transaction, which
// is what a Supabase project out of disk answers to everything. See explain().
const READ_ONLY_SQLSTATE = '25006';

const NOT_CONNECTED = () => new CrewStoreError(
    'This VA has not connected a data store yet. Connect your Supabase project in Crew Center → Settings → Data store.',
    { status: 409, code: 'store_not_connected' });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// How long a stored pilot callsign may be. It was 20, which is shorter than
// real callsigns are: a pilot's callsign is the VA's airline, a number and a tag
// ("AEROMEXICO CONNECT 007CX" is 24), and truncating it produces a callsign that
// matches neither the VA's registered mask nor the pilot's own flights. Every
// column behind this is `text`, so the cap was only ever a guess. See
// crewCallsign.js for how the string is built.
const CALLSIGN_MAX = 40;
const icao = (v) => str(v, 8).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const num = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
};
const int = (v, min, max) => Math.round(num(v, min, max));
// PostgREST returns timestamptz as an ISO string; Mongo gives a Date. Callers
// (and JSON.stringify) want one of the two, consistently.
const date = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------
// Row mapping: Postgres snake_case <-> the camelCase document shape.
//
// Each entity has a `fromRow` (Postgres -> document) and a `toRow` (document ->
// Postgres). toRow only emits keys that were actually supplied, so a PATCH of
// one field does not overwrite the other twenty with defaults.
// ---------------------------------------------------------------------------
const pick = (obj, out, key, col, fn) => {
    if (obj[key] !== undefined) out[col] = fn(obj[key]);
};

const memberFromRow = (r) => r && {
    _id: r.id,
    name: r.name || '',
    callsign: r.callsign || '',
    hours: Number(r.hours) || 0,
    role: r.role || '',
    aircraft: Array.isArray(r.aircraft) ? r.aircraft : [],
    status: r.status || 'active',
    ifUserId: r.if_user_id || '',
    ifcName: r.ifc_name || '',
    // v7. The rungs this pilot has been signed off for. Names, not indexes —
    // see the schema, and crewRanks' header, for why.
    checksPassed: Array.isArray(r.checks_passed) ? r.checks_passed : [],
    // v10. When the retention sweep last warned this pilot that they were
    // running out of time — either to fly their first flight, or to fly at all.
    // Compared against the join date / last flight rather than cleared, so
    // flying moves the anchor past it and the next silence warns afresh. See
    // crewRetention.alreadyWarned.
    retentionWarnedAt: date(r.retention_warned_at),
    // v15. Leave of absence, as the pilot themselves set it. `status === 'loa'`
    // is still the flag the roster sweep reads; these are the sentence around
    // it. A null `loaUntil` on an 'loa' member is open-ended leave — which is
    // what every hand-set one from before v15 looks like, and is why the sweep
    // treats it exactly as it always did.
    loaUntil: date(r.loa_until),
    loaReason: r.loa_reason || '',
    loaSince: date(r.loa_since),
    // v15. The wallet. Absent columns read as zero rather than as nothing, so a
    // project that predates the shop answers "0" to a balance question instead
    // of putting NaN on a card.
    points: {
        balance: Number(r.points_balance) || 0,
        earned: Number(r.points_earned) || 0,
        spent: Number(r.points_spent) || 0,
    },
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const memberToRow = (m) => {
    const out = {};
    pick(m, out, 'name', 'name', (v) => str(v, 60));
    pick(m, out, 'callsign', 'callsign', (v) => str(v, CALLSIGN_MAX));
    pick(m, out, 'hours', 'hours', (v) => num(v, 0, 1e6));
    pick(m, out, 'role', 'role', (v) => str(v, 40));
    pick(m, out, 'aircraft', 'aircraft', (v) => (Array.isArray(v) ? v.slice(0, 40).map((a) => str(a, 40)).filter(Boolean) : []));
    pick(m, out, 'status', 'status', (v) => (['active', 'loa', 'inactive'].includes(v) ? v : 'active'));
    pick(m, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(m, out, 'ifcName', 'ifc_name', (v) => str(v, 60));
    pick(m, out, 'checksPassed', 'checks_passed', (v) => (Array.isArray(v)
        ? [...new Set(v.map((c) => str(c, 40)).filter(Boolean))].slice(0, 40) : []));
    pick(m, out, 'retentionWarnedAt', 'retention_warned_at', (v) => (v ? new Date(v).toISOString() : null));
    return out;
};

// A crew center login. `passwordHash` is carried in the document shape because
// the caller that compares a password needs it — nothing else may read it, and
// no serialiser in the app emits it (see publicAccount in crewAccounts.js).
const accountFromRow = (r) => r && {
    _id: r.id,
    username: r.username || '',
    displayName: r.display_name || '',
    passwordHash: r.password_hash || '',
    role: r.role || 'pilot',
    memberId: r.member_id || null,
    email: r.email || '',
    active: r.active !== false,
    mustChangePassword: !!r.must_change_password,
    createdVia: r.created_via || '',
    createdByName: r.created_by_name || '',
    // v16. Empty on a project that has not re-run the SQL, and empty on an
    // account that has simply never linked — the two are the same thing to
    // every reader, which is why neither needs telling apart here.
    discordId: r.discord_id || '',
    discordUsername: r.discord_username || '',
    discordAvatar: r.discord_avatar || '',
    discordLinkedAt: date(r.discord_linked_at),
    // v17. The central staff account this row belongs to, when it belongs to
    // one. Empty on every ordinary pilot's row, which is all of them until a
    // staff member provisions their own pilot side.
    portalAccountId: r.portal_account_id || '',
    // v17. Which version of the pilot terms this account has agreed to, and
    // when. Empty means they have not been asked, or were asked and have not
    // answered — the crew center cannot tell those apart and does not need to.
    termsVersion: r.terms_version || '',
    termsAcceptedAt: date(r.terms_accepted_at),
    // v19. A forgotten password. The HASH of the one-time link, never the link
    // — see crewPasswordReset.js, which is the only thing that should read any
    // of these. Empty on every account that has not asked, which is almost all
    // of them almost all of the time.
    resetTokenHash: r.reset_token_hash || '',
    resetTokenExpiresAt: date(r.reset_token_expires_at),
    resetRequestedAt: date(r.reset_requested_at),
    resetNeedsStaff: !!r.reset_needs_staff,
    resetReason: r.reset_reason || '',
    lastLoginAt: date(r.last_login_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const accountToRow = (a) => {
    const out = {};
    pick(a, out, 'username', 'username', (v) => str(v, 60).toLowerCase());
    pick(a, out, 'displayName', 'display_name', (v) => str(v, 80));
    pick(a, out, 'passwordHash', 'password_hash', (v) => str(v, 120));
    pick(a, out, 'role', 'role', (v) => (['pilot', 'staff', 'owner'].includes(v) ? v : 'pilot'));
    pick(a, out, 'memberId', 'member_id', (v) => v || null);
    pick(a, out, 'email', 'email', (v) => str(v, 120).toLowerCase());
    pick(a, out, 'active', 'active', (v) => !!v);
    pick(a, out, 'mustChangePassword', 'must_change_password', (v) => !!v);
    pick(a, out, 'createdVia', 'created_via', (v) => str(v, 40));
    pick(a, out, 'createdByName', 'created_by_name', (v) => str(v, 80));
    pick(a, out, 'lastLoginAt', 'last_login_at', (v) => (date(v) ? date(v).toISOString() : null));
    // A Discord id is digits. Bounded here as well as at the edge because this
    // is the last thing between a value and a unique index somebody else's
    // login depends on.
    pick(a, out, 'discordId', 'discord_id', (v) => (/^[0-9]{5,32}$/.test(String(v || '')) ? String(v) : ''));
    pick(a, out, 'discordUsername', 'discord_username', (v) => str(v, 40));
    pick(a, out, 'discordAvatar', 'discord_avatar', (v) => str(v, 64));
    pick(a, out, 'discordLinkedAt', 'discord_linked_at', (v) => (date(v) ? date(v).toISOString() : null));
    // A Mongo ObjectId, as a string. Bounded here for the same reason the
    // Discord id is: this is the last thing between a value and a unique index
    // that decides whose session a sign-in produces.
    pick(a, out, 'portalAccountId', 'portal_account_id', (v) => (/^[a-f0-9]{24}$/i.test(String(v || '')) ? String(v) : ''));
    pick(a, out, 'termsVersion', 'terms_version', (v) => str(v, 20));
    pick(a, out, 'termsAcceptedAt', 'terms_accepted_at', (v) => (date(v) ? date(v).toISOString() : null));
    // v19. Hex SHA-256, so 64 characters — bounded here as well as at the edge
    // because this is the last thing between a value and the index an
    // unauthenticated reset link is looked up on.
    pick(a, out, 'resetTokenHash', 'reset_token_hash', (v) => (/^[a-f0-9]{64}$/i.test(String(v || '')) ? String(v).toLowerCase() : ''));
    pick(a, out, 'resetTokenExpiresAt', 'reset_token_expires_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'resetRequestedAt', 'reset_requested_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'resetNeedsStaff', 'reset_needs_staff', (v) => !!v);
    pick(a, out, 'resetReason', 'reset_reason', (v) => str(v, 40));
    return out;
};

const routeFromRow = (r) => r && {
    _id: r.id,
    flightNumber: r.flight_number || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraft: r.aircraft || '',
    distanceNm: Number(r.distance_nm) || 0,
    notes: r.notes || '',
    active: r.active !== false,
    // v5. `kind` defaults to 'own' rather than '' so a route read from a
    // pre-v5 project sorts with the airline's own network instead of falling
    // into a third, nonexistent category.
    kind: r.kind === 'codeshare' ? 'codeshare' : 'own',
    partnerName: r.partner_name || '',
    partnerLogo: r.partner_logo || '',
    minRank: r.min_rank || '',
    // v21. Empty on every route a VA has not set them on, which is the default
    // and the common case — gate-to-gate is something an airline opts into.
    departureGate: r.departure_gate || '',
    arrivalGate: r.arrival_gate || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const routeToRow = (r) => {
    const out = {};
    pick(r, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    pick(r, out, 'origin', 'origin', icao);
    pick(r, out, 'destination', 'destination', icao);
    pick(r, out, 'aircraft', 'aircraft', (v) => str(v, 60));
    pick(r, out, 'distanceNm', 'distance_nm', (v) => int(v, 0, 20000));
    pick(r, out, 'notes', 'notes', (v) => str(v, 500));
    pick(r, out, 'active', 'active', (v) => !!v);
    pick(r, out, 'kind', 'kind', (v) => (v === 'codeshare' ? 'codeshare' : 'own'));
    pick(r, out, 'partnerName', 'partner_name', (v) => str(v, 60));
    // A logo lands in an <img> on a public crew center page, so anything that
    // is not plainly an https URL is dropped rather than rendered.
    pick(r, out, 'partnerLogo', 'partner_logo', (v) => {
        const s = str(v, 600);
        return /^https:\/\//i.test(s) ? s : '';
    });
    pick(r, out, 'minRank', 'min_rank', (v) => str(v, 40));
    // A stand is short and the VA types it by hand, so it is bounded and
    // otherwise left alone — every airport names its gates differently and a
    // pattern strict enough to be useful would reject somebody's real terminal.
    pick(r, out, 'departureGate', 'departure_gate', (v) => str(v, 12));
    pick(r, out, 'arrivalGate', 'arrival_gate', (v) => str(v, 12));
    return out;
};

const pirepFromRow = (r) => r && {
    _id: r.id,
    memberId: r.member_id || null,
    routeId: r.route_id || null,
    // v7. The event this flight was flown for, when it was flown for one.
    eventId: r.event_id || null,
    // v8. The scheduled departure it was filed against, when it was flown off
    // the schedule. What lets a departure read as flown rather than only booked.
    scheduleId: r.schedule_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    flightNumber: r.flight_number || '',
    ifUserId: r.if_user_id || '',
    flightId: r.flight_id || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraftName: r.aircraft_name || '',
    liveryName: r.livery_name || '',
    durationMin: Number(r.duration_min) || 0,
    landings: Number(r.landings) || 0,
    xp: Number(r.xp) || 0,
    violations: Number(r.violations) || 0,
    distanceNm: Number(r.distance_nm) || 0,
    server: r.server || '',
    inFleet: !!r.in_fleet,
    source: r.source || 'auto',
    status: r.status || 'pending',
    hoursApplied: !!r.hours_applied,
    // v15. What this flight paid into the wallet, or null if it never has.
    // Null and 0 are different answers — see the column's note in the schema —
    // so this is deliberately not coerced to a number.
    pointsAwarded: r.points_awarded == null ? null : Number(r.points_awarded) || 0,
    flownAt: date(r.flown_at),
    reviewedAt: date(r.reviewed_at),
    // v18. When a staff member last corrected this report by hand, and who.
    // A logbook staff can edit is a logbook that needs to say when they did:
    // the alternative is a pilot's hours changing with nothing anywhere to
    // point at, which is the same class of problem as a silent rejection.
    editedAt: date(r.edited_at),
    editedBy: r.edited_by || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const pirepToRow = (p) => {
    const out = {};
    pick(p, out, 'memberId', 'member_id', (v) => v || null);
    pick(p, out, 'routeId', 'route_id', (v) => v || null);
    pick(p, out, 'eventId', 'event_id', (v) => (str(v, 64) || null));
    pick(p, out, 'scheduleId', 'schedule_id', (v) => (str(v, 64) || null));
    pick(p, out, 'pilotName', 'pilot_name', (v) => str(v, 60));
    pick(p, out, 'callsign', 'callsign', (v) => str(v, CALLSIGN_MAX));
    pick(p, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    pick(p, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(p, out, 'flightId', 'flight_id', (v) => str(v, 60));
    pick(p, out, 'origin', 'origin', icao);
    pick(p, out, 'destination', 'destination', icao);
    pick(p, out, 'aircraftName', 'aircraft_name', (v) => str(v, 60));
    pick(p, out, 'liveryName', 'livery_name', (v) => str(v, 80));
    pick(p, out, 'durationMin', 'duration_min', (v) => int(v, 0, 100000));
    pick(p, out, 'landings', 'landings', (v) => int(v, 0, 100));
    pick(p, out, 'xp', 'xp', (v) => int(v, 0, 1e9));
    pick(p, out, 'violations', 'violations', (v) => int(v, 0, 10000));
    pick(p, out, 'distanceNm', 'distance_nm', (v) => int(v, 0, 20000));
    pick(p, out, 'server', 'server', (v) => str(v, 40));
    pick(p, out, 'inFleet', 'in_fleet', (v) => !!v);
    pick(p, out, 'source', 'source', (v) => (v === 'manual' ? 'manual' : 'auto'));
    pick(p, out, 'status', 'status', (v) => (['pending', 'approved', 'rejected'].includes(v) ? v : 'pending'));
    pick(p, out, 'hoursApplied', 'hours_applied', (v) => !!v);
    pick(p, out, 'flownAt', 'flown_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(p, out, 'reviewedAt', 'reviewed_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(p, out, 'editedAt', 'edited_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(p, out, 'editedBy', 'edited_by', (v) => str(v, 60));
    return out;
};

const applicationFromRow = (r) => r && {
    _id: r.id,
    ifcName: r.ifc_name || '',
    email: r.email || '',
    callsignPrefix: r.callsign_prefix || '',
    callsignNumber: r.callsign_number || '',
    grade: Number(r.grade) || 0,
    ifVerified: !!r.if_verified,
    ifUserId: r.if_user_id || '',
    answers: Array.isArray(r.answers) ? r.answers : [],
    status: r.status || 'pending',
    staffMessage: r.staff_message || '',
    statusToken: r.status_token || '',
    // The Discord invite the pilot was sent on acceptance, kept so their status
    // page can show it again — an emailed invite is easy to lose, and an
    // applicant with no email has the status link as their only copy.
    discordInvite: r.discord_invite || '',
    // The invitation handed to an accepted applicant. `invitePassword` is a live
    // credential for as long as it is non-empty — see crewInvite.js for the
    // lifecycle, and the schema for why it is stored at all. Handlers must run
    // it through crewInvite.inviteState() rather than reading it directly: a
    // password that is still in the column but claimed, revoked or expired must
    // not be shown to anyone.
    inviteUsername: r.invite_username || '',
    invitePassword: r.invite_password || '',
    inviteIssuedAt: date(r.invite_issued_at),
    inviteClaimedAt: date(r.invite_claimed_at),
    inviteRevokedAt: date(r.invite_revoked_at),
    inviteAccountId: r.invite_account_id || null,
    reviewedAt: date(r.reviewed_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const applicationToRow = (a) => {
    const out = {};
    pick(a, out, 'ifcName', 'ifc_name', (v) => str(v, 60));
    pick(a, out, 'email', 'email', (v) => str(v, 120).toLowerCase());
    // 40, not 10: this holds the AIRLINE a pilot's callsign is built on (see
    // crewCallsign.js), and a real one runs past ten characters — "AEROMEXICO
    // CONNECT" truncated to "AEROMEXICO" no longer matches any callsign the VA
    // registered, so the application reads back in the wrong shape. The column
    // is `text`; the cap was only ever a guess at how long a prefix gets.
    pick(a, out, 'callsignPrefix', 'callsign_prefix', (v) => str(v, 40));
    pick(a, out, 'callsignNumber', 'callsign_number', (v) => str(v, 10));
    pick(a, out, 'grade', 'grade', (v) => int(v, 0, 5));
    pick(a, out, 'ifVerified', 'if_verified', (v) => !!v);
    pick(a, out, 'ifUserId', 'if_user_id', (v) => str(v, 40));
    pick(a, out, 'answers', 'answers', (v) => (Array.isArray(v)
        ? v.slice(0, 50).map((x) => ({ q: str(x && x.q, 120), a: str(x && x.a, 2000) })) : []));
    pick(a, out, 'status', 'status', (v) => (['pending', 'accepted', 'declined'].includes(v) ? v : 'pending'));
    pick(a, out, 'staffMessage', 'staff_message', (v) => str(v, 2000));
    pick(a, out, 'statusToken', 'status_token', (v) => str(v, 64));
    pick(a, out, 'discordInvite', 'discord_invite', (v) => str(v, 200));
    pick(a, out, 'inviteUsername', 'invite_username', (v) => str(v, 60));
    pick(a, out, 'invitePassword', 'invite_password', (v) => str(v, 128));
    pick(a, out, 'inviteIssuedAt', 'invite_issued_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'inviteClaimedAt', 'invite_claimed_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(a, out, 'inviteRevokedAt', 'invite_revoked_at', (v) => (date(v) ? date(v).toISOString() : null));
    // A uuid column: '' is not a valid uuid, so an empty id has to go as null.
    pick(a, out, 'inviteAccountId', 'invite_account_id', (v) => (str(v, 64) || null));
    pick(a, out, 'reviewedAt', 'reviewed_at', (v) => (date(v) ? date(v).toISOString() : null));
    return out;
};

// v6. An event, and one pilot's place at it.
//
// `gateIcao` is stored rather than derived: the board's airport is the origin
// for a group departure and the destination for a fly-in, and only the VA knows
// which this is. crewEvents.gateAirport() applies that fallback in one place so
// every caller resolves it the same way.
const eventFromRow = (r) => r && {
    _id: r.id,
    title: r.title || '',
    description: r.description || '',
    bannerUrl: r.banner_url || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraft: r.aircraft || '',
    flightNumber: r.flight_number || '',
    // v7. The leg in the VA's own network this event is flown on, when it is
    // one. The leg details above are kept alongside rather than read through
    // it — plenty of events are one-offs the network does not carry.
    routeId: r.route_id || null,
    server: r.server || '',
    startsAt: date(r.starts_at),
    endsAt: date(r.ends_at),
    slots: Number(r.slots) || 0,
    gatesOpen: r.gates_open !== false,
    gatesLocked: !!r.gates_locked,
    gateIcao: r.gate_icao || '',
    minRank: r.min_rank || '',
    status: r.status || 'draft',
    createdBy: r.created_by || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const eventToRow = (e) => {
    const out = {};
    pick(e, out, 'title', 'title', (v) => str(v, 120));
    pick(e, out, 'description', 'description', (v) => str(v, 4000));
    // Event artwork lands in an <img> on a public page — same rule as a
    // codeshare partner's logo, so anything not plainly https is dropped.
    pick(e, out, 'bannerUrl', 'banner_url', (v) => {
        const s = str(v, 600);
        return /^https:\/\//i.test(s) ? s : '';
    });
    pick(e, out, 'origin', 'origin', icao);
    pick(e, out, 'destination', 'destination', icao);
    pick(e, out, 'aircraft', 'aircraft', (v) => str(v, 60));
    pick(e, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    // A uuid column: '' is not a valid uuid, so "no route" has to go as null.
    pick(e, out, 'routeId', 'route_id', (v) => (str(v, 64) || null));
    pick(e, out, 'server', 'server', (v) => str(v, 30));
    pick(e, out, 'startsAt', 'starts_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(e, out, 'endsAt', 'ends_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(e, out, 'slots', 'slots', (v) => int(v, 0, 5000));
    pick(e, out, 'gatesOpen', 'gates_open', (v) => !!v);
    pick(e, out, 'gatesLocked', 'gates_locked', (v) => !!v);
    pick(e, out, 'gateIcao', 'gate_icao', icao);
    pick(e, out, 'minRank', 'min_rank', (v) => str(v, 40));
    pick(e, out, 'status', 'status', (v) => (['draft', 'published', 'cancelled'].includes(v) ? v : 'draft'));
    pick(e, out, 'createdBy', 'created_by', (v) => str(v, 80));
    return out;
};

const signupFromRow = (r) => r && {
    _id: r.id,
    eventId: r.event_id || null,
    memberId: r.member_id || null,
    accountId: r.account_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    aircraft: r.aircraft || '',
    gate: r.gate || '',
    // Nullable in the column and left null here: 0/0 is a real place in the
    // Gulf of Guinea, and a board that pins an unplaced stand there is worse
    // than one that simply does not draw it.
    gateLat: r.gate_lat == null ? null : Number(r.gate_lat),
    gateLon: r.gate_lon == null ? null : Number(r.gate_lon),
    gateKind: r.gate_kind || '',
    note: r.note || '',
    status: r.status === 'waitlist' ? 'waitlist' : 'going',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const signupToRow = (s) => {
    const out = {};
    pick(s, out, 'eventId', 'event_id', (v) => (str(v, 64) || null));
    pick(s, out, 'memberId', 'member_id', (v) => (str(v, 64) || null));
    pick(s, out, 'accountId', 'account_id', (v) => (str(v, 64) || null));
    pick(s, out, 'pilotName', 'pilot_name', (v) => str(v, 80));
    pick(s, out, 'callsign', 'callsign', (v) => str(v, CALLSIGN_MAX));
    pick(s, out, 'aircraft', 'aircraft', (v) => str(v, 60));
    // Upper-cased on the way in, because the unique index that makes a stand
    // one pilot's is on upper(gate) — storing "b24" would claim the same stand
    // as "B24" but read back as a different one on the board.
    pick(s, out, 'gate', 'gate', (v) => str(v, 20).toUpperCase());
    pick(s, out, 'gateLat', 'gate_lat', (v) => (v == null || v === '' ? null : num(v, -90, 90)));
    pick(s, out, 'gateLon', 'gate_lon', (v) => (v == null || v === '' ? null : num(v, -180, 180)));
    pick(s, out, 'gateKind', 'gate_kind', (v) => str(v, 30));
    pick(s, out, 'note', 'note', (v) => str(v, 300));
    pick(s, out, 'status', 'status', (v) => (v === 'waitlist' ? 'waitlist' : 'going'));
    return out;
};

// v8. A scheduled departure, and one pilot's booking on it.
//
// Deliberately close in shape to an event without being one: an event gathers
// everybody at a single departure, a schedule entry is one leg of an ordinary
// week that one pilot (or a small crew) puts their name against. See the schema
// note above crew_schedules for why they are separate tables.
const scheduleFromRow = (r) => r && {
    _id: r.id,
    routeId: r.route_id || null,
    flightNumber: r.flight_number || '',
    origin: r.origin || '',
    destination: r.destination || '',
    aircraft: r.aircraft || '',
    departsAt: date(r.departs_at),
    arrivesAt: date(r.arrives_at),
    // Never 0: the column refuses it, and a departure nobody can fly is not a
    // departure. A row that somehow arrives without one reads as single-crew.
    seats: Number(r.seats) || 1,
    minRank: r.min_rank || '',
    notes: r.notes || '',
    status: r.status || 'draft',
    createdBy: r.created_by || '',
    // Where this departure lives in Infinite Flight, when it has been pushed
    // there. Empty on a project whose schema predates v13 — the columns are in
    // LATE_COLUMNS, so a write mentioning them degrades rather than failing.
    ifScheduleId: r.if_schedule_id || '',
    ifAircraftId: r.if_aircraft_id || '',
    ifRegistration: r.if_registration || '',
    ifSyncedAt: date(r.if_synced_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const scheduleToRow = (s) => {
    const out = {};
    // A uuid column: '' is not a valid uuid, so "no route" has to go as null.
    pick(s, out, 'routeId', 'route_id', (v) => (str(v, 64) || null));
    pick(s, out, 'flightNumber', 'flight_number', (v) => str(v, 12));
    pick(s, out, 'origin', 'origin', icao);
    pick(s, out, 'destination', 'destination', icao);
    pick(s, out, 'aircraft', 'aircraft', (v) => str(v, 60));
    pick(s, out, 'departsAt', 'departs_at', (v) => (date(v) ? date(v).toISOString() : null));
    pick(s, out, 'arrivesAt', 'arrives_at', (v) => (date(v) ? date(v).toISOString() : null));
    // Floored at 1 rather than 0: the check constraint would refuse a zero and
    // fail the whole write, and what a caller sending one means is "one pilot".
    pick(s, out, 'seats', 'seats', (v) => int(v, 1, 20));
    pick(s, out, 'minRank', 'min_rank', (v) => str(v, 40));
    pick(s, out, 'notes', 'notes', (v) => str(v, 2000));
    pick(s, out, 'status', 'status', (v) => (['draft', 'published', 'cancelled'].includes(v) ? v : 'draft'));
    pick(s, out, 'createdBy', 'created_by', (v) => str(v, 80));
    // --- The link to Infinite Flight Live (v13) ---
    //
    // A departure that has been pushed to a real aircraft's schedule in
    // Infinite Flight carries the id it was given there, so the next push is an
    // update rather than a duplicate leg on somebody's aeroplane. Cleared by
    // sending '' — which is why these go as null rather than as an empty
    // string: the columns are text, but "not linked" is an absence and a query
    // for `is.null` is how the sync finds what it still has to push.
    pick(s, out, 'ifScheduleId', 'if_schedule_id', (v) => (str(v, 64) || null));
    pick(s, out, 'ifAircraftId', 'if_aircraft_id', (v) => (str(v, 64) || null));
    pick(s, out, 'ifSyncedAt', 'if_synced_at', (v) => (date(v) ? date(v).toISOString() : null));
    // Text, not a uuid column, so '' is a legal value — but null keeps "no
    // airframe" a single answer across all four of these rather than two.
    pick(s, out, 'ifRegistration', 'if_registration', (v) => (str(v, 40) || null));
    return out;
};

const bookingFromRow = (r) => r && {
    _id: r.id,
    scheduleId: r.schedule_id || null,
    memberId: r.member_id || null,
    accountId: r.account_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    seat: Number(r.seat) || 1,
    note: r.note || '',
    status: r.status === 'flown' ? 'flown' : 'booked',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const bookingToRow = (b) => {
    const out = {};
    pick(b, out, 'scheduleId', 'schedule_id', (v) => (str(v, 64) || null));
    pick(b, out, 'memberId', 'member_id', (v) => (str(v, 64) || null));
    pick(b, out, 'accountId', 'account_id', (v) => (str(v, 64) || null));
    pick(b, out, 'pilotName', 'pilot_name', (v) => str(v, 80));
    pick(b, out, 'callsign', 'callsign', (v) => str(v, CALLSIGN_MAX));
    pick(b, out, 'seat', 'seat', (v) => int(v, 1, 20));
    pick(b, out, 'note', 'note', (v) => str(v, 300));
    pick(b, out, 'status', 'status', (v) => (v === 'flown' ? 'flown' : 'booked'));
    return out;
};

// v7. A row on the VA's noticeboard. Two kinds of thing live here in one
// shape: what staff write, and what the crew center writes for them when
// something worth telling the crew happens.
const announcementFromRow = (r) => r && {
    _id: r.id,
    title: r.title || '',
    body: r.body || '',
    kind: r.kind || 'notice',
    source: r.source === 'auto' ? 'auto' : 'staff',
    pinned: !!r.pinned,
    refId: r.ref_id || null,
    authorName: r.author_name || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
// v18. 'leave' is the other half of 'join'. A board that announces only the
// arrivals is a board where people quietly stop existing.
//
// v20. 'staff' is somebody joining or leaving the team that RUNS the airline —
// the one promotion the board used to say nothing about, so a VA's crew could
// watch a pilot make Captain and never learn who had started approving their
// flight reports. A kind the project's check constraint refuses is coerced to
// 'notice' by the line below rather than failing the write, which is why this
// list must not run ahead of the schema: see the v20 constraint widening in
// supabase/crew-center-schema.sql.
const ANNOUNCEMENT_KINDS = ['notice', 'promotion', 'join', 'event', 'checkride', 'schedule', 'leave', 'staff'];
const announcementToRow = (a) => {
    const out = {};
    pick(a, out, 'title', 'title', (v) => str(v, 160));
    pick(a, out, 'body', 'body', (v) => str(v, 4000));
    pick(a, out, 'kind', 'kind', (v) => (ANNOUNCEMENT_KINDS.includes(v) ? v : 'notice'));
    pick(a, out, 'source', 'source', (v) => (v === 'auto' ? 'auto' : 'staff'));
    pick(a, out, 'pinned', 'pinned', (v) => !!v);
    // A uuid column: '' is not a valid uuid, so an empty id has to go as null.
    pick(a, out, 'refId', 'ref_id', (v) => (str(v, 64) || null));
    pick(a, out, 'authorName', 'author_name', (v) => str(v, 80));
    return out;
};

// v11. A document in the VA's library. The shape decisions — which source field
// survives, what counts as a revision, who may read it — all live in crewDocs.js;
// this is only the column mapping, and it deliberately does not re-implement any
// of them. A caller that wants a cleaned document runs it through
// crewDocs.normalizeDocument first.
const documentFromRow = (r) => r && {
    _id: r.id,
    title: r.title || '',
    summary: r.summary || '',
    kind: r.kind || 'document',
    source: r.source || 'text',
    body: r.body || '',
    linkUrl: r.link_url || '',
    fileUrl: r.file_url || '',
    fileName: r.file_name || '',
    fileSize: Number(r.file_size) || 0,
    minRank: r.min_rank || '',
    pinned: !!r.pinned,
    status: r.status || 'draft',
    revision: r.revision || '',
    revisedAt: date(r.revised_at),
    authorName: r.author_name || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const documentToRow = (d) => {
    const out = {};
    pick(d, out, 'title', 'title', (v) => str(v, 160));
    pick(d, out, 'summary', 'summary', (v) => str(v, 400));
    pick(d, out, 'kind', 'kind', (v) => (crewDocs.KINDS.includes(v) ? v : 'document'));
    pick(d, out, 'source', 'source', (v) => (crewDocs.SOURCES.includes(v) ? v : 'text'));
    // The column is unbounded text; the cap here is the same one crewDocs
    // applies, so a body that arrived past a normalize step is still refused
    // rather than committing a megabyte of paste to the VA's project.
    pick(d, out, 'body', 'body', (v) => str(v, 200000));
    pick(d, out, 'linkUrl', 'link_url', (v) => str(v, 600));
    pick(d, out, 'fileUrl', 'file_url', (v) => str(v, 600));
    pick(d, out, 'fileName', 'file_name', (v) => str(v, 200));
    pick(d, out, 'fileSize', 'file_size', (v) => int(v, 0, 1e11));
    pick(d, out, 'minRank', 'min_rank', (v) => str(v, 40));
    pick(d, out, 'pinned', 'pinned', (v) => !!v);
    pick(d, out, 'status', 'status', (v) => (crewDocs.STATUSES.includes(v) ? v : 'draft'));
    pick(d, out, 'revision', 'revision', (v) => str(v, 40));
    // A timestamptz: '' is not a valid one, so "no revision recorded" has to go
    // as null. Passed through rather than stamped here because WHEN a revision
    // happened is the caller's decision (see crewDocs.isSubstantiveChange) — the
    // store does not get to decide that a save was substantive.
    pick(d, out, 'revisedAt', 'revised_at', (v) => (v ? new Date(v).toISOString() : null));
    pick(d, out, 'authorName', 'author_name', (v) => str(v, 80));
    return out;
};

// v11. One message addressed to one pilot. See crewInbox.js for who gets what.
const notificationFromRow = (r) => r && {
    _id: r.id,
    accountId: r.account_id || null,
    memberId: r.member_id || null,
    title: r.title || '',
    body: r.body || '',
    kind: r.kind || 'message',
    refId: r.ref_id || null,
    linkUrl: r.link_url || '',
    senderName: r.sender_name || '',
    readAt: date(r.read_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const notificationToRow = (n) => {
    const out = {};
    // Both uuid columns: '' is not a valid uuid, so an absent id goes as null.
    pick(n, out, 'accountId', 'account_id', (v) => (str(v, 64) || null));
    pick(n, out, 'memberId', 'member_id', (v) => (str(v, 64) || null));
    pick(n, out, 'title', 'title', (v) => str(v, 160));
    pick(n, out, 'body', 'body', (v) => str(v, 4000));
    pick(n, out, 'kind', 'kind', (v) => (crewInbox.KINDS.includes(v) ? v : 'message'));
    pick(n, out, 'refId', 'ref_id', (v) => (str(v, 64) || null));
    pick(n, out, 'linkUrl', 'link_url', (v) => str(v, 600));
    pick(n, out, 'senderName', 'sender_name', (v) => str(v, 80));
    pick(n, out, 'readAt', 'read_at', (v) => (v ? new Date(v).toISOString() : null));
    return out;
};

// v12. A tile on the VA's quick-links board. Every decision about it — whether
// the URL is one we will send a pilot to, what category it belongs in, who may
// see it — lives in crewLinks.js; this is the column mapping only.
//
// `opens` and `lastOpenedAt` are read here and never written: they belong to
// crew_link_open(), which increments atomically because a read-then-write would
// lose counts the moment two pilots tap the Discord tile together.
const linkFromRow = (r) => r && {
    _id: r.id,
    title: r.title || '',
    url: r.url || '',
    description: r.description || '',
    category: r.category || 'other',
    icon: r.icon || 'link',
    minRank: r.min_rank || '',
    pinned: !!r.pinned,
    status: r.status || 'published',
    sortOrder: Number(r.sort_order) || 0,
    opens: Number(r.opens) || 0,
    lastOpenedAt: date(r.last_opened_at),
    authorName: r.author_name || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const linkToRow = (l) => {
    const out = {};
    pick(l, out, 'title', 'title', (v) => str(v, 80));
    // Already normalised by crewLinks.safeUrl at the route — capped here too, so
    // a caller that skipped that step cannot commit an unbounded string.
    pick(l, out, 'url', 'url', (v) => str(v, 2000));
    pick(l, out, 'description', 'description', (v) => str(v, 240));
    pick(l, out, 'category', 'category', (v) => (crewLinks.CATEGORIES.includes(v) ? v : 'other'));
    pick(l, out, 'icon', 'icon', (v) => str(v, 40));
    pick(l, out, 'minRank', 'min_rank', (v) => str(v, 40));
    pick(l, out, 'pinned', 'pinned', (v) => !!v);
    pick(l, out, 'status', 'status', (v) => (crewLinks.STATUSES.includes(v) ? v : 'published'));
    pick(l, out, 'sortOrder', 'sort_order', (v) => int(v, 0, 9999));
    pick(l, out, 'authorName', 'author_name', (v) => str(v, 80));
    return out;
};

// v14. One pilot's ask for a check-ride, and everything that then happened to
// it. The row is the record rather than a workflow token: it survives the
// decision so a pilot can be shown why they are still where they are, and so a
// VA can see who is waiting on whom.
//
// `scheduledAt` and `scheduledText` are both kept on purpose -- an examiner
// types "Saturday 19:00Z, KJFK -> EGLL", of which only the front half is an
// instant. Parsing it and keeping only the instant throws away the route the
// pilot needs; keeping only the words leaves the queue with nothing to sort by.
const trainingFromRow = (r) => r && {
    _id: r.id,
    memberId: r.member_id || null,
    forRank: r.for_rank || '',
    status: r.status || 'requested',
    scheduledAt: date(r.scheduled_at),
    scheduledText: r.scheduled_text || '',
    examinerName: r.examiner_name || '',
    notes: r.notes || '',
    decidedAt: date(r.decided_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const TRAINING_STATUSES = ['requested', 'scheduled', 'passed', 'failed', 'withdrawn'];
const trainingToRow = (t) => {
    const out = {};
    pick(t, out, 'memberId', 'member_id', (v) => v || null);
    pick(t, out, 'forRank', 'for_rank', (v) => str(v, 40));
    pick(t, out, 'status', 'status', (v) => (TRAINING_STATUSES.includes(v) ? v : 'requested'));
    pick(t, out, 'scheduledAt', 'scheduled_at', (v) => (v ? new Date(v).toISOString() : null));
    pick(t, out, 'scheduledText', 'scheduled_text', (v) => str(v, 160));
    pick(t, out, 'examinerName', 'examiner_name', (v) => str(v, 80));
    pick(t, out, 'notes', 'notes', (v) => str(v, 300));
    pick(t, out, 'decidedAt', 'decided_at', (v) => (v ? new Date(v).toISOString() : null));
    return out;
};

// v15. One thing on the shop's shelf.
//
// `stock` is deliberately not clamped at 0: -1 is unlimited and is the default,
// which is what most of what a VA sells actually is (a livery, a Discord role, a
// callsign). `description` is the column and `desc` is the document field,
// because `desc` is a reserved word in the SQL the VA may one day read this
// table with by hand.
const shopItemFromRow = (r) => r && {
    _id: r.id,
    // v18. The shelf it sits on, and how loudly the shop draws it. Both are
    // late columns, so a project that has not re-run the SQL reads them as
    // undefined — which is exactly the shape every item written before they
    // existed has, and crewShop bounds both to their inert default.
    group: r.item_group || '',
    tier: r.tier || '',
    name: r.name || '',
    desc: r.description || '',
    image: r.image_url || '',
    icon: r.icon || '',
    price: Number(r.price) || 0,
    stock: r.stock == null ? -1 : Number(r.stock),
    limitPerPilot: Number(r.limit_per_pilot) || 0,
    active: r.active !== false,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const shopItemToRow = (i) => {
    const out = {};
    // `item_group` rather than `group`, because `group` is a reserved word in
    // SQL and a column called one is a column every hand-written query has to
    // quote forever.
    pick(i, out, 'group', 'item_group', (v) => str(v, 40));
    pick(i, out, 'tier', 'tier', (v) => str(v, 16));
    pick(i, out, 'name', 'name', (v) => str(v, 60));
    pick(i, out, 'desc', 'description', (v) => str(v, 240));
    pick(i, out, 'image', 'image_url', (v) => str(v, 500));
    pick(i, out, 'icon', 'icon', (v) => str(v, 40));
    pick(i, out, 'price', 'price', (v) => int(v, 0, 1e7));
    // -1 (unlimited) through to a sensible ceiling. Rounded, because the field
    // in the editor is a number input and a VA pasting "12.5" means twelve.
    pick(i, out, 'stock', 'stock', (v) => int(v, -1, 1e6));
    pick(i, out, 'limitPerPilot', 'limit_per_pilot', (v) => int(v, 0, 1e4));
    pick(i, out, 'active', 'active', (v) => v !== false);
    return out;
};

// An order, which is a receipt: it carries its own copy of what was bought and
// what it cost, so editing or deleting the item afterwards cannot rewrite what a
// pilot actually paid. See the table's note in the schema.
const shopOrderFromRow = (r) => r && {
    _id: r.id,
    memberId: r.member_id || null,
    itemId: r.item_id || null,
    itemName: r.item_name || '',
    price: Number(r.price) || 0,
    status: r.status || 'placed',
    code: r.code || '',
    decidedAt: date(r.decided_at),
    decidedBy: r.decided_by || '',
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};

// v20. A pilot asking for a job on the team.
//
// `position` and `pilotName`/`callsign` are copies, not joins, and that is the
// point: an opening can be renamed or withdrawn and a pilot can leave the
// roster while their application is still in the queue. A reviewer looking at
// "(deleted) applied for (deleted)" cannot review anything, so the words are
// frozen at the moment of asking and the ids are what the accept path
// re-resolves against what exists now.
const staffAppFromRow = (r) => r && {
    _id: r.id,
    openingId: r.opening_id || '',
    roleId: r.role_id || '',
    position: r.position || '',
    memberId: r.member_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    answers: Array.isArray(r.answers) ? r.answers : [],
    status: r.status || 'pending',
    staffMessage: r.staff_message || '',
    decidedBy: r.decided_by || '',
    decidedAt: date(r.decided_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const STAFF_APP_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn'];
const staffAppToRow = (a) => {
    const out = {};
    pick(a, out, 'openingId', 'opening_id', (v) => str(v, 40));
    pick(a, out, 'roleId', 'role_id', (v) => str(v, 40));
    pick(a, out, 'position', 'position', (v) => str(v, 120));
    pick(a, out, 'memberId', 'member_id', (v) => v || null);
    pick(a, out, 'pilotName', 'pilot_name', (v) => str(v, 80));
    pick(a, out, 'callsign', 'callsign', (v) => str(v, 40));
    pick(a, out, 'answers', 'answers', (v) => (Array.isArray(v) ? v : []));
    pick(a, out, 'status', 'status', (v) => (STAFF_APP_STATUSES.includes(v) ? v : 'pending'));
    pick(a, out, 'staffMessage', 'staff_message', (v) => str(v, 1000));
    pick(a, out, 'decidedBy', 'decided_by', (v) => str(v, 80));
    pick(a, out, 'decidedAt', 'decided_at', (v) => (v ? new Date(v).toISOString() : null));
    return out;
};

// v22. One pilot sitting one quiz.
//
// `quizTitle`, `passMark` and `maxAttempts` are COPIES of the quiz as it stood
// when the attempt was issued, and that is the point: a quiz can be renamed,
// re-marked or deleted while somebody is half way through it, and a result
// reading "(deleted) — 7/10 against a pass mark of (gone)" is not a record of
// anything. What the pilot sat is frozen here; the questions are re-read from
// the airline's record at the moment of marking, because a paper must be marked
// against the answers the airline holds now.
//
// `token` is the link. It is a secret in the sense that holding one is how a
// pilot reaches their own attempt, so it is never listed to anybody but the
// pilot it belongs to -- see myAttemptView in crewQuizzes.js.
const quizAttemptFromRow = (r) => r && {
    _id: r.id,
    quizId: r.quiz_id || '',
    quizTitle: r.quiz_title || '',
    token: r.token || '',
    memberId: r.member_id || null,
    pilotName: r.pilot_name || '',
    callsign: r.callsign || '',
    status: r.status || 'issued',
    gate: r.gate === true,
    score: Number(r.score) || 0,
    total: Number(r.total) || 0,
    passMark: Number(r.pass_mark) || 0,
    attemptsUsed: Number(r.attempts_used) || 0,
    maxAttempts: Number(r.max_attempts) || 0,
    answers: Array.isArray(r.answers) ? r.answers : [],
    note: r.note || '',
    issuedBy: r.issued_by || '',
    startedAt: date(r.started_at),
    submittedAt: date(r.submitted_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
};
const QUIZ_ATTEMPT_STATUSES = ['issued', 'started', 'passed', 'failed', 'revoked'];
const quizAttemptToRow = (a) => {
    const out = {};
    pick(a, out, 'quizId', 'quiz_id', (v) => str(v, 40));
    pick(a, out, 'quizTitle', 'quiz_title', (v) => str(v, 120));
    pick(a, out, 'token', 'token', (v) => str(v, 64));
    pick(a, out, 'memberId', 'member_id', (v) => v || null);
    pick(a, out, 'pilotName', 'pilot_name', (v) => str(v, 80));
    pick(a, out, 'callsign', 'callsign', (v) => str(v, 40));
    pick(a, out, 'status', 'status', (v) => (QUIZ_ATTEMPT_STATUSES.includes(v) ? v : 'issued'));
    pick(a, out, 'gate', 'gate', (v) => v === true);
    pick(a, out, 'score', 'score', (v) => int(v, 0, 1000));
    pick(a, out, 'total', 'total', (v) => int(v, 0, 1000));
    pick(a, out, 'passMark', 'pass_mark', (v) => int(v, 0, 100));
    pick(a, out, 'attemptsUsed', 'attempts_used', (v) => int(v, 0, 1000));
    pick(a, out, 'maxAttempts', 'max_attempts', (v) => int(v, 0, 1000));
    pick(a, out, 'answers', 'answers', (v) => (Array.isArray(v) ? v : []));
    pick(a, out, 'note', 'note', (v) => str(v, 500));
    pick(a, out, 'issuedBy', 'issued_by', (v) => str(v, 80));
    pick(a, out, 'startedAt', 'started_at', (v) => (v ? new Date(v).toISOString() : null));
    pick(a, out, 'submittedAt', 'submitted_at', (v) => (v ? new Date(v).toISOString() : null));
    return out;
};

// ---------------------------------------------------------------------------
// PostgREST transport
//
// A thin wrapper rather than @supabase/supabase-js: the client library adds a
// dependency (and an auth/realtime stack) for what is, at this level, four HTTP
// verbs against one host. axios is already the backend's HTTP client.
// ---------------------------------------------------------------------------
// Which column did the project not have? PostgREST says
//   Could not find the 'kind' column of 'crew_routes' in the schema cache
// and Postgres itself says
//   column "kind" of relation "crew_routes" does not exist
// Both are matched because a filter or a select produces the second one where a
// write produces the first.
//
// Narrowly, though: plenty of Postgres errors name a column ("null value in
// column \"name\" violates …") and reading one of those as a schema-version
// problem would drop the VA's data on the floor and call it an upgrade. Only
// the two "this column is not there" phrasings count; everything else gets ''.
function missingColumnFrom(body) {
    const text = [body && body.message, body && body.details, body && body.hint]
        .filter(Boolean).join(' ');
    if (!/schema cache|does not exist/i.test(text)) return '';
    const m = text.match(/could not find the\s+['"]([a-z0-9_]+)['"]\s+column/i)
        || text.match(/column\s+['"]?([a-z0-9_]+)['"]?\s+(?:of relation\s+['"]?[a-z0-9_.]+['"]?\s+)?does not exist/i);
    return m ? m[1] : '';
}

class Postgrest {
    constructor(url, serviceKey) {
        this.base = String(url).replace(/\/+$/, '') + '/rest/v1';
        this.key = serviceKey;
        // Columns this request had to drop because the project has not got
        // them. Per-instance (one store per request) so a handler can tell the
        // VA what its write did not include — see SupabaseStore.drift.
        this.dropped = new Set();
    }

    get headers() {
        return {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    async request(method, path, { params, data, prefer } = {}) {
        const headers = this.headers;
        if (prefer) headers.Prefer = prefer;
        try {
            const res = await axios({
                method, url: `${this.base}${path}`, params, data, headers,
                timeout: TIMEOUT_MS,
                // We want to inspect PostgREST's error body ourselves rather
                // than have axios throw a message that hides it.
                validateStatus: () => true,
            });
            if (res.status >= 200 && res.status < 300) return res.data;
            throw this.explain(res);
        } catch (err) {
            if (err instanceof CrewStoreError) throw err;
            const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
            throw new CrewStoreError(
                timedOut
                    ? 'The VA’s data store did not respond in time.'
                    : 'Could not reach the VA’s data store.',
                { status: 502, code: timedOut ? 'store_timeout' : 'store_unreachable', detail: err.message || '' });
        }
    }

    // Turn a PostgREST error body into something a VA admin can act on. The
    // three cases below are the ones people actually hit while setting up.
    explain(res) {
        const body = res.data || {};
        const detail = [body.message, body.details, body.hint].filter(Boolean).join(' — ');
        if (res.status === 401 || res.status === 403) {
            return new CrewStoreError(
                'The VA’s data store rejected our credentials. Re-copy the service key from Supabase → Settings → API.',
                { status: 502, code: 'store_unauthorized', detail });
        }
        // 404 on the table itself, or PGRST205 "could not find the table".
        if (res.status === 404 || body.code === 'PGRST205' || body.code === '42P01') {
            return new CrewStoreError(
                'The VA’s data store is missing the crew center tables. Run supabase/crew-center-schema.sql in the project’s SQL editor.',
                { status: 502, code: 'store_schema_missing', detail });
        }
        // A column we write that the project has not got: the project is on an
        // older schema than this code. PGRST204 is PostgREST's schema-cache
        // miss; 42703 is Postgres' own undefined_column, which is what comes
        // back when a filter or a select names it.
        //
        // 409, not 502: nothing is broken and nothing is unreachable — the
        // VA's database is simply behind, and the fix is one button in
        // Settings → Data store. A 502 said "our end fell over", which sent
        // people to us instead of to the thing that fixes it.
        const column = missingColumnFrom(body);
        if (column || body.code === 'PGRST204' || body.code === '42703') {
            const err = new CrewStoreError(
                column
                    ? `The VA’s data store is on an older schema and has no “${column}” column. Update it in Crew Center → Settings → Data store.`
                    : 'The VA’s data store is on an older schema than this crew center. Update it in Crew Center → Settings → Data store.',
                { status: 409, code: 'store_schema_outdated', detail });
            err.column = column;
            return err;
        }
        // The project is in read-only mode — Supabase's protection when a
        // project runs out of database space, or while it is restoring from a
        // pause. Every write fails with SQLSTATE 25006 until that is resolved,
        // and the VA is the only one who can resolve it, so say which thing is
        // wrong instead of "the data store returned an error". 409 for the same
        // reason as the outdated-schema case: nothing here is broken.
        if (body.code === READ_ONLY_SQLSTATE || /read-only transaction/i.test(detail)) {
            return new CrewStoreError(
                'The VA’s Supabase project is in read-only mode, so nothing can be saved to it. Supabase does that when a project runs out of database space (the free plan stops at 500 MB) or while it is restoring from a pause. Crew Center → Settings → Data store shows what is using the room; clear some, or raise the disk size in Supabase.',
                { status: 409, code: 'store_read_only', detail });
        }
        if (res.status === 409 || body.code === '23505') {
            const err = new CrewStoreError('That record already exists.', { status: 409, code: 'store_conflict', detail });
            // Which uniqueness was violated, when Postgres says. A caller that
            // knows its indexes can turn this into the sentence the user needs
            // — "that gate has just been taken" rather than "that record
            // already exists" — and one that doesn't is unaffected.
            const m = /unique constraint\s+"([a-z0-9_]+)"/i.exec(detail);
            err.constraint = m ? m[1] : '';
            return err;
        }
        return new CrewStoreError('The VA’s data store returned an error.',
            { status: 502, code: 'store_error', detail: detail || `HTTP ${res.status}` });
    }

    select(table, params) { return this.request('get', `/${table}`, { params }); }

    insert(table, rows) {
        return this.write(table, rows, (data) => this.request('post', `/${table}`, { data, prefer: 'return=representation' }));
    }

    update(table, params, patch) {
        return this.write(table, patch, (data) => this.request('patch', `/${table}`, { params, data, prefer: 'return=representation' }));
    }

    /**
     * A write that survives a project on an older schema.
     *
     * Columns already known to be missing are left out before the first
     * attempt; one the project turns out not to have is dropped and the write
     * retried. Only columns in LATE_COLUMNS are ever dropped — see the note
     * there for why that is the safe set — so a genuinely wrong column name
     * still fails, loudly, on the first attempt.
     */
    async write(table, payload, run) {
        let data = this.strip(table, payload);
        // Bounded by the number of droppable columns: each pass removes one, so
        // this cannot spin even if the project answers oddly.
        const limit = (LATE_COLUMNS[table] ? LATE_COLUMNS[table].size : 0) + 1;
        for (let attempt = 0; ; attempt++) {
            try {
                const out = await run(data);
                return Array.isArray(out) ? out : [out];
            } catch (err) {
                const col = err && err.code === 'store_schema_outdated' ? err.column : '';
                if (!col || !isLateColumn(table, col) || attempt >= limit) throw err;
                noteMissing(this.base, table, col);
                const next = this.strip(table, payload);
                // Nothing came off — retrying would send the same body again.
                if (JSON.stringify(next) === JSON.stringify(data)) throw err;
                data = next;
            }
        }
    }

    /** The payload without the columns this project is known to lack. */
    strip(table, payload) {
        const missing = missingFor(this.base, table);
        if (!missing || !missing.size) return payload;
        const one = (row) => {
            if (!row || typeof row !== 'object') return row;
            const out = {};
            for (const [k, v] of Object.entries(row)) {
                if (missing.has(k)) { this.dropped.add(`${table}.${k}`); continue; }
                out[k] = v;
            }
            return out;
        };
        return Array.isArray(payload) ? payload.map(one) : one(payload);
    }

    remove(table, params) { return this.request('delete', `/${table}`, { params }); }

    /**
     * A delete that says what it deleted.
     *
     * PostgREST answers a plain DELETE with 204 and no body, which is the right
     * default — nobody wants a thousand rows echoed back for saying "drop the
     * old ones". `purgeMember` is the one caller that genuinely needs the
     * count: it is telling a person what was removed when they were promised
     * everything would be, and "ok" is not an answer to that. Bounded by
     * construction, because it only ever matches one pilot's own rows.
     */
    removeReturning(table, params) {
        return this.request('delete', `/${table}`, { params, prefer: 'return=representation' });
    }

    rpc(fn, args) { return this.request('post', `/rpc/${fn}`, { data: args }); }
}

// ---------------------------------------------------------------------------
// The VA's own Supabase project
// ---------------------------------------------------------------------------
class SupabaseStore {
    constructor(va) {
        this.kind = 'supabase';
        this.owned = true;              // the VA owns this data
        this.slug = String(va.slug || '').toLowerCase();
        this.db = new Postgrest(va.supabaseUrl, va.supabaseServiceKey);
    }

    /**
     * What this request could not store because the project is on an older
     * schema — in the VA's words, not column names. Empty on a project that is
     * up to date, which is every project that has re-run the SQL.
     *
     * Handlers put this on the response so a write that quietly did less than
     * it was asked to says so, rather than looking like a success and losing a
     * codeshare flag. Nothing here is an error: the row was written.
     */
    drift() {
        const out = [];
        for (const key of this.db.dropped) {
            const label = DRIFT_LABELS[key] || key.split('.')[1];
            if (!out.includes(label)) out.push(label);
        }
        return out;
    }

    // Every query is scoped to this crew center's slug so one Supabase project
    // can safely back several brands (see the schema's multi-brand note).
    get scope() { return { va_slug: `eq.${this.slug}` }; }
    ident(id) { return { ...this.scope, id: `eq.${id}` }; }

    async one(table, params, fromRow) {
        const rows = await this.db.select(table, { ...params, limit: 1 });
        return rows && rows[0] ? fromRow(rows[0]) : null;
    }

    // --- Roster ---
    async listMembers({ limit = 2000 } = {}) {
        const rows = await this.db.select('crew_members', {
            ...this.scope, order: 'hours.desc,name.asc', limit,
        });
        return (rows || []).map(memberFromRow);
    }
    listActiveLinkedMembers({ limit = 300 } = {}) {
        return this.db.select('crew_members', {
            ...this.scope, status: 'eq.active', if_user_id: 'neq.', limit,
        }).then((rows) => (rows || []).map(memberFromRow));
    }
    getMember(id) { return this.one('crew_members', this.ident(id), memberFromRow); }
    async createMember(data) {
        const [row] = await this.db.insert('crew_members', { va_slug: this.slug, ...memberToRow(data) });
        return memberFromRow(row);
    }
    async updateMember(id, patch) {
        const [row] = await this.db.update('crew_members', this.ident(id), memberToRow(patch));
        return row ? memberFromRow(row) : null;
    }
    async deleteMember(id) { await this.db.remove('crew_members', this.ident(id)); return true; }

    /* ===================================================================
     * EVERYTHING THIS PILOT IS, GONE.
     *
     * WHY deleteMember ABOVE IS NOT ENOUGH
     *
     * Every table that points at a roster row does so with `on delete set
     * null` — deliberately, because an order is a receipt and a flight report
     * is a record, and neither should vanish because somebody was taken off a
     * list. So `deleteMember` removed the row and left the rest of that person
     * behind, orphaned: their flights still in the log with a name on them and
     * no pilot to attach to, their bookings still holding seats on departures,
     * their signups still counted against an event's capacity, and — the one
     * that actually matters — THEIR LOGIN STILL WORKING. A pilot removed from
     * the roster could still sign in, because crew_accounts.member_id was set
     * to null rather than the account being deleted, and an account with no
     * member is a perfectly valid account.
     *
     * This is the other verb. Remove is "take them off the list"; purge is
     * "this person was never here", and it is what both doors that end a
     * membership now use — a staff member removing somebody, and somebody
     * leaving of their own accord.
     *
     * CHILDREN FIRST, ROSTER ROW LAST. If the run dies halfway, what is left
     * is a pilot with less history rather than a set of orphans with no pilot;
     * the first is recoverable by hand and the second is not.
     *
     * A MISSING TABLE IS NOT A FAILURE. A project on a pre-v6 schema has no
     * crew_event_signups and a pre-v15 one has no crew_shop_orders. There is
     * nothing of this pilot's in a table that does not exist, so the absence is
     * counted as zero and the purge carries on — refusing to remove somebody
     * because their VA has not re-run the SQL would be the wrong answer to the
     * wrong question.
     *
     * Returns what it removed, per table, so the caller can say so rather than
     * reporting a bare ok to somebody who has just been told everything would
     * go.
     * =================================================================== */
    async purgeMember(id) {
        const memberId = String(id || '');
        if (!memberId) return { ok: false, removed: {} };
        const byMember = { ...this.scope, member_id: `eq.${memberId}` };

        // The order is the point — see the note above. `crew_accounts` sits
        // second to last, immediately before the roster row: it is the one
        // whose survival is a security problem rather than a tidiness one, so
        // it goes even if something earlier threw.
        const tables = [
            'crew_shop_orders',
            'crew_training_requests',
            // v20. Their staff applications go with them. The row names what
            // they wrote about themselves and what staff wrote back; a pilot
            // who has left the airline has not left that behind for the next
            // reviewer to read.
            'crew_staff_applications',
            'crew_bookings',
            'crew_event_signups',
            'crew_notifications',
            'crew_pireps',
        ];
        const removed = {};
        const failed = [];
        for (const table of tables) {
            try {
                const rows = await this.db.removeReturning(table, byMember);
                removed[table] = Array.isArray(rows) ? rows.length : 0;
            } catch (err) {
                // A table this project has not got holds nothing of theirs.
                // Anything else is recorded and the purge continues, because
                // stopping here is what leaves a working login behind.
                if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                    removed[table] = 0;
                } else {
                    removed[table] = 0;
                    failed.push(table);
                }
            }
        }

        // The login. Last but one, and never skipped: an account whose
        // member_id was nulled is still an account that signs in.
        try {
            const rows = await this.db.removeReturning('crew_accounts', byMember);
            removed.crew_accounts = Array.isArray(rows) ? rows.length : 0;
        } catch (err) {
            removed.crew_accounts = 0;
            if (!(err instanceof CrewStoreError && err.code === 'store_schema_missing')) {
                // This one IS worth failing over. Everything else left behind
                // is clutter; a login left behind is a person who was told
                // they were gone and can still sign in.
                throw err;
            }
        }

        await this.db.remove('crew_members', this.ident(memberId));
        removed.crew_members = 1;
        return { ok: true, removed, failed };
    }

    // Credit or debit a pilot's hours. Read-modify-write: PostgREST has no
    // atomic increment, and the alternative (an RPC) would mean a VA whose
    // project predates that function silently loses hour crediting. The window
    // is small and the writers are our own serialised review actions.
    async addMemberHours(id, deltaHours) {
        const m = await this.getMember(id);
        if (!m) return null;
        const next = Math.max(0, (Number(m.hours) || 0) + Number(deltaHours || 0));
        return this.updateMember(id, { hours: next });
    }

    // --- Crew center logins ---
    //
    // These are the VA's pilots' accounts, and they live in the VA's project
    // like the rest of their data. A project still on a pre-v3 schema has no
    // crew_accounts table; rather than let a missing table surface as the
    // generic "run the SQL" error, upgrade() names the one thing that is
    // actually missing, because everything ELSE on that project works fine and
    // "your tables are missing" would read as a lie.
    async accounts(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the pilot-logins table yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_accounts_missing', detail: err.detail });
            }
            throw err;
        }
    }

    listAccounts({ limit = 2000 } = {}) {
        return this.accounts(async () => {
            const rows = await this.db.select('crew_accounts', { ...this.scope, order: 'username.asc', limit });
            return (rows || []).map(accountFromRow);
        });
    }
    getAccount(id) { return this.accounts(() => this.one('crew_accounts', this.ident(id), accountFromRow)); }
    // Usernames are stored lower-cased, so an equality match is the whole
    // lookup — no ilike, and the unique index answers it directly.
    getAccountByUsername(username) {
        const u = str(username, 60).toLowerCase();
        if (!u) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, username: `eq.${u}` }, accountFromRow));
    }
    /**
     * The account a Discord identity opens, or null.
     *
     * THE ONLY QUESTION THE CALLBACK GETS TO ASK. It cannot create, cannot
     * claim and cannot fall back to matching on a name — an id that is not
     * already written against a row signs nobody in.
     *
     * The unique index makes this at most one row per crew center.
     *
     * A PROJECT THAT HAS NOT RE-RUN THE SQL RAISES rather than answering
     * "nobody", and that is deliberate — an earlier version of this comment
     * claimed the opposite and the code never did it. A filter naming a column
     * the project has not got comes back as `store_schema_outdated`, which the
     * sign-in callback turns into "your database needs updating" with the
     * button that fixes it. Swallowing it would print "that Discord account
     * isn't linked to anybody here" to a pilot who had linked it, on a crew
     * center where linking cannot work yet.
     */
    getAccountByDiscord(discordId) {
        const id = String(discordId || '');
        if (!/^[0-9]{5,32}$/.test(id)) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, discord_id: `eq.${id}` }, accountFromRow));
    }
    getAccountByMember(memberId) {
        if (!memberId) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, member_id: `eq.${memberId}` }, accountFromRow));
    }
    /**
     * The pilot row belonging to one of OUR central staff accounts. v17.
     *
     * Scoped by va_slug like every other read here, so a staff account that
     * administers two airlines has a separate pilot side in each and neither
     * can be found from the other.
     */
    getAccountByPortal(portalAccountId) {
        const id = String(portalAccountId || '');
        if (!/^[a-f0-9]{24}$/i.test(id)) return Promise.resolve(null);
        return this.accounts(() => this.one('crew_accounts', { ...this.scope, portal_account_id: `eq.${id}` }, accountFromRow));
    }
    createAccount(data) {
        return this.accounts(async () => {
            const [row] = await this.db.insert('crew_accounts', { va_slug: this.slug, ...accountToRow(data) });
            return accountFromRow(row);
        });
    }
    updateAccount(id, patch) {
        return this.accounts(async () => {
            const [row] = await this.db.update('crew_accounts', this.ident(id), accountToRow(patch));
            return row ? accountFromRow(row) : null;
        });
    }
    deleteAccount(id) {
        return this.accounts(async () => { await this.db.remove('crew_accounts', this.ident(id)); return true; });
    }

    // --- Forgotten passwords (v19) ---
    //
    // The same shape as accounts() above, one layer in: a project on a pre-v19
    // schema HAS the logins table and is signing pilots in perfectly, and what
    // it has not got is the five columns a reset needs. So the error names that
    // rather than the table, and the routes turn this one code into the answer
    // the sign-in page gives a pilot — "this crew centre cannot do resets yet,
    // message your staff" — instead of promising an email that is not coming.
    //
    // A filter or a select naming a column the project has not got comes back
    // as store_schema_outdated; a project with no crew_accounts at all comes
    // back as store_accounts_missing from accounts(). Both mean the same thing
    // here, and both are the VA's to fix with one button.
    async resets(fn) {
        try { return await this.accounts(fn); } catch (err) {
            if (err instanceof CrewStoreError
                && (err.code === 'store_schema_missing' || err.code === 'store_schema_outdated'
                    || err.code === 'store_accounts_missing')) {
                throw new CrewStoreError(
                    'This crew center’s project cannot do password resets yet. Re-run the setup SQL (Settings → Data store) to add them.',
                    { status: 409, code: 'store_resets_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * The account a reset link opens, or null.
     *
     * Looked up by the HASH of the token — the link itself is never stored, so
     * this is the only question that can be asked of it. Whether the link is
     * still in date is NOT decided here: crewPasswordReset.tokenState owns
     * that, so "expired" is one rule in one place rather than a filter here
     * and a check there that can disagree.
     *
     * The empty hash is refused rather than queried, because every account
     * that has never asked holds '' and a filter on it would open the first
     * one of them to anybody who pressed `?reset=`.
     */
    getAccountByResetToken(hash) {
        const h = String(hash || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(h)) return Promise.resolve(null);
        return this.resets(() => this.one('crew_accounts', { ...this.scope, reset_token_hash: `eq.${h}` }, accountFromRow));
    }

    /**
     * What is still waiting on a human: the requests that could not be emailed
     * and have not been dealt with.
     *
     * Oldest first, deliberately — this is a queue of people who cannot get
     * into their crew center, and the one who has been waiting longest is the
     * one to deal with next.
     */
    listPasswordRequests({ limit = 200 } = {}) {
        return this.resets(async () => {
            const rows = await this.db.select('crew_accounts', {
                ...this.scope, reset_needs_staff: 'is.true',
                order: 'reset_requested_at.asc', limit,
            });
            return (rows || []).map(accountFromRow);
        });
    }

    // --- Routes ---
    async listRoutes({ activeOnly = false, limit = 3000 } = {}) {
        const params = { ...this.scope, order: 'flight_number.asc,created_at.desc', limit };
        if (activeOnly) params.active = 'is.true';
        const rows = await this.db.select('crew_routes', params);
        return (rows || []).map(routeFromRow);
    }
    getRoute(id) { return this.one('crew_routes', this.ident(id), routeFromRow); }
    async createRoute(data) {
        const [row] = await this.db.insert('crew_routes', { va_slug: this.slug, ...routeToRow(data) });
        return routeFromRow(row);
    }
    async updateRoute(id, patch) {
        const [row] = await this.db.update('crew_routes', this.ident(id), routeToRow(patch));
        return row ? routeFromRow(row) : null;
    }
    async deleteRoute(id) { await this.db.remove('crew_routes', this.ident(id)); return true; }

    // --- Flight reports ---
    async listPireps({ status = '', limit = 500 } = {}) {
        const params = { ...this.scope, order: 'flown_at.desc.nullslast,created_at.desc', limit };
        if (status) params.status = `eq.${status}`;
        const rows = await this.db.select('crew_pireps', params);
        return (rows || []).map(pirepFromRow);
    }
    getPirep(id) { return this.one('crew_pireps', this.ident(id), pirepFromRow); }
    async createPirep(data) {
        const [row] = await this.db.insert('crew_pireps', { va_slug: this.slug, ...pirepToRow(data) });
        return pirepFromRow(row);
    }
    async updatePirep(id, patch) {
        const [row] = await this.db.update('crew_pireps', this.ident(id), pirepToRow(patch));
        return row ? pirepFromRow(row) : null;
    }
    async deletePirep(id) { await this.db.remove('crew_pireps', this.ident(id)); return true; }

    // The flights filed for one event. Answers "who actually flew it?", which
    // is a different question from "who said they were coming" and the one
    // that matters after the fact.
    async listPirepsForEvent(eventId, { limit = 500 } = {}) {
        if (!eventId) return [];
        const rows = await this.db.select('crew_pireps', {
            ...this.scope, event_id: `eq.${eventId}`, order: 'flown_at.desc.nullslast,created_at.desc', limit,
        });
        return (rows || []).map(pirepFromRow);
    }

    /**
     * One pilot's own flights — their logbook.
     *
     * Every status, unlike the public flight log. A pilot must be able to see
     * that the report they filed on Tuesday is still pending, and that the one
     * before it was rejected; showing them only the approved ones is how a
     * rejection becomes a report that silently never existed.
     */
    async listPirepsForMember(memberId, { limit = 500 } = {}) {
        if (!memberId) return [];
        const rows = await this.db.select('crew_pireps', {
            ...this.scope, member_id: `eq.${memberId}`,
            order: 'flown_at.desc.nullslast,created_at.desc', limit,
        });
        return (rows || []).map(pirepFromRow);
    }

    /**
     * Just the dates a pilot has flown on, for the streak.
     *
     * A separate method rather than listPirepsForMember with a filter, because
     * the difference is the whole point: a streak needs one column and a status
     * off every approved report a pilot has, and pulling their entire logbook —
     * liveries, routes, remarks, five hundred rows of it — to count weeks would
     * put the heaviest query in the crew center behind the lightest number on
     * the card.
     *
     * `since` bounds it to the window crewStreaks can actually count, so a pilot
     * with four years of flying costs the same as one with four months.
     */
    async listFlightDatesForMember(memberId, { since = null, limit = 1000 } = {}) {
        if (!memberId) return [];
        const params = {
            ...this.scope, member_id: `eq.${memberId}`, status: 'eq.approved',
            select: 'id,status,flown_at,created_at',
            order: 'flown_at.desc.nullslast,created_at.desc', limit,
        };
        if (since) params.flown_at = `gte.${new Date(since).toISOString()}`;
        const rows = await this.db.select('crew_pireps', params);
        return (rows || []).map((r) => ({
            _id: r.id, status: r.status || 'approved',
            flownAt: date(r.flown_at), createdAt: date(r.created_at),
        }));
    }

    // Which of these Infinite Flight flight ids have we already captured? Used
    // by the sync to skip flights without attempting (and failing) an insert.
    async seenFlightIds(flightIds) {
        const ids = (flightIds || []).map((i) => String(i)).filter(Boolean);
        if (!ids.length) return new Set();
        const rows = await this.db.select('crew_pireps', {
            ...this.scope,
            flight_id: `in.(${ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`,
            select: 'flight_id',
            limit: ids.length,
        });
        return new Set((rows || []).map((r) => r.flight_id));
    }

    // --- Applications ---
    async listApplications({ status = 'pending', limit = 500 } = {}) {
        const params = { ...this.scope, order: 'created_at.desc', limit };
        if (status) params.status = `eq.${status}`;
        const rows = await this.db.select('crew_applications', params);
        return (rows || []).map(applicationFromRow);
    }
    getApplication(id) { return this.one('crew_applications', this.ident(id), applicationFromRow); }
    getApplicationByToken(token) {
        return this.one('crew_applications', { ...this.scope, status_token: `eq.${token}` }, applicationFromRow);
    }
    // The invitation belonging to an account, so signing in can clear it.
    // Deliberately not filtered on a non-empty password: expressing "not the
    // empty string" in a PostgREST query string is fragile, and the caller has
    // to look at the row anyway. Cheap either way — this is one indexed lookup.
    getApplicationByInviteAccount(accountId) {
        return this.one('crew_applications', {
            ...this.scope, invite_account_id: `eq.${accountId}`,
        }, applicationFromRow);
    }
    async createApplication(data) {
        const [row] = await this.db.insert('crew_applications', { va_slug: this.slug, ...applicationToRow(data) });
        return applicationFromRow(row);
    }
    async updateApplication(id, patch) {
        const [row] = await this.db.update('crew_applications', this.ident(id), applicationToRow(patch));
        return row ? applicationFromRow(row) : null;
    }

    // --- Events ---
    //
    // Same shape as accounts(): a project on a pre-v6 schema has no events
    // tables, and the generic "your tables are missing" would read as a lie on
    // a crew center whose roster, routes and flight reports are all answering.
    async events(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the events tables yet. Re-run the setup SQL (Settings → Data store) to add them.',
                    { status: 409, code: 'store_events_missing', detail: err.detail });
            }
            throw err;
        }
    }

    // `upcomingOnly` is deliberately "starts after 12 hours ago" rather than
    // "starts in the future": an event under way is exactly what a pilot
    // opening the crew center mid-departure needs to see, and it matches the
    // window the public VA-events feed already uses.
    listEvents({ status = '', upcomingOnly = false, limit = 300 } = {}) {
        return this.events(async () => {
            const params = { ...this.scope, order: 'starts_at.asc.nullslast,created_at.desc', limit };
            if (status) params.status = `eq.${status}`;
            if (upcomingOnly) params.starts_at = `gte.${new Date(Date.now() - 12 * 3600 * 1000).toISOString()}`;
            const rows = await this.db.select('crew_events', params);
            return (rows || []).map(eventFromRow);
        });
    }
    /**
     * Events that finished a while ago and still carry artwork. v21.
     *
     * What the artwork sweep reads. Narrow on purpose: a VA with four hundred
     * events has four hundred rows nothing needs, and the sweep runs over every
     * VA we have. The filter is `starts_at` because that is the indexed column
     * and an event cannot END before it starts — so this is a superset of what
     * is actually expired, and crewEvents.bannerExpired makes the real decision
     * (including on `ends_at`, and on whether the picture is even ours).
     *
     * `banner_url: 'neq.'` is "not the empty string", the same filter the
     * linked-pilot lookup uses. Almost every event has no banner at all.
     */
    listEventsWithBanner({ startedBefore, limit = 500 } = {}) {
        return this.events(async () => {
            const params = {
                ...this.scope, order: 'starts_at.asc', limit,
                banner_url: 'neq.',
            };
            if (startedBefore) params.starts_at = `lt.${new Date(startedBefore).toISOString()}`;
            const rows = await this.db.select('crew_events', params);
            return (rows || []).map(eventFromRow);
        });
    }
    getEvent(id) { return this.events(() => this.one('crew_events', this.ident(id), eventFromRow)); }
    createEvent(data) {
        return this.events(async () => {
            const [row] = await this.db.insert('crew_events', { va_slug: this.slug, ...eventToRow(data) });
            return eventFromRow(row);
        });
    }
    updateEvent(id, patch) {
        return this.events(async () => {
            const [row] = await this.db.update('crew_events', this.ident(id), eventToRow(patch));
            return row ? eventFromRow(row) : null;
        });
    }
    // The signups go with it: crew_event_signups.event_id cascades on delete.
    deleteEvent(id) {
        return this.events(async () => { await this.db.remove('crew_events', this.ident(id)); return true; });
    }

    // --- Who is attending ---
    listSignups(eventId, { limit = 1000 } = {}) {
        return this.events(async () => {
            const rows = await this.db.select('crew_event_signups', {
                ...this.scope, event_id: `eq.${eventId}`, order: 'created_at.asc', limit,
            });
            return (rows || []).map(signupFromRow);
        });
    }
    // Every attendee of several events at once. The calendar needs a count on
    // each card, and asking per event would be one round trip per event — sixty
    // of them on a busy VA's events page. One `in.()` query answers the lot.
    listSignupsForEvents(eventIds, { limit = 5000 } = {}) {
        const ids = (eventIds || []).map((i) => String(i)).filter(Boolean);
        if (!ids.length) return Promise.resolve([]);
        return this.events(async () => {
            const rows = await this.db.select('crew_event_signups', {
                ...this.scope,
                event_id: `in.(${ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`,
                order: 'created_at.asc',
                limit,
            });
            return (rows || []).map(signupFromRow);
        });
    }
    getSignup(id) { return this.events(() => this.one('crew_event_signups', this.ident(id), signupFromRow)); }
    // The row belonging to one pilot at one event, however we know them. Used
    // to answer "am I signed up?" and to route a gate change to the right row.
    getSignupFor(eventId, { accountId = '', memberId = '' } = {}) {
        const key = accountId ? { account_id: `eq.${accountId}` } : memberId ? { member_id: `eq.${memberId}` } : null;
        if (!key) return Promise.resolve(null);
        return this.events(() => this.one('crew_event_signups', {
            ...this.scope, event_id: `eq.${eventId}`, ...key,
        }, signupFromRow));
    }
    createSignup(data) {
        return this.events(async () => {
            const [row] = await this.db.insert('crew_event_signups', { va_slug: this.slug, ...signupToRow(data) });
            return signupFromRow(row);
        });
    }
    updateSignup(id, patch) {
        return this.events(async () => {
            const [row] = await this.db.update('crew_event_signups', this.ident(id), signupToRow(patch));
            return row ? signupFromRow(row) : null;
        });
    }
    deleteSignup(id) {
        return this.events(async () => { await this.db.remove('crew_event_signups', this.ident(id)); return true; });
    }

    // --- The schedule ---
    //
    // Wrapped exactly as events() is, and for the same reason: a project on a
    // pre-v8 schema has no schedule tables, and "your tables are missing" would
    // read as a lie on a crew center whose roster, routes, flights and events
    // are all answering.
    async schedules(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the schedule tables yet. Re-run the setup SQL (Settings → Data store) to add them.',
                    { status: 409, code: 'store_schedules_missing', detail: err.detail });
            }
            throw err;
        }
    }

    // `upcomingOnly` uses the same twelve-hour grace as listEvents: a departure
    // that pushed back an hour ago is exactly what a pilot opening the crew
    // center mid-flight is looking for, and dropping it the moment the clock
    // passes it would take the day's own flying off the day's schedule.
    listSchedules({ status = '', upcomingOnly = false, limit = 500 } = {}) {
        return this.schedules(async () => {
            const params = { ...this.scope, order: 'departs_at.asc.nullslast,created_at.desc', limit };
            if (status) params.status = `eq.${status}`;
            if (upcomingOnly) params.departs_at = `gte.${new Date(Date.now() - 12 * 3600 * 1000).toISOString()}`;
            const rows = await this.db.select('crew_schedules', params);
            return (rows || []).map(scheduleFromRow);
        });
    }
    getSchedule(id) { return this.schedules(() => this.one('crew_schedules', this.ident(id), scheduleFromRow)); }
    // Several departures at once, for the per-pilot booking cap: a pilot with a
    // season of bookings would otherwise cost one round trip per booking to
    // answer "how many are you still holding?", which would make the check more
    // expensive than the booking it guards.
    listSchedulesByIds(ids, { limit = 500 } = {}) {
        const clean = [...new Set((ids || []).map((i) => String(i)).filter(Boolean))];
        if (!clean.length) return Promise.resolve([]);
        return this.schedules(async () => {
            const rows = await this.db.select('crew_schedules', {
                ...this.scope,
                id: `in.(${clean.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`,
                limit,
            });
            return (rows || []).map(scheduleFromRow);
        });
    }
    createSchedule(data) {
        return this.schedules(async () => {
            const [row] = await this.db.insert('crew_schedules', { va_slug: this.slug, ...scheduleToRow(data) });
            return scheduleFromRow(row);
        });
    }
    updateSchedule(id, patch) {
        return this.schedules(async () => {
            const [row] = await this.db.update('crew_schedules', this.ident(id), scheduleToRow(patch));
            return row ? scheduleFromRow(row) : null;
        });
    }
    // The bookings go with it: crew_bookings.schedule_id cascades on delete.
    deleteSchedule(id) {
        return this.schedules(async () => { await this.db.remove('crew_schedules', this.ident(id)); return true; });
    }

    // --- Who is flying it ---
    listBookings(scheduleId, { limit = 100 } = {}) {
        return this.schedules(async () => {
            const rows = await this.db.select('crew_bookings', {
                ...this.scope, schedule_id: `eq.${scheduleId}`, order: 'seat.asc', limit,
            });
            return (rows || []).map(bookingFromRow);
        });
    }
    // Every booking across several departures at once. The schedule panel shows
    // coverage on every row, and asking per departure would be one round trip
    // per leg — a fortnight of flying is hundreds of them. One `in.()` answers
    // the lot, the same way listSignupsForEvents does for the calendar.
    listBookingsForSchedules(scheduleIds, { limit = 5000 } = {}) {
        const ids = (scheduleIds || []).map((i) => String(i)).filter(Boolean);
        if (!ids.length) return Promise.resolve([]);
        return this.schedules(async () => {
            const rows = await this.db.select('crew_bookings', {
                ...this.scope,
                schedule_id: `in.(${ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`,
                order: 'seat.asc',
                limit,
            });
            return (rows || []).map(bookingFromRow);
        });
    }
    getBooking(id) { return this.schedules(() => this.one('crew_bookings', this.ident(id), bookingFromRow)); }
    // The row belonging to one pilot on one departure, however we know them.
    // Answers "have I booked this?" and routes a cancellation to the right row.
    getBookingFor(scheduleId, { accountId = '', memberId = '' } = {}) {
        const key = accountId ? { account_id: `eq.${accountId}` } : memberId ? { member_id: `eq.${memberId}` } : null;
        if (!key) return Promise.resolve(null);
        return this.schedules(() => this.one('crew_bookings', {
            ...this.scope, schedule_id: `eq.${scheduleId}`, ...key,
        }, bookingFromRow));
    }
    // Every departure one pilot has booked, so their own page can show the week
    // they are flying without walking the whole schedule.
    listBookingsForPilot({ accountId = '', memberId = '' } = {}, { limit = 200 } = {}) {
        const key = accountId ? { account_id: `eq.${accountId}` } : memberId ? { member_id: `eq.${memberId}` } : null;
        if (!key) return Promise.resolve([]);
        return this.schedules(async () => {
            const rows = await this.db.select('crew_bookings', {
                ...this.scope, ...key, order: 'created_at.desc', limit,
            });
            return (rows || []).map(bookingFromRow);
        });
    }
    createBooking(data) {
        return this.schedules(async () => {
            const [row] = await this.db.insert('crew_bookings', { va_slug: this.slug, ...bookingToRow(data) });
            return bookingFromRow(row);
        });
    }
    updateBooking(id, patch) {
        return this.schedules(async () => {
            const [row] = await this.db.update('crew_bookings', this.ident(id), bookingToRow(patch));
            return row ? bookingFromRow(row) : null;
        });
    }
    deleteBooking(id) {
        return this.schedules(async () => { await this.db.remove('crew_bookings', this.ident(id)); return true; });
    }
    // What has actually been flown against a departure. Best-effort at the call
    // site for the same reason listPirepsForEvent is: a project on an older
    // schema has no schedule_id column, and a departure whose flights cannot be
    // listed is still a departure worth opening.
    async listPirepsForSchedule(scheduleId, { limit = 100 } = {}) {
        if (!scheduleId) return [];
        const rows = await this.db.select('crew_pireps', {
            ...this.scope, schedule_id: `eq.${scheduleId}`, order: 'flown_at.desc.nullslast,created_at.desc', limit,
        });
        return (rows || []).map(pirepFromRow);
    }

    // --- The noticeboard ---
    //
    // Wrapped like events and accounts: a project on a pre-v7 schema has no
    // crew_announcements table, and the caller that writes to it is almost
    // always doing so as a SIDE EFFECT of something that has already happened
    // (a promotion, a pilot joining). So the missing table has to surface as a
    // thing the VA can fix, and the caller has to be free to ignore it.
    async announcements(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the announcements table yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_announcements_missing', detail: err.detail });
            }
            throw err;
        }
    }

    listAnnouncements({ limit = 50 } = {}) {
        return this.announcements(async () => {
            const rows = await this.db.select('crew_announcements', {
                ...this.scope, order: 'pinned.desc,created_at.desc', limit,
            });
            return (rows || []).map(announcementFromRow);
        });
    }
    getAnnouncement(id) {
        return this.announcements(() => this.one('crew_announcements', this.ident(id), announcementFromRow));
    }
    /**
     * Write a notice, and never lose one to a `kind` the project has not heard of.
     *
     * THE FAILURE THIS CLOSES. `kind` is an inline CHECK constraint, and the
     * schema file has widened it three times — 'schedule' at v8, 'leave' at
     * v18, 'staff' at v20 — each with a note saying that a project provisioned
     * earlier refuses a value it does not know and "the notice would vanish
     * with no explanation". That was not hypothetical and it was never fixed: a
     * VA who has not re-run the SQL silently loses every notice of the newest
     * kind, and because postAnnouncement is fire-and-forget nothing anywhere
     * reports it.
     *
     * A check violation on `kind` is not a reason to drop the row. It is a
     * reason to post it as 'notice' — which every project back to v7 accepts,
     * and which costs only the icon the board would have drawn. The fact
     * survives; the styling waits for the upgrade. Same trade as LATE_COLUMNS,
     * for a constraint rather than a column.
     *
     * Retried ONCE, and only for this one constraint. Every other write failure
     * is a real fault and still throws.
     */
    createAnnouncement(data) {
        return this.announcements(async () => {
            const row = announcementToRow(data);
            try {
                const [saved] = await this.db.insert('crew_announcements', { va_slug: this.slug, ...row });
                return announcementFromRow(saved);
            } catch (err) {
                const refusedKind = err instanceof CrewStoreError
                    && row.kind && row.kind !== 'notice'
                    && /crew_announcements_kind_check|violates check constraint/i.test(String(err.detail || ''));
                if (!refusedKind) throw err;
                this.db.dropped.add('crew_announcements.kind');
                const [saved] = await this.db.insert('crew_announcements',
                    { va_slug: this.slug, ...row, kind: 'notice' });
                return announcementFromRow(saved);
            }
        });
    }
    updateAnnouncement(id, patch) {
        return this.announcements(async () => {
            const [row] = await this.db.update('crew_announcements', this.ident(id), announcementToRow(patch));
            return row ? announcementFromRow(row) : null;
        });
    }
    deleteAnnouncement(id) {
        return this.announcements(async () => { await this.db.remove('crew_announcements', this.ident(id)); return true; });
    }

    /**
     * Drop the generated notices that have scrolled off the board. v20.
     *
     * Returns how many went, and 0 for every reason it could not run — the
     * project is on a pre-v20 schema and has no such function, the RPC failed,
     * the VA's project is unreachable. Housekeeping is the one thing that must
     * never turn into an error for the caller: this is invoked after a notice
     * has already been written, and failing the write that caused it would mean
     * a promotion reported as broken because the tidy-up afterwards did not
     * happen. Same contract, and same reasoning, as noteLinkOpen above.
     *
     * The keep count, what is safe from it, and why it counts rows rather than
     * days are all in the schema file under crew_announcements_prune. Nothing
     * here decides any of it.
     */
    async pruneAnnouncements({ keep = 200 } = {}) {
        try {
            const out = await this.db.rpc('crew_announcements_prune', {
                p_va_slug: this.slug, p_keep: keep,
            });
            return Number(Array.isArray(out) ? out[0] : out) || 0;
        } catch { return 0; }
    }

    // --- The document library (v11) ---
    //
    // Wrapped like events, schedules and the noticeboard: a pre-v11 project has
    // no crew_documents table, and the panel offers the update button itself
    // rather than reporting a broken store.
    async documents(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the document library yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_documents_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * The library.
     *
     * Ordered here only enough to be deterministic — the order a READER wants
     * (pinned, then by kind, then by title) is crewDocs.libraryFor's job,
     * because it depends on the viewer and on a kind ranking that would need a
     * CASE expression kept in step with crewDocs.KINDS by hand.
     *
     * `status` filters server-side when given, so the pilot-facing call fetches
     * published rows only instead of pulling drafts across the wire and throwing
     * them away — a VA with a big archived manual should not pay for it on every
     * pilot's page load.
     */
    listDocuments({ status = '', limit = 200 } = {}) {
        return this.documents(async () => {
            const q = { ...this.scope, order: 'pinned.desc,title.asc', limit };
            if (status) q.status = `eq.${status}`;
            const rows = await this.db.select('crew_documents', q);
            return (rows || []).map(documentFromRow);
        });
    }
    getDocument(id) {
        return this.documents(() => this.one('crew_documents', this.ident(id), documentFromRow));
    }
    createDocument(data) {
        return this.documents(async () => {
            const [row] = await this.db.insert('crew_documents', { va_slug: this.slug, ...documentToRow(data) });
            return documentFromRow(row);
        });
    }
    updateDocument(id, patch) {
        return this.documents(async () => {
            const [row] = await this.db.update('crew_documents', this.ident(id), documentToRow(patch));
            return row ? documentFromRow(row) : null;
        });
    }
    deleteDocument(id) {
        return this.documents(async () => { await this.db.remove('crew_documents', this.ident(id)); return true; });
    }

    // --- The pilot's inbox (v11) ---
    async notifications(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project cannot hold pilot messages yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_notifications_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * One pilot's inbox.
     *
     * Addressed by account OR member, both, because the two are populated at
     * different moments: an automatic message written the instant an application
     * is accepted has a member id and may not have an account id yet, and the
     * pilot who then signs in must still find it. Querying on either with an
     * `or` keeps that one row from being invisible to the only person it was for.
     */
    listNotifications({ accountId = '', memberId = '', unreadOnly = false, limit = 100 } = {}) {
        return this.notifications(async () => {
            const ids = [];
            if (accountId) ids.push(`account_id.eq.${accountId}`);
            if (memberId) ids.push(`member_id.eq.${memberId}`);
            // No identity means no inbox. Returned empty rather than
            // unfiltered — a missing id must never fall through to "everybody's
            // messages", which is the one mistake here that would be a breach.
            if (!ids.length) return [];
            const q = { ...this.scope, or: `(${ids.join(',')})`, order: 'created_at.desc', limit };
            if (unreadOnly) q.read_at = 'is.null';
            const rows = await this.db.select('crew_notifications', q);
            return (rows || []).map(notificationFromRow);
        });
    }
    getNotification(id) {
        return this.notifications(() => this.one('crew_notifications', this.ident(id), notificationFromRow));
    }

    /**
     * Write a batch of messages — one send, many recipients.
     *
     * A single insert with an array body rather than a loop: a rank send to a
     * 200-pilot roster is 200 rows, and 200 round trips against the VA's project
     * would take long enough for the request to time out halfway and leave the
     * send half-delivered with no way to tell which half.
     */
    createNotifications(rows) {
        const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
        if (!list.length) return Promise.resolve([]);
        return this.notifications(async () => {
            const payload = list.map((n) => ({ va_slug: this.slug, ...notificationToRow(n) }));
            const out = await this.db.insert('crew_notifications', payload);
            return (out || []).map(notificationFromRow);
        });
    }

    /**
     * Mark read. Scoped by the reader's own ids as well as the row id, so a
     * pilot holding somebody else's notification id cannot mark it read (or
     * learn that it exists) — the filter simply matches nothing.
     */
    markNotificationsRead({ ids = [], accountId = '', memberId = '', all = false } = {}) {
        return this.notifications(async () => {
            const owner = [];
            if (accountId) owner.push(`account_id.eq.${accountId}`);
            if (memberId) owner.push(`member_id.eq.${memberId}`);
            if (!owner.length) return 0;
            const q = { ...this.scope, or: `(${owner.join(',')})`, read_at: 'is.null' };
            if (!all) {
                const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
                if (!list.length) return 0;
                q.id = `in.(${list.join(',')})`;
            }
            const rows = await this.db.update('crew_notifications', q, { read_at: new Date().toISOString() });
            return (rows || []).length;
        });
    }

    deleteNotification(id) {
        return this.notifications(async () => { await this.db.remove('crew_notifications', this.ident(id)); return true; });
    }

    // --- The quick-links board (v12) ---
    async links(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center’s project does not have the quick-links board yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_links_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * The board.
     *
     * Ordered only enough to be deterministic; the order a READER wants (pinned,
     * then staff's arrangement, then alphabetical, with sort_order 0 meaning
     * "never arranged" and sorting LAST) is crewLinks.boardFor's job — see the
     * note there for why an ORDER BY gets it backwards.
     */
    listLinks({ status = '', limit = 300 } = {}) {
        return this.links(async () => {
            const q = { ...this.scope, order: 'pinned.desc,sort_order.asc,title.asc', limit };
            if (status) q.status = `eq.${status}`;
            const rows = await this.db.select('crew_links', q);
            return (rows || []).map(linkFromRow);
        });
    }
    getLink(id) {
        return this.links(() => this.one('crew_links', this.ident(id), linkFromRow));
    }
    createLink(data) {
        return this.links(async () => {
            const [row] = await this.db.insert('crew_links', { va_slug: this.slug, ...linkToRow(data) });
            return linkFromRow(row);
        });
    }
    updateLink(id, patch) {
        return this.links(async () => {
            const [row] = await this.db.update('crew_links', this.ident(id), linkToRow(patch));
            return row ? linkFromRow(row) : null;
        });
    }
    deleteLink(id) {
        return this.links(async () => { await this.db.remove('crew_links', this.ident(id)); return true; });
    }

    /**
     * Count an open.
     *
     * Through the RPC rather than a PATCH, because `opens = opens + 1` is not
     * something PostgREST can express and a read-then-write would lose counts
     * under exactly the traffic this counter exists to measure.
     *
     * Best-effort by design: a pilot's tap must open the link whether or not the
     * counter moved, so the caller is free to ignore a failure here. A project on
     * a pre-v12 schema has no function to call, and that is a reason to skip the
     * tally, never to refuse the click.
     */
    async noteLinkOpen(id) {
        if (!id) return 0;
        try {
            const out = await this.db.rpc('crew_link_open', { p_va_slug: this.slug, p_link_id: id });
            return Number(Array.isArray(out) ? out[0] : out) || 0;
        } catch { return 0; }
    }

    // --- Check-rides (v14) ---
    async training(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew center\u2019s project does not have the check-ride queue yet. Re-run the setup SQL (Settings \u2192 Data store) to add it.',
                    { status: 409, code: 'store_training_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * The queue, oldest ask first.
     *
     * Ascending rather than descending, unlike every other list here: this one is
     * worked rather than read, and the person who has been waiting longest is the
     * one who should be at the top. The pilot's own view re-sorts client-side,
     * where "my latest" is what matters.
     *
     * `memberId` narrows it to one pilot, which is what a signed-in pilot with no
     * staff capability is allowed to see \u2014 the filter is applied in the query
     * rather than after it, so the rows never leave Postgres in the first place.
     */
    listTrainingRequests({ memberId = '', limit = 300 } = {}) {
        return this.training(async () => {
            const q = { ...this.scope, order: 'created_at.asc', limit };
            if (memberId) q.member_id = `eq.${memberId}`;
            const rows = await this.db.select('crew_training_requests', q);
            return (rows || []).map(trainingFromRow);
        });
    }
    getTrainingRequest(id) {
        return this.training(() => this.one('crew_training_requests', this.ident(id), trainingFromRow));
    }
    createTrainingRequest(data) {
        return this.training(async () => {
            const [row] = await this.db.insert('crew_training_requests',
                { va_slug: this.slug, ...trainingToRow(data) });
            return trainingFromRow(row);
        });
    }
    updateTrainingRequest(id, patch) {
        return this.training(async () => {
            const [row] = await this.db.update('crew_training_requests', this.ident(id), trainingToRow(patch));
            return row ? trainingFromRow(row) : null;
        });
    }

    // --- Staff applications (v20) ---
    async staffApps(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError && err.code === 'store_schema_missing') {
                throw new CrewStoreError(
                    'This crew centre’s project cannot take staff applications yet. Re-run the setup SQL (Settings → Data store) to add them.',
                    { status: 409, code: 'store_staff_apps_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * The queue, newest ask first.
     *
     * Descending, unlike the check-ride queue: hiring is read as a shortlist
     * rather than worked as a first-come line, and the reviewer wants to see
     * who has just applied. A pilot's own view re-sorts client-side.
     *
     * `memberId` narrows it to one pilot — what a signed-in pilot with no
     * team.manage is allowed to see — and the filter is applied in the query so
     * the rest of the airline's applications never leave Postgres. `status`
     * narrows it to the open ones, which is what the badge counts.
     */
    listStaffApplications({ memberId = '', status = '', limit = 300 } = {}) {
        return this.staffApps(async () => {
            const q = { ...this.scope, order: 'created_at.desc', limit };
            if (memberId) q.member_id = `eq.${memberId}`;
            if (status) q.status = `eq.${status}`;
            const rows = await this.db.select('crew_staff_applications', q);
            return (rows || []).map(staffAppFromRow);
        });
    }
    getStaffApplication(id) {
        return this.staffApps(() => this.one('crew_staff_applications', this.ident(id), staffAppFromRow));
    }
    createStaffApplication(data) {
        return this.staffApps(async () => {
            const [row] = await this.db.insert('crew_staff_applications',
                { va_slug: this.slug, ...staffAppToRow(data) });
            return staffAppFromRow(row);
        });
    }
    updateStaffApplication(id, patch) {
        return this.staffApps(async () => {
            const [row] = await this.db.update('crew_staff_applications', this.ident(id), staffAppToRow(patch));
            return row ? staffAppFromRow(row) : null;
        });
    }
    deleteStaffApplication(id) {
        return this.staffApps(async () => {
            await this.db.remove('crew_staff_applications', this.ident(id));
            return true;
        });
    }

    // --- Quizzes (v22) ---
    //
    // The quizzes themselves are config and live on the VA's record beside the
    // rank ladder and the staff openings. What is here is the sitting of one:
    // who was sent which quiz, what they answered and what it came to.
    async quizzes(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError
                && (err.code === 'store_schema_missing' || err.code === 'store_schema_outdated')) {
                throw new CrewStoreError(
                    'This crew centre\u2019s project cannot record quiz results yet. Re-run the setup SQL (Settings \u2192 Data store) to add them.',
                    { status: 409, code: 'store_quizzes_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * Attempts, newest first — which is what both screens want. Staff read this
     * as "who has been sent what lately", and a pilot's own view is almost
     * always about the one they were just given.
     *
     * `memberId` narrows it to one pilot, which is all a signed-in pilot may
     * see, and the filter is applied in the query so the rest of the airline's
     * results never leave Postgres.
     */
    listQuizAttempts({ memberId = '', quizId = '', status = '', limit = 300 } = {}) {
        return this.quizzes(async () => {
            const q = { ...this.scope, order: 'created_at.desc', limit };
            if (memberId) q.member_id = `eq.${memberId}`;
            if (quizId) q.quiz_id = `eq.${quizId}`;
            if (status) q.status = `eq.${status}`;
            const rows = await this.db.select('crew_quiz_attempts', q);
            return (rows || []).map(quizAttemptFromRow);
        });
    }
    getQuizAttempt(id) {
        return this.quizzes(() => this.one('crew_quiz_attempts', this.ident(id), quizAttemptFromRow));
    }
    /** The link, resolved. The token is unique per project by index. */
    getQuizAttemptByToken(token) {
        return this.quizzes(() => this.one('crew_quiz_attempts',
            { ...this.scope, token: `eq.${String(token || '')}` }, quizAttemptFromRow));
    }
    createQuizAttempt(data) {
        return this.quizzes(async () => {
            const [row] = await this.db.insert('crew_quiz_attempts',
                { va_slug: this.slug, ...quizAttemptToRow(data) });
            return quizAttemptFromRow(row);
        });
    }
    updateQuizAttempt(id, patch) {
        return this.quizzes(async () => {
            const [row] = await this.db.update('crew_quiz_attempts', this.ident(id), quizAttemptToRow(patch));
            return row ? quizAttemptFromRow(row) : null;
        });
    }
    deleteQuizAttempt(id) {
        return this.quizzes(async () => {
            await this.db.remove('crew_quiz_attempts', this.ident(id));
            return true;
        });
    }

    /* --- Leave of absence (v15) ---
     *
     * Two codes collapse into one here, and deliberately. A project that has
     * never had the crew tables answers `store_schema_missing`; one that has
     * them but predates the leave columns answers `store_schema_outdated`, which
     * is what PostgREST says when a write names `loa_until` and the column is
     * not there. From the panel's side those are the same sentence — "your
     * database is behind, here is the button" — and `store_leave_missing` is
     * what CrewPanels.isSchemaGap recognises.
     */
    async leave(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError
                && (err.code === 'store_schema_missing' || err.code === 'store_schema_outdated')) {
                throw new CrewStoreError(
                    'This crew center’s project cannot record leave yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_leave_missing', detail: err.detail });
            }
            throw err;
        }
    }

    /**
     * Put a pilot on leave.
     *
     * `status` moves with it because the roster sweep reads the status and
     * nothing else — the three columns are the record, the flag is the rule.
     * Writing both in one PATCH is what stops a pilot being marked away with a
     * sweep that still has them in its sights.
     */
    setLeave(memberId, { until = null, reason = '' } = {}) {
        return this.leave(async () => {
            const [row] = await this.db.update('crew_members', this.ident(memberId), {
                status: 'loa',
                loa_until: until ? new Date(until).toISOString() : null,
                loa_reason: str(reason, 120),
                loa_since: new Date().toISOString(),
            });
            return row ? memberFromRow(row) : null;
        });
    }

    /**
     * Back early, or back on time.
     *
     * Clears the record as well as the flag, so a pilot who goes away twice does
     * not carry the first trip's sentence into the second. Returning to 'active'
     * rather than to whatever they were before is right for the same reason the
     * sweep only ever marks people inactive: this is the pilot saying they are
     * flying again, and that is the status for it.
     */
    endLeave(memberId) {
        return this.leave(async () => {
            const [row] = await this.db.update('crew_members', this.ident(memberId), {
                status: 'active', loa_until: null, loa_reason: '', loa_since: null,
            });
            return row ? memberFromRow(row) : null;
        });
    }

    /* --- The shop (v15) ---
     *
     * One wrapper for the shelf, the orders and the wallet, because they fail
     * together: see SHOP_SCHEMA_VERSION for why there is no useful sentence
     * about a project with one and not the others.
     */
    async shop(fn) {
        try { return await fn(); } catch (err) {
            if (err instanceof CrewStoreError
                && (err.code === 'store_schema_missing' || err.code === 'store_schema_outdated')) {
                throw new CrewStoreError(
                    'This crew center’s project does not have the shop yet. Re-run the setup SQL (Settings → Data store) to add it.',
                    { status: 409, code: 'store_shop_missing', detail: err.detail });
            }
            throw err;
        }
    }

    listShopItems({ activeOnly = false, limit = 200 } = {}) {
        return this.shop(async () => {
            const q = { ...this.scope, order: 'created_at.asc', limit };
            if (activeOnly) q.active = 'is.true';
            const rows = await this.db.select('crew_shop_items', q);
            return (rows || []).map(shopItemFromRow);
        });
    }
    getShopItem(id) {
        return this.shop(() => this.one('crew_shop_items', this.ident(id), shopItemFromRow));
    }
    createShopItem(data) {
        return this.shop(async () => {
            const [row] = await this.db.insert('crew_shop_items', { va_slug: this.slug, ...shopItemToRow(data) });
            return shopItemFromRow(row);
        });
    }
    updateShopItem(id, patch) {
        return this.shop(async () => {
            const [row] = await this.db.update('crew_shop_items', this.ident(id), shopItemToRow(patch));
            return row ? shopItemFromRow(row) : null;
        });
    }
    /**
     * Take something off the shelf.
     *
     * A real delete, not a flag: `crew_shop_orders.item_id` is `on delete set
     * null` and every order keeps its own copy of the name and the price, so
     * somebody's receipt survives the thing they bought being removed. Staff who
     * want it back later add it again; staff who want it hidden for a week use
     * `active`, which is what that column is for.
     */
    deleteShopItem(id) {
        return this.shop(async () => { await this.db.remove('crew_shop_items', this.ident(id)); return true; });
    }

    /**
     * The orders.
     *
     * `memberId` narrows it to one pilot, which is what a pilot with no staff
     * capability is allowed to see — applied in the query rather than after it,
     * so nobody else's receipts leave Postgres.
     */
    listShopOrders({ memberId = '', limit = 300 } = {}) {
        return this.shop(async () => {
            const q = { ...this.scope, order: 'created_at.desc', limit };
            if (memberId) q.member_id = `eq.${memberId}`;
            const rows = await this.db.select('crew_shop_orders', q);
            return (rows || []).map(shopOrderFromRow);
        });
    }
    getShopOrder(id) {
        return this.shop(() => this.one('crew_shop_orders', this.ident(id), shopOrderFromRow));
    }

    /**
     * Handed over.
     *
     * Guarded on `status = 'placed'` in the query rather than by reading first:
     * two staff members pressing Delivered on the same order is a normal thing
     * to happen in a busy VA, and the second press should change nothing rather
     * than stamp a second name on it.
     */
    fulfilShopOrder(id, by = '') {
        return this.shop(async () => {
            const [row] = await this.db.update('crew_shop_orders',
                { ...this.ident(id), status: 'eq.placed' },
                { status: 'fulfilled', decided_at: new Date().toISOString(), decided_by: str(by, 80) });
            return row ? shopOrderFromRow(row) : null;
        });
    }

    /**
     * Buying, refunding, and paying for a flight.
     *
     * All four go through the schema's own functions rather than through reads
     * and writes from here, because each of them is several statements that must
     * not tear: a balance tested and debited, a stock taken, a payment recorded
     * exactly once. See their notes in supabase/crew-center-schema.sql.
     */
    buyShopItem(memberId, itemId) {
        return this.shop(async () => {
            const out = await this.db.rpc('crew_shop_buy', {
                p_va_slug: this.slug, p_member_id: memberId, p_item_id: itemId,
            });
            const r = (Array.isArray(out) ? out[0] : out) || {};
            if (!r.ok) {
                throw new CrewStoreError(r.error || 'That purchase did not go through.',
                    { status: 409, code: `shop_${r.code || 'refused'}` });
            }
            return { order: shopOrderFromRow(r.order), wallet: r.wallet || null, stock: r.stock };
        });
    }
    refundShopOrder(id, by = '') {
        return this.shop(async () => {
            const out = await this.db.rpc('crew_shop_refund', {
                p_va_slug: this.slug, p_order_id: id, p_by: str(by, 80),
            });
            const r = (Array.isArray(out) ? out[0] : out) || {};
            if (!r.ok) {
                throw new CrewStoreError(r.error || 'That order could not be refunded.',
                    { status: 409, code: `shop_${r.code || 'refused'}` });
            }
            return shopOrderFromRow(r.order);
        });
    }
    /**
     * Credit a flight, once.
     *
     * Best-effort at the CALLER's discretion, never here: the function itself is
     * the thing that guarantees one payment per flight, and swallowing its
     * answer would leave the server unable to tell "paid" from "already paid".
     */
    creditFlight(pirepId, memberId, amount) {
        return this.shop(async () => {
            const out = await this.db.rpc('crew_shop_credit', {
                p_va_slug: this.slug, p_pirep_id: pirepId,
                p_member_id: memberId || null, p_amount: Math.max(0, Math.round(Number(amount) || 0)),
            });
            return (Array.isArray(out) ? out[0] : out) || { ok: false };
        });
    }
    uncreditFlight(pirepId, memberId) {
        return this.shop(async () => {
            const out = await this.db.rpc('crew_shop_uncredit', {
                p_va_slug: this.slug, p_pirep_id: pirepId, p_member_id: memberId || null,
            });
            return (Array.isArray(out) ? out[0] : out) || { ok: false };
        });
    }

    // --- Aggregates ---
    // One round trip via the schema's crew_stats() function. If the project is
    // on an older schema that predates it, fall back to counting client-side so
    // the figures still appear rather than the panel going blank.
    async stats() {
        try {
            const out = await this.db.rpc('crew_stats', { p_va_slug: this.slug });
            if (out && typeof out === 'object') return { ...out, source: 'supabase' };
        } catch (err) {
            if (err.code !== 'store_schema_missing') throw err;
        }
        return this.statsFallback();
    }

    async statsFallback() {
        const [members, pireps, routes] = await Promise.all([
            this.listMembers({ limit: 5000 }),
            this.listPireps({ limit: 5000 }),
            this.listRoutes({ limit: 5000 }),
        ]);
        return { ...computeStats({ members, pireps, routes, applications: [] }), source: 'supabase-fallback' };
    }

    /**
     * How much room this project is using, from the project itself.
     *
     * One round trip to crew_storage_usage(), which is a definer function over
     * Postgres' own size catalogues — the alternative, adding up what we think
     * we wrote, would ignore indexes, TOAST and dead tuples and report a number
     * comfortably under the one Supabase bills against, which is the opposite
     * of useful on a screen whose job is to warn.
     *
     * A project on an older schema has not got the function; that surfaces as
     * `store_schema_missing`, which the handler turns into "update your
     * database" rather than an error.
     */
    async storageUsage() {
        const out = await this.db.rpc('crew_storage_usage', { p_va_slug: this.slug });
        if (!out || typeof out !== 'object') {
            throw new CrewStoreError('The VA’s data store did not report its size.',
                { status: 502, code: 'store_error' });
        }
        return out;
    }

    // Is the project reachable and provisioned? Powers the settings screen's
    // green tick and tells the VA precisely what to fix when it is not.
    async health() {
        try {
            const rows = await this.db.select('crew_schema_info', { select: 'version,installed_at', limit: 1 });
            const version = rows && rows[0] ? Number(rows[0].version) : 0;
            return {
                ok: true,
                provisioned: version > 0,
                version,
                expectedVersion: EXPECTED_SCHEMA_VERSION,
                outdated: version > 0 && version < EXPECTED_SCHEMA_VERSION,
                // Can this project hold pilot logins? Reported separately from
                // `outdated` because it is the one capability an older schema
                // actually lacks, and the dashboard says so in those terms.
                accounts: version >= ACCOUNTS_SCHEMA_VERSION,
                // Same question for events, so the dashboard can offer the
                // update button on the events panel itself rather than sending
                // a VA off to hunt for what "outdated" means for them.
                events: version >= EVENTS_SCHEMA_VERSION,
                // And for the schedule, so the schedule panel can offer the
                // update button itself instead of sending a VA off to work out
                // what "outdated" means for them.
                schedules: version >= SCHEDULES_SCHEMA_VERSION,
                // And whether the project can answer "how much room am I
                // using?" — the storage screen offers the update button itself
                // when it cannot.
                storage: version >= STORAGE_SCHEMA_VERSION,
                // v11. The library and the inbox, each reported on its own so the
                // panel that needs one can offer the update button without
                // implying the other is broken too.
                documents: version >= DOCUMENTS_SCHEMA_VERSION,
                notifications: version >= NOTIFICATIONS_SCHEMA_VERSION,
                links: version >= LINKS_SCHEMA_VERSION,
                // v13. Whether a departure pushed to Infinite Flight can have
                // the link recorded against it. Reported so the Live panel can
                // say "sent, but this project cannot remember it yet" with the
                // update button attached, rather than pushing the same leg
                // again next time because it forgot the first one.
                ifLink: version >= IF_LINK_SCHEMA_VERSION,
                // v14. Whether the project can hold a check-ride request. Its own
                // flag, like events and links, so the training panel can name the
                // missing thing and offer the update button itself rather than
                // leaving a VA to work out what "outdated" means for them.
                training: version >= TRAINING_SCHEMA_VERSION,
                // v15. Whether a pilot can say they are away with a date on it,
                // and whether the project can hold a shelf, an order and a
                // balance. Their own flags, like every feature above, so the
                // panel that needs one can offer the update button itself.
                leave: version >= LEAVE_SCHEMA_VERSION,
                shop: version >= SHOP_SCHEMA_VERSION,
                // v17. Whether a staff member can have a pilot row of their own
                // — which is also what Discord sign-in for staff rests on — and
                // whether an account can record the pilot terms it agreed to.
                // One flag: the same ALTER adds both, so a project has neither
                // or both, and two flags would only invite a panel to imply
                // otherwise.
                staffPilot: version >= STAFF_PILOT_SCHEMA_VERSION,
                // v19. Whether a pilot who has forgotten their password can get
                // back in without a staff member doing it for them. Its own
                // flag like every feature above, so the sign-in page can say
                // "this crew centre cannot do resets yet" rather than promising
                // an email a pre-v19 project has nowhere to record.
                passwordResets: version >= PASSWORD_RESET_SCHEMA_VERSION,
                // v20. Whether a pilot can apply for a job on the team. Its own
                // flag like every feature above, so the hiring panel can offer
                // the update button itself — and, more to the point, so the
                // pilot's own screen can stay silent about openings a project
                // has nowhere to record an application against, rather than
                // taking an application it is about to lose.
                staffApps: version >= STAFF_APPS_SCHEMA_VERSION,
                // v22. Whether this project can hold a quiz result. The gate in
                // front of the crew centre is read off these rows, so a VA on an
                // older project is told the quizzes cannot run at all rather
                // than being handed a lock whose key it cannot record.
                quizzes: version >= QUIZZES_SCHEMA_VERSION,
                installedAt: (rows && rows[0] && rows[0].installed_at) || null,
            };
        } catch (err) {
            return {
                ok: false,
                provisioned: false,
                version: 0,
                expectedVersion: EXPECTED_SCHEMA_VERSION,
                accounts: false,
                events: false,
                schedules: false,
                storage: false,
                documents: false,
                notifications: false,
                links: false,
                ifLink: false,
                training: false,
                leave: false,
                shop: false,
                passwordResets: false,
                staffApps: false,
                quizzes: false,
                code: err.code || 'store_error',
                error: err.message,
                detail: err.detail || '',
            };
        }
    }

    /* =====================================================================
     * BULK DATA MANAGEMENT
     *
     * Per-row deletes already exist everywhere they belong — a bin on a notice,
     * on a flight report, on a schedule. What did not exist was a way to answer
     * "this project is filling up, get rid of the 2023 flight reports", and the
     * storage screen has been telling VAs to do exactly that with no button to
     * do it with.
     *
     * Two shapes, because they are different decisions:
     *   · a purge BY AGE — routine housekeeping, the common case
     *   · a WIPE of one dataset — deliberate, and confirmed by typing the name
     *
     * Both go through countPurgeable() first so the VA is told how many rows
     * they are about to lose BEFORE they lose them, and both are scoped by
     * va_slug like every other query here: one Supabase project can back
     * several brands, and a purge must never reach past its own.
     * =================================================================== */

    async countPurgeable(dataset, { before = null } = {}) {
        const set = PURGE_DATASETS[dataset];
        if (!set) throw new CrewStoreError('Unknown dataset.', { code: 'unknown_dataset', status: 400 });
        const rows = await this.db.select(set.table, {
            ...this.purgeFilter(set, before), select: 'id', limit: PURGE_MAX + 1,
        });
        const n = (rows || []).length;
        // A count that hit the ceiling is reported as "at least this many" so a
        // VA with 80k reports is not told they have exactly 20,000.
        return { count: Math.min(n, PURGE_MAX), capped: n > PURGE_MAX };
    }

    /**
     * Delete the rows a purge covers, and say how many went.
     *
     * Ids are read first and the delete is keyed on them rather than repeating
     * the date filter: PostgREST would happily DELETE on a filter, but then the
     * count comes from a second round trip that can disagree with what was
     * actually removed — and a row written between the two would be deleted
     * without ever having been counted or shown.
     */
    async purge(dataset, { before = null } = {}) {
        const set = PURGE_DATASETS[dataset];
        if (!set) throw new CrewStoreError('Unknown dataset.', { code: 'unknown_dataset', status: 400 });

        let deleted = 0;
        // Batched so one call cannot build a URL longer than PostgREST accepts,
        // and so a very large purge makes progress rather than timing out whole.
        for (let pass = 0; pass < PURGE_PASSES; pass++) {
            const rows = await this.db.select(set.table, {
                ...this.purgeFilter(set, before), select: 'id', limit: PURGE_BATCH,
            });
            const ids = (rows || []).map((r) => r.id).filter((id) => id != null);
            if (!ids.length) break;
            await this.db.remove(set.table, {
                ...this.scope, id: `in.(${ids.map((i) => `"${String(i).replace(/"/g, '')}"`).join(',')})`,
            });
            deleted += ids.length;
            if (ids.length < PURGE_BATCH) break;
        }
        return { deleted, dataset };
    }

    /** The scope + date window one purge covers. No date = the whole dataset. */
    purgeFilter(set, before) {
        const params = { ...this.scope };
        if (before) {
            // `or` rather than a plain lt: an event with no start date, or a
            // report never given a flown_at, would otherwise be invisible to
            // every age-based purge and sit in the project forever.
            params.or = `(${set.dateColumn}.lt.${before},${set.dateColumn}.is.null)`;
        }
        return params;
    }
}

/**
 * What can be bulk-managed, and which column decides how old a row is.
 *
 * Deliberately NOT the whole schema. The roster, the route network and pilot
 * accounts are the crew center's spine — deleting those in bulk is not
 * housekeeping, it is closing the airline, and it belongs behind its own
 * conversation rather than a dropdown next to "flight reports".
 */
const PURGE_DATASETS = {
    pireps:        { table: 'crew_pireps',        dateColumn: 'flown_at',   label: 'Flight reports' },
    events:        { table: 'crew_events',        dateColumn: 'starts_at',  label: 'Events' },
    schedules:     { table: 'crew_schedules',     dateColumn: 'departs_at', label: 'Scheduled flights' },
    applications:  { table: 'crew_applications',  dateColumn: 'created_at', label: 'Applications' },
    announcements: { table: 'crew_announcements', dateColumn: 'created_at', label: 'Noticeboard posts' },
    // v11. An inbox is the one new table that genuinely accumulates: every pilot
    // gets a row for every thing, so a VA three years in has tens of thousands of
    // "you're on Thursday's LHR–JFK" nobody will read again. Clearing those is
    // housekeeping in exactly the way this dropdown is for.
    //
    // crew_documents is deliberately NOT here. A library is not a log — the
    // superseded manual IS the thing you want when a pilot asks why they were
    // told something different last month, which is why 'archived' exists rather
    // than deleting. Bulk-clearing it belongs with the roster and the network,
    // behind its own conversation.
    notifications: { table: 'crew_notifications', dateColumn: 'created_at', label: 'Pilot messages' },
    // v20. Hiring rounds pile up the same way membership applications do, and
    // for the same reason a VA wants them gone: a declined application is a
    // private thing about a pilot who is still on the roster and still flying
    // with the people who declined them. Keeping it forever serves nobody.
    staffApplications: { table: 'crew_staff_applications', dateColumn: 'created_at', label: 'Staff applications' },
};

// How many rows one count will look at, one delete will take at a time, and how
// many batches a single purge will run. 20k rows per call is far more than any
// crew center clears in one go, and the ceiling is what stops a runaway request
// holding a VA's project open indefinitely.
const PURGE_MAX = 20000;
const PURGE_BATCH = 500;
const PURGE_PASSES = 40;

// ---------------------------------------------------------------------------
// Legacy managed storage (our Mongo)
//
// Only reachable by a VA that already has rows here. Everything it does is
// deliberately a straight translation of what the handlers used to do inline,
// so behaviour for a not-yet-migrated VA is bit-for-bit what it was.
// ---------------------------------------------------------------------------
// A legacy VA asked for something that needs a column their crew accounts do
// not have, because those accounts are rows in OUR collection. The same code
// the Supabase store raises on a pre-v19 project, so the routes have one case
// to answer rather than two.
const legacyResetsUnsupported = () => new CrewStoreError(
    'Password resets need this VA’s own data store. Connect one in Crew Center → Settings → Data store.',
    { status: 409, code: 'store_resets_missing' });

class LegacyStore {
    constructor(va) {
        this.kind = 'managed';
        this.owned = false;             // hosted by us — the thing we're moving away from
        this.vaAdId = va._id;
        this.slug = String(va.slug || '').toLowerCase();
    }

    get q() { return { vaAdId: this.vaAdId }; }
    lean(doc) { return doc ? (doc.toObject ? doc.toObject() : doc) : null; }

    // Our own collections are never behind the code, so there is nothing to
    // report. Present so a handler can ask any store without checking which
    // kind it holds.
    drift() { return []; }

    listMembers({ limit = 2000 } = {}) {
        return models.CrewMember.find(this.q).sort({ hours: -1, name: 1 }).limit(limit).lean();
    }
    listActiveLinkedMembers({ limit = 300 } = {}) {
        return models.CrewMember.find({ ...this.q, status: 'active', ifUserId: { $exists: true, $ne: '' } })
            .limit(limit).lean();
    }
    getMember(id) { return models.CrewMember.findOne({ ...this.q, _id: id }).lean(); }
    async createMember(data) {
        return this.lean(await models.CrewMember.create({ ...this.q, ...memberDefaults(data) }));
    }
    async updateMember(id, patch) {
        const m = await models.CrewMember.findOne({ ...this.q, _id: id });
        if (!m) return null;
        Object.assign(m, patch);
        await m.save();
        return this.lean(m);
    }
    async deleteMember(id) { await models.CrewMember.deleteOne({ ...this.q, _id: id }); return true; }
    /**
     * Everything this pilot is, gone — see purgeMember on the Supabase store
     * for what the verb means and why it exists.
     *
     * This store is the legacy managed one and holds only four of the tables
     * the real one does: members, flight reports, routes and applications. Two
     * of those are a pilot's. There are no bookings, no signups, no orders and
     * no logins here to remove, so the purge is smaller — not because less is
     * kept, but because less was ever here.
     */
    async purgeMember(id) {
        const removed = {};
        const gone = await models.CrewPirep.deleteMany({ ...this.q, memberId: id });
        removed.crew_pireps = gone.deletedCount || 0;
        await models.CrewMember.deleteOne({ ...this.q, _id: id });
        removed.crew_members = 1;
        return { ok: true, removed, failed: [] };
    }
    async addMemberHours(id, deltaHours) {
        const d = Number(deltaHours) || 0;
        if (d >= 0) {
            await models.CrewMember.updateOne({ ...this.q, _id: id }, { $inc: { hours: d } });
        } else {
            // Clamp at zero rather than $inc into negatives.
            const m = await models.CrewMember.findOne({ ...this.q, _id: id }).select('hours');
            if (!m) return null;
            m.hours = Math.max(0, (Number(m.hours) || 0) + d);
            await m.save();
        }
        return this.getMember(id);
    }

    // --- Crew center logins ---
    //
    // A not-yet-migrated VA's pilot logins are still rows in our central
    // VaPortalAccount collection, which is exactly what this adapter exists to
    // paper over: same interface, same document shape, so the login path and
    // the account provisioner never learn which side answered. The migration
    // copies these into the VA's project and then they stop being ours.
    accountQ() { return { vaAdId: this.vaAdId, role: 'pilot' }; }
    portalToAccount(a) {
        if (!a) return null;
        const d = this.lean(a);
        return {
            _id: d._id,
            username: d.username || '',
            displayName: d.displayName || '',
            passwordHash: d.passwordHash || '',
            role: 'pilot',
            memberId: null,          // the central table never linked to a roster row
            email: '',
            active: d.active !== false,
            mustChangePassword: !!d.mustChangePassword,
            createdVia: d.createdVia || '',
            createdByName: d.createdByName || '',
            lastLoginAt: d.lastLoginAt || null,
            createdAt: d.createdAt || null,
            updatedAt: d.updatedAt || null,
        };
    }
    async listAccounts({ limit = 2000 } = {}) {
        const rows = await models.VaPortalAccount.find(this.accountQ()).sort({ username: 1 }).limit(limit).lean();
        return rows.map((r) => this.portalToAccount(r));
    }
    async getAccount(id) {
        return this.portalToAccount(await models.VaPortalAccount.findOne({ ...this.accountQ(), _id: id }).lean());
    }
    async getAccountByUsername(username) {
        const u = str(username, 60).toLowerCase();
        if (!u) return null;
        return this.portalToAccount(await models.VaPortalAccount.findOne({ ...this.accountQ(), username: u }).lean());
    }
    async getAccountByMember() { return null; }
    // Neither of these exists on the legacy store, and both answer null rather
    // than being absent. A caller that has to check whether the method is there
    // before calling it ends up with the check in some places and not others;
    // "no such account" is the true answer here anyway, because a VA on the
    // legacy store has no project for a pilot row to live in — their crew
    // accounts ARE our central accounts, which is the arrangement v17's binding
    // exists to replace.
    async getAccountByDiscord() { return null; }
    async getAccountByPortal() { return null; }
    /* Forgotten passwords (v19) THROW here rather than answering "nobody", and
     * that is the opposite of the two methods above on purpose.
     *
     * "No such account" is a true answer for a Discord id on the legacy store.
     * "No outstanding reset" would not be: a legacy crew account is a row in
     * OUR central collection, which has no column for a one-time link, and
     * updateAccount below writes only the fields this interface owns and drops
     * the rest. So a request would be accepted, store nothing, and tell the
     * pilot a way back in is on its way — the confirmation-that-is-not-true
     * failure that LATE_COLUMNS refuses the reset columns to avoid.
     *
     * The route turns this code into the same sentence a pre-v19 project gets:
     * this crew centre cannot do resets, message your staff. Which is the
     * honest answer, and the fix is the migration these VAs are already being
     * asked to run. */
    async getAccountByResetToken() { throw legacyResetsUnsupported(); }
    async listPasswordRequests() { throw legacyResetsUnsupported(); }
    async createAccount(data) {
        const doc = await models.VaPortalAccount.create({
            username: str(data.username, 60).toLowerCase(),
            displayName: str(data.displayName, 80),
            passwordHash: data.passwordHash,
            role: 'pilot',
            vaAdId: this.vaAdId,
            vaName: data.vaName || '',
            createdVia: 'owner',
            createdByName: str(data.createdByName, 80),
            mustChangePassword: data.mustChangePassword !== false,
            active: data.active !== false,
        });
        return this.portalToAccount(doc);
    }
    async updateAccount(id, patch) {
        const a = await models.VaPortalAccount.findOne({ ...this.accountQ(), _id: id });
        if (!a) return null;
        // Only the fields this interface owns — memberId and email have no
        // column on the central account and are dropped rather than stored
        // somewhere they would be missed by the migration.
        for (const k of ['username', 'displayName', 'passwordHash', 'active', 'mustChangePassword', 'lastLoginAt']) {
            if (patch[k] !== undefined) a[k] = k === 'username' ? String(patch[k]).toLowerCase() : patch[k];
        }
        await a.save();
        return this.portalToAccount(a);
    }
    async deleteAccount(id) {
        await models.VaPortalAccount.deleteOne({ ...this.accountQ(), _id: id });
        return true;
    }

    listRoutes({ activeOnly = false, limit = 3000 } = {}) {
        const q = activeOnly ? { ...this.q, active: true } : this.q;
        return models.CrewRoute.find(q).sort({ flightNumber: 1, createdAt: -1 }).limit(limit).lean();
    }
    getRoute(id) { return models.CrewRoute.findOne({ ...this.q, _id: id }).lean(); }
    async createRoute(data) { return this.lean(await models.CrewRoute.create({ ...this.q, ...data })); }
    async updateRoute(id, patch) {
        const r = await models.CrewRoute.findOne({ ...this.q, _id: id });
        if (!r) return null;
        Object.assign(r, patch);
        await r.save();
        return this.lean(r);
    }
    async deleteRoute(id) { await models.CrewRoute.deleteOne({ ...this.q, _id: id }); return true; }

    listPireps({ status = '', limit = 500 } = {}) {
        const q = status ? { ...this.q, status } : this.q;
        return models.CrewPirep.find(q).sort({ flownAt: -1, createdAt: -1 }).limit(limit).lean();
    }
    getPirep(id) { return models.CrewPirep.findOne({ ...this.q, _id: id }).lean(); }
    async createPirep(data) { return this.lean(await models.CrewPirep.create({ ...this.q, ...data })); }
    async updatePirep(id, patch) {
        const p = await models.CrewPirep.findOne({ ...this.q, _id: id });
        if (!p) return null;
        Object.assign(p, patch);
        await p.save();
        return this.lean(p);
    }
    async deletePirep(id) { await models.CrewPirep.deleteOne({ ...this.q, _id: id }); return true; }
    // No events on this path, so nothing was ever flown for one.
    async listPirepsForEvent() { return []; }
    // The pilot's own logbook. Every status, for the reason the Supabase store
    // gives: a pending report a pilot cannot see is one they will file twice.
    async listPirepsForMember(memberId, { limit = 500 } = {}) {
        if (!memberId) return [];
        return models.CrewPirep.find({ ...this.q, memberId: String(memberId) })
            .sort({ flownAt: -1, createdAt: -1 }).limit(limit).lean();
    }
    // The same window, off the managed collection. Narrowed with select() for
    // the reason the Supabase store narrows its own: this is a count of weeks,
    // not a logbook.
    async listFlightDatesForMember(memberId, { since = null, limit = 1000 } = {}) {
        if (!memberId) return [];
        const q = { ...this.q, memberId: String(memberId), status: 'approved' };
        if (since) q.flownAt = { $gte: new Date(since) };
        return models.CrewPirep.find(q).select('status flownAt createdAt')
            .sort({ flownAt: -1, createdAt: -1 }).limit(limit).lean();
    }
    async seenFlightIds(flightIds) {
        const ids = (flightIds || []).filter(Boolean);
        if (!ids.length) return new Set();
        const rows = await models.CrewPirep.find({ ...this.q, flightId: { $in: ids } }).select('flightId').lean();
        return new Set(rows.map((r) => r.flightId));
    }

    listApplications({ status = 'pending', limit = 500 } = {}) {
        const q = status ? { ...this.q, status } : this.q;
        return models.CrewApplication.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    }
    getApplication(id) { return models.CrewApplication.findOne({ ...this.q, _id: id }).lean(); }
    getApplicationByToken(token) { return models.CrewApplication.findOne({ ...this.q, statusToken: token }).lean(); }
    getApplicationByInviteAccount(accountId) {
        return models.CrewApplication.findOne({ ...this.q, inviteAccountId: String(accountId) }).lean();
    }
    async createApplication(data) { return this.lean(await models.CrewApplication.create({ ...this.q, ...data })); }
    async updateApplication(id, patch) {
        const a = await models.CrewApplication.findOne({ ...this.q, _id: id });
        if (!a) return null;
        Object.assign(a, patch);
        await a.save();
        return this.lean(a);
    }

    // --- Events ---
    //
    // Not implemented here, and deliberately so. Managed storage is the thing
    // this platform is moving away from: every collection above exists because
    // a VA already had rows in it before their own project was a requirement,
    // and giving a retiring path a brand-new feature would mean building rows
    // we would then have to write a migration for. A VA who wants events
    // connects their own database, which takes about a minute and is what the
    // dashboard already asks them to do.
    //
    // Said in the VA's words rather than as a 500, and as a 409 (something for
    // you to do) rather than a 502 (something broken at our end).
    events() {
        return Promise.reject(new CrewStoreError(
            'Events need your VA’s own database. Connect one in Crew Center → Settings → Data store — it takes about a minute, and your roster and routes come with you.',
            { status: 409, code: 'store_events_unsupported' }));
    }
    listEvents() { return this.events(); }
    listEventsWithBanner() { return this.events(); }
    getEvent() { return this.events(); }
    createEvent() { return this.events(); }
    updateEvent() { return this.events(); }
    deleteEvent() { return this.events(); }
    listSignups() { return this.events(); }
    listSignupsForEvents() { return this.events(); }
    getSignup() { return this.events(); }
    getSignupFor() { return this.events(); }
    createSignup() { return this.events(); }
    updateSignup() { return this.events(); }
    deleteSignup() { return this.events(); }

    // The schedule, like events, was never built on the retiring path. Same
    // reasoning, same shape of refusal.
    schedules() {
        return Promise.reject(new CrewStoreError(
            'The schedule needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_schedules_unsupported' }));
    }
    listSchedules() { return this.schedules(); }
    getSchedule() { return this.schedules(); }
    listSchedulesByIds() { return this.schedules(); }
    createSchedule() { return this.schedules(); }
    updateSchedule() { return this.schedules(); }
    deleteSchedule() { return this.schedules(); }
    listBookings() { return this.schedules(); }
    listBookingsForSchedules() { return this.schedules(); }
    listBookingsForPilot() { return this.schedules(); }
    getBooking() { return this.schedules(); }
    getBookingFor() { return this.schedules(); }
    createBooking() { return this.schedules(); }
    updateBooking() { return this.schedules(); }
    deleteBooking() { return this.schedules(); }
    listPirepsForSchedule() { return this.schedules(); }

    // The noticeboard, like events, is not built on the retiring path. Same
    // reasoning, same shape of refusal.
    announcements() {
        return Promise.reject(new CrewStoreError(
            'The noticeboard needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_announcements_unsupported' }));
    }
    listAnnouncements() { return this.announcements(); }
    getAnnouncement() { return this.announcements(); }
    createAnnouncement() { return this.announcements(); }
    updateAnnouncement() { return this.announcements(); }
    deleteAnnouncement() { return this.announcements(); }
    // The one that does NOT refuse. A legacy store has no noticeboard to prune,
    // so there is nothing here to tidy and nothing to report — and a rejection
    // would make the caller handle an error over housekeeping it did not ask
    // for. Zero is the honest answer: no rows went.
    async pruneAnnouncements() { return 0; }

    // v11. The library and the inbox are the VA's operational record and are not
    // built on the retiring managed path either. Same reasoning, same refusal.
    documents() {
        return Promise.reject(new CrewStoreError(
            'The document library needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_documents_unsupported' }));
    }
    listDocuments() { return this.documents(); }
    getDocument() { return this.documents(); }
    createDocument() { return this.documents(); }
    updateDocument() { return this.documents(); }
    deleteDocument() { return this.documents(); }

    notifications() {
        return Promise.reject(new CrewStoreError(
            'Messaging your crew needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_notifications_unsupported' }));
    }
    listNotifications() { return this.notifications(); }
    getNotification() { return this.notifications(); }
    createNotifications() { return this.notifications(); }
    markNotificationsRead() { return this.notifications(); }
    deleteNotification() { return this.notifications(); }

    links() {
        return Promise.reject(new CrewStoreError(
            'The quick-links board needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_links_unsupported' }));
    }

    // v14. Check-rides were never built on the retiring managed path either.
    // Same reasoning as events and the schedule, same shape of refusal.
    training() {
        return Promise.reject(new CrewStoreError(
            'Check-rides need your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_training_unsupported' }));
    }
    listTrainingRequests() { return this.training(); }
    getTrainingRequest() { return this.training(); }
    createTrainingRequest() { return this.training(); }
    updateTrainingRequest() { return this.training(); }

    // v20. Staff applications were never built on the retiring managed path
    // either. Same reasoning as events, the schedule and check-rides, same
    // shape of refusal — and with rather less cost than the others, because a
    // VA still on managed storage can go on promoting people by hand exactly
    // as they always have.
    staffApps() {
        return Promise.reject(new CrewStoreError(
            'Staff applications need your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_staff_apps_unsupported' }));
    }
    listStaffApplications() { return this.staffApps(); }
    getStaffApplication() { return this.staffApps(); }
    createStaffApplication() { return this.staffApps(); }
    updateStaffApplication() { return this.staffApps(); }
    deleteStaffApplication() { return this.staffApps(); }

    // v22. Same answer, same reason: a legacy VA has no project of its own to
    // hold a quiz result in, and a crew centre gate read off rows that cannot
    // exist would lock every pilot out with nothing anybody could do about it.
    quizzes() {
        throw new CrewStoreError(
            'This crew centre is not on its own database yet, so it cannot run quizzes. Connect a Supabase project in Settings \u2192 Data store.',
            { status: 409, code: 'store_quizzes_missing' });
    }
    listQuizAttempts() { return this.quizzes(); }
    getQuizAttempt() { return this.quizzes(); }
    getQuizAttemptByToken() { return this.quizzes(); }
    createQuizAttempt() { return this.quizzes(); }
    updateQuizAttempt() { return this.quizzes(); }
    deleteQuizAttempt() { return this.quizzes(); }

    // v15. Leave was never built on the retiring managed path. `status = 'loa'`
    // can still be set by hand on a managed roster — that column is as old as
    // the roster — but the date a pilot is coming back has nowhere to live here,
    // and a leave with no end is the thing this feature exists to replace.
    leave() {
        return Promise.reject(new CrewStoreError(
            'Leave needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_leave_unsupported' }));
    }
    setLeave() { return this.leave(); }
    endLeave() { return this.leave(); }

    // v15. Nor the shop. This one is not close: it is two tables, a wallet on
    // every pilot and four functions that move money inside one statement, and
    // building that on a path we are retiring would mean writing a migration for
    // somebody's balance.
    shop() {
        return Promise.reject(new CrewStoreError(
            'The shop needs your VA’s own database. Connect one in Crew Center → Settings → Data store.',
            { status: 409, code: 'store_shop_unsupported' }));
    }
    listShopItems() { return this.shop(); }
    getShopItem() { return this.shop(); }
    createShopItem() { return this.shop(); }
    updateShopItem() { return this.shop(); }
    deleteShopItem() { return this.shop(); }
    listShopOrders() { return this.shop(); }
    getShopOrder() { return this.shop(); }
    fulfilShopOrder() { return this.shop(); }
    buyShopItem() { return this.shop(); }
    refundShopOrder() { return this.shop(); }
    // Not a refusal: crediting a flight is something the approve path does on
    // every VA, shop or no shop, and a managed VA approving a report must not
    // see it fail because they have no wallet to pay into. Nothing happened, and
    // that is the honest answer.
    creditFlight() { return Promise.resolve({ ok: false, code: 'no_shop' }); }
    uncreditFlight() { return Promise.resolve({ ok: false, code: 'no_shop' }); }
    listLinks() { return this.links(); }
    getLink() { return this.links(); }
    createLink() { return this.links(); }
    updateLink() { return this.links(); }
    deleteLink() { return this.links(); }
    // Not a refusal: the counter is best-effort everywhere, and a legacy VA
    // clicking a link they do not have should not see an error for a tally.
    noteLinkOpen() { return Promise.resolve(0); }

    async stats() {
        const [members, pireps, routes, applications] = await Promise.all([
            this.listMembers({ limit: 5000 }),
            this.listPireps({ limit: 20000 }),
            this.listRoutes({ limit: 5000 }),
            models.CrewApplication.find(this.q).select('status createdAt').limit(5000).lean(),
        ]);
        return { ...computeStats({ members, pireps, routes, applications }), source: 'managed' };
    }

    async health() {
        // `accounts: true` — managed pilot logins work, they just work in our
        // database instead of the VA's, which is the thing the migration fixes.
        // `events: false` — those never existed here; see the block above.
        return {
            // `passwordResets: false` — a reset needs somewhere to record a
            // one-time link, and a central account has no column for one. See
            // the two methods that say so rather than answering nothing.
            ok: true, provisioned: true, managed: true, accounts: true, events: false,
            passwordResets: false,
            version: 0, expectedVersion: EXPECTED_SCHEMA_VERSION,
        };
    }

    // Does this VA actually have anything in managed storage? forVa asks this on
    // every request from a VA with no connected project, so it is an existence
    // probe (four indexed findOnes, short-circuited) rather than a count, and
    // the answer is cached — a VA does not sprout legacy rows spontaneously, and
    // the one transition that matters (legacy -> empty, after a release) is
    // handled by clearing the entry.
    async hasData() {
        const key = String(this.vaAdId);
        const hit = LEGACY_DATA_CACHE.get(key);
        if (hit && (Date.now() - hit.at) < LEGACY_DATA_TTL_MS) return hit.value;
        let value = false;
        for (const model of [models.CrewMember, models.CrewPirep, models.CrewApplication, models.CrewRoute]) {
            if (await model.findOne(this.q).select('_id').lean()) { value = true; break; }
        }
        LEGACY_DATA_CACHE.set(key, { at: Date.now(), value });
        return value;
    }

    /* ---------------------------------------------------------------------
     * Bulk data management
     *
     * Managed storage only ever held four things, so this covers the two a VA
     * would want to clear out. Events, schedules and the noticeboard never
     * existed here — asking to purge them is not an error, there is simply
     * nothing to purge, and saying "unsupported" would send a VA looking for a
     * problem that does not exist.
     * ------------------------------------------------------------------- */

    async countPurgeable(dataset, { before = null } = {}) {
        const model = LEGACY_PURGE_MODELS[dataset];
        if (!model) return { count: 0, capped: false, unsupported: true };
        const n = await models[model.name].countDocuments(this.purgeQuery(model, before));
        return { count: n, capped: false };
    }

    async purge(dataset, { before = null } = {}) {
        const model = LEGACY_PURGE_MODELS[dataset];
        if (!model) return { deleted: 0, dataset, unsupported: true };
        const res = await models[model.name].deleteMany(this.purgeQuery(model, before));
        return { deleted: res.deletedCount || 0, dataset };
    }

    /** Same "or the date is missing" rule the Supabase store applies. */
    purgeQuery(model, before) {
        if (!before) return { ...this.q };
        const d = new Date(before);
        return {
            ...this.q,
            $or: [{ [model.dateField]: { $lt: d } }, { [model.dateField]: null }, { [model.dateField]: { $exists: false } }],
        };
    }
}

// The managed-storage half of PURGE_DATASETS. Only what Mongo ever held.
const LEGACY_PURGE_MODELS = {
    pireps:       { name: 'CrewPirep',       dateField: 'flownAt' },
    applications: { name: 'CrewApplication', dateField: 'createdAt' },
};

// vaAdId -> { at, value }. See LegacyStore.hasData.
const LEGACY_DATA_CACHE = new Map();
const LEGACY_DATA_TTL_MS = 5 * 60 * 1000;
const forgetLegacyData = (vaAdId) => LEGACY_DATA_CACHE.delete(String(vaAdId));

// Mongoose applies schema defaults on create; the Supabase path relies on
// column defaults. This keeps a hand-built member object complete either way.
const memberDefaults = (d) => ({
    name: '', callsign: '', hours: 0, role: '', aircraft: [], status: 'active',
    ifUserId: '', ifcName: '', ...d,
});

// ---------------------------------------------------------------------------
// Shared aggregate maths.
//
// The Supabase path normally computes this in Postgres (crew_stats). This JS
// version backs the legacy store and the older-schema fallback, and the two are
// kept deliberately identical in shape so no caller has to care which ran.
// ---------------------------------------------------------------------------
function computeStats({ members = [], pireps = [], routes = [], applications = [] }) {
    const now = Date.now();
    const within30d = (d) => d && (now - new Date(d).getTime()) < 30 * 86400000;
    const approved = pireps.filter((p) => p.status === 'approved');
    const recent = approved.filter((p) => within30d(p.flownAt || p.createdAt));
    const flownMin = approved.reduce((s, p) => s + (Number(p.durationMin) || 0), 0);
    const recentMin = recent.reduce((s, p) => s + (Number(p.durationMin) || 0), 0);
    const round1 = (n) => Math.round(n * 10) / 10;
    const lastFlight = approved.reduce((best, p) => {
        const t = p.flownAt || p.createdAt;
        return t && (!best || new Date(t) > new Date(best)) ? t : best;
    }, null);

    return {
        pilots: members.length,
        pilotsActive: members.filter((m) => m.status === 'active').length,
        pilotsLoa: members.filter((m) => m.status === 'loa').length,
        pilotsLinked: members.filter((m) => m.ifUserId).length,
        pilotsJoined30d: members.filter((m) => within30d(m.createdAt)).length,
        hours: round1(members.reduce((s, m) => s + (Number(m.hours) || 0), 0)),
        pireps: pireps.length,
        pirepsApproved: approved.length,
        pirepsPending: pireps.filter((p) => p.status === 'pending').length,
        pirepsRejected: pireps.filter((p) => p.status === 'rejected').length,
        flightHours: round1(flownMin / 60),
        flightHours30d: round1(recentMin / 60),
        flights30d: recent.length,
        landings: approved.reduce((s, p) => s + (Number(p.landings) || 0), 0),
        distanceNm: Math.round(approved.reduce((s, p) => s + (Number(p.distanceNm) || 0), 0)),
        lastFlightAt: lastFlight || null,
        routes: routes.length,
        routesActive: routes.filter((r) => r.active !== false).length,
        destinations: new Set(routes.filter((r) => r.active !== false && r.destination).map((r) => r.destination)).size,
        applicationsPending: applications.filter((a) => a.status === 'pending').length,
        applicationsAccepted: applications.filter((a) => a.status === 'accepted').length,
        applications30d: applications.filter((a) => a.status === 'pending' && within30d(a.createdAt)).length,
        topPilots: members
            .filter((m) => m.status === 'active' && (Number(m.hours) || 0) > 0)
            .sort((a, b) => (b.hours - a.hours) || String(a.name).localeCompare(String(b.name)))
            .slice(0, 10)
            .map((m) => ({ name: m.name, callsign: m.callsign, hours: round1(Number(m.hours) || 0) })),
        generatedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Picking a store for a VA
//
// `va` must have been loaded with the secret service key selected — see
// crewStore.SELECT, which every caller uses so nobody forgets a field.
// ---------------------------------------------------------------------------
// `ranks` rides along because rank is now resolved server-side on nearly every
// crew route — the roster, the route network's gating, a promotion notice — and
// fetching the same small array again in each handler would be a second query
// per request for a field that is a few hundred bytes.
// `callsigns`, `callsignPrefix` and `callsignReservedMax` ride along because a
// pilot callsign is built from the VA's registered mask (see crewCallsign.js),
// and every handler that issues or validates one already resolves the VA
// through here. None of the three is a secret.
const SELECT = '_id slug callsign callsigns callsignMatch callsignPrefix callsignReservedMax name contactEmail crewAccent ranks crewShop crewClubs crewStreaks crewFeatured crewRetention supabaseUrl supabaseAnonKey +supabaseServiceKey';

function isConnected(va) {
    return !!(va && va.supabaseUrl && va.supabaseServiceKey);
}

async function forVa(va) {
    if (!va) throw new CrewStoreError('Crew center not found.', { status: 404, code: 'va_not_found' });
    if (isConnected(va)) return new SupabaseStore(va);

    const legacy = new LegacyStore(va);
    if (!REQUIRE_OWN_STORE) return legacy;
    // A VA with rows in managed storage keeps working until they migrate;
    // anyone else has to bring their own project first.
    if (await legacy.hasData()) return legacy;
    throw NOT_CONNECTED();
}

// Read-only variant for public surfaces (the stats endpoint, the roster on a
// VA's own website). Returns null instead of throwing when the VA has no store
// at all, so a public page renders "no data yet" rather than an error.
async function forVaOrNull(va) {
    try { return await forVa(va); } catch { return null; }
}

module.exports = {
    configure,
    forVa,
    forVaOrNull,
    forgetLegacyData,
    forgetSchemaDrift,
    isConnected,
    computeStats,
    CrewStoreError,
    SupabaseStore,
    LegacyStore,
    PURGE_DATASETS,
    SELECT,
    EXPECTED_SCHEMA_VERSION,
    DISCORD_SCHEMA_VERSION,
    STAFF_PILOT_SCHEMA_VERSION,
    PASSWORD_RESET_SCHEMA_VERSION,
    ACCOUNTS_SCHEMA_VERSION,
    EVENTS_SCHEMA_VERSION,
    SCHEDULES_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION,
    DOCUMENTS_SCHEMA_VERSION,
    NOTIFICATIONS_SCHEMA_VERSION,
    LINKS_SCHEMA_VERSION,
    IF_LINK_SCHEMA_VERSION,
    TRAINING_SCHEMA_VERSION,
    LEAVE_SCHEMA_VERSION,
    SHOP_SCHEMA_VERSION,
    STAFF_APPS_SCHEMA_VERSION,
    REQUIRE_OWN_STORE,
};
