#!/usr/bin/env bash
# test-crew-schema.sh
# Run supabase/crew-center-schema.sql against a real Postgres and check the
# properties it claims about itself.
#
# WHY THIS EXISTS
#
# That file is the biggest single artefact in this repository and nothing had
# ever executed it. Every VA runs it by hand in their own Supabase SQL editor,
# which means a syntax error, a function that does not compile or a grant that
# refers to something that is not there is discovered by a VA, in their own
# database, with no way to tell whether the half that applied is safe.
#
# WHAT IS CHECKED
#
#   1. The whole file applies with ON_ERROR_STOP, and stamps its version last.
#   2. crew_announcements_prune keeps the newest N generated notices and will
#      not touch a staff-written one, a pinned one, or another airline's rows.
#   3. The tables that hold private things refuse the browser roles at the
#      door, and the noticeboard does not — which is the control, and the
#      reason a declined staff application must never be posted to it.
#
# SUPABASE'S ROLES. The file grants to `anon`, `authenticated` and
# `service_role`, which a Supabase project has and vanilla Postgres does not.
# They are created here first. That is the ONE difference between this harness
# and a real project, and it is why a failure about a missing role means this
# script is wrong rather than the schema.
#
# Skips cleanly (exit 0) where there is no Postgres to run against, so it can
# sit in a suite that also runs on machines without one.
#
# Run:  scripts/test-crew-schema.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="$HERE/../supabase/crew-center-schema.sql"

for d in /usr/lib/postgresql/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH

if ! command -v initdb >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
    echo "no local Postgres (initdb/psql) — skipping schema test"
    exit 0
fi
[ -f "$SCHEMA" ] || { echo "cannot find $SCHEMA"; exit 1; }

# Postgres refuses to run as root, so the whole thing runs as a less-privileged
# user when we happen to be root (a container) and as ourselves otherwise.
PGUSER_LOCAL=""
if [ "$(id -u)" = "0" ]; then
    id postgres >/dev/null 2>&1 || { echo "running as root with no postgres user — skipping"; exit 0; }
    PGUSER_LOCAL="postgres"
fi
run() { if [ -n "$PGUSER_LOCAL" ]; then su "$PGUSER_LOCAL" -c "PATH=$PATH; $1"; else bash -c "$1"; fi; }

DIR="$(mktemp -d)"
cleanup() {
    run "pg_ctl -D '$DIR/data' stop -m immediate" >/dev/null 2>&1 || true
    rm -rf "$DIR"
}
trap cleanup EXIT

cp "$SCHEMA" "$DIR/schema.sql"
[ -n "$PGUSER_LOCAL" ] && chown -R "$PGUSER_LOCAL" "$DIR"
PORT=$(( 5400 + RANDOM % 150 ))

run "initdb -D '$DIR/data' -U postgres --auth=trust" >/dev/null 2>&1 \
    || { echo "initdb failed — skipping"; exit 0; }
run "pg_ctl -D '$DIR/data' -o '-k $DIR -p $PORT -c listen_addresses=' -l '$DIR/log' start" >/dev/null 2>&1 \
    || { echo "could not start Postgres — skipping"; sed -n '1,20p' "$DIR/log" 2>/dev/null; exit 0; }

PSQL="psql -h '$DIR' -p $PORT -U postgres"
fails=0
step() { printf '  %s %s\n' "$1" "$2"; }

# ---- 1. The file applies, and stamps itself last -------------------------
run "$PSQL -c 'create database crew;'" >/dev/null 2>&1
run "$PSQL -d crew -c \"do \\\$\\\$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end \\\$\\\$;\"" >/dev/null 2>&1

echo
echo "The schema file applies"
apply_out="$(run "$PSQL -d crew -v ON_ERROR_STOP=1 -f '$DIR/schema.sql'" 2>&1)"
if printf '%s' "$apply_out" | grep -qiE '^psql:.*(ERROR|FATAL)'; then
    step "✗" "applies with no error"
    printf '%s\n' "$apply_out" | grep -iE '^psql:.*(ERROR|FATAL)' | head -5 | sed 's/^/      /'
    fails=$((fails+1))
else
    step "✓" "applies with no error"
fi

want_version="$(grep -oE 'insert into crew_schema_info \(id, version\) values \(1, [0-9]+\)' "$SCHEMA" | grep -oE '[0-9]+\)$' | tr -d ')')"
got_version="$(run "$PSQL -d crew -tAc 'select version from crew_schema_info where id = 1;'" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$want_version" ] && [ "$got_version" = "$want_version" ]; then
    step "✓" "stamps itself v$got_version, last"
else
    step "✗" "version stamp: wanted '$want_version', got '$got_version'"
    fails=$((fails+1))
fi

# Re-running must be safe: every VA who updates their database does exactly this.
rerun_out="$(run "$PSQL -d crew -v ON_ERROR_STOP=1 -f '$DIR/schema.sql'" 2>&1)"
if printf '%s' "$rerun_out" | grep -qiE '^psql:.*(ERROR|FATAL)'; then
    step "✗" "re-applies cleanly over itself"
    printf '%s\n' "$rerun_out" | grep -iE '^psql:.*(ERROR|FATAL)' | head -5 | sed 's/^/      /'
    fails=$((fails+1))
else
    step "✓" "re-applies cleanly over itself"
fi

# ---- 2 and 3. The behaviour it claims ------------------------------------
cat > "$DIR/checks.sql" <<'SQL'
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- 600 generated notices, oldest last; plus the three things a prune must not
-- touch: a staff-written notice, a pinned generated one, another airline.
insert into crew_announcements (va_slug, title, kind, source, created_at)
select 'ba', 'auto '||g, 'join', 'auto', now() - (g || ' minutes')::interval from generate_series(1, 600) g;
insert into crew_announcements (va_slug, title, kind, source, created_at)
values ('ba','staff wrote this','notice','staff', now() - interval '400 days');
insert into crew_announcements (va_slug, title, kind, source, pinned, created_at)
values ('ba','old but pinned','promotion','auto', true, now() - interval '400 days');
insert into crew_announcements (va_slug, title, kind, source, created_at)
select 'ocean', 'ocean '||g, 'join', 'auto', now() - (g || ' minutes')::interval from generate_series(1, 300) g;

-- v20's widened kind constraint has to accept a staff row at all.
insert into crew_announcements (va_slug, title, kind, source) values ('ba','joined the team','staff','auto');

select 'removed=' || crew_announcements_prune('ba', 200);
select 'autos_left=' || count(*) from crew_announcements where va_slug='ba' and source='auto' and not pinned;
-- The survivors must be the NEWEST 200 by created_at, which is auto 1..199
-- plus the staff row posted just now.
select 'newest_kept=' || count(*) from crew_announcements
 where va_slug='ba' and source='auto' and not pinned and kind='join'
   and (regexp_replace(title,'\D','','g'))::int <= 200;
select 'staff_written_survived=' || count(*) from crew_announcements where va_slug='ba' and source='staff';
select 'pinned_survived=' || count(*) from crew_announcements where va_slug='ba' and pinned;
select 'other_airline_untouched=' || count(*) from crew_announcements where va_slug='ocean';
select 'second_prune=' || crew_announcements_prune('ba', 200);
-- Two statements, deliberately: a delete in a FROM subquery is not visible to
-- a scalar subquery in the same statement's select list, so counting the
-- result of the prune alongside calling it reads the pre-delete snapshot.
select crew_announcements_prune('ba', 0);
select 'keep_clamped_to_50=' || count(*) from crew_announcements
 where va_slug='ba' and source='auto' and not pinned;
select 'unknown_slug=' || crew_announcements_prune('nobody', 200);
SQL
[ -n "$PGUSER_LOCAL" ] && chown "$PGUSER_LOCAL" "$DIR/checks.sql"

echo
echo "The noticeboard prune"
out="$(run "$PSQL -d crew -f '$DIR/checks.sql'" 2>&1)"
val() { printf '%s' "$out" | grep -oE "^$1=.*" | head -1 | cut -d= -f2 | tr -d '[:space:]'; }
expect() {
    if [ "$(val "$1")" = "$2" ]; then step "✓" "$3"; else
        step "✗" "$3 — wanted $2, got '$(val "$1")'"; fails=$((fails+1)); fi
}
# 601 generated rows go in above — 600 'join' plus the one 'staff' row that
# proves v20's widened constraint accepts it — so 401 go and 200 stay.
expect removed 401                  "drops everything past the newest 200"
expect autos_left 200               "keeps exactly 200"
expect newest_kept 199              "and they are the newest ones"
expect staff_written_survived 1     "never touches what a person typed"
expect pinned_survived 1            "never touches a pinned notice"
expect other_airline_untouched 300  "never reaches another airline's board"
expect second_prune 0               "is idempotent"
expect keep_clamped_to_50 50        "clamps an absurd keep count to 50"
expect unknown_slug 0               "answers 0 for an airline it has never heard of"

cat > "$DIR/rls.sql" <<'SQL'
\set ON_ERROR_STOP off
\pset tuples_only on
\pset format unaligned
insert into crew_staff_applications (va_slug, position, pilot_name) values ('ba','PIREP reviewer','Rae');
set role anon;
select 'anon_staff_apps=' || count(*) from crew_staff_applications;
select 'anon_applicants=' || count(*) from crew_applications;
select 'anon_inbox=' || count(*) from crew_notifications;
select 'anon_logins=' || count(*) from crew_accounts;
select 'anon_prune=' || crew_announcements_prune('ba', 50);
select 'anon_board=' || count(*) from crew_announcements;
reset role;
set role authenticated;
select 'auth_staff_apps=' || count(*) from crew_staff_applications;
reset role;
SQL
[ -n "$PGUSER_LOCAL" ] && chown "$PGUSER_LOCAL" "$DIR/rls.sql"

echo
echo "What a browser key can reach"
out="$(run "$PSQL -d crew -f '$DIR/rls.sql'" 2>&1)"
refused() {
    # A revoked grant is refused at the door, which is what these tables want:
    # no policy AND no grant, so nothing is evaluated per row.
    if printf '%s' "$out" | grep -qE "permission denied for (table|function) $1"; then step "✓" "$2"; else
        step "✗" "$2 — it was not refused"; fails=$((fails+1)); fi
}
refused crew_staff_applications "staff applications are unreachable"
refused crew_applications       "pilot applications are unreachable"
refused crew_notifications      "a pilot's inbox is unreachable"
refused crew_accounts           "password hashes are unreachable"
refused crew_announcements_prune "the prune cannot be called"
# The control. If this ever fails, the tests above prove nothing — and it is
# also the reason a DECLINED staff application must never be posted here.
if printf '%s' "$out" | grep -qE '^anon_board=[0-9]+'; then
    step "✓" "the noticeboard is public (control)"
else
    step "✗" "the noticeboard should be publicly readable (control)"; fails=$((fails+1))
fi

echo
if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed."; exit 1; fi
echo "schema checks passed."
