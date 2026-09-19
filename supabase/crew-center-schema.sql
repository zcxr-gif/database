-- ============================================================================
-- Inflight Crew Center — the schema a VA runs in their OWN Supabase project.
--
-- READ THIS FIRST
-- ---------------
-- A VA's operational data is the VA's property and lives in the VA's own
-- Postgres. Inflight does NOT keep a copy. What we keep centrally is only:
--
--     * the VA's *staff* logins (owner + team — usernames and bcrypt hashes),
--     * the VA's directory/branding metadata (name, slug, colours, fleet
--       definitions, rank ladder, join requirements),
--     * the connection details for the project defined below.
--
-- Everything with operational weight — who flies for the VA, how many hours
-- they have logged, every flight report, every membership application, the
-- applicant's email address, every EVENT and who signed up for it, every
-- SCHEDULED DEPARTURE and who booked it, every OPERATIONS DOCUMENT the VA
-- publishes to its crew, every QUICK LINK it points them at, every MESSAGE sent
-- to a pilot, and every
-- PILOT ACCOUNT (see crew_accounts) — is
-- created here, in this file's tables, inside the VA's project. If the VA
-- leaves the platform they keep the lot and we have nothing to hand back,
-- because we never held it.
--
-- HOW TO INSTALL
-- --------------
-- The crew dashboard installs this for you: Settings → Data store → Set up
-- automatically, paste a Supabase access token, pick a project. It runs this
-- exact file against the project and copies the keys back itself.
--
-- By hand, if you would rather:
-- 1. Supabase dashboard → SQL Editor → New query.
-- 2. Paste this whole file and Run. It is idempotent: running it again on an
--    already-provisioned project upgrades it in place and changes no data.
-- 3. Settings → API: copy the Project URL, the `anon` key and the
--    `service_role` key into Crew Center → Settings → Data store.
--
-- HOW TO UPDATE, LATER
-- --------------------
-- This file gains columns as the crew center gains features, and a project set
-- up a year ago has not got them. Crew dashboard → Settings → Data store →
-- Update my database runs the current version against the project you are
-- already connected to: your keys do not change, your data is not touched, and
-- it is safe to run as often as you like. Re-running the SQL by hand does the
-- same thing.
--
-- If you let the crew center keep your Supabase access token when you set up
-- (one tick, and you can withdraw it whenever you like), that update needs no
-- token pasted — and with "keep my database up to date" left on, it happens on
-- its own the first time the crew center notices this file has moved ahead of
-- your project. Nothing about what runs changes: it is this script, unmodified,
-- against the project you are already connected to.
--
-- Until then the crew center keeps working and simply cannot store what your
-- project has no column for — it says so at the time rather than failing the
-- write.
--
-- WHICH KEY DOES WHAT
-- -------------------
--   anon key          Public, safe in a browser. RLS (below) limits it to the
--                     things a crew center shows the world: the roster, the
--                     active route network and approved flight reports.
--   service_role key  Full access, bypasses RLS. Held only by the Inflight
--                     backend so it can write on the VA's behalf (accept an
--                     application, credit hours, capture a PIREP). Never send
--                     it to a browser.
--
-- MULTI-BRAND PROJECTS
-- --------------------
-- Every table carries `va_slug`. One project can therefore back several crew
-- centers (a parent brand plus a regional subsidiary, say) without their data
-- mixing — every query the backend issues is filtered by slug, and the unique
-- indexes are scoped by slug too.
-- ============================================================================

-- gen_random_uuid()
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Provisioning marker. The backend reads this to tell "connected but empty"
-- apart from "connected and ready", and to know whether the project is running
-- an older shape than the code expects.
-- ----------------------------------------------------------------------------
create table if not exists crew_schema_info (
    id          int primary key default 1 check (id = 1),
    version     int not null,
    installed_at timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Roster. One row per pilot flying for the VA.
--
-- `hours` is the credited total and is the number the rank ladder is read
-- against — rank itself is deliberately NOT stored, it is derived from hours
-- against the ladder the VA configures in the crew center, so editing the
-- ladder re-ranks everyone at once instead of leaving stale titles behind.
-- ----------------------------------------------------------------------------
create table if not exists crew_members (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    name        text not null default '',
    callsign    text not null default '',
    hours       numeric(12,4) not null default 0 check (hours >= 0),
    role        text not null default '',
    aircraft    text[] not null default '{}',
    status      text not null default 'active' check (status in ('active','loa','inactive')),
    -- Infinite Flight identity, carried over from the accepted application.
    -- A member with an if_user_id is eligible for automatic PIREP capture.
    if_user_id  text not null default '',
    ifc_name    text not null default '',
    -- ------------------------------------------------------------------------
    -- v7. Check-rides.
    --
    -- The names of the rungs this pilot has been signed off for. A VA can mark
    -- any rung of their ladder "requires a check-ride" (crew center settings →
    -- ranks), and a pilot who has the hours for such a rung does NOT hold it
    -- until their name appears here — they sit at the rung below, marked as
    -- ready, and staff sign them off.
    --
    -- Names, not indexes, for the reason min_rank is a name: a VA reordering
    -- their ladder must not silently un-promote their whole roster. A rung that
    -- is renamed lets the requirement lapse, so the failure mode is "the pilot
    -- gets promoted" rather than "the pilot is stuck and nobody knows why".
    -- ------------------------------------------------------------------------
    checks_passed text[] not null default '{}',
    -- ------------------------------------------------------------------------
    -- v10. The roster sweep.
    --
    -- When this pilot was last warned that they were running out of time —
    -- either to fly their first flight inside the VA's probation window, or to
    -- fly at all inside its inactivity window. Null means never warned.
    --
    -- It is never cleared. The sweep compares it against the anchor for the
    -- state the pilot is in (their join date on probation, their last flight
    -- otherwise), so a warning recorded before that anchor belongs to a cycle
    -- that has already ended — which is what "they flew, then went quiet again"
    -- looks like. Flying moves the anchor past the old warning and the next
    -- silence warns afresh, with nothing to reset.
    -- ------------------------------------------------------------------------
    retention_warned_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v1–v6 picks it up on re-run.
alter table crew_members add column if not exists checks_passed text[] not null default '{}';
-- v10. Same, for the roster sweep's warning stamp.
alter table crew_members add column if not exists retention_warned_at timestamptz;
-- v15. Leave of absence, told properly.
--
-- `status = 'loa'` has existed since v1 and the roster sweep has always spared
-- it, but it was a flag with nothing attached: staff set it by hand, nobody
-- knew when the pilot was due back, and a pilot could not say it themselves.
-- These three columns are the sentence around the flag — who said it, when they
-- expect to be flying again, and why — which is what turns "away" from a label
-- staff maintain into something the person actually away can set.
--
-- `loa_until` is the one the sweep reads: past it, the pilot is ordinary again
-- and the clock they paused starts running. Null means open-ended, which is
-- what a hand-set 'loa' from before this version looks like, so those keep
-- behaving exactly as they did.
alter table crew_members add column if not exists loa_until  timestamptz;
alter table crew_members add column if not exists loa_reason text not null default '';
alter table crew_members add column if not exists loa_since  timestamptz;

-- v15. The wallet.
--
-- On the pilot rather than in a table of its own: a balance is a property of a
-- member the way hours are, every read of it already has the roster row in
-- hand, and a separate wallet table would mean a join on the one query the shop
-- runs on every page. `points_earned` and `points_spent` are kept alongside the
-- balance rather than derived, because the two figures the card shows are
-- lifetime totals and a balance is not a history: refunding an order returns
-- the money without unspending it.
--
-- Integers, not numeric. This is a game currency counted in whole units; a
-- fractional mile would only ever be a rounding argument.
alter table crew_members add column if not exists points_balance int not null default 0;
alter table crew_members add column if not exists points_earned  int not null default 0;
alter table crew_members add column if not exists points_spent   int not null default 0;
create index if not exists crew_members_va_idx      on crew_members (va_slug);
create index if not exists crew_members_hours_idx   on crew_members (va_slug, hours desc);
create index if not exists crew_members_if_idx      on crew_members (va_slug, if_user_id) where if_user_id <> '';

-- ----------------------------------------------------------------------------
-- Crew center logins. v3.
--
-- A pilot's ACCOUNT — the thing they sign in with — is the VA's data like
-- everything else here, so it lives in the VA's project rather than in ours.
-- Accepting an application writes the row below; signing in at the crew center
-- reads it. Inflight holds no copy, which means a VA that leaves takes their
-- pilots' logins with them and we cannot sign in as anyone's pilot.
--
-- SECURITY: this table holds bcrypt password hashes. Like crew_applications it
-- has NO anon policy and NO grant — it is unreachable with a browser key, and
-- the RLS block at the bottom of this file is what enforces that. Passwords
-- themselves are never stored anywhere, in any form: a generated password is
-- shown to the pilot once and only its hash lands here.
--
-- `role` is constrained to the three crew center roles rather than to 'pilot'
-- alone, so a VA that later brings its staff logins over needs no migration —
-- only pilot rows are written today.
-- ----------------------------------------------------------------------------
create table if not exists crew_accounts (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    -- Lower-cased on write; the unique index below is what makes a username
    -- one-per-crew-center rather than one-per-project.
    username      text not null,
    display_name  text not null default '',
    password_hash text not null,
    role          text not null default 'pilot' check (role in ('pilot','staff','owner')),
    -- The roster row this login belongs to. `on delete set null`: removing a
    -- pilot from the roster leaves their account behind for staff to deal with
    -- deliberately, rather than deleting a credential as a side effect.
    member_id     uuid references crew_members (id) on delete set null,
    email         text not null default '',
    active        boolean not null default true,
    -- Set when we generated the password. The crew center nags until it is
    -- cleared by a password change.
    must_change_password boolean not null default false,
    created_via   text not null default 'crew-center',
    created_by_name text not null default '',
    last_login_at timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists crew_accounts_username_idx
    on crew_accounts (va_slug, lower(username));
create index if not exists crew_accounts_member_idx on crew_accounts (va_slug, member_id);

-- v16. Signing in with Discord.
--
-- A SECOND KEY TO AN EXISTING DOOR, and nothing more. A pilot signs in with the
-- password they were given, links Discord from their own account page, and from
-- then on the button signs them in. Nothing in the crew center creates or claims
-- an account from a Discord identity: the callback finds a row that is already
-- linked, or it signs nobody in. A VA's roster is the VA's, and a login button
-- does not get to add to it.
--
-- Added separately, like every column since v2, so a project provisioned at
-- v3-v15 picks them up on a re-run rather than needing the table dropped. They
-- are LATE_COLUMNS in crewStore.js as well, which is what lets a VA who has not
-- re-run the SQL carry on signing in with a password while the Discord button
-- says it needs the database updating.
alter table crew_accounts add column if not exists discord_id        text not null default '';
alter table crew_accounts add column if not exists discord_username  text not null default '';
alter table crew_accounts add column if not exists discord_avatar    text not null default '';
alter table crew_accounts add column if not exists discord_linked_at timestamptz;

-- ONE Discord account, ONE login, per crew center.
--
-- Partial, on the non-empty values only: every account that has not linked
-- holds '' in this column, and a plain unique index would make the second
-- unlinked account in a VA a constraint violation.
--
-- Scoped per va_slug rather than globally, because one person genuinely may fly
-- for two airlines, and their Discord account is the same account in both. What
-- must not happen is the same Discord identity opening two different pilots'
-- logins inside ONE airline.
create unique index if not exists crew_accounts_discord_idx
    on crew_accounts (va_slug, discord_id) where discord_id <> '';

-- v17. A staff member's own pilot side.
--
-- THE PROBLEM. A VA's owner and staff sign in with a CENTRAL account — ours,
-- not a row in their project — because that is the account that administers the
-- partnership. It works for managing, and it runs out the moment the same
-- person wants to fly: there is no crew_accounts row, so there is nothing to
-- hang a Discord link on, nothing to address an inbox message to, and nothing
-- that is theirs in the way every pilot's login is theirs.
--
-- What they had instead was claiming a roster row (VaPortalAccount.crewMemberId)
-- — enough to be booked onto a departure, and no more. The alternative staff
-- actually reached for was being handed a SECOND, ordinary pilot login by
-- somebody with roster.manage: two usernames, two passwords, and a pilot
-- account that is only theirs by convention.
--
-- SO: one row, bound to the central account that owns it. The staff member
-- provisions it themselves, it is a normal crew_accounts row in every other
-- respect, and it is what makes signing in with Discord available to the people
-- who run the airline as well as to the people who fly for it.
--
-- IT CARRIES NO AUTHORITY. The role stays 'pilot' and the capabilities a staff
-- session gets are still resolved from the central account it is bound to (see
-- effectiveCaps in crewAuth.js) — never from this row. A row in a project the
-- VA's own people can write to must not be able to promote anybody, which is
-- exactly what a row with role 'owner' in here would do.
alter table crew_accounts add column if not exists portal_account_id text not null default '';

-- ONE central account, ONE bound row, per crew center. Partial for the same
-- reason the Discord index is: every ordinary pilot's row holds '' here.
create unique index if not exists crew_accounts_portal_idx
    on crew_accounts (va_slug, portal_account_id) where portal_account_id <> '';

-- v17. Which version of the Crew Center pilot terms this account has agreed to.
--
-- The version STRING rather than a boolean, because the question is not "have
-- they ever agreed" but "have they agreed to what is in front of them now" —
-- and a privacy notice that changes without anybody being asked again is a
-- notice nobody has agreed to. Empty means never asked or never answered; the
-- crew center asks again whenever this differs from the current version.
--
-- Deliberately NOT a gate on the door. A pilot who has not agreed can still
-- sign in and read their own hours; what they get is the notice, once, until
-- they answer it. Locking a roster out of its own crew center over a consent
-- prompt would punish the pilot for a change their VA and we made.
alter table crew_accounts add column if not exists terms_version     text not null default '';
alter table crew_accounts add column if not exists terms_accepted_at timestamptz;

-- v19. Getting back in without asking a human.
--
-- A pilot who forgot their password had exactly one route back: message the
-- airline, and wait for whoever next opened the dashboard to find them, issue a
-- temporary password and send it. It is the commonest piece of admin a VA does
-- and the slowest thing that happens to one of its pilots.
--
-- These five columns are the whole of what the database has to remember for
-- that to stop being a person's job:
--
--   reset_token_hash        SHA-256 of the one-time link, never the link. A
--                           reset link is a bearer credential for this account,
--                           and a readable copy of one in a row is a password
--                           by another name. It is emailed once and cannot be
--                           recovered from here afterwards — the same trade
--                           password_hash makes, and deliberately NOT the one
--                           crew_applications.invite_password makes, because
--                           that one exists to be read out by a staff member.
--   reset_token_expires_at  when the link stops working. A link with no end
--                           date is a second password.
--   reset_requested_at      when they asked. What the Logins tab counts
--                           "waiting 4 minutes" from.
--   reset_needs_staff       true only for the requests that could not be
--                           emailed. This is what makes the staff queue a
--                           queue: a pilot whose link went out is not in it.
--   reset_reason            why it reached a human — 'no_email' or
--                           'email_failed'. Stored because "this one is yours
--                           to pass on" is only actionable with the reason.
--
-- There is at most ONE outstanding request per account: a new request replaces
-- whatever was here, so the newest link is the only live one. That is why there
-- is no crew_password_resets table — a row per account is the shape of the
-- thing, and a table would also need its own RLS, its own purge entry and its
-- own answer to "what happens when the account is deleted". Here, a deleted
-- account takes its reset with it.
--
-- NOT droppable in crewStore.js's LATE_COLUMNS, for the reason discord_id is
-- not: on a request, the column IS the write. Drop it and the update succeeds,
-- stores nothing, and the pilot is told a way back in is on its way. It never
-- arrives, and nothing anywhere says why.
alter table crew_accounts add column if not exists reset_token_hash       text not null default '';
alter table crew_accounts add column if not exists reset_token_expires_at timestamptz;
alter table crew_accounts add column if not exists reset_requested_at     timestamptz;
alter table crew_accounts add column if not exists reset_needs_staff      boolean not null default false;
alter table crew_accounts add column if not exists reset_reason           text not null default '';

-- The link lookup runs on an UNAUTHENTICATED route, once per press of a reset
-- link, so it is the one read here that must not become a scan. Partial on the
-- non-empty hashes: every account that has not asked holds '' in this column,
-- and indexing those is indexing the whole roster.
create index if not exists crew_accounts_reset_token_idx
    on crew_accounts (va_slug, reset_token_hash) where reset_token_hash <> '';

-- The staff queue. Partial for the same reason, and on the same table the
-- roster drawer is already reading.
create index if not exists crew_accounts_reset_staff_idx
    on crew_accounts (va_slug, reset_requested_at) where reset_needs_staff;

-- ----------------------------------------------------------------------------
-- Membership applications submitted through the crew center's join form.
--
-- PRIVACY: this table holds applicant email addresses and the opaque
-- `status_token` that lets someone read their own application. RLS below gives
-- the anon key NO access to it whatsoever — it is service-key only.
-- ----------------------------------------------------------------------------
create table if not exists crew_applications (
    id              uuid primary key default gen_random_uuid(),
    va_slug         text not null,
    ifc_name        text not null default '',
    email           text not null default '',
    callsign_prefix text not null default '',
    callsign_number text not null default '',
    grade           int  not null default 0,
    -- Did our Infinite Flight lookup confirm the account exists? When true,
    -- `grade` came from IF rather than from the applicant.
    if_verified     boolean not null default false,
    if_user_id      text not null default '',
    -- The applicant's answers to the VA's custom form: [{ q, a }, …]
    answers         jsonb not null default '[]'::jsonb,
    status          text not null default 'pending' check (status in ('pending','accepted','declined')),
    staff_message   text not null default '',
    status_token    text not null default '',
    -- The Discord invite this pilot was sent when they were accepted. Kept so
    -- their status page can show it again: an emailed invite is easy to lose,
    -- and an applicant who gave no email has the status link as their only copy.
    discord_invite  text not null default '',
    -- ------------------------------------------------------------------------
    -- The invitation. v4.
    --
    -- An accepted applicant is handed a temporary password. It is kept HERE, in
    -- readable form, which is a deliberate reversal of the rule the rest of this
    -- file follows for credentials — crew_accounts stores only a bcrypt hash and
    -- nothing anywhere stores a password. The reason is that a temporary
    -- password nobody can read again is a temporary password that only works if
    -- the applicant catches it on first sight: an applicant who gave no email
    -- had one screenful, and staff passing it on by hand (IFC DM, Discord) had
    -- one screenful too. Reissuing on every miss trains everyone to reissue.
    --
    -- So the trade is stated plainly rather than hidden: this column holds a
    -- live credential until it is used. What keeps that bounded is that it
    -- deletes itself — cleared the moment the pilot signs in (invite_claimed_at),
    -- when staff throw the invitation away (invite_revoked_at), or when it ages
    -- out. It is never a permanent store of anyone's password, because the
    -- account's real password is the bcrypt hash in crew_accounts and this one
    -- must be changed on first use (must_change_password).
    --
    -- It is not encrypted, on purpose. Encrypting a VA's own data with a key
    -- Inflight holds would mean the VA no longer owns the contents of their own
    -- database, which is the one thing this whole schema exists to guarantee.
    -- The protection is the same one that covers applicant emails and password
    -- hashes in this table: no anon policy AND no grant, so a browser key is
    -- refused at the door (see the RLS block at the foot of this file).
    -- ------------------------------------------------------------------------
    invite_username   text not null default '',
    invite_password   text not null default '',
    invite_issued_at  timestamptz,
    invite_claimed_at timestamptz,
    invite_revoked_at timestamptz,
    invite_account_id uuid,
    reviewed_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
-- v2. Added separately so a project provisioned at v1 picks it up on re-run
-- rather than needing the table dropped.
alter table crew_applications add column if not exists discord_invite text not null default '';
-- v4. Same reasoning: a project provisioned at v1–v3 picks these up on re-run.
alter table crew_applications add column if not exists invite_username   text not null default '';
alter table crew_applications add column if not exists invite_password   text not null default '';
alter table crew_applications add column if not exists invite_issued_at  timestamptz;
alter table crew_applications add column if not exists invite_claimed_at timestamptz;
alter table crew_applications add column if not exists invite_revoked_at timestamptz;
alter table crew_applications add column if not exists invite_account_id uuid;
-- Finding the invitation belonging to an account that has just signed in, so it
-- can be cleared. This runs on every pilot sign-in, so it is not optional.
create index if not exists crew_applications_invite_idx
    on crew_applications (va_slug, invite_account_id) where invite_account_id is not null;
create index if not exists crew_applications_va_idx     on crew_applications (va_slug, status, created_at desc);
-- The status link must resolve to exactly one application.
create unique index if not exists crew_applications_token_idx
    on crew_applications (va_slug, status_token) where status_token <> '';

-- ----------------------------------------------------------------------------
-- The VA's route network — the legs pilots can pick up. A filed PIREP is
-- checked against this table to decide whether the leg flown was a real route.
-- ----------------------------------------------------------------------------
create table if not exists crew_routes (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    flight_number text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    distance_nm   numeric(10,2) not null default 0 check (distance_nm >= 0),
    notes         text not null default '',
    active        boolean not null default true,
    -- ------------------------------------------------------------------------
    -- v5.
    --
    -- `kind` splits the network in two. A VA's own routes are what the airline
    -- flies; a codeshare is a leg it sells under a partner's metal. They are
    -- listed apart and drawn apart on the map, because a network map that mixes
    -- them overstates what the airline actually operates — which is the one
    -- thing that map is for.
    --
    -- `min_rank` names a rung on the VA's ladder (crew center settings → ranks)
    -- rather than storing an hours figure. The VA sets what a rank is worth in
    -- one place; move the threshold and every route gated on it moves with it.
    -- Empty means open to everyone, which is the default and the common case.
    --
    -- Deliberately a NAME and not an index: a VA reordering their ladder would
    -- otherwise silently re-gate their whole network. A name that no longer
    -- exists lets the gate lapse (see crewRanks.meetsRank) — a VA who renames a
    -- rank gets an open route, never a network that quietly shrinks.
    -- ------------------------------------------------------------------------
    kind          text not null default 'own' check (kind in ('own','codeshare')),
    partner_name  text not null default '',
    partner_logo  text not null default '',
    min_rank      text not null default '',
    -- ------------------------------------------------------------------------
    -- v21. The stands the leg is flown between.
    --
    -- A route already says which airports; this says where on them. Free text
    -- and not a reference to anything, because a gate is a fact about a real
    -- terminal ("A12", "T2 B34", "Pier C 51") and no two airports name theirs
    -- the same way. There is no table of gates to join to, and inventing one
    -- would mean a VA could not publish a stand we had not heard of.
    --
    -- Both optional and both default to empty, which is what nearly every
    -- existing route will stay: the VA that cares about gate-to-gate sets them
    -- and the rest never see the fields. Nothing is enforced against them — a
    -- pilot parking on the wrong stand is not a rule the crew center polices,
    -- it is the detail that makes the leg feel flown rather than logged.
    -- ------------------------------------------------------------------------
    departure_gate text not null default '',
    arrival_gate   text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists crew_routes_va_idx  on crew_routes (va_slug, flight_number);
create index if not exists crew_routes_od_idx  on crew_routes (va_slug, origin, destination) where active;
-- v5. Added separately so a project provisioned at v1–v4 picks them up on a
-- re-run rather than needing the table rebuilt. The check constraint goes on
-- afterwards for the same reason, and is skipped if it is already there.
alter table crew_routes add column if not exists kind         text not null default 'own';
alter table crew_routes add column if not exists partner_name text not null default '';
alter table crew_routes add column if not exists partner_logo text not null default '';
alter table crew_routes add column if not exists min_rank     text not null default '';
do $$
begin
    alter table crew_routes add constraint crew_routes_kind_chk check (kind in ('own','codeshare'));
exception
    when duplicate_object then null;
end $$;
-- The network map and the route panel both split on this.
create index if not exists crew_routes_kind_idx on crew_routes (va_slug, kind) where active;
-- v21. Added separately for the same reason the v5 columns are: a project
-- provisioned at v1–v20 picks the stands up on a re-run rather than needing the
-- table rebuilt. No index — nothing looks a route up by its gate, and nothing
-- should: it is something a route CARRIES, not something the network is
-- searched by.
alter table crew_routes add column if not exists departure_gate text not null default '';
alter table crew_routes add column if not exists arrival_gate   text not null default '';

-- ----------------------------------------------------------------------------
-- Flight reports. Either captured automatically from a linked pilot's real
-- Infinite Flight history (`source = 'auto'`) or filed by hand (`'manual'`).
--
-- `hours_applied` is the double-credit guard: hours move onto the pilot's total
-- exactly once, and approving an already-approved report is a no-op.
-- ----------------------------------------------------------------------------
create table if not exists crew_pireps (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    member_id     uuid references crew_members (id) on delete set null,
    route_id      uuid references crew_routes  (id) on delete set null,
    -- v7. The event this flight was flown for, when it was flown for one.
    -- Set when a pilot files from an event's brief, which is what lets the
    -- event show what has actually been flown rather than only who said they
    -- would turn up.
    --
    -- The foreign key is added further down, once crew_events exists — this
    -- table is created before it, and a reference to a table that is not there
    -- yet fails a FRESH install while looking fine on an upgrade. The column is
    -- declared bare here and constrained there.
    event_id      uuid,
    -- v8. The scheduled departure this report was filed against, when it was
    -- flown off the schedule rather than freely. Declared bare here and
    -- constrained below crew_schedules, for the same file-ordering reason as
    -- event_id above.
    schedule_id   uuid,
    -- Denormalised so a report still reads correctly after the pilot or route
    -- it points at has been deleted.
    pilot_name    text not null default '',
    callsign      text not null default '',
    flight_number text not null default '',
    if_user_id    text not null default '',
    -- The Infinite Flight flight id. This is the dedupe key that stops a repeat
    -- sync from capturing the same flight twice (see the unique index below).
    flight_id     text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft_name text not null default '',
    livery_name   text not null default '',
    duration_min  int not null default 0 check (duration_min >= 0),
    landings      int not null default 0 check (landings >= 0),
    xp            int not null default 0,
    violations    int not null default 0 check (violations >= 0),
    distance_nm   numeric(10,2) not null default 0 check (distance_nm >= 0),
    server        text not null default '',
    in_fleet      boolean not null default false,
    source        text not null default 'auto'    check (source in ('auto','manual')),
    status        text not null default 'pending' check (status in ('pending','approved','rejected')),
    hours_applied boolean not null default false,
    flown_at      timestamptz,
    reviewed_at   timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v1–v6 picks it up on re-run.
-- The constraint that ties it to crew_events waits until that table exists —
-- see the block below crew_event_signups.
alter table crew_pireps add column if not exists event_id uuid;
create index if not exists crew_pireps_va_idx     on crew_pireps (va_slug, status, flown_at desc);
create index if not exists crew_pireps_member_idx on crew_pireps (va_slug, member_id);
-- What has been flown for an event. Partial: almost no flight belongs to one.
create index if not exists crew_pireps_event_idx  on crew_pireps (va_slug, event_id) where event_id is not null;
-- One row per real Infinite Flight flight. Enforced in the database rather than
-- in application code so two concurrent syncs cannot both insert the same leg.
create unique index if not exists crew_pireps_flight_idx
    on crew_pireps (va_slug, flight_id) where flight_id <> '';

-- ----------------------------------------------------------------------------
-- Events. v6.
--
-- The thing a VA actually gathers around: a group departure, a fly-in, a
-- long-haul night. An event is published from the crew center, pilots sign
-- themselves up (crew_event_signups below), and the airline's own website reads
-- the same rows — so the calendar a visitor sees is the calendar staff filled
-- in, not a copy of it maintained by hand.
--
-- `gate_icao` is the airport whose stands the gate board covers, and it is
-- stored rather than derived because the answer is not always the origin: a
-- group departure parks everyone at the field they leave from, a fly-in parks
-- them at the field they arrive at. An empty value means "the origin", which is
-- the common case and what the crew center fills in for you.
--
-- `slots` is a cap, and 0 means uncapped. Signing up past the cap is not
-- refused — it lands on the waitlist (see the signups table), because an event
-- that quietly turns pilots away is one staff find out about too late.
--
-- `min_rank` names a rung on the VA's ladder, exactly as crew_routes.min_rank
-- does, and for the same reason: the VA sets what a rank is worth in one place.
-- ----------------------------------------------------------------------------
create table if not exists crew_events (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    title         text not null default '',
    description   text not null default '',
    -- Event artwork, shown on the card in the crew center and on the VA's site.
    -- Rendered in an <img>, so the backend only ever stores an https URL here.
    banner_url    text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    flight_number text not null default '',
    -- ------------------------------------------------------------------------
    -- v7. The leg this event is flown on, when it is one of the VA's own.
    --
    -- Optional, and the leg details above are kept alongside it rather than
    -- read through it. An event is often a route the airline already publishes
    -- — picking it fills the fields in and ties the two together, so a PIREP
    -- filed for the event credits against the route like any other flight. But
    -- plenty of events are one-offs (a fly-in from anywhere, a charter to a
    -- field the network does not serve), so the leg has to stand on its own.
    --
    -- `on delete set null`: retiring a route must not delete the event that was
    -- flown on it, nor quietly blank the leg everybody signed up for.
    -- ------------------------------------------------------------------------
    route_id      uuid references crew_routes (id) on delete set null,
    -- Which Infinite Flight server this is being flown on. Free text: the
    -- server list is Infinite Flight's to change, not ours to constrain.
    server        text not null default '',
    starts_at     timestamptz,
    ends_at       timestamptz,
    slots         int not null default 0 check (slots >= 0),
    -- The gate board. `gates_open` is what a VA turns off for an event where
    -- stands are irrelevant (a formation over the ocean); `gates_locked` is
    -- what they turn on once the allocation is final, which freezes the board
    -- without deleting anybody's stand.
    gates_open    boolean not null default true,
    gates_locked  boolean not null default false,
    gate_icao     text not null default '',
    min_rank      text not null default '',
    -- Draft is the default on purpose: an event is written over several
    -- sittings and must not appear on the airline's public calendar (or in a
    -- pilot's list) until staff say so. Cancelled is kept rather than deleted —
    -- pilots who signed up need to be told, and a row that vanished tells
    -- nobody anything.
    status        text not null default 'draft' check (status in ('draft','published','cancelled')),
    created_by    text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
-- v7. Added separately so a project provisioned at v6 picks it up on a re-run.
alter table crew_events add column if not exists route_id uuid references crew_routes (id) on delete set null;
create index if not exists crew_events_va_idx     on crew_events (va_slug, starts_at desc);
create index if not exists crew_events_public_idx on crew_events (va_slug, starts_at) where status = 'published';

-- ----------------------------------------------------------------------------
-- Who is attending, and from which stand. v6.
--
-- One row per pilot per event. Withdrawing DELETES the row rather than flagging
-- it: a withdrawn pilot still holding a gate is the bug this whole table exists
-- to prevent, and "who is coming" is a question a list of live rows answers
-- exactly.
--
-- THE GATE IS CLAIMED IN THE DATABASE, NOT IN THE BROWSER. The unique index
-- below is what makes a stand belong to one pilot: two people tapping the same
-- marker at the same moment is not a rare case at an event that has just been
-- announced, and any check performed before the insert loses that race. The
-- second insert fails, the crew center says the stand has just gone, and the
-- board is never wrong about who is parked where.
--
-- `member_id` links to the roster where there is one; it is nullable so staff
-- can put a guest on the board (a partner VA flying in) without inventing a
-- roster row for them. `account_id` is the login that signed up — deliberately
-- NOT a foreign key onto crew_accounts, because deleting an account must not
-- cascade a pilot off an event that has already been planned around them.
-- ----------------------------------------------------------------------------
create table if not exists crew_event_signups (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    -- Cascade: an event that is gone has no attendees. This is the one place a
    -- cascade is right — the rows have no meaning apart from their event.
    event_id    uuid not null references crew_events (id) on delete cascade,
    member_id   uuid references crew_members (id) on delete set null,
    account_id  uuid,
    -- Denormalised so the board still reads correctly after the pilot's roster
    -- row has been removed, the same way a PIREP keeps its pilot's name.
    pilot_name  text not null default '',
    callsign    text not null default '',
    aircraft    text not null default '',
    -- The stand itself, plus where it is, so the board can be drawn without
    -- asking OpenStreetMap again — and can still be drawn years later for an
    -- airport whose mapping has since changed.
    gate        text not null default '',
    gate_lat    double precision,
    gate_lon    double precision,
    gate_kind   text not null default '',
    note        text not null default '',
    -- 'waitlist' is what a signup becomes past the event's slot cap. It is a
    -- real attendance record — it just does not hold a gate.
    status      text not null default 'going' check (status in ('going','waitlist')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_event_signups_event_idx
    on crew_event_signups (va_slug, event_id, created_at);
-- One stand, one aircraft. Case-insensitive because "b24" and "B24" are the
-- same gate to everyone except a database.
create unique index if not exists crew_event_signups_gate_idx
    on crew_event_signups (event_id, upper(gate)) where gate <> '';
-- One signup per pilot per event, whichever way we know them. Both are partial
-- so a staff-added guest — no account, no roster row — is never blocked by
-- another guest.
create unique index if not exists crew_event_signups_account_idx
    on crew_event_signups (event_id, account_id) where account_id is not null;
create unique index if not exists crew_event_signups_member_idx
    on crew_event_signups (event_id, member_id) where member_id is not null;

-- v7. crew_pireps.event_id points at an event, and can only say so once
-- crew_events exists — which, in file order, is here. `on delete set null`:
-- deleting an event must not delete anybody's logbook entry, and a flight that
-- was flown was still flown after the event it belonged to is gone.
--
-- Wrapped because `add constraint` has no `if not exists`, and this file is run
-- again on every upgrade.
do $$
begin
    alter table crew_pireps
        add constraint crew_pireps_event_fk
        foreign key (event_id) references crew_events (id) on delete set null;
exception
    when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- Announcements. v7.
--
-- The noticeboard on a pilot's home page. Two kinds of row live here and they
-- are deliberately the same shape:
--
--   * what staff write — "July schedule is live", pinned notices, briefings;
--   * what the crew center writes for them — a pilot promoted, a pilot joined,
--     an event published.
--
-- The second kind is the point. A VA's own good news already happens inside the
-- crew center and was visible only as a Discord message that scrolls away; a
-- pilot who joins on Tuesday should still see on Friday that they joined, and
-- that two other people did too. `kind` is what lets the page draw them
-- differently without needing a second table, and `source = 'auto'` is what
-- stops a staff member's hand-written notice being tidied up by a job that
-- prunes generated ones.
--
-- `ref_id` points at whatever caused an automatic row (a member, an event). It
-- is deliberately NOT a foreign key: an announcement is a record of something
-- that happened, and it stays true after the pilot leaves or the event is
-- deleted. Nothing reads it back as a join — it is there so a page can offer a
-- link when the target still exists.
-- ----------------------------------------------------------------------------
create table if not exists crew_announcements (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    title       text not null default '',
    body        text not null default '',
    kind        text not null default 'notice'
                check (kind in ('notice','promotion','join','event','checkride',
                                'schedule','leave')),
    source      text not null default 'staff' check (source in ('staff','auto')),
    -- Pinned notices sort above everything regardless of age: "read the new
    -- rules before you file" has to stay at the top of the board.
    pinned      boolean not null default false,
    ref_id      uuid,
    author_name text not null default '',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_announcements_va_idx
    on crew_announcements (va_slug, pinned desc, created_at desc);
-- v8. 'schedule' joins the list: a fortnight of flying going up is exactly the
-- kind of thing the board exists to tell the crew about. Replaced rather than
-- widened in place because the constraint is an inline column check, and a
-- project provisioned at v7 carries the old five-value version — a row it has
-- never heard of is refused, and the notice would vanish with no explanation.
-- v18. And 'leave' joins it, as the other half of 'join': a pilot coming off
-- the roster is the same class of fact as one arriving, and a board that
-- announces only the arrivals is a board where people quietly stop existing.
-- Widened the same way and for the same reason as v8 above.
-- v20. And 'staff', for somebody joining or leaving the team that RUNS the
-- airline. Until now the board recorded every promotion up the rank ladder and
-- said nothing at all about the one that decides who can act on everybody
-- else's behalf — so a VA's crew could watch a pilot make Captain and never
-- learn who had started approving their flight reports.
--
-- WHAT DOES NOT GET A ROW, and this is the more important half: a staff
-- application arriving, and a staff application being declined. This board is
-- PUBLIC (see the RLS policy at the foot of this file). A pilot who put their
-- name forward and was turned down told their airline something in confidence,
-- and "Sam applied to be PIREP manager" on a page the whole world can read is a
-- betrayal of that, whichever way the decision went. The reviewers already hear
-- about a new application down the recruitment webhook, which is private, and
-- the applicant hears the outcome in their own inbox. Only an ACCEPTED
-- application produces a row here, and it says what the other staff rows say —
-- who is on the team now.
do $$
begin
    alter table crew_announcements drop constraint if exists crew_announcements_kind_check;
    alter table crew_announcements add constraint crew_announcements_kind_check
        check (kind in ('notice','promotion','join','event','checkride','schedule','leave','staff'));
end $$;

-- ----------------------------------------------------------------------------
-- Keeping the board from becoming a log. v20.
--
-- THE THING THIS FIXES WAS DESIGNED FOR AND NEVER BUILT. `source` has said
-- 'staff' or 'auto' since v7, and the note above the table says the column
-- exists so "a job that prunes generated ones" cannot tidy away a staff
-- member's hand-written notice. That job was never written. So every pilot who
-- joined, every rank awarded, every fortnight of schedule published has been
-- accumulating since the day each VA installed this file, and the board reads
-- the newest fifty — which means an established airline is storing thousands of
-- rows to display fifty, forever, in a database it pays for.
--
-- ROWS, NOT DAYS. A day-based cutoff gets this exactly wrong in both
-- directions: a busy airline generates fifty rows in a week and would keep
-- almost nothing worth keeping, while a quiet one takes a year to fill the
-- board and would have its entire history deleted. What "off the board" means
-- is a position in a list, so that is what is counted.
--
-- WHAT IT WILL NOT TOUCH, ever:
--
--   * `source = 'staff'`. Somebody typed it. It is not this function's to
--     delete, however old — that is the whole reason the column is there, and
--     the bulk-purge dropdown in the dashboard is where a VA clears those
--     deliberately.
--   * `pinned`. A pinned automatic row is one staff went out of their way to
--     keep at the top of the board. Deleting it because it is old would undo a
--     decision somebody made on purpose.
--
-- SECURITY: definer, and reachable only by the service key (see the grants at
-- the foot of this file). It deletes rows; a browser credential has no business
-- with it.
-- ----------------------------------------------------------------------------
create or replace function crew_announcements_prune(
    p_va_slug text,
    p_keep    int default 200
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    keep    int := greatest(50, least(5000, coalesce(p_keep, 200)));
    removed int;
begin
    with prunable as (
        select id, row_number() over (order by created_at desc, id desc) as rn
          from crew_announcements
         where va_slug = p_va_slug
           and source  = 'auto'
           and not pinned
    )
    delete from crew_announcements a
     using prunable p
     where a.id = p.id and p.rn > keep;
    get diagnostics removed = row_count;
    return removed;
end;
$$;

-- ----------------------------------------------------------------------------
-- The schedule. v8.
--
-- A route says the airline flies LHR–JFK. A schedule says it flies at 18:40 on
-- Thursday, in a 787, and one pilot can put their name against it. That gap is
-- why this table exists and is not a column on crew_routes: the network is what
-- the VA operates, the schedule is when, and the same leg appears in it as many
-- times as it is flown.
--
-- HOW IT RELATES TO EVENTS. An event is everyone at once — twenty pilots, one
-- departure, a gate board to keep them off each other. A schedule is the
-- ordinary week: many departures, each flown by one pilot (or a small crew),
-- nobody gathering. They stay separate tables because the questions asked of
-- them are different — "who is coming?" versus "is this leg covered?" — and
-- collapsing them would mean every ordinary Tuesday departure carrying an
-- attendee list it never uses.
--
-- `route_id` is optional and the leg details are kept alongside it rather than
-- read through it, exactly as crew_events does: picking a route fills the
-- fields in, but a schedule may be built for a leg the network does not
-- publish, and retiring a route must not blank a departure pilots have already
-- booked.
--
-- `seats` is how many pilots may fly this departure. One is the common case and
-- the default; a VA running two-crew long-hauls sets two. Unlike an event's
-- `slots` there is no waitlist and no zero-means-uncapped: a departure with
-- nobody assignable is not a schedule entry, and a pilot who cannot have the
-- leg needs to be told now so they can book another.
-- ----------------------------------------------------------------------------
create table if not exists crew_schedules (
    id            uuid primary key default gen_random_uuid(),
    va_slug       text not null,
    route_id      uuid references crew_routes (id) on delete set null,
    flight_number text not null default '',
    origin        text not null default '',
    destination   text not null default '',
    aircraft      text not null default '',
    -- Both stored, both optional after the departure. An arrival time is what
    -- makes the schedule readable as a day of flying rather than a list of
    -- start times, but plenty of VAs publish only the push-back.
    departs_at    timestamptz,
    arrives_at    timestamptz,
    seats         int not null default 1 check (seats > 0),
    -- Names a rung on the VA's ladder, as crew_routes.min_rank and
    -- crew_events.min_rank do. Set on the schedule rather than inherited from
    -- the route, because the same leg can be open to everyone midweek and
    -- captain-only on the Friday night rotation.
    min_rank      text not null default '',
    notes         text not null default '',
    -- Draft is the default for the reason it is on events: a schedule is built
    -- a fortnight at a time and must not appear in a pilot's list until staff
    -- say so. Cancelled is kept rather than deleted — a pilot who booked the
    -- leg is owed the notice, and a row that vanished tells them nothing.
    status        text not null default 'draft' check (status in ('draft','published','cancelled')),
    created_by    text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists crew_schedules_va_idx     on crew_schedules (va_slug, departs_at);
create index if not exists crew_schedules_public_idx on crew_schedules (va_slug, departs_at) where status = 'published';
-- Which departures a route is carrying — read when a route is retired, and by
-- the route panel's "next departure" line. Partial: an ad-hoc leg has no route.
create index if not exists crew_schedules_route_idx  on crew_schedules (va_slug, route_id) where route_id is not null;

-- ----------------------------------------------------------------------------
-- Bookings. v8.
--
-- One row per pilot per departure they have taken. Cancelling DELETES the row,
-- for the reason withdrawing from an event does: the seat is the thing being
-- held, and a cancelled booking that still occupies one is the bug this table
-- exists to prevent.
--
-- THE SEAT IS CLAIMED IN THE DATABASE, NOT IN THE BROWSER. `seat` is a small
-- integer, 1..seats, and the unique index below is what makes it exclusive. Two
-- pilots tapping "book" on the last seat of a popular leg at the same moment is
-- not a rare case — it is what happens the minute a schedule is published — and
-- any count taken before the insert loses that race. The backend picks the
-- lowest free seat and inserts; the loser's insert fails, is retried against
-- what is now free, and is told the leg is full only when it genuinely is.
--
-- That is the same mechanism as the event gate board, deliberately. A seat is a
-- stand with the map taken away.
--
-- `member_id` links to the roster where there is one and is nullable so staff
-- can assign a leg to a guest crew. `account_id` is the login that booked and
-- is deliberately NOT a foreign key onto crew_accounts, because deleting an
-- account must not cascade a pilot off a departure the week has been planned
-- around.
-- ----------------------------------------------------------------------------
create table if not exists crew_bookings (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    -- Cascade: a departure that is gone has no bookings. Same reasoning as
    -- event signups — these rows have no meaning apart from their schedule.
    schedule_id uuid not null references crew_schedules (id) on delete cascade,
    member_id   uuid references crew_members (id) on delete set null,
    account_id  uuid,
    -- Denormalised so the schedule still reads correctly after the pilot's
    -- roster row has been removed, the same way a PIREP keeps its pilot's name.
    pilot_name  text not null default '',
    callsign    text not null default '',
    seat        int not null default 1 check (seat > 0),
    note        text not null default '',
    -- 'flown' is set when a flight report is matched to the booking, which is
    -- what lets a schedule show coverage — booked, flown, or nobody — instead
    -- of only intent.
    status      text not null default 'booked' check (status in ('booked','flown')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists crew_bookings_schedule_idx on crew_bookings (va_slug, schedule_id, seat);
create index if not exists crew_bookings_member_idx   on crew_bookings (va_slug, member_id) where member_id is not null;
-- One seat, one pilot. The claim that makes the race above safe.
create unique index if not exists crew_bookings_seat_idx
    on crew_bookings (schedule_id, seat);
-- One booking per pilot per departure, whichever way we know them. Both are
-- partial so a staff-assigned guest — no account, no roster row — is never
-- blocked by another guest.
create unique index if not exists crew_bookings_account_idx
    on crew_bookings (schedule_id, account_id) where account_id is not null;
create unique index if not exists crew_bookings_pilot_idx
    on crew_bookings (schedule_id, member_id) where member_id is not null;

-- v8. crew_pireps.schedule_id points at the departure a report was filed
-- against, and can only say so once crew_schedules exists — which, in file
-- order, is here. `on delete set null` for the same reason event_id uses it: a
-- flight that was flown was still flown after the schedule it belonged to has
-- been torn up.
alter table crew_pireps add column if not exists schedule_id uuid;
do $$
begin
    alter table crew_pireps
        add constraint crew_pireps_schedule_fk
        foreign key (schedule_id) references crew_schedules (id) on delete set null;
exception
    when duplicate_object then null;
end $$;
create index if not exists crew_pireps_schedule_idx
    on crew_pireps (va_slug, schedule_id) where schedule_id is not null;

-- v15. What this flight paid into the pilot's wallet, if the VA runs a shop.
--
-- Recorded ON THE FLIGHT rather than as a ledger row, because the only question
-- ever asked of it is "has this one been paid?" — and a column that is null
-- until it is not answers that in the same statement that does the paying, which
-- is what makes approving a flight twice pay once. It is also what keeps a rate
-- change out of history: the figure here is what the rates said on the day, and
-- nothing re-reads it.
--
-- Null means "never paid", which is every flight on a VA that has no shop, and
-- 0 means "paid, and the rates came to nothing" — a real answer, and a different
-- one.
alter table crew_pireps add column if not exists points_awarded int;

-- v18. When a staff member last corrected this report by hand, and who did it.
--
-- Staff can now open any pilot's logbook and edit a flight's duration and
-- landings -- which they need, because Infinite Flight's own record is
-- occasionally wrong and the alternative was deleting the report and asking the
-- pilot to file it again. A logbook that can be edited is a logbook that has to
-- say when it was: hours that change with nothing anywhere to point at are the
-- same class of problem as a rejection with no reason.
--
-- Both are droppable (see LATE_COLUMNS in crewStore.js): a correction written
-- without them is still a correction, and the hours still move.
alter table crew_pireps add column if not exists edited_at timestamptz;
alter table crew_pireps add column if not exists edited_by text not null default '';

-- ----------------------------------------------------------------------------
-- The link to Infinite Flight Live. v13.
--
-- Infinite Flight's PublicApi v3 gives a VA's Live ORGANIZATION a schedule of
-- its own: real aircraft, each with an ordered list of flights it is going to
-- operate. A crew center already has a schedule — the table above — and a VA
-- that keeps both is typing every departure twice.
--
-- THIS IS A LINK, NOT A MERGE, and the distinction is the whole design. The two
-- objects are not the same thing and must not be conflated:
--
--   crew_schedules      a departure with SEATS, which pilots book, gated on a
--                       rank, drafted before it is published.
--   an IF Live schedule a leg attached to one real aeroplane, with a sequence
--                       in that aeroplane's running order and a status driven
--                       by the flight actually happening.
--
-- So a row here may REFER to the Infinite Flight schedule it was pushed to, and
-- that is all. `if_schedule_id` is the id Infinite Flight gave it, which is what
-- makes the second push an update instead of a duplicate leg on somebody's
-- aircraft. `if_aircraft_id` is the PERSISTENT organization aircraft id — the
-- API's `id`, not its `aircraftId`, which is a livery content identifier and a
-- different thing entirely.
--
-- Not foreign keys, and not uuid: these name rows in somebody else's database.
-- Text, so that an id format change on a preview API is not a migration here.
--
-- `if_synced_at` is when we last pushed, which is what lets the panel say
-- "changed here since it was last sent" rather than making the VA remember.
--
-- All three are nullable and all three are in crewStore.js's LATE_COLUMNS: a
-- project still on v12 keeps working and simply cannot record the link, and the
-- crew center says so at the time instead of failing the write.
-- ----------------------------------------------------------------------------
alter table crew_schedules add column if not exists if_schedule_id text;
alter table crew_schedules add column if not exists if_aircraft_id text;
alter table crew_schedules add column if not exists if_synced_at   timestamptz;

-- The airframe's registration, kept next to its id.
--
-- Denormalised deliberately. `aircraft` above is the TYPE and livery — what a
-- VA has always been able to say about a departure. This is the specific
-- aeroplane, and the registration is the only part of it a pilot reads ("you're
-- on N682XL"). Resolving it from `if_aircraft_id` would mean calling Infinite
-- Flight to draw a schedule, on a page the whole roster loads, for a VA who may
-- not have connected an organization at all.
--
-- The id is the truth and the registration is the label. A stale label on a
-- re-registered airframe is a much smaller problem than a schedule that cannot
-- render unless a third party answers.
alter table crew_schedules add column if not exists if_registration text;

-- One crew departure per Infinite Flight schedule. Scoped by slug like every
-- other unique index here (one project can back several brands), and partial so
-- the many unpushed departures do not collide on null.
create unique index if not exists crew_schedules_if_idx
    on crew_schedules (va_slug, if_schedule_id) where if_schedule_id is not null;
-- "What have I pushed to this aeroplane?" — the read the sync does every time.
create index if not exists crew_schedules_if_aircraft_idx
    on crew_schedules (va_slug, if_aircraft_id) where if_aircraft_id is not null;

-- ----------------------------------------------------------------------------
-- The document library. v11.
--
-- Every VA has an operations manual, and until now every VA hosted it
-- somewhere else — a Google Doc, a Discord pin, a PDF in a channel nobody can
-- search. The crew center already knows who each pilot is and what rung they
-- are on, which is exactly what deciding "may this person read this" needs, so
-- the library belongs here rather than behind a link.
--
-- THREE KINDS OF CONTENT, ONE TABLE
-- `source` says where the words actually are, and only one of the three fields
-- is ever filled:
--
--   'text'   written in the crew center. `body` holds it. Best for the short
--            standing orders a VA rewrites often, because editing is one panel
--            rather than a round trip through someone else's editor.
--   'link'   somewhere else already — a Doc, a Notion page, a shared drive.
--            `link_url` points at it. The VA keeps their existing workflow and
--            still gets the gating and the index.
--   'file'   uploaded to us. `file_url` is the hosted copy; `file_name` and
--            `file_size` are kept so the list can say "Ops Manual.pdf, 4.2 MB"
--            without fetching the thing to find out.
--
-- Storing which one it is, rather than inferring it from whichever column is
-- non-empty, means a document whose link is temporarily blank is still a link
-- document with a missing link — a fixable state that says so — instead of
-- silently becoming an empty text document.
--
-- `min_rank` is the rank gate, deliberately the same shape as crew_routes and
-- crew_events use: a rung name read against the VA's own ladder, so editing the
-- ladder re-gates the library at once and no rank is stored twice. Note what
-- this means for RLS below — unlike a route, a document's CONTENT is the thing
-- being gated, so a gated row is not readable with a browser key at all.
--
-- `revision` and `revised_at` are the pair that makes a library trustworthy. A
-- pilot who has read the manual needs to know whether the change since then was
-- a typo or a new fuel policy, and only the person editing it knows which. So
-- the revision label is theirs to write and `revised_at` moves only when they
-- say the change was substantive — it is NOT `updated_at`, which moves on every
-- keystroke saved and would mark the whole roster unread for a fixed comma.
-- ----------------------------------------------------------------------------
create table if not exists crew_documents (
    id           uuid primary key default gen_random_uuid(),
    va_slug      text not null,
    title        text not null default '',
    summary      text not null default '',
    kind         text not null default 'document'
                 check (kind in ('manual','sop','handbook','policy','briefing','form','document')),
    source       text not null default 'text' check (source in ('text','link','file')),
    body         text not null default '',
    link_url     text not null default '',
    file_url     text not null default '',
    file_name    text not null default '',
    file_size    bigint not null default 0 check (file_size >= 0),
    min_rank     text not null default '',
    pinned       boolean not null default false,
    -- 'archived' rather than deleting: a superseded manual is the thing you want
    -- when a pilot asks why they were told something different last month.
    status       text not null default 'draft' check (status in ('draft','published','archived')),
    revision     text not null default '',
    revised_at   timestamptz,
    author_name  text not null default '',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
-- The library as a pilot reads it: what is published, pinned first.
create index if not exists crew_documents_va_idx
    on crew_documents (va_slug, status, pinned desc, title);
-- And as staff file it: everything of one kind, newest revision first.
create index if not exists crew_documents_kind_idx
    on crew_documents (va_slug, kind, updated_at desc);

-- ----------------------------------------------------------------------------
-- The pilot's inbox. v11.
--
-- The noticeboard (crew_announcements) is the airline talking to everybody at
-- once, and it is the wrong shape for half of what a VA needs to say. "Your
-- application was accepted", "you are on Thursday's LHR–JFK", "your Captain
-- check-ride is booked" are addressed to ONE pilot, and putting them on a board
-- either tells the whole roster somebody else's business or does not get said
-- at all. So this table is the other half: one row per pilot per thing.
--
-- ADDRESSING. `account_id` is the login that reads it and is the key the inbox
-- is actually queried by. It is deliberately NOT a foreign key onto
-- crew_accounts, for the reason crew_bookings.account_id is not either — an
-- account being reset or replaced must not silently delete the record of what
-- the pilot was told.
--
-- `member_id` is the roster row, kept alongside so staff can address a message
-- to a pilot they picked off the roster without first looking up which login
-- belongs to them. This one DOES cascade: a pilot removed from the roster
-- should not leave their correspondence behind in the VA's project.
--
-- `read_at` null means unread, and it is a timestamp rather than a boolean
-- because "when did they see this" is the question staff actually ask — after
-- posting the new fuel policy, the useful answer is which pilots have opened it
-- and when, not a count of ticks.
--
-- WHY NOT DISCORD. Most VAs do reach their pilots through Discord, and the crew
-- center still posts there. But a Discord message is gone in a week, cannot be
-- addressed to "everyone above Senior First Officer", and is invisible to a
-- pilot who joined after it was sent. This is the durable copy, and it is in
-- the VA's own project where the rest of their operational record lives.
-- ----------------------------------------------------------------------------
create table if not exists crew_notifications (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    account_id  uuid,
    member_id   uuid references crew_members (id) on delete cascade,
    title       text not null default '',
    body        text not null default '',
    kind        text not null default 'message'
                check (kind in ('message','application','promotion','booking',
                                'event','document','checkride','system',
                                -- v15. The three things the bell carries that
                                -- nothing used to tell a pilot about at all: a
                                -- flight they filed being reviewed, and an order
                                -- they paid for being handed over.
                                'flight_approved','flight_rejected',
                                -- v18. Staff corrected a flight's hours or
                                -- landings by hand. Its own kind so the bell
                                -- can draw it differently: "we changed a
                                -- number on your record" is not the same news
                                -- as "your flight counted".
                                'flight_edited','order')),
    -- What it is about, when it is about something — an event, a departure, a
    -- document. Untyped on purpose: `kind` says which table to read it against,
    -- and a hard reference to seven of them would make deleting any one of
    -- those a cascade through the inbox.
    ref_id      uuid,
    -- Where tapping it should go. Held rather than derived so a message about a
    -- thing that has since moved still lands somewhere sensible.
    link_url    text not null default '',
    sender_name text not null default '',
    read_at     timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- v15. Widen the vocabulary on a project that already has the table. The check
-- above only runs on a fresh create, so an established VA would otherwise refuse
-- every "your flight was approved" with a constraint violation. Dropped by the
-- name Postgres gives an inline column check; a project whose constraint has
-- been renamed by hand simply gains a second, identical one.
-- v18 widens it again, for 'flight_edited'. Same shape and same reason: the
-- inline check only runs on a fresh create, so without this an established VA
-- refuses every correction notice with a constraint violation -- and the
-- correction itself would go through, leaving the pilot's hours changed and
-- nothing anywhere telling them so.
alter table crew_notifications drop constraint if exists crew_notifications_kind_check;
alter table crew_notifications add constraint crew_notifications_kind_check
    check (kind in ('message','application','promotion','booking',
                    'event','document','checkride','system',
                    'flight_approved','flight_rejected','flight_edited','order','quiz'));

-- The inbox itself: one pilot's messages, newest first.
create index if not exists crew_notifications_account_idx
    on crew_notifications (va_slug, account_id, created_at desc) where account_id is not null;
-- The badge. Partial so the count a pilot's every page load asks for reads an
-- index of only what is unread, which is the small set, not the whole history.
create index if not exists crew_notifications_unread_idx
    on crew_notifications (va_slug, account_id, created_at desc)
    where read_at is null and account_id is not null;
create index if not exists crew_notifications_member_idx
    on crew_notifications (va_slug, member_id) where member_id is not null;

-- ----------------------------------------------------------------------------
-- Quick links. v12.
--
-- Where the crew is sent: the Discord, the IFC thread, SimBrief, the charts
-- site, the livery pack, the leave form. Today that lives in a Discord pinned
-- message — invisible to anyone who has not joined Discord, invisible to a pilot
-- on the web, scrolled past within a week, and kept up to date by hand or by a
-- bot the VA has to run and host. A crew center already IS where pilots go, so
-- the links belong here and no bot is involved.
--
-- WHY THIS IS NOT crew_documents. A document is something to READ: long, with
-- revisions, where knowing which version you read is the point. A link is
-- somewhere to GO: one line, never revised, and the only questions about it are
-- whether the address still works and whether anyone uses it. Collapsing them
-- would give a library full of one-line rows needing a reader, or a link list
-- carrying revision machinery it never touches. A link may of course POINT at a
-- document, which is what crew_documents.link_url does from the other side.
--
-- `url` is stored as the URL parser's own normalised output, never as the string
-- staff typed — see crewLinks.safeUrl, which refuses everything that is not http
-- or https. That is enforced in the backend rather than by a check constraint
-- here because the rule needs a URL parser, and a regex approximating one is how
-- `java<TAB>script:` gets through.
--
-- `sort_order` is 1-based where staff have arranged a tile, and 0 — the default —
-- means NEVER ARRANGED. Those sort last, not first; see crewLinks.boardFor for
-- why an ORDER BY alone gets this backwards.
--
-- `opens` is how often the crew actually used a link, which is the number that
-- tells a VA their charts link is dead weight and their leave form is not. It is
-- a usage HINT: the increment is not an authenticated act (opening a link is not
-- session-bearing), so it is good for "which of these matters" and not for
-- anything that has to be exact.
-- ----------------------------------------------------------------------------
create table if not exists crew_links (
    id             uuid primary key default gen_random_uuid(),
    va_slug        text not null,
    title          text not null default '',
    url            text not null default '',
    description    text not null default '',
    category       text not null default 'other'
                   check (category in ('community','tools','charts','downloads',
                                       'training','forms','social','other')),
    icon           text not null default 'link',
    min_rank       text not null default '',
    pinned         boolean not null default false,
    -- No 'archived' here, unlike a document. A superseded manual is worth keeping
    -- because somebody may ask what it used to say; a dead link has nothing to
    -- say. Staff either fix the address or remove the tile.
    status         text not null default 'published' check (status in ('published','draft')),
    sort_order     int not null default 0 check (sort_order >= 0),
    opens          bigint not null default 0 check (opens >= 0),
    last_opened_at timestamptz,
    author_name    text not null default '',
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
-- The board as it is drawn.
create index if not exists crew_links_va_idx
    on crew_links (va_slug, status, pinned desc, sort_order);
-- And as staff review it: what is actually being used.
create index if not exists crew_links_opens_idx
    on crew_links (va_slug, opens desc);

-- v12. Counting an open.
--
-- A function rather than a PATCH because `opens = opens + 1` is not something
-- PostgREST can express, and a read-then-write from the backend would lose
-- counts whenever two pilots tap the same tile at once — which, for the Discord
-- link right after a notice goes out, is the normal case rather than the edge.
--
-- NOT security definer, and execute is NOT granted to anon: the backend calls
-- this with the service key after it has checked that the caller may actually see
-- the link, so a browser key has no reason to reach it. `status = 'published'`
-- is belt and braces on top of that — a draft nobody can see cannot be counted.
create or replace function crew_link_open(p_va_slug text, p_link_id uuid)
returns bigint
language sql
volatile
as $$
    update crew_links
       set opens = opens + 1, last_opened_at = now()
     where va_slug = p_va_slug and id = p_link_id and status = 'published'
    returning opens;
$$;

-- ----------------------------------------------------------------------------
-- v14. Check-rides: the queue between "I think I'm ready" and a rank that moves.
--
-- The ladder already knew which rungs need a check-ride, and crew_members.
-- checks_passed already held the sign-offs. What had no place to live was the
-- MIDDLE of that process: a pilot asking, staff agreeing a time, and the result
-- being written down. That happened in Discord, where a request scrolls away and
-- the sign-off gets forgotten -- which is the exact failure the sign-off column
-- was built to fix and could not, because nothing ever reached it.
--
-- One row per request, and the row IS the record: it outlives the check-ride, so
-- "why am I still a First Officer?" has an answer with a date on it.
--
-- `for_rank` is a rung's NAME, like every other rank reference in this schema
-- (crew_routes.min_rank, crew_documents.min_rank). A VA reordering their ladder
-- must not silently repoint a pilot's pending check-ride at a different rank.
--
-- `scheduled_at` is a real timestamp and `scheduled_text` is what the examiner
-- actually typed. Both, because staff write times the way people do -- "Saturday
-- 19:00Z, KJFK -> EGLL" -- and half of that is an instant a calendar understands
-- while the other half is the part the pilot needs. Parsing it and keeping only
-- the instant loses the route; keeping only the words loses the ordering.
--
-- Hours and flights are deliberately NOT snapshotted here. Staff judge a
-- check-ride against what a pilot has NOW, and a figure frozen at the moment
-- they asked is worse than no figure -- the same reasoning that keeps rank
-- itself derived rather than stored (see crewRanks.js).
-- ----------------------------------------------------------------------------
create table if not exists crew_training_requests (
    id             uuid primary key default gen_random_uuid(),
    va_slug        text not null,
    member_id      uuid,
    for_rank       text not null default '',
    status         text not null default 'requested'
                   check (status in ('requested','scheduled','passed','failed','withdrawn')),
    scheduled_at   timestamptz,
    scheduled_text text not null default '',
    examiner_name  text not null default '',
    notes          text not null default '',
    decided_at     timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
-- The queue as staff work it: what is open, oldest ask first.
create index if not exists crew_training_va_idx
    on crew_training_requests (va_slug, status, created_at);
-- And one pilot's own history, which is the other way it is read.
create index if not exists crew_training_member_idx
    on crew_training_requests (va_slug, member_id, created_at desc);


-- ----------------------------------------------------------------------------
-- v15. The shop: what a flight is worth, and what a pilot spends it on.
--
-- A VA has exactly one thing to give a pilot for flying: hours. They go up, and
-- they are never spent on anything. Every airline that has wanted more than
-- that has built the same thing by hand -- a points spreadsheet, a channel of
-- shop screenshots, and a staff member subtracting numbers by hand -- and it
-- works for about a month.
--
-- Two tables and three functions are the whole of it. What is NOT here is as
-- deliberate as what is:
--
--   * No "give this pilot 500 points" table. Points come from approved flight
--     reports and nothing else (see crew_pireps.points_awarded), because a
--     second, unaudited supply is how every hand-rolled VA economy has ended up
--     in an argument.
--   * No prices, rates or currency name. Those are settings, they live on the
--     VA's record with the rank ladder and the fleet, and a project full of
--     rows does not need a row to say what a mile is called.
--
-- WHERE THE ARITHMETIC HAPPENS. In crew_shop_buy, below, in one statement. The
-- browser is never allowed to decide whether a pilot can afford something: it
-- asks, and this debits, re-checking the price, the stock and the per-pilot
-- limit against the rows as they are RIGHT NOW rather than as they were when
-- the shelf was drawn.
-- ----------------------------------------------------------------------------
create table if not exists crew_shop_items (
    id              uuid primary key default gen_random_uuid(),
    va_slug         text not null,
    name            text not null default '',
    description     text not null default '',
    image_url       text not null default '',
    icon            text not null default '',
    price           int  not null default 0 check (price >= 0),
    -- -1 is unlimited, and it is the default: a livery, a Discord role or a
    -- callsign does not run out, and those are most of what a VA puts on a
    -- shelf. 0 is sold out, which is a different and real state.
    stock           int  not null default -1,
    -- 0 means no limit. A cap belongs per item rather than per shop because
    -- "one retro livery each" and "as many stickers as you like" are both
    -- normal on the same shelf.
    limit_per_pilot int  not null default 0 check (limit_per_pilot >= 0),
    active          boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists crew_shop_items_va_idx
    on crew_shop_items (va_slug, active, created_at);

-- v18. Two presentation columns, both additive and both with inert defaults,
-- so every item written before they existed is a valid row on the new shape.
--
-- `item_group` and not `group`: `group` is a reserved word in SQL, and a column
-- called one is a column every hand-written query has to quote forever.
--
-- `tier` is how loudly the shelf draws a thing -- 'standard' (an ordinary tile,
-- and the default, which is what every existing item already was), 'showcase'
-- (a thing whose whole value is that other people can see it, drawn wide) and
-- 'flagship' (a thing that changes the AIRLINE rather than the pilot, drawn as
-- a band at the top of the shelf). The check is deliberately permissive about
-- an empty string: the backend bounds the value on the way in and reads an
-- unrecognised one as 'standard', and a constraint that rejects a row is a
-- worse failure here than a tile drawn small.
alter table crew_shop_items add column if not exists item_group text not null default '';
alter table crew_shop_items add column if not exists tier       text not null default 'standard';

-- An order is a receipt, so it keeps its own copy of the name and the price.
-- The item it came from may be edited, repriced or taken off the shelf
-- afterwards, and none of that may rewrite what a pilot actually paid -- which
-- is why `item_id` is nullable and carries `on delete set null` rather than
-- cascading a delete through somebody's history.
create table if not exists crew_shop_orders (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    member_id   uuid,
    item_id     uuid references crew_shop_items (id) on delete set null,
    item_name   text not null default '',
    price       int  not null default 0,
    status      text not null default 'placed'
                check (status in ('placed','fulfilled','cancelled')),
    -- What the pilot shows their staff to collect it. Short enough to read out.
    code        text not null default '',
    decided_at  timestamptz,
    decided_by  text not null default '',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- The queue as staff work it: what is waiting, newest first.
create index if not exists crew_shop_orders_va_idx
    on crew_shop_orders (va_slug, status, created_at desc);
-- And one pilot's own receipts, which is the other way it is read.
create index if not exists crew_shop_orders_member_idx
    on crew_shop_orders (va_slug, member_id, created_at desc);

-- ----------------------------------------------------------------------------
-- v20. Staff applications: a pilot asking for a job on the team.
--
-- WHY THIS IS A TABLE AND NOT A MESSAGE.
--
-- Becoming staff used to have exactly one route: the owner noticed somebody,
-- opened the team editor and promoted them. Everything before that moment —
-- "we need a second PIREP reviewer", a pilot saying they would like to help,
-- the owner comparing three volunteers — happened in Discord, off the record,
-- and the crew centre knew nothing about it. The owner was the bottleneck and
-- the only person who could see the queue, because there was no queue.
--
-- So an OPENING is a job the airline has advertised (held on the VA's own
-- record alongside the staff roles it points at — see crewStaffApps.js), and a
-- row here is one pilot asking for one of them. Accepting it runs the same
-- promotion the owner would have run by hand, which is the point: this is a
-- front door onto the existing path, not a second way of becoming staff.
--
-- WHOSE DATA. The VA's, like every other table in this file. These rows name a
-- VA's own pilots and carry what they wrote about themselves and what staff
-- wrote back about them, which is the airline's business and nobody else's.
--
-- PRIVACY: no anon policy and no grant (see the RLS block at the foot of this
-- file). A rejected application is a thing a pilot told their airline in
-- confidence; a browser key is refused at the door.
-- ----------------------------------------------------------------------------
create table if not exists crew_staff_applications (
    id          uuid primary key default gen_random_uuid(),
    va_slug     text not null,
    -- The opening as it was advertised. Both are kept, and both are plain text
    -- rather than references, because an opening lives on the VA's record and
    -- can be renamed, re-pointed or withdrawn while an application against it
    -- is still open. A queue that reads "applied for (deleted)" is a queue
    -- staff cannot work, so the title is copied at the moment of asking and the
    -- ids are what the accept path re-resolves against what exists NOW.
    opening_id  text not null default '',
    role_id     text not null default '',
    position    text not null default '',
    -- Who is asking. `member_id` is the roster row and is the identity that
    -- matters — the pilot's name and callsign are copied alongside it for the
    -- same reason the position is, so the queue still reads properly for
    -- somebody who has since left.
    member_id   uuid references crew_members (id) on delete cascade,
    pilot_name  text not null default '',
    callsign    text not null default '',
    -- Their answers to the opening's questions: [{ q, a }, …]. Same shape as
    -- crew_applications.answers, deliberately — it is the same kind of thing
    -- and the serialisers were written once.
    answers     jsonb not null default '[]'::jsonb,
    -- 'withdrawn' is the applicant's own move and is why this list is one
    -- longer than crew_applications'. A pilot who changes their mind must be
    -- able to take the ask back without a staff member having to decline them,
    -- which is a small thing that decides whether the queue reflects reality.
    status      text not null default 'pending'
                check (status in ('pending','accepted','declined','withdrawn')),
    -- What staff said. Shown to the applicant, so it is written as a reply
    -- rather than as a note: there is deliberately no private staff field here,
    -- because a box marked "they will never see this" invites the kind of
    -- remark a VA would not want in its own database.
    staff_message text not null default '',
    decided_by  text not null default '',
    decided_at  timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
-- The queue as staff work it: what is waiting, oldest ask first is the pilot's
-- view and newest first is the reviewer's. Indexed for the reviewer, who is the
-- one paging through it.
create index if not exists crew_staff_applications_va_idx
    on crew_staff_applications (va_slug, status, created_at desc);
-- And one pilot's own asks, which is what their own screen draws.
create index if not exists crew_staff_applications_member_idx
    on crew_staff_applications (va_slug, member_id, created_at desc);
-- One live ask per pilot per opening. A partial unique index rather than a
-- constraint on the pair, because a pilot who was declined — or who withdrew —
-- must be able to apply again when the airline advertises it next time.
create unique index if not exists crew_staff_applications_open_idx
    on crew_staff_applications (va_slug, member_id, opening_id)
    where status = 'pending' and member_id is not null;

-- ----------------------------------------------------------------------------
-- v22. QUIZZES — one pilot sitting one quiz.
--
-- The quizzes themselves are NOT here. A quiz is config, like the rank ladder,
-- the join form and the staff openings, so it lives on the VA's own record with
-- them and is edited in one place. What is here is the sitting of one: who was
-- sent which quiz, what they answered, and what it came to.
--
-- THE ANSWER KEY IS NOT IN THIS TABLE EITHER. `answers` is what the pilot
-- picked; the marking happens on the backend against the airline's own copy of
-- the questions. Nothing a browser can reach has ever held the right answers.
--
-- WHY SO MANY COPIES (quiz_title, pass_mark, max_attempts). A quiz can be
-- renamed, re-marked or deleted while somebody is half way through it. A result
-- that reads "(deleted) — 7/10 against a pass mark of (gone)" is not a record of
-- anything, so what the pilot sat is frozen on the row. Same reasoning as
-- crew_staff_applications.position.
-- ----------------------------------------------------------------------------
create table if not exists crew_quiz_attempts (
    id           uuid primary key default gen_random_uuid(),
    va_slug      text not null,
    quiz_id      text not null default '',
    quiz_title   text not null default '',
    -- The link. Holding one is how a pilot reaches their own attempt, so it is
    -- unique per project and is never listed to anybody but the pilot it
    -- belongs to. It is not a credential on its own: the backend still checks
    -- that the signed-in caller is the pilot the attempt names.
    token        text not null default '',
    member_id    uuid references crew_members (id) on delete cascade,
    pilot_name   text not null default '',
    callsign     text not null default '',
    -- 'issued'  staff sent it and nobody has opened it
    -- 'started' opened, not yet handed in
    -- 'passed' / 'failed' marked
    -- 'revoked' staff took the link back
    status       text not null default 'issued'
                 check (status in ('issued','started','passed','failed','revoked')),
    -- Whether THIS attempt is the one standing between the pilot and the crew
    -- centre. Held on the row rather than derived, so that turning the gate off
    -- — or pointing it at a different quiz — does not rewrite the history of
    -- who was once held at the door.
    gate         boolean not null default false,
    score        int not null default 0,
    total        int not null default 0,
    pass_mark    int not null default 0,
    attempts_used int not null default 0,
    max_attempts  int not null default 0,
    -- What they picked, in the order they were asked: [{ id, chosen, right }, …].
    answers      jsonb not null default '[]'::jsonb,
    -- What staff said when they sent it, or when they gave somebody another go.
    note         text not null default '',
    issued_by    text not null default '',
    started_at   timestamptz,
    submitted_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
-- The staff queue: what has been sent lately, and what is still outstanding.
create index if not exists crew_quiz_attempts_va_idx
    on crew_quiz_attempts (va_slug, status, created_at desc);
-- One pilot's own results, which is what the gate is read off on every sign-in.
create index if not exists crew_quiz_attempts_member_idx
    on crew_quiz_attempts (va_slug, member_id, created_at desc);
-- The link, resolved in one hop. Unique because a token that matched two rows
-- would be a pilot opening somebody else's paper.
create unique index if not exists crew_quiz_attempts_token_idx
    on crew_quiz_attempts (token) where token <> '';

-- ----------------------------------------------------------------------------
-- Buying something.
--
-- One function, one transaction, and every check inside it. The order of the
-- checks is the order a pilot would ask them in, so the message that comes back
-- names the first real reason rather than a generic refusal.
--
-- The debit is `update ... where points_balance >= price returning`: the price
-- is re-read and the balance is tested in the same statement that changes it,
-- so two taps on a cheap item cannot both succeed against one balance. The same
-- trick guards the stock.
--
-- SECURITY: definer, and reachable only by the service key (see the grants at
-- the foot of this file). It moves money; a browser credential has no business
-- with it, and the backend calls it only after deciding who the caller is.
-- ----------------------------------------------------------------------------
create or replace function crew_shop_buy(
    p_va_slug   text,
    p_member_id uuid,
    p_item_id   uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    it      crew_shop_items%rowtype;
    mine    int;
    bal     int;
    ord     crew_shop_orders%rowtype;
    m       crew_members%rowtype;
begin
    select * into it from crew_shop_items
     where va_slug = p_va_slug and id = p_item_id
       for update;
    if not found or not it.active then
        return jsonb_build_object('ok', false, 'code', 'item_gone',
            'error', 'That is not on the shelf any more.');
    end if;
    if it.stock = 0 then
        return jsonb_build_object('ok', false, 'code', 'sold_out',
            'error', 'That is sold out.');
    end if;

    if it.limit_per_pilot > 0 then
        select count(*) into mine from crew_shop_orders
         where va_slug = p_va_slug and member_id = p_member_id
           and item_id = p_item_id and status <> 'cancelled';
        if mine >= it.limit_per_pilot then
            return jsonb_build_object('ok', false, 'code', 'limit_reached',
                'error', format('You have had all %s of those you can.', it.limit_per_pilot));
        end if;
    end if;

    -- The debit. Balance tested and changed in one statement: nothing between
    -- the two, so nothing to race.
    update crew_members
       set points_balance = points_balance - it.price,
           points_spent   = points_spent + it.price
     where va_slug = p_va_slug and id = p_member_id
       and points_balance >= it.price
    returning points_balance into bal;
    if not found then
        return jsonb_build_object('ok', false, 'code', 'short',
            'error', 'That costs more than you have.');
    end if;

    -- Stock, where it is counted at all. Guarded the same way, and the debit is
    -- rolled back with the whole function if this cannot take one.
    if it.stock > 0 then
        update crew_shop_items set stock = stock - 1
         where id = it.id and stock > 0;
        if not found then
            raise exception 'sold out' using errcode = 'check_violation';
        end if;
    end if;

    insert into crew_shop_orders (va_slug, member_id, item_id, item_name, price, code)
    values (p_va_slug, p_member_id, it.id, it.name, it.price,
            upper(substr(md5(gen_random_uuid()::text), 1, 6)))
    returning * into ord;

    select * into m from crew_members where va_slug = p_va_slug and id = p_member_id;

    return jsonb_build_object(
        'ok', true,
        'order', to_jsonb(ord),
        'wallet', jsonb_build_object(
            'balance', bal,
            'earned', coalesce(m.points_earned, 0),
            'spent', coalesce(m.points_spent, 0)),
        'stock', (select stock from crew_shop_items where id = it.id));
end;
$$;

-- ----------------------------------------------------------------------------
-- Paying for a flight, exactly once.
--
-- `points_awarded is null` in the WHERE is the whole idempotency argument: the
-- row that records the payment is the row that gates it, so approving an
-- already-approved report updates nothing and credits nothing. Re-running this
-- for a flight that has been paid is a no-op that reports what it was paid.
--
-- The amount is computed by the backend from the VA's rates (they live on the
-- VA record, not here) and passed in, so a rate change cannot re-price history:
-- this only ever writes the figure it is handed, once.
-- ----------------------------------------------------------------------------
create or replace function crew_shop_credit(
    p_va_slug   text,
    p_pirep_id  uuid,
    p_member_id uuid,
    p_amount    int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    paid int;
    bal  int;
begin
    update crew_pireps set points_awarded = greatest(0, coalesce(p_amount, 0))
     where va_slug = p_va_slug and id = p_pirep_id and points_awarded is null
    returning points_awarded into paid;
    if not found then
        return jsonb_build_object('ok', false, 'code', 'already_paid');
    end if;

    if p_member_id is null or paid = 0 then
        return jsonb_build_object('ok', true, 'credited', coalesce(paid, 0));
    end if;

    update crew_members
       set points_balance = points_balance + paid,
           points_earned  = points_earned + paid
     where va_slug = p_va_slug and id = p_member_id
    returning points_balance into bal;

    return jsonb_build_object('ok', true, 'credited', paid, 'balance', bal);
end;
$$;

-- Taking it back, when an approved flight is rejected or deleted. The mirror of
-- the above and guarded the same way round: `points_awarded is not null` means
-- there is something to reverse, and clearing it is what makes a later
-- re-approval pay again -- which is right, because the flight would be counting
-- again too. The balance is floored at zero: a pilot who has already spent what
-- a since-rejected flight paid does not go into debt over staff changing their
-- mind, and `points_earned` carries the correction so the card's lifetime
-- figures stay honest.
create or replace function crew_shop_uncredit(
    p_va_slug   text,
    p_pirep_id  uuid,
    p_member_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    paid int;
begin
    update crew_pireps set points_awarded = null
     where va_slug = p_va_slug and id = p_pirep_id and points_awarded is not null
    returning points_awarded into paid;
    if not found then
        return jsonb_build_object('ok', false, 'code', 'not_paid');
    end if;

    if p_member_id is not null and paid > 0 then
        update crew_members
           set points_balance = greatest(0, points_balance - paid),
               points_earned  = greatest(0, points_earned - paid)
         where va_slug = p_va_slug and id = p_member_id;
    end if;
    return jsonb_build_object('ok', true, 'reversed', paid);
end;
$$;

-- ----------------------------------------------------------------------------
-- Refunding an order.
--
-- Staff cancelling an order gives the pilot their money back and puts the item
-- back on the shelf. `points_spent` comes down with the balance because a
-- refunded order is not a purchase -- the lifetime figure on the card should
-- read the same as if it had never happened.
--
-- Guarded on `status = 'placed'`, so pressing Refund twice refunds once.
-- ----------------------------------------------------------------------------
create or replace function crew_shop_refund(
    p_va_slug  text,
    p_order_id uuid,
    p_by       text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    ord crew_shop_orders%rowtype;
begin
    update crew_shop_orders
       set status = 'cancelled', decided_at = now(), decided_by = coalesce(p_by, '')
     where va_slug = p_va_slug and id = p_order_id and status = 'placed'
    returning * into ord;
    if not found then
        return jsonb_build_object('ok', false, 'code', 'not_open',
            'error', 'That order has already been dealt with.');
    end if;

    if ord.member_id is not null and ord.price > 0 then
        update crew_members
           set points_balance = points_balance + ord.price,
               points_spent   = greatest(0, points_spent - ord.price)
         where va_slug = p_va_slug and id = ord.member_id;
    end if;
    -- Back on the shelf, but only where stock is counted. An unlimited item is
    -- left at -1 rather than incremented into a number.
    if ord.item_id is not null then
        update crew_shop_items set stock = stock + 1
         where id = ord.item_id and stock >= 0;
    end if;

    return jsonb_build_object('ok', true, 'order', to_jsonb(ord));
end;
$$;

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function crew_touch_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps','crew_events','crew_event_signups','crew_announcements','crew_schedules','crew_bookings','crew_documents','crew_notifications','crew_links','crew_training_requests','crew_shop_items','crew_shop_orders','crew_staff_applications','crew_quiz_attempts','crew_schema_info']
    loop
        execute format('drop trigger if exists %I on %I', t || '_touch', t);
        execute format(
            'create trigger %I before update on %I for each row execute function crew_touch_updated_at()',
            t || '_touch', t);
    end loop;
end;
$$;

-- ============================================================================
-- Statistics
--
-- The crew center and the VA's public website both ask "how many pilots, how
-- many hours, how many flights?". Answering that with four separate PostgREST
-- round trips is wasteful and can tear (counts taken microseconds apart), so it
-- is one function returning one jsonb snapshot, computed in a single statement.
--
-- SECURITY: this is the ONE thing an unauthenticated visitor is allowed to
-- compute, because it is what a VA wants on their homepage. It returns
-- aggregates and a small leaderboard of pilot names — never emails, never
-- tokens, never application contents.
-- ============================================================================
create or replace function crew_stats(p_va_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with m as (
        select
            count(*)                                        as pilots,
            count(*) filter (where status = 'active')       as pilots_active,
            count(*) filter (where status = 'loa')          as pilots_loa,
            count(*) filter (where if_user_id <> '')        as pilots_linked,
            coalesce(sum(hours), 0)                         as hours,
            count(*) filter (where created_at > now() - interval '30 days') as joined_30d
        from crew_members where va_slug = p_va_slug
    ),
    p as (
        select
            count(*)                                            as pireps,
            count(*) filter (where status = 'approved')          as pireps_approved,
            count(*) filter (where status = 'pending')           as pireps_pending,
            count(*) filter (where status = 'rejected')          as pireps_rejected,
            coalesce(sum(duration_min) filter (where status = 'approved'), 0) as flown_min,
            coalesce(sum(landings)     filter (where status = 'approved'), 0) as landings,
            coalesce(sum(distance_nm)  filter (where status = 'approved'), 0) as distance_nm,
            count(*) filter (where status = 'approved'
                             and coalesce(flown_at, created_at) > now() - interval '30 days') as flights_30d,
            coalesce(sum(duration_min) filter (where status = 'approved'
                             and coalesce(flown_at, created_at) > now() - interval '30 days'), 0) as flown_min_30d,
            max(coalesce(flown_at, created_at)) filter (where status = 'approved') as last_flight_at
        from crew_pireps where va_slug = p_va_slug
    ),
    r as (
        select
            count(*)                                as routes,
            count(*) filter (where active)          as routes_active,
            count(distinct destination) filter (where active and destination <> '') as destinations
        from crew_routes where va_slug = p_va_slug
    ),
    a as (
        select
            count(*) filter (where status = 'pending')  as applications_pending,
            count(*) filter (where status = 'accepted') as applications_accepted,
            count(*) filter (where status = 'pending'
                             and created_at > now() - interval '30 days') as applications_30d
        from crew_applications where va_slug = p_va_slug
    ),
    -- v6. "Upcoming" means published and not yet started, which is the figure a
    -- VA quotes and the one the dashboard's events tile shows.
    ev as (
        select
            count(*)                                                       as events,
            count(*) filter (where status = 'published'
                             and starts_at > now())                        as events_upcoming,
            min(starts_at) filter (where status = 'published'
                             and starts_at > now())                        as next_event_at
        from crew_events where va_slug = p_va_slug
    ),
    -- v8. The schedule, answered the way staff ask about it: how much of what
    -- we published is actually covered? `seats_open` is the figure that sends
    -- someone to the schedule panel — legs nobody has taken, on published
    -- departures that have not left yet.
    sch as (
        select
            count(*) filter (where status = 'published'
                             and departs_at > now())                       as schedules_upcoming,
            min(departs_at) filter (where status = 'published'
                             and departs_at > now())                       as next_departure_at,
            coalesce(sum(seats) filter (where status = 'published'
                             and departs_at > now()), 0)                   as seats_upcoming
        from crew_schedules where va_slug = p_va_slug
    ),
    bk as (
        select count(*) as booked_upcoming
        from crew_bookings b
        join crew_schedules s on s.id = b.schedule_id
        where b.va_slug = p_va_slug and s.status = 'published' and s.departs_at > now()
    ),
    -- v11. The library. `to_regclass` is not needed here the way it is in
    -- crew_storage_usage — this function is replaced by the same script that
    -- creates the table, so by the time it can be called the table exists.
    doc as (
        select
            count(*) filter (where status = 'published')      as documents,
            count(*) filter (where status = 'published'
                             and min_rank <> '')              as documents_gated
        from crew_documents where va_slug = p_va_slug
    ),
    -- v12. The links board, plus how much it is actually used — the figure that
    -- tells a VA whether the resources they curated are earning their place.
    lnk as (
        select
            count(*) filter (where status = 'published')      as links,
            coalesce(sum(opens), 0)                           as link_opens
        from crew_links where va_slug = p_va_slug
    ),
    -- A small "top pilots by hours" board. Names only, and only pilots who have
    -- actually flown, so an empty roster doesn't produce a wall of zeroes.
    top as (
        select coalesce(jsonb_agg(t), '[]'::jsonb) as top_pilots from (
            select name, callsign, round(hours::numeric, 1) as hours
            from crew_members
            where va_slug = p_va_slug and status = 'active' and hours > 0
            order by hours desc, name asc
            limit 10
        ) t
    )
    select jsonb_build_object(
        'pilots',               m.pilots,
        'pilotsActive',         m.pilots_active,
        'pilotsLoa',            m.pilots_loa,
        'pilotsLinked',         m.pilots_linked,
        'pilotsJoined30d',      m.joined_30d,
        -- Credited roster hours: the figure the rank ladder is read against.
        'hours',                round(m.hours, 1),
        'pireps',               p.pireps,
        'pirepsApproved',       p.pireps_approved,
        'pirepsPending',        p.pireps_pending,
        'pirepsRejected',       p.pireps_rejected,
        -- Hours actually recorded on approved reports. Usually tracks `hours`
        -- closely; they diverge when staff hand-adjust a pilot's total.
        'flightHours',          round((p.flown_min / 60.0)::numeric, 1),
        'flightHours30d',       round((p.flown_min_30d / 60.0)::numeric, 1),
        'flights30d',           p.flights_30d,
        'landings',             p.landings,
        'distanceNm',           round(p.distance_nm, 0),
        'lastFlightAt',         p.last_flight_at,
        'routes',               r.routes,
        'routesActive',         r.routes_active,
        'destinations',         r.destinations,
        'applicationsPending',  a.applications_pending,
        'applicationsAccepted', a.applications_accepted,
        'applications30d',      a.applications_30d,
        'events',               ev.events,
        'eventsUpcoming',       ev.events_upcoming,
        'nextEventAt',          ev.next_event_at,
        'schedulesUpcoming',    sch.schedules_upcoming,
        'nextDepartureAt',      sch.next_departure_at,
        'seatsOpen',            greatest(sch.seats_upcoming - bk.booked_upcoming, 0),
        'seatsBooked',          bk.booked_upcoming,
        'documents',            doc.documents,
        'documentsGated',       doc.documents_gated,
        'links',                lnk.links,
        'linkOpens',            lnk.link_opens,
        'topPilots',            top.top_pilots,
        'generatedAt',          now()
    )
    from m, p, r, a, ev, sch, bk, doc, lnk, top;
$$;

-- ============================================================================
-- v9. How much room is this crew center using?
--
-- Supabase's free plan gives a project half a gigabyte of database, and a VA
-- who blows through it discovers that fact when writes start failing — the
-- project goes read-only and the crew center looks broken. The number is on
-- Supabase's own dashboard, but that is a place VA staff do not otherwise go
-- and, once the crew center is set up, have no reason to have an account for.
--
-- So the crew center answers it directly: total database size, what each crew
-- table costs, and what else is in the project (a VA may keep their own tables
-- alongside ours, and if something is eating the plan it is worth seeing which
-- thing). Sizes include indexes and TOAST — pg_total_relation_size is what the
-- plan is actually measured against, so a figure that left them out would read
-- low and reassure a VA who is about to run out.
--
-- SECURITY: definer, because the sizes live in catalogues an ordinary caller
-- cannot read, and because storage.objects belongs to another schema. It
-- returns sizes and counts — no row contents, no names of anything but tables.
-- Execute is granted to service_role only: the browser key has no business with
-- it, and everything the dashboard shows comes through the backend anyway.
-- ============================================================================
create or replace function crew_storage_usage(p_va_slug text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    crew_tables text[] := array[
        'crew_members','crew_accounts','crew_applications','crew_routes','crew_pireps',
        'crew_events','crew_event_signups','crew_announcements','crew_schedules',
        'crew_bookings','crew_documents','crew_notifications','crew_links','crew_training_requests',
        'crew_shop_items','crew_shop_orders','crew_staff_applications','crew_quiz_attempts',
        'crew_schema_info'];
    t              text;
    rel            regclass;
    tbl_bytes      bigint;
    tbl_rows       bigint;
    tbl_mine       bigint;
    tables_json    jsonb := '[]'::jsonb;
    crew_bytes     bigint := 0;
    db_bytes       bigint := 0;
    other_json     jsonb := '[]'::jsonb;
    other_bytes    bigint := 0;
    storage_bytes  bigint := 0;
    storage_files  bigint := 0;
begin
    foreach t in array crew_tables loop
        rel := to_regclass('public.' || t);
        continue when rel is null;                   -- project predates this table
        tbl_bytes := pg_total_relation_size(rel);
        execute format('select count(*) from public.%I', t) into tbl_rows;
        -- Rows belonging to THIS crew center, where the table is per-VA. One
        -- project can back several brands (see the multi-brand note above), so
        -- "your rows" and "rows in here" are different questions and staff
        -- looking at a shared project need both.
        tbl_mine := null;
        if p_va_slug is not null and t <> 'crew_schema_info' then
            execute format('select count(*) from public.%I where va_slug = $1', t)
                into tbl_mine using p_va_slug;
        end if;
        crew_bytes := crew_bytes + tbl_bytes;
        tables_json := tables_json || jsonb_build_object(
            'table', t, 'bytes', tbl_bytes, 'rows', tbl_rows, 'vaRows', tbl_mine);
    end loop;

    db_bytes := pg_database_size(current_database());

    -- Anything else the VA keeps in this project. Named, because "something is
    -- using 400 MB" is only actionable if you can see what.
    select coalesce(sum(bytes), 0),
           coalesce(jsonb_agg(jsonb_build_object('table', name, 'bytes', bytes)
                    order by bytes desc) filter (where rn <= 8), '[]'::jsonb)
      into other_bytes, other_json
      from (
        select c.relname::text as name,
               pg_total_relation_size(c.oid) as bytes,
               row_number() over (order by pg_total_relation_size(c.oid) desc) as rn
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r','p','m')
           and not (c.relname = any (crew_tables))
      ) s;

    -- Supabase Storage, if the project uses it. Its own schema, so a project
    -- where it is absent or locked down reports zero rather than failing the
    -- whole call — this figure is a nice-to-have next to the database size.
    begin
        execute 'select coalesce(sum((metadata->>''size'')::bigint), 0), count(*) from storage.objects'
            into storage_bytes, storage_files;
    exception when others then
        storage_bytes := 0; storage_files := 0;
    end;

    return jsonb_build_object(
        'databaseBytes',  db_bytes,
        'crewBytes',      crew_bytes,
        'otherBytes',     other_bytes,
        'storageBytes',   storage_bytes,
        'storageFiles',   storage_files,
        'tables',         tables_json,
        'otherTables',    other_json,
        'vaSlug',         p_va_slug,
        'generatedAt',    now()
    );
end;
$$;

-- ============================================================================
-- Row Level Security
--
-- Default deny on every table. The anon key then gets back exactly the three
-- public reads a crew center needs, and nothing else. Note what is absent:
-- there is no anon policy on crew_applications or crew_accounts at all, so
-- applicant emails, status tokens and password hashes are unreachable with a
-- browser key even if it leaks.
--
-- Writes have no policy for any role. They happen through the service key,
-- which bypasses RLS — so every mutation goes through the Inflight backend and
-- its permission checks rather than straight from a page.
-- ============================================================================
alter table crew_members       enable row level security;
alter table crew_accounts      enable row level security;
alter table crew_applications  enable row level security;
alter table crew_routes        enable row level security;
alter table crew_pireps        enable row level security;
alter table crew_events        enable row level security;
alter table crew_event_signups enable row level security;
alter table crew_announcements enable row level security;
alter table crew_schedules     enable row level security;
alter table crew_bookings      enable row level security;
alter table crew_documents     enable row level security;
alter table crew_notifications enable row level security;
alter table crew_links         enable row level security;
alter table crew_training_requests enable row level security;
alter table crew_shop_items    enable row level security;
alter table crew_shop_orders   enable row level security;
alter table crew_staff_applications enable row level security;
alter table crew_quiz_attempts enable row level security;
alter table crew_schema_info   enable row level security;

drop policy if exists crew_members_public_read on crew_members;
create policy crew_members_public_read on crew_members
    for select to anon, authenticated using (true);

drop policy if exists crew_routes_public_read on crew_routes;
create policy crew_routes_public_read on crew_routes
    for select to anon, authenticated using (active);

-- A public flight log: approved reports only. Pending and rejected ones are
-- staff business and stay invisible until a decision has been made.
drop policy if exists crew_pireps_public_read on crew_pireps;
create policy crew_pireps_public_read on crew_pireps
    for select to anon, authenticated using (status = 'approved');

-- Published events only. A draft is staff's working copy and stays invisible
-- until they publish it; a cancelled one stays readable, because pilots who
-- signed up are owed the notice.
drop policy if exists crew_events_public_read on crew_events;
create policy crew_events_public_read on crew_events
    for select to anon, authenticated using (status in ('published','cancelled'));

-- The attendee board, but only for events that are actually public. Tying the
-- policy to the event rather than granting the table outright means a draft's
-- signups cannot be read back through its attendees — which would otherwise
-- leak both the draft's existence and who staff had penciled in.
drop policy if exists crew_event_signups_public_read on crew_event_signups;
create policy crew_event_signups_public_read on crew_event_signups
    for select to anon, authenticated using (
        exists (
            select 1 from crew_events e
            where e.id = crew_event_signups.event_id
              and e.status in ('published','cancelled')
        )
    );

-- The noticeboard is what a VA tells its crew, and a crew center shows it to
-- anyone looking at the airline. Nothing sensitive goes in it — staff write the
-- notices, and the generated ones carry names that are already on the public
-- roster.
drop policy if exists crew_announcements_public_read on crew_announcements;
create policy crew_announcements_public_read on crew_announcements
    for select to anon, authenticated using (true);

-- Published and cancelled departures, matching the events rule exactly: a
-- draft schedule is staff's working copy, and a cancelled leg stays readable
-- because the pilot who booked it is owed the notice.
drop policy if exists crew_schedules_public_read on crew_schedules;
create policy crew_schedules_public_read on crew_schedules
    for select to anon, authenticated using (status in ('published','cancelled'));

-- Who is flying what, but only for departures that are actually public. Tying
-- the policy to the schedule rather than granting the table outright keeps a
-- draft's bookings from leaking both the draft's existence and who staff had
-- pencilled in — the same reasoning as crew_event_signups_public_read.
drop policy if exists crew_bookings_public_read on crew_bookings;
create policy crew_bookings_public_read on crew_bookings
    for select to anon, authenticated using (
        exists (
            select 1 from crew_schedules s
            where s.id = crew_bookings.schedule_id
              and s.status in ('published','cancelled')
        )
    );

-- v11. The library, and the one place in this file where a rank gate has to be
-- enforced by RLS rather than by the backend.
--
-- Compare crew_routes: a gated route is READ by everyone and the crew center
-- draws it as locked, because "the airline flies LHR–JFK, Captains only" is not
-- a secret — the gate is about who may fly it. A document is the opposite. Its
-- content IS the gated thing, so a Captains-only SOP that anon could select
-- would be gated on the screen and readable with a browser key, which is not a
-- gate at all.
--
-- So the browser key gets published, UNGATED documents only. Anything with a
-- min_rank is reachable exclusively through the Inflight backend, which knows
-- the pilot's hours and reads them against the VA's ladder before returning a
-- word of it. Staff drafts and archived revisions stay out for the same reason
-- a draft event does.
drop policy if exists crew_documents_public_read on crew_documents;
create policy crew_documents_public_read on crew_documents
    for select to anon, authenticated using (status = 'published' and min_rank = '');

-- v12. Quick links, treated exactly like documents and for the same reason: a
-- rank-gated link's ADDRESS is the thing being gated, so "visible but locked"
-- would be no gate. The browser key gets published, ungated tiles — which is
-- most of them, and is what makes the board work on a VA's public crew center
-- with nobody signed in. A gated one goes through the backend, which checks the
-- pilot's rung before returning the URL.
drop policy if exists crew_links_public_read on crew_links;
create policy crew_links_public_read on crew_links
    for select to anon, authenticated using (status = 'published' and min_rank = '');

-- crew_notifications gets NO policy at all, and no grant below.
--
-- A notification is addressed to ONE pilot. There is no filter available here
-- that could scope a browser key to "mine" — the anon key is one shared
-- credential with no identity behind it, so any policy permissive enough to let
-- a pilot read their own inbox would let anybody read the whole airline's. That
-- is a pilot's correspondence, including what staff said about their
-- application, so the table is unreachable with a browser key by construction
-- and every read goes through the backend against a signed-in session.

drop policy if exists crew_schema_info_public_read on crew_schema_info;
create policy crew_schema_info_public_read on crew_schema_info
    for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on crew_members, crew_routes, crew_pireps, crew_events, crew_event_signups,
    crew_announcements, crew_schedules, crew_bookings, crew_documents, crew_links, crew_schema_info to anon, authenticated;
-- Deliberately NOT granted on crew_applications or crew_accounts. The first
-- holds applicant emails and unclaimed invitation passwords, the second holds
-- password hashes; neither has a policy above, and revoking the grant means a
-- browser key is refused at the door rather than at the row.
revoke all on crew_applications from anon, authenticated;
revoke all on crew_accounts     from anon, authenticated;
-- v11. Same treatment, for the reason spelt out at crew_notifications' absent
-- policy: one shared browser credential cannot express "only mine".
revoke all on crew_notifications from anon, authenticated;

-- v14. Check-ride requests, kept from the browser key for the same reason. A row
-- names one pilot and carries what an examiner wrote about their flying; there
-- is no filter a single shared credential could be scoped by, so the table gets
-- no policy above and no grant here. Every read goes through the backend against
-- a signed-in session that knows whose request it is.
revoke all on crew_training_requests from anon, authenticated;

-- v20. Staff applications, same treatment and the same reason. A row names one
-- pilot, carries what they wrote about why they should have the job and what
-- staff wrote back when they said no. There is no filter one shared browser
-- credential could be scoped by, so the table gets no policy above and no grant
-- here; every read goes through the backend against a signed-in session that
-- knows whether the caller is the applicant or the person reviewing them.
revoke all on crew_staff_applications from anon, authenticated;

-- v22. Quiz attempts, same treatment and the same reason twice over. A row names
-- one pilot and carries what they answered and whether they passed — and it
-- carries the token that opens their paper. There is no filter one shared
-- browser credential could be scoped by, so the table gets no policy above and
-- no grant here; every read goes through the backend against a signed-in session
-- that knows whether the caller is the pilot sitting it or the staff member who
-- sent it.
revoke all on crew_quiz_attempts from anon, authenticated;

-- v15. The shelf is readable with the browser key, because it is a shop window:
-- a VA's own website should be able to show what its pilots can earn without
-- asking us for anything. Only the items, and only the ones that are on sale --
-- the policy below is the whole of what anon may see.
drop policy if exists crew_shop_items_public_read on crew_shop_items;
create policy crew_shop_items_public_read on crew_shop_items
    for select to anon, authenticated using (active);
grant select on crew_shop_items to anon, authenticated;

-- Orders are the opposite: a row names one pilot and what they spent, and one
-- shared browser credential cannot express "only mine". No policy, no grant,
-- and every read goes through the backend against a signed-in session -- the
-- same treatment crew_notifications and crew_training_requests get, for the
-- same reason.
revoke all on crew_shop_orders from anon, authenticated;

-- The three functions that move a balance are service-key only. A browser
-- credential that could call crew_shop_credit could mint a VA's currency at
-- will, and one that could call crew_shop_buy could spend somebody else's.
revoke all on function crew_shop_buy(text, uuid, uuid) from public, anon, authenticated;
revoke all on function crew_shop_credit(text, uuid, uuid, int) from public, anon, authenticated;
revoke all on function crew_shop_uncredit(text, uuid, uuid) from public, anon, authenticated;
revoke all on function crew_shop_refund(text, uuid, text) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function crew_shop_buy(text, uuid, uuid) to service_role';
        execute 'grant execute on function crew_shop_credit(text, uuid, uuid, int) to service_role';
        execute 'grant execute on function crew_shop_uncredit(text, uuid, uuid) to service_role';
        execute 'grant execute on function crew_shop_refund(text, uuid, text) to service_role';
    end if;
end $$;

-- v12. crew_link_open increments a counter and is reached only through the
-- backend's service key, after IT has decided the caller may see the link. A
-- browser key that could call this could inflate any VA's figures at will, and
-- there is no reason for a page to reach it directly.
revoke all on function crew_link_open(text, uuid) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function crew_link_open(text, uuid) to service_role';
    end if;
end $$;

-- v20. crew_announcements_prune DELETES rows. The noticeboard is publicly
-- readable, so a browser key that could call this could quietly empty any VA's
-- board — which is why it is service-key only, like every other function here
-- that changes something.
revoke all on function crew_announcements_prune(text, int) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function crew_announcements_prune(text, int) to service_role';
    end if;
end $$;

-- crew_stats is security definer so it can aggregate rows the caller cannot
-- read row-by-row (pending reports feed the "awaiting review" counter). It
-- returns only aggregates, so this widens what can be counted, never what can
-- be read.
grant execute on function crew_stats(text) to anon, authenticated;

-- crew_storage_usage is the opposite call: definer over the size catalogues and
-- another schema's tables, so it is kept away from the browser key entirely.
-- The backend reads it with the service key and shows staff the result.
revoke all on function crew_storage_usage(text) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function crew_storage_usage(text) to service_role';
    end if;
end $$;

-- ----------------------------------------------------------------------------
-- Stamp the version last, so a half-applied script does not advertise itself as
-- a complete install.
-- ----------------------------------------------------------------------------
insert into crew_schema_info (id, version) values (1, 22)
on conflict (id) do update set version = excluded.version, updated_at = now();
