#!/usr/bin/env bash
#
# bootstrap-testbed.sh — disposable PostgreSQL 16 testbed for the WhatsApp v2 work.
#
# Applies the migration chain as the plain non-superuser `jale_admin` owner, which
# is what every migration header requires ("Connect as: jale_admin (NOT the RDS
# master user)") and what the DB suites assert. A superuser bootstrap has
# rolbypassrls = t, so it silently skips the FORCE ROW LEVEL SECURITY behavior that
# migration 042's security model is built on.
#
# Two modes:
#   --persistent (default)  drive the docker-compose container `jale-wa-v2-pg`
#   --ephemeral             create a throwaway container and remove it on exit
#
# Flag-compatible with the canonical gate commands in the sprint plans, so
#   bash infra/db/local/bootstrap-testbed.sh --ephemeral --repo . -- <command>
# is a drop-in replacement for the out-of-repo psql-migration-testbed wrapper.
#
# NEVER point this at RDS. It only ever talks to a container it can see by name.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap-testbed.sh [options] [-- command...]

Mode:
  --persistent       Use the docker-compose container (default).
  --ephemeral        Create a throwaway container; remove it on exit.

Options:
  --empty            Create the jale_admin owner but do NOT apply migrations.
                     For apply-order.test.ts's clean-apply, which applies the
                     chain itself as jale_admin and therefore needs a virgin
                     cluster (roles are cluster-wide, so a fresh DB is not enough).
  --bare             Container and database only — no roles, no extension.
                     For billing-034-upgrade.test.ts, which creates jale_admin
                     itself as a non-executor GRANT target on purpose.
  --url-user USER    User in the emitted URL: jale_admin or postgres.
                     Default: postgres when migrated, jale_admin when --empty.
  --url-var NAME     Env var to export. Default: JALE_TEST_DATABASE_URL.
  --repo PATH        Repo root. Default: three levels above this script.
  --migrations PATH  Migration dir. Default: <repo>/infra/db/migrations.
  --ref REF          Also apply migrations present in this git ref but absent
                     locally (i.e. 042). Default: feat/wa-v2-integration.
                     Use --ref none to stop at the local chain.
  --port PORT        Host port. Default: 55442 (persistent) / 55443 (ephemeral).
  --db NAME          Database name. Default: jale.
  --image IMAGE      Docker image. Default: postgres:16.
  --container NAME   Container name. Default: jale-wa-v2-pg / jale-wa-v2-testbed.
  --verify           Run the acceptance probes after bootstrapping.
  --force            Re-apply even if the database is already bootstrapped.
  --keep             Ephemeral only: keep the container on exit.
  --no-tests         Bootstrap only; ignore any -- command.
  -h, --help         Show this help.

Anything after -- runs with JALE_TEST_DATABASE_URL exported.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$script_dir/../../.." && pwd)"
migrations=""
ref="feat/wa-v2-integration"
port=""
db="jale"
image="postgres:16"
container=""
mode="persistent"
verify=0
force=0
keep=0
run_tests=1
empty=0
bare=0
url_user=""
url_var="JALE_TEST_DATABASE_URL"
custom_cmd=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persistent) mode="persistent"; shift ;;
    --ephemeral) mode="ephemeral"; shift ;;
    --repo) repo="$2"; shift 2 ;;
    --migrations) migrations="$2"; shift 2 ;;
    --ref) ref="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --db) db="$2"; shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --container) container="$2"; shift 2 ;;
    --empty) empty=1; shift ;;
    --bare) bare=1; shift ;;
    --url-user) url_user="$2"; shift 2 ;;
    --url-var) url_var="$2"; shift 2 ;;
    --verify) verify=1; shift ;;
    --force) force=1; shift ;;
    --keep) keep=1; shift ;;
    --no-tests) run_tests=0; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; custom_cmd=("$@"); break ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker is required." >&2; exit 127; }

repo="$(cd "$repo" && pwd)"
[[ -n "$migrations" ]] || migrations="$repo/infra/db/migrations"
[[ "$migrations" = /* ]] || migrations="$repo/$migrations"
[[ -d "$migrations" ]] || { echo "Migration directory does not exist: $migrations" >&2; exit 2; }

if [[ "$mode" == "ephemeral" ]]; then
  [[ -n "$container" ]] || container="jale-wa-v2-testbed"
  [[ -n "$port" ]] || port="55443"
else
  [[ -n "$container" ]] || container="jale-wa-v2-pg"
  [[ -n "$port" ]] || port="55442"
fi

superuser="postgres"
superpass="test"
admin_user="jale_admin"
admin_pass="test-admin-pw"

# ---------------------------------------------------------------------------
# psql helpers. All database access goes through `docker exec`, so no local
# psql client is required — same approach as scripts/run-migrations.sh.
# ---------------------------------------------------------------------------
psql_super() {
  docker exec -i -e PGPASSWORD="$superpass" "$container" \
    psql -v ON_ERROR_STOP=1 -U "$superuser" -d "$db" "$@"
}
psql_admin() {
  docker exec -i -e PGPASSWORD="$admin_pass" "$container" \
    psql -v ON_ERROR_STOP=1 -U "$admin_user" -d "$db" "$@"
}
# Maintenance connection to the `postgres` database, for DROP/CREATE DATABASE.
psql_maint() {
  docker exec -i -e PGPASSWORD="$superpass" "$container" \
    psql -v ON_ERROR_STOP=1 -U "$superuser" -d postgres "$@"
}

cleanup() {
  local code=$?
  if [[ "$mode" == "ephemeral" && "$keep" -eq 0 ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Container up.
# ---------------------------------------------------------------------------
if [[ "$mode" == "ephemeral" ]]; then
  echo ">> Creating throwaway container: $container"
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker run -d --name "$container" \
    -e POSTGRES_USER="$superuser" \
    -e POSTGRES_PASSWORD="$superpass" \
    -e POSTGRES_DB="$db" \
    -p "127.0.0.1:${port}:5432" \
    "$image" >/dev/null
elif ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
  compose_file="$script_dir/docker-compose.wa-v2.yml"

  # docker-compose.wa-v2.yml is the declarative definition of this container, but
  # Compose is not installed everywhere (all three pre-existing Jale containers on
  # this box were made with plain `docker run`). The fallback below reproduces the
  # same container. Assert the two agree so they cannot silently drift.
  if [[ -f "$compose_file" ]]; then
    for literal in "container_name: $container" "image: $image" "127.0.0.1:${port}:5432" "POSTGRES_DB: $db"; do
      grep -qF "$literal" "$compose_file" || {
        echo "!! $(basename "$compose_file") disagrees with this script: expected '$literal'" >&2
        exit 1
      }
    done
  fi

  if docker compose version >/dev/null 2>&1; then
    echo ">> Starting $container via docker compose"
    docker compose -f "$compose_file" up -d
  elif docker-compose version >/dev/null 2>&1; then
    echo ">> Starting $container via docker-compose"
    docker-compose -f "$compose_file" up -d
  else
    echo ">> Compose unavailable; starting $container with docker run"
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker run -d --name "$container" \
      -e POSTGRES_USER="$superuser" \
      -e POSTGRES_PASSWORD="$superpass" \
      -e POSTGRES_DB="$db" \
      -p "127.0.0.1:${port}:5432" \
      -v jale-wa-v2-pgdata:/var/lib/postgresql/data \
      "$image" >/dev/null
  fi
fi

echo ">> Waiting for PostgreSQL readiness"
for _ in $(seq 1 60); do
  docker exec "$container" pg_isready -U "$superuser" -d "$db" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U "$superuser" -d "$db" >/dev/null 2>&1 \
  || { echo "PostgreSQL did not become ready." >&2; exit 1; }

# The emitted URL's user is a separate question from who APPLIES the migrations.
# Ownership fidelity comes from the apply step below (always jale_admin). The
# migrated suites then need a superuser to connect, because their fixtures insert
# into RLS-forced tables — see billing-rls.integration.test.ts:12-13, "The DB user
# in the URL must be a superuser (e.g. postgres) so the test can set role
# passwords and insert fixtures." The clean-apply gates do only DDL, so they run
# as jale_admin and stay faithful end to end.
if [[ -z "$url_user" ]]; then
  if [[ "$empty" -eq 1 ]]; then url_user="$admin_user"; else url_user="$superuser"; fi
fi
if [[ "$bare" -eq 1 && "$url_user" == "$admin_user" ]]; then
  echo "--bare creates no jale_admin role; use --url-user postgres" >&2; exit 2
fi
case "$url_user" in
  "$admin_user") url="postgres://${admin_user}:${admin_pass}@127.0.0.1:${port}/${db}" ;;
  "$superuser")  url="postgres://${superuser}:${superpass}@127.0.0.1:${port}/${db}" ;;
  *) echo "--url-user must be $admin_user or $superuser" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# 2. Short-circuit when already bootstrapped.
# ---------------------------------------------------------------------------
already=0
if psql_super -tAc "SELECT to_regclass('public.users') IS NOT NULL" 2>/dev/null | grep -qx t; then
  already=1
fi

if [[ ( "$bare" -eq 1 || "$empty" -eq 1 ) && "$already" -eq 1 ]]; then
  echo "!! --bare/--empty require a virgin cluster, but this one already has the chain applied." >&2
  echo "   Use --ephemeral (roles are cluster-wide, so a fresh database is not enough)." >&2
  exit 1
fi

if [[ "$bare" -eq 1 ]]; then
  echo ">> --bare: container and database only; no roles or extension created."
elif [[ "$already" -eq 1 && "$force" -eq 0 ]]; then
  echo ">> Already bootstrapped; skipping migration apply (use --force to re-run)."
else
  if [[ "$already" -eq 1 ]]; then
    # The chain is NOT idempotent across a full re-apply: 001's bare
    # CREATE TRIGGER users_updated_at raises 42710 on the second pass. So --force
    # recreates the database and drops the cluster-wide jale_* roles rather than
    # replaying over a populated one.
    echo ">> --force: dropping and recreating database $db and the jale_* roles"
    psql_maint <<SQL >/dev/null
DROP DATABASE IF EXISTS ${db} WITH (FORCE);
DO \$\$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'jale%' LOOP
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END
\$\$;
CREATE DATABASE ${db};
SQL
  fi

  # -------------------------------------------------------------------------
  # 3-4. Superuser prerequisites, then hand the database to a plain owner.
  # -------------------------------------------------------------------------
  echo ">> Preparing the non-superuser jale_admin owner"
  psql_super <<SQL >/dev/null
-- 008_worker_skills.sql:7 runs CREATE EXTENSION IF NOT EXISTS pg_trgm, which a
-- non-superuser cannot execute. Creating it here makes that statement a no-op.
-- It is the only extension in the chain (gen_random_uuid() is built into PG16).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${admin_user}') THEN
    -- Exactly the production ownership model. CREATEROLE is required because
    -- migrations 039/040/042 create helper roles and the DB suites ALTER ROLE
    -- ... PASSWORD. NOBYPASSRLS is the load-bearing attribute: it is what makes
    -- FORCE ROW LEVEL SECURITY observable.
    CREATE ROLE ${admin_user}
      LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      PASSWORD '${admin_pass}';
  ELSE
    ALTER ROLE ${admin_user} WITH PASSWORD '${admin_pass}';
  END IF;
END
\$\$;

ALTER DATABASE ${db} OWNER TO ${admin_user};
ALTER SCHEMA public OWNER TO ${admin_user};
SQL

  if [[ "$empty" -eq 1 ]]; then
    echo ">> --empty: owner prepared, migrations intentionally not applied."
  else

  # -------------------------------------------------------------------------
  # 5. Resolve the migration order and assert it has not drifted.
  #
  # scripts/run-migrations.sh's MIGRATIONS array is the canonical chain, and
  # apply-order.test.ts locks the same list. Both are authoritative; this script
  # adds no third ordering. The comparison uses LC_ALL=C so it matches JS
  # codepoint .sort() — a locale-aware sort places 020b BEFORE 020, which aborts
  # migration 023 with 42P17 (020b is the recursion-prevention migration).
  # -------------------------------------------------------------------------
  mapfile -t canonical < <(
    sed -n '/^MIGRATIONS=(/,/^)/p' "$repo/scripts/run-migrations.sh" \
      | grep -oE '"[0-9]+[a-z]?_[^"]+\.sql"' | tr -d '"'
  )
  [[ ${#canonical[@]} -gt 0 ]] || { echo "Could not parse MIGRATIONS from scripts/run-migrations.sh" >&2; exit 2; }

  mapfile -t on_disk < <(cd "$migrations" && ls -1 *.sql | LC_ALL=C sort)

  if [[ "${canonical[*]}" != "${on_disk[*]}" ]]; then
    echo "!! Migration order drift between scripts/run-migrations.sh and $migrations" >&2
    diff <(printf '%s\n' "${canonical[@]}") <(printf '%s\n' "${on_disk[@]}") >&2 || true
    exit 1
  fi

  files=("${canonical[@]/#/$migrations/}")

  # -------------------------------------------------------------------------
  # 6. Materialize ref-only migrations (042) without mutating the branch.
  #
  # 042 lives on feat/wa-v2-integration. The workflow branch is frozen — no
  # push, no merge, 042 not pulled in — so it is extracted to a temp dir instead
  # of being cherry-picked. `git status` stays clean.
  # -------------------------------------------------------------------------
  ref_dir=""
  if [[ "$ref" != "none" ]]; then
    # A bare branch name only resolves where that local branch exists. On a fresh
    # clone or in CI only origin/<ref> is present, so try the remote-tracking ref
    # too — otherwise the 042 environment would silently degrade to 041 and Tier B
    # would report N/A instead of failing.
    resolved=""
    for candidate in "$ref" "origin/$ref"; do
      if git -C "$repo" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
        resolved="$candidate"; break
      fi
    done

    if [[ -z "$resolved" ]]; then
      echo "!! Ref '$ref' not found locally or as origin/$ref." >&2
      echo "   Fetch it, or pass --ref none to deliberately stop at the local chain." >&2
      exit 1
    fi

    ref_dir="$(mktemp -d)"
    added=0
    mapfile -t ref_files < <(
      git -C "$repo" ls-tree --name-only "$resolved" -- infra/db/migrations/ \
        | grep -E '\.sql$' | xargs -r -n1 basename | LC_ALL=C sort
    )
    for f in "${ref_files[@]}"; do
      [[ -f "$migrations/$f" ]] && continue
      git -C "$repo" show "$resolved:infra/db/migrations/$f" > "$ref_dir/$f"
      files+=("$ref_dir/$f")
      echo ">> From ref $resolved: $f"
      added=$((added + 1))
    done
    [[ "$added" -eq 0 ]] && echo ">> Ref $resolved adds no migrations beyond the local chain."
  fi

  # -------------------------------------------------------------------------
  # 7. Apply every migration as jale_admin, in order, stopping on first error.
  # -------------------------------------------------------------------------
  echo ">> Applying ${#files[@]} migrations as $admin_user"
  for file in "${files[@]}"; do
    echo "   -> $(basename "$file")"
    psql_admin -f - < "$file" >/dev/null
  done

  [[ -n "$ref_dir" ]] && rm -rf "$ref_dir"

  # -------------------------------------------------------------------------
  # 8. Service-role login passwords the DB suites expect.
  # See infra/test/unit/db/billing-rls.integration.test.ts:40-52.
  # -------------------------------------------------------------------------
  echo ">> Setting service-role test passwords"
  psql_admin <<'SQL' >/dev/null
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('jale_billing',       'test-billing-pw'),
      ('jale_matching',      'test-matching-pw'),
      ('jale_whatsapp',      'test-whatsapp-pw'),
      ('jale_ai',            'test-ai-pw'),
      ('jale_admin_console', 'test-adminconsole-pw')
    ) AS t(role_name, pw)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', r.role_name, r.pw);
    END IF;
  END LOOP;
END
$$;
SQL
  fi
fi

echo ">> ${url_var}=$url"

# ---------------------------------------------------------------------------
# 9. Acceptance probes.
# ---------------------------------------------------------------------------
if [[ "$verify" -eq 1 ]]; then
  echo
  echo ">> Verifying the testbed"
  bash "$script_dir/verify-testbed.sh" --container "$container" --db "$db"
fi

# ---------------------------------------------------------------------------
# 10. Optional verification command, with the URL exported under $url_var
#     (billing-034-upgrade.test.ts reads JALE_TEST_UPGRADE_DATABASE_URL).
# ---------------------------------------------------------------------------

if [[ "$run_tests" -eq 1 && ${#custom_cmd[@]} -gt 0 ]]; then
  echo
  echo ">> Running verification command"
  (cd "$repo" && env "$url_var=$url" "${custom_cmd[@]}")
fi
