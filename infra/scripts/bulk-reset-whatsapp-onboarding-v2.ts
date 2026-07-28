/**
 * Operator CLI: bulk WhatsApp v2 onboarding reset (cutover tool).
 *
 * At the v2 cutover, every worker's onboarding state is reset so everyone
 * re-enters onboarding v2 cleanly through the same path a brand-new worker
 * takes: language -> OTP -> bind creates the workflow run at 'legal.review'
 * (bind_verified_identity_and_start_workflow, migration 047). This script is
 * the bulk counterpart to `reset-whatsapp-onboarding-v2.ts`, which
 * deliberately resets exactly one worker (`--user-id` + `--phone`, both
 * required, no bulk mode). This script does NOT reimplement any of that
 * script's reset logic: it discovers the population to reset, then calls
 * its exported `runReset` ONCE PER WORKER, so every worker keeps the exact
 * single-tool semantics — its own BEGIN/COMMIT, its own id+phone
 * re-verification against the current `users` row (so a worker deleted or
 * changed mid-run is simply skipped/failed, never silently mismatched), its
 * own single `worker_reset_audit` row, its own re-seeded
 * `worker_onboarding_state` row at 'onboarding', and NO seeded
 * `worker_workflow_runs` row (see the seed-site comment in the reset script
 * for the softlock an earlier seeded-run version caused). Because each
 * worker is reset in its own transaction, a run that stops partway through
 * (crash, timeout, operator abort) leaves every already-reset worker fully
 * done and every not-yet-reached worker fully untouched — safe to simply
 * re-run with the same flags; already-reset workers are re-verified and
 * reset again harmlessly (the reset script itself is idempotent, per its
 * own "running --execute twice" test).
 *
 * Discovery query (run once, as the operator/admin connection, before any
 * worker is touched):
 *
 *   SELECT id, whatsapp_number FROM users
 *    WHERE user_type = 'worker' AND whatsapp_number IS NOT NULL
 *    ORDER BY id
 *
 * Two adjacent populations are DELIBERATELY out of scope, not overlooked:
 *
 *   1. Workers with a NULL whatsapp_number. These have never linked
 *      WhatsApp, so there is no onboarding/profile/trust state for v2 to
 *      collide with. They self-heal for free: the v2 pre-auth lane
 *      (start.choose_language / identity.verify_otp) runs off
 *      worker_identity_challenges keyed by phone_hash, and
 *      bind_verified_identity_and_start_workflow (migration 047) accepts a
 *      `candidateUserId` at OTP verification time to bind a brand-new or
 *      not-yet-linked user — there is nothing here for a reset to do.
 *
 *   2. Orphan, unbound `whatsapp_conversations` rows (user_id IS NULL —
 *      inbound messages from a number that never completed a bind).
 *      Onboarding v2 never reads `conversation_state` off these rows; the
 *      pre-auth lane's state lives in worker_identity_challenges, and the
 *      bound lane's state lives in worker_workflow_runs. An orphan
 *      conversation row is inert with respect to v2 and resetting it would
 *      touch a table the v2 flow never consults.
 *
 * Never prints or logs a raw phone number anywhere. Per-worker output is
 * limited to the user id and its per-table delete/update counts (as the
 * underlying `runReset` already prints); this script additionally prints
 * only aggregate per-table totals and the total worker count at the end.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/bulk-reset-whatsapp-onboarding-v2.ts \
 *     --reason "<why>" --dry-run|--execute [--limit <n>]
 *
 * `--limit <n>` processes only the first n discovered workers (ordered by
 * id) — useful for a canary batch before the full cutover run.
 *
 * Failure policy (--execute only): a per-worker failure (e.g. the id+phone
 * pair no longer matches, or a query throws) is logged with the user id and
 * error message, and the run CONTINUES with the remaining workers — a
 * failed worker never blocks or rolls back any other worker's transaction.
 * The process exits non-zero at the end if any worker failed, printing a
 * failed-worker summary (ids + error messages).
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import {
  runReset,
  resolveOperator,
  type Queryable,
  type ResetOutcome,
} from './reset-whatsapp-onboarding-v2';

export type { Queryable };

export const DISCOVERY_QUERY = `
  SELECT id, whatsapp_number FROM users
   WHERE user_type = 'worker' AND whatsapp_number IS NOT NULL
   ORDER BY id
`;

export interface DiscoveredWorker {
  id: string;
  whatsappNumber: string;
}

/**
 * Runs the discovery query. Never logs the returned rows (they carry raw
 * phone numbers) — callers must only surface `id` fields downstream.
 */
export async function discoverWorkers(client: Queryable): Promise<DiscoveredWorker[]> {
  const result = await client.query(DISCOVERY_QUERY);
  return result.rows.map((row) => ({
    id: row.id as string,
    whatsappNumber: row.whatsapp_number as string,
  }));
}

export interface BulkResetArgs {
  reason: string;
  dryRun: boolean;
  limit?: number;
}

export type ParseBulkResetArgsResult =
  | { ok: true; value: BulkResetArgs }
  | { ok: false; error: string };

/**
 * Parses and strictly validates argv for the bulk reset CLI. Modeled
 * directly on `parseResetArgs` in the single-target script: unknown flags
 * are rejected, a bare (non `--`) argument is never echoed back (it could
 * be a raw phone number), and every flag is capped at exactly one
 * occurrence. There is deliberately no `--user-id` / `--phone` flag — this
 * script always operates over the full discovered population (optionally
 * capped by `--limit`).
 */
export function parseBulkResetArgs(argv: string[]): ParseBulkResetArgsResult {
  const known = new Set(['--reason', '--dry-run', '--execute', '--limit']);

  const collected: Record<string, string[]> = {
    '--reason': [],
    '--limit': [],
  };
  let dryRunFlag = false;
  let executeFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!known.has(flag)) {
      return {
        ok: false,
        error: flag.startsWith('--')
          ? `Unrecognized flag: ${flag}`
          : 'Unrecognized argument (redacted)',
      };
    }
    if (flag === '--dry-run') {
      dryRunFlag = true;
      continue;
    }
    if (flag === '--execute') {
      executeFlag = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `Missing value for flag: ${flag}` };
    }
    collected[flag].push(value);
    i += 1;
  }

  if (collected['--reason'].length === 0) {
    return { ok: false, error: 'Missing required flag: --reason' };
  }
  if (collected['--reason'].length > 1) {
    return { ok: false, error: '--reason may only be supplied once' };
  }
  if (collected['--limit'].length > 1) {
    return { ok: false, error: '--limit may only be supplied once' };
  }

  const reason = collected['--reason'][0].trim();
  if (reason.length === 0) {
    return { ok: false, error: '--reason must not be empty' };
  }

  if (dryRunFlag === executeFlag) {
    return {
      ok: false,
      error: 'Exactly one of --dry-run or --execute is required',
    };
  }

  let limit: number | undefined;
  if (collected['--limit'].length === 1) {
    const raw = collected['--limit'][0].trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      return { ok: false, error: '--limit must be a positive integer' };
    }
    limit = Number(raw);
  }

  return { ok: true, value: { reason, dryRun: dryRunFlag, limit } };
}

export interface BulkWorkerFailure {
  userId: string;
  error: string;
}

export interface BulkResetSummary {
  dryRun: boolean;
  totalWorkers: number;
  succeeded: number;
  failed: BulkWorkerFailure[];
  aggregateTableCounts: Record<string, number>;
}

/**
 * Discovers the worker population, then calls `runReset` once per worker,
 * exactly as if the single-target CLI had been invoked for each of them in
 * turn. A per-worker failure is caught, recorded, and logged (id + message
 * only — never the phone), and the loop continues; it never aborts the
 * batch and never rolls back a sibling worker's already-committed
 * transaction (each worker's BEGIN/COMMIT is fully self-contained inside
 * `runReset`).
 */
export async function runBulkReset(
  client: Queryable,
  args: BulkResetArgs & { operator: string },
): Promise<BulkResetSummary> {
  const discovered = await discoverWorkers(client);
  const workers = args.limit !== undefined ? discovered.slice(0, args.limit) : discovered;

  const aggregateTableCounts: Record<string, number> = {};
  const failed: BulkWorkerFailure[] = [];
  let succeeded = 0;

  for (const worker of workers) {
    try {
      const outcome: ResetOutcome = await runReset(client, {
        userId: worker.id,
        phone: worker.whatsappNumber,
        reason: args.reason,
        dryRun: args.dryRun,
        operator: args.operator,
      });

      succeeded += 1;
      for (const [table, count] of Object.entries(outcome.tableCounts)) {
        aggregateTableCounts[table] = (aggregateTableCounts[table] ?? 0) + count;
      }
      console.log(`[worker ${worker.id}] ${args.dryRun ? 'dry-run ok' : 'reset ok'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ userId: worker.id, error: message });
      console.error(`[worker ${worker.id}] failed: ${message}`);
    }
  }

  return {
    dryRun: args.dryRun,
    totalWorkers: workers.length,
    succeeded,
    failed,
    aggregateTableCounts,
  };
}

/** 0 when every worker in the summary succeeded, 1 if any failed. */
export function exitCodeForSummary(summary: BulkResetSummary): number {
  return summary.failed.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseBulkResetArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ca: fs.readFileSync(
              path.join(__dirname, '../lambda/lib/rds-ca-bundle.pem'),
              'utf-8',
            ),
          }
        : false,
  });

  await client.connect();
  try {
    const summary = await runBulkReset(client, {
      ...parsed.value,
      operator: resolveOperator(),
    });

    console.log(`Total workers processed: ${summary.totalWorkers}`);
    console.log('Aggregate per-table counts:');
    console.log(JSON.stringify(summary.aggregateTableCounts, null, 2));

    if (summary.dryRun) {
      console.log('Dry run complete. No changes were made.');
    } else {
      console.log(
        `Execute complete. Succeeded: ${summary.succeeded}. Failed: ${summary.failed.length}.`,
      );
    }

    if (summary.failed.length > 0) {
      console.error('Failed workers:');
      for (const failure of summary.failed) {
        console.error(`  ${failure.userId}: ${failure.error}`);
      }
    }

    process.exitCode = exitCodeForSummary(summary);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
