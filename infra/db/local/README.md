# Local PostgreSQL testbed — WhatsApp v2

Disposable PostgreSQL 16 for the WhatsApp v2 database work. Replaces the out-of-repo
`~/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh` that the sprint plans
reference.

**Never point any of this at RDS.** Every published port binds to `127.0.0.1` only.

---

## Why this exists

The old wrapper had two defects.

**It was not in the repository.** It lived in one machine's `~/.codex/skills/`, yet every gate
command in the sprint plans depends on it.

**It applied migrations as the `postgres` superuser.** Every migration header says
`-- Connect as: jale_admin (NOT the RDS master user)`, and this is not cosmetic:

- Migration 042 puts `FORCE ROW LEVEL SECURITY` on all eight new tables and then adds explicit
  `_definer` policies **`TO jale_admin`** (`042:159`, `217-225`) — needed only because the owner is
  *not* exempt under FORCE RLS. A superuser has `rolbypassrls = t` and skips all of it.
- `042:496`/`042:649` grant, then surrender, `jale_twilio_callback` membership around the callback
  re-creation. That round-trip only reproduces production when `current_user` is the same
  `jale_admin` that created the role in migration 040.
- `whatsapp-delivery-040.integration.test.ts:50-58` requires the chain applied "as that same
  non-superuser role. No ownership rewrites, no RLS bypass, no `ALTER TABLE ... OWNER TO`
  shortcuts."

Concretely: `SELECT count(*) FROM worker_identity_challenges` raises
`permission denied for table worker_identity_challenges` for `jale_whatsapp` here, and returns a
result set under a superuser bootstrap. Pre-auth rows are meant to be reachable only through the
`SECURITY DEFINER` functions. **A superuser testbed cannot detect a regression in that boundary.**

---

## Ownership vs. connection — the thing to get right

These are two separate questions:

| Question | Answer |
| --- | --- |
| Who **applies** the migrations? | Always `jale_admin`, a plain `NOSUPERUSER … NOBYPASSRLS` role. This is what makes the testbed faithful. |
| Who **connects** during tests? | Depends on the suite. |

The migrated suites need a **superuser** URL because their fixtures insert into RLS-forced tables —
`billing-rls.integration.test.ts:12-13`: *"The DB user in the URL must be a superuser (e.g.
`postgres`) so the test can set role passwords and insert fixtures."* Using a `jale_admin` URL there
fails with `new row violates row-level security policy for table "users"`.

Fidelity comes from the apply step, not the connection string.

---

## Three gates

The DB suites have mutually exclusive database requirements, so they run as three commands. Roles in
PostgreSQL are **cluster-wide**, so "a fresh database" is not enough for the clean-apply gates —
they need their own container.

| Gate | Database | Why |
| --- | --- | --- |
| 1. Migrated suites | persistent, chain applied | Assert behavior against the finished schema |
| 2. Clean apply | virgin cluster **with** `jale_admin` | `apply-order.test.ts:496` applies the chain itself, as `jale_admin` |
| 3. 034 upgrade path | virgin cluster **without** `jale_admin` | `billing-034-upgrade.test.ts:129-139` creates `jale_admin` itself, deliberately as a non-executor GRANT target |

### Gate 1 — migrated suites

```bash
cd infra/db/local
./bootstrap-testbed.sh --verify
export JALE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55442/jale
cd ../.. && npx jest test/unit/db --runInBand \
  --testPathIgnorePatterns 'apply-order|billing-034-upgrade'
```

Expected: `8 passed, 8 total` / `73 passed`, and **no `CONCERN:` lines**.

> A green run that still prints `CONCERN: migration 039/040 PostgreSQL gate was not run` means the
> env var never reached jest — the suites skipped. That is a failure, not a pass. Without the
> variable this command reports 47 skipped tests and 23 CONCERN/SKIPPED lines.

### Gate 2 — clean apply

```bash
./bootstrap-testbed.sh --ephemeral --empty --repo ../../.. \
  -- bash -lc 'cd infra && npx jest test/unit/db/migrations/apply-order --runInBand'
```

Expected: `25 passed, 1 skipped`. The skip is the ARCHITECTURE.md content check —
`docs/` is local-only and untracked.

### Gate 3 — migration 034 upgrade path

```bash
./bootstrap-testbed.sh --ephemeral --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL --repo ../../.. \
  -- bash -lc 'cd infra && npx jest test/unit/db/migrations/billing-034-upgrade --runInBand'
```

Expected: `14 passed`.

---

### If you are following a sprint plan's gate command

The plans (C3 Step 4, C9 Steps 2/4, C10 Step 3, and the Claude lane's Bootstrap Barrier) bundle
`apply-order.test.ts` **together with** the migrated suites in a single
`-- npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts …` call.

**That command cannot pass against any testbed.** `apply-order.test.ts:496` applies the chain itself
and needs an empty database; the suites next to it need a migrated one. Run the three gates above
instead — they cover the same ground and each gets the database it actually requires.

## Acceptance probes

`./bootstrap-testbed.sh --verify` (or `./verify-testbed.sh` directly) runs 14 probes.

**Tier A** proves the production ownership model: chain applied, `jale_admin` is a plain
non-superuser owner without `BYPASSRLS`, `public` schema owned by it, and it can no longer
`SET ROLE jale_twilio_callback`.

**Tier B** proves the environment can host the 042 suites — the eight tables, RLS enabled *and*
forced on all of them, the four named constraints, the four `SECURITY DEFINER` functions owned by
`jale_admin` with catalog-only `search_path` and no `PUBLIC` execute, the callback still owned by
`jale_twilio_callback`, column-scoped grants only, both runtime controls seeded disabled, and the
`worker_identity_challenges` denial above.

Tier B reports `N/A` instead of failing when 042 is absent, so `--ref none` still works.

These probes deliberately **do not** duplicate
`whatsapp-onboarding-042.integration.test.ts` (Codex C3) or
`whatsapp-onboarding-concurrency.integration.test.ts` (Codex C9). They prove the environment; those
suites prove the behavior.

The probes are mutation-verified — granting `PUBLIC` execute on `load_worker_pre_auth`, setting
`NO FORCE ROW LEVEL SECURITY`, or adding a bare table grant on `worker_identity_challenges` each
produce a clean `FAIL` on the corresponding probe.

---

## Migration 042 and the branch freeze

042 lives on `feat/wa-v2-integration`; the workflow branch stops at 041. The lane handoff freezes
this branch — no push, no merge, 042 not pulled in — so `bootstrap-testbed.sh` extracts 042 with
`git show <ref>:infra/db/migrations/042_…` into a temp dir rather than cherry-picking it.
**`git status` stays clean.** Use `--ref none` to stop at 041.

## Migration order

The order comes from the `MIGRATIONS` array in `scripts/run-migrations.sh`, asserted against a
`LC_ALL=C` sort of the migrations directory. The script fails loudly on drift.

`LC_ALL=C` is load-bearing: a locale-aware sort ignores punctuation and places `020b` **before**
`020`, which aborts migration 023 with `42P17 infinite recursion detected in policy for relation
"users"` — `020b` is the recursion-prevention migration. `apply-order.test.ts` uses JS codepoint
`.sort()`, which matches `LC_ALL=C`.

## Compose

`docker-compose.wa-v2.yml` is the declarative definition. Compose is not installed on every machine
(all three pre-existing Jale containers were made with plain `docker run`), so the script falls back
to `docker run` and asserts the compose file agrees with it on name, image, port, and database —
drift is a hard error, not a silent divergence.

## Reset

```bash
docker rm -f jale-wa-v2-pg && docker volume rm jale-wa-v2-pgdata
```

`--force` drops and recreates the database and the cluster-wide `jale_*` roles, then re-applies. It
does **not** replay migrations over a populated database — the chain is not idempotent across a full
re-apply (migration 001's bare `CREATE TRIGGER users_updated_at` raises `42710` on the second pass).

## Ports

`55442` persistent, `55443` ephemeral. Chosen to avoid the existing `jale-billing-pg` (55432),
`jale-w2-native-pg` (55433), and `jale-release-pg` (55439).
