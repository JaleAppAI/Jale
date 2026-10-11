/**
 * policy-copies.ts -- the reviewed policy copies a test bed carries.
 *
 * Migration 106 copies some existing policies for the dedicated logins
 * (`<policy>__api` for jale_api, `<policy>__dg` for jale_job_digest). A suite
 * that asserts a table's exact policy set expects the table's own policies
 * plus exactly these copies, so the copies come from the one list the
 * generator writes them from (generate.ts policyCopies over manifest.json),
 * never from a second, hand-written list.
 *
 * Whether the bed carries 106 is read from its migration ledger
 * (public.schema_migrations, which bootstrap-testbed.sh records as it applies
 * the chain), never from the catalog: a copy that should exist but does not
 * must fail the suite, not shrink what it expects. A bed with no ledger at all
 * predates the ledger and is refused; recreate it.
 */
import type { ClientBase } from 'pg';
import { baseManifest, MIGRATION_106, policyCopies } from '../../../../db/access/generate';

export interface ReviewedPolicyCopy {
  /** The copy's name, as pg_policies.policyname shows it. */
  policyname: string;
  /** pg_policies.cmd: ALL, SELECT, INSERT, UPDATE or DELETE. */
  cmd: string;
  /** pg_policies.roles: the one dedicated login the copy applies to. */
  roles: string[];
  /** The table's own policy it copies. */
  copyOf: string;
}

/** Whether the bed's migration ledger records `file`. Throws when the bed has no ledger. */
export async function ledgerRecords(client: ClientBase, file: string): Promise<boolean> {
  const ledger = await client.query<{ present: boolean }>(
    `SELECT pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (!ledger.rows[0].present) {
    throw new Error(
      'this test bed has no migration ledger (public.schema_migrations): it predates the ledger; '
      + 'recreate it with infra/db/local/bootstrap-testbed.sh',
    );
  }
  const recorded = await client.query<{ recorded: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE filename = $1) AS recorded',
    [file],
  );
  return recorded.rows[0].recorded;
}

/**
 * The reviewed copies migration 106 adds to `table` (schema-qualified, e.g.
 * `public.users`), in name order; none when the ledger does not record 106.
 */
export async function reviewedPolicyCopies(client: ClientBase, table: string): Promise<ReviewedPolicyCopy[]> {
  if (!table.includes('.')) throw new Error(`reviewedPolicyCopies: name the table with its schema, e.g. public.${table}`);
  if (!(await ledgerRecords(client, MIGRATION_106.file))) return [];
  return policyCopies(baseManifest())
    .filter((copy) => copy.table === table)
    .map((copy) => ({ policyname: copy.name, cmd: copy.command, roles: [...copy.to], copyOf: copy.copyOf }))
    .sort((a, b) => (a.policyname < b.policyname ? -1 : a.policyname > b.policyname ? 1 : 0));
}

/** The policy names a table carries on this bed: its own `sources` plus its reviewed copies, sorted. */
export async function expectedPolicyNames(client: ClientBase, table: string, sources: readonly string[]): Promise<string[]> {
  const copies = await reviewedPolicyCopies(client, table);
  return [...sources, ...copies.map((copy) => copy.policyname)].sort();
}
