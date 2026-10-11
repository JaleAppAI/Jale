# Database access manifest

`manifest.json` is the reviewed source of truth for which database login may
reach which object. `access-manifest.ts` loads and validates it; the coverage
guard, the posture check and the access-rights generator all read it through
that loader.

- **New objects go in a fragment.** A change that adds tables, functions,
  logins or roles puts them in its own `manifest.d/<name>.json` instead of
  editing `manifest.json`. A fragment has the same top-level sections and only
  adds entries: a key that already exists in `manifest.json` or in another
  fragment is a hard error. Fragments merge in filename order. A fragment's
  own `policies` are on tables it defines itself.
- **Rights on another file's objects go in an additions section** of the
  fragment, each entry with its own `reason`: `table_additions` (new grantees
  in `access`, new policy names in `policies`, at most one `owner` for a
  master-owned table), `function_additions` (`execute`), `schema_additions`
  (`usage`, `create`) and `sequence_additions` (`usage`, `select`, `update`).
  An existing grantee or policy name, any other field, runtime-login access to
  an excluded table, or a target nobody defines is a hard error. The merged
  manifest has the additions folded in.
- **Test-bed passwords follow the merged `logins`.** Step 8 of
  `infra/db/local/bootstrap-testbed.sh` gives every login, fragments included,
  its `test-<name>-pw` password, so a new login needs no script edit.
- **`runner_managed: true`** marks a table the migration tooling creates, not a
  migration: the ledger, which `scripts/run-migrations.sh` keeps on the
  databases it manages and `bootstrap-testbed.sh` records on every bed it
  applies the chain to. It may be absent from a database migrated by hand.
- **Reviewed policy copies** (`origin: "copy"`) come from one list:
  `policyCopies()` in `generate.ts`. Migration 106 is generated from it, and
  the DB suites that assert a table's exact policy set read it through
  `infra/test/unit/db/helpers/policy-copies.ts`, keyed on the bed's ledger.
- **Recorded policy expressions.** Every new policy, every copy source and
  every capability owner's policy records `using` and `with_check` exactly
  as `pg_get_expr()` shows them with `search_path = public` on PostgreSQL 16
  (`snapshot.ts` reads them that way from a bed with every migration
  applied). The coverage guard and the posture check compare them byte for
  byte, and a copy with its source, so a policy and its copies cannot change
  together unnoticed. `parseManifest` refuses a copy source or a capability
  owner's policy without them.
- **Logins that need a secret** carry `"prepare_secret": true`. Credential
  preparation and the ops host's secret access read exactly that set.
- **`manifestDigest()`** identifies a merged manifest, so a posture report says
  which manifest it was checked against.
- **`SIGNATURES.md`** documents the `jale_cap` capability functions for the code
  that calls them.
- **Regenerating the access-rights migration (106).** `generate.ts` writes
  `infra/db/migrations/106_least_privilege_access_rights.sql` from
  `manifest.json` alone (never a fragment) and `catalog-snapshot.json`, a
  catalog read of a test bed with every migration up to 105 applied:

  ```
  # 1. an empty bed (the owner role only), then the chain up to and
  #    including 105 applied as jale_admin, in scripts/run-migrations.sh order
  bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --empty --ref none \
    --container <name> --port <port> --no-tests
  for f in <001 ... 105 from the MIGRATIONS array>; do
    docker exec -i -e PGPASSWORD=test-admin-pw <name> \
      psql -h 127.0.0.1 -U jale_admin -d jale -v ON_ERROR_STOP=1 -q -f - < infra/db/migrations/$f
  done
  # 2. from infra/: snapshot it, then regenerate
  JALE_TEST_DATABASE_URL=postgres://postgres:<superuser password>@127.0.0.1:<port>/jale \
    npx tsx db/access/snapshot.ts --out db/access/catalog-snapshot.json
  npx tsx db/access/generate.ts            # writes 106
  npx tsx db/access/generate.ts --check    # exits 1 if 106 differs
  ```

  The snapshot must not include 106 itself: its copies would collide with
  the names the generator writes.

  `generate.test.ts` fails whenever the committed 106 differs from what the
  generator writes. 106 is applied once in production: a change to rights it
  already granted belongs in a new migration, not a regenerated 106.
