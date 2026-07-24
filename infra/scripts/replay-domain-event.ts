/**
 * Operator CLI: exact-ID replay of a `worker_domain_outbox` domain event
 * (O3 — Design D3, binding interpretation recorded in the Lane C sprint
 * plan). `worker_domain_outbox` is the only DB record that retains the
 * original event payload (`payload` jsonb) together with an idempotency key
 * (`event_key`, UNIQUE) and a processing status lifecycle
 * (pending|processing|completed|failed) — see
 * docs/superpowers/plans/2026-07-23-wa-v2-lane-c-sprint-completion.md.
 *
 * This tool NEVER fabricates a new `event_key` or `payload`: replay always
 * resets the SAME row back to `pending` so the existing scheduled drain
 * (Lane C2-owned `domain-outbox-drain.ts`, never touched here) re-leases and
 * reprocesses it exactly as it would any other pending event.
 *
 * Safety:
 *   - Exactly one id (a `worker_domain_outbox.id` uuid OR an `event_key`
 *     string) is accepted per invocation. Wildcards, comma lists, ranges,
 *     and any bulk/all flag are rejected before any DB connection is made.
 *   - `--execute` is required to mutate anything; omitting it is a dry run
 *     that prints the state and the would-be change without touching the
 *     database.
 *   - State is always printed BEFORE any mutation is attempted. The payload
 *     is NEVER printed raw — only a redacted summary of key names and
 *     JS value types. Raw phone numbers, OTP codes, message bodies, DB
 *     URLs, and any other secret are never logged by this tool.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/replay-domain-event.ts <id>              # dry run
 *   npx ts-node scripts/replay-domain-event.ts <id> --execute     # replay
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export type ReplayArgsAction = { kind: 'replay'; identifier: string; execute: boolean };

export type ParseReplayArgsResult =
  | { ok: true; value: ReplayArgsAction }
  | { ok: false; error: string };

const KNOWN_FLAGS = new Set(['--execute']);
// Anything resembling a request to act on more than one row is rejected
// outright — this tool only ever touches exactly one row.
const BULK_FLAGS = new Set(['--all', '--bulk', '-a', '--force-all', '--everything']);
const WILDCARD_CHARS = /[*%?[\]]/;

/**
 * Parses and strictly validates argv for the replay CLI. Never opens a DB
 * connection. Accepts exactly one positional id and an optional `--execute`
 * flag. A bare non-`--` positional is never echoed back in an error message
 * (it may be sensitive), matching the redaction style used by
 * whatsapp-runtime-controls.ts.
 */
export function parseReplayArgs(argv: string[]): ParseReplayArgsResult {
  let execute = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (BULK_FLAGS.has(arg)) {
      return { ok: false, error: `Bulk/all operations are not supported: ${arg}` };
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg.startsWith('--')) {
      return { ok: false, error: `Unrecognized flag: ${arg}` };
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    return { ok: false, error: 'Missing required id (a worker_domain_outbox.id uuid or event_key)' };
  }
  if (positionals.length > 1) {
    return { ok: false, error: 'Exactly one id is required per invocation (redacted)' };
  }

  const raw = positionals[0];

  if (raw.trim().length === 0) {
    return { ok: false, error: 'Id must not be empty' };
  }
  if (raw.includes(',')) {
    return { ok: false, error: 'Comma-separated id lists are not supported (redacted)' };
  }
  if (raw.includes('..')) {
    return { ok: false, error: 'Id ranges are not supported (redacted)' };
  }
  if (WILDCARD_CHARS.test(raw)) {
    return { ok: false, error: 'Wildcard/glob characters are not supported in id (redacted)' };
  }

  return { ok: true, value: { kind: 'replay', identifier: raw.trim(), execute } };
}

export type ReplayResultKind =
  | 'not_found'
  | 'ambiguous_id'
  | 'already_completed'
  | 'event_in_flight'
  | 'dry_run'
  | 'executed';

export interface ReplayResult {
  kind: ReplayResultKind;
}

export interface ReplayDomainEventOptions {
  now?: () => Date;
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  event_key: string;
  payload: unknown;
  status: string;
  attempts: number;
  next_attempt_at: string | Date | null;
  last_error: string | null;
  leased_until: string | Date | null;
  lease_token: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Redacts a payload down to `{ key: jsTypeOfValue }` — never the raw value. */
function redactedPayloadSummary(payload: unknown): Record<string, string> {
  if (payload === null || typeof payload !== 'object') {
    return { '(value)': payload === null ? 'null' : typeof payload };
  }
  if (Array.isArray(payload)) {
    return { '(value)': 'array' };
  }
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    summary[key] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  }
  return summary;
}

function printState(row: OutboxRow, lifecycle: string | null, intentCounts: Record<string, number>): void {
  console.log('--- worker_domain_outbox state (pre-mutation) ---');
  console.log('event_type:', row.event_type);
  console.log('status:', row.status);
  console.log('attempts:', row.attempts);
  console.log('aggregate_id:', row.aggregate_id);
  console.log('created_at:', row.created_at);
  console.log('last_error present:', Boolean(row.last_error));
  console.log('payload summary (keys/types only):', JSON.stringify(redactedPayloadSummary(row.payload)));
  console.log('worker lifecycle:', lifecycle ?? 'unknown');
  console.log('deferred intents:', intentCounts.deferred ?? 0);
  console.log('released intents:', intentCounts.released ?? 0);
  console.log('--------------------------------------------------');
}

/**
 * Resolves the identifier against both `id` and `event_key`, prints the
 * pre-mutation state, and — on `--execute` — replays a pending/failed/
 * expired-lease event by resetting it to `pending` while reusing the SAME
 * `event_key` and `payload` (never fabricated). `completed` is a safe
 * no-op. An unexpired `processing` lease is rejected as `event_in_flight`.
 * Mutates nothing outside `worker_domain_outbox`, and nothing at all unless
 * `execute` is true and the event is actually replayable.
 */
export async function replayDomainEvent(
  client: Queryable,
  identifier: string,
  execute: boolean,
  options: ReplayDomainEventOptions = {},
): Promise<ReplayResult> {
  const now = options.now ?? (() => new Date());

  const lookup = await client.query(
    `SELECT id, event_type, aggregate_id, event_key, payload, status, attempts,
            next_attempt_at, last_error, leased_until, lease_token, created_at, updated_at
       FROM worker_domain_outbox
      WHERE id::text = $1 OR event_key = $1`,
    [identifier],
  );

  const rows = lookup.rows as unknown as OutboxRow[];

  if (rows.length === 0) {
    console.error('event_not_found');
    return { kind: 'not_found' };
  }
  if (rows.length > 1) {
    console.error('ambiguous_id: the supplied id matches two different worker_domain_outbox rows');
    return { kind: 'ambiguous_id' };
  }

  const row = rows[0];

  const [gateResult, intentsResult] = await Promise.all([
    client.query(`SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`, [row.aggregate_id]),
    client.query(
      `SELECT status, count(*)::int AS count
         FROM worker_message_intents
        WHERE user_id = $1 AND status IN ('deferred', 'released')
        GROUP BY status`,
      [row.aggregate_id],
    ),
  ]);

  const lifecycle = (gateResult.rows[0]?.lifecycle as string | undefined) ?? null;
  const intentCounts: Record<string, number> = {};
  for (const r of intentsResult.rows) {
    intentCounts[r.status as string] = Number(r.count);
  }

  printState(row, lifecycle, intentCounts);

  if (row.status === 'completed') {
    console.log('already successful — no-op, nothing mutated');
    return { kind: 'already_completed' };
  }

  if (row.status === 'processing') {
    const leasedUntil = row.leased_until ? new Date(row.leased_until) : null;
    const leaseUnexpired = leasedUntil !== null && leasedUntil.getTime() > now().getTime();
    if (leaseUnexpired) {
      console.error('event_in_flight: event is currently leased and the lease has not expired');
      return { kind: 'event_in_flight' };
    }
    // Expired lease: falls through to the replayable branch below.
  }

  // Replayable: pending, failed, or processing with an expired lease.
  if (!execute) {
    console.log(
      `DRY RUN: would reset worker_domain_outbox.id=${row.id} to status='pending', ` +
        `leased_until=NULL, lease_token=NULL, next_attempt_at=now(). Pass --execute to apply.`,
    );
    return { kind: 'dry_run' };
  }

  await client.query(
    `UPDATE worker_domain_outbox
        SET status = 'pending',
            leased_until = NULL,
            lease_token = NULL,
            next_attempt_at = $2
      WHERE id = $1`,
    [row.id, now()],
  );
  console.log(`Replayed: worker_domain_outbox.id=${row.id} reset to pending (event_key unchanged).`);
  return { kind: 'executed' };
}

function resolveExitCode(result: ReplayResult): number {
  switch (result.kind) {
    case 'not_found':
    case 'ambiguous_id':
    case 'event_in_flight':
      return 1;
    default:
      return 0;
  }
}

async function main(): Promise<void> {
  const parsed = parseReplayArgs(process.argv.slice(2));
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
    const result = await replayDomainEvent(client, parsed.value.identifier, parsed.value.execute);
    process.exitCode = resolveExitCode(result);
  } catch (err) {
    console.error('replay-domain-event failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
