/**
 * Operator CLI: re-queue trust assessments that have no
 * `worker_trust_extractions` row for a given `extractor_version` (R1-X).
 *
 * The extractor's table is keyed UNIQUE on `(assessment_id,
 * extractor_version)`, so bumping `EXTRACTOR_VERSION` in
 * `lambda/ai/trust-extractor.ts` does not overwrite history — it simply leaves
 * every existing assessment without a row at the NEW version. This tool is how
 * that backlog gets filled: it finds those assessments and sends each one the
 * same `{ assessmentId, userId, professionKey }` payload the drain fans out,
 * onto the same TrustExtractor queue. It is also the recovery path after a
 * prolonged extractor outage, where the fan-out messages were lost.
 *
 * It picks up three kinds of row: assessments with NO extraction row at this
 * version (a version bump), and rows left `failed` (the DLQ case) or orphaned
 * in `pending` (a recovery sweep that reset rows and then failed to send).
 * The extractor's claim accepts `status IN ('pending','failed')`, so all three
 * are re-claimable; anything `extracting` or `completed` is deliberately left
 * alone.
 *
 * This tool never calls Bedrock, never writes `worker_trust_extractions`, and
 * never touches `worker_trust_assessments` or `users`. Everything downstream
 * of the SQS send is the extractor's own idempotent claim.
 *
 * CONNECTION ROLE — this matters more than it looks. `worker_trust_assessments`
 * (012) and `worker_trust_extractions` (086) are both FORCE RLS, and
 * jale_admin's policies on them are GUC-gated (own-row / employer
 * relationship). A bastion run as jale_admin sets neither GUC, so the backlog
 * query returns ZERO rows and the tool exits 0 reporting "nothing to
 * re-extract" — a silent no-op indistinguishable from success. jale_ai is the
 * only role with a `USING(true)` SELECT on both tables, so it is the default
 * and the tool refuses to run as anything else unless `--allow-role` says so.
 *
 * Safety (mirrors scripts/redrive-billing-dlq.ts and replay-domain-event.ts):
 *   - Dry run is the default. `--execute` is required to send anything.
 *   - Strict flag validation happens before any DB or AWS call: unknown flags,
 *     duplicated flags, missing values, `--flag=value` forms, extra
 *     positionals, and any bulk/all flag are rejected up front.
 *   - The output is COUNTS and assessment UUIDs only. Worker answers are
 *     never selected into the result set at all, so there is no code path on
 *     which an answer could be printed.
 *   - Queue URLs embed the AWS account id and are never printed; AWS failures
 *     surface the error's `name` only.
 *   - `--execute` is refused when TRUST_EXTRACTION_QUEUE_URL is unset, before
 *     the DB is touched.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_ai DB_PASSWORD=<pw> \
 *   AWS_REGION=us-east-2 TRUST_EXTRACTION_QUEUE_URL=<url> \
 *     npm run reextract:trust -- --extractor-version v1                 # dry run
 *   … --extractor-version v1 --limit 50 --execute                        # send
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export interface ReextractArgs {
  extractorVersion: string;
  execute: boolean;
  limit: number;
  /** Escape hatch for the connection-role guard. Absent (not `undefined`)
   *  unless the operator explicitly opted out. */
  allowRole?: string;
}

export type ParseReextractArgsResult =
  | { ok: true; value: ReextractArgs }
  | { ok: false; error: string };

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** The only SQS surface this tool needs — keeps the tests credential-free. */
export interface SqsCommandClient {
  send(command: unknown): Promise<unknown>;
}

export type ReextractResultKind =
  | 'dry_run'
  | 'executed'
  | 'nothing_to_do'
  | 'queue_not_configured'
  | 'wrong_role'
  | 'aws_error';

export interface ReextractResult {
  kind: ReextractResultKind;
  selected: number;
  queued: number;
}

export interface ReextractDeps {
  db: Queryable;
  args: ReextractArgs;
  /** Only required for `--execute`; a dry run never constructs one. */
  sqs?: SqsCommandClient;
  queueUrl?: string;
  send?: (client: SqsCommandClient, queueUrl: string, body: string) => Promise<unknown>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const VALUE_FLAGS = new Set(['--extractor-version', '--limit', '--allow-role']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, '--execute', '--dry-run']);
// Same posture as replay-domain-event.ts / redrive-billing-dlq.ts: a flag that
// implies "everything" means the operator wants a different tool. `--limit` is
// the only knob on blast radius here.
const BULK_FLAGS = new Set(['--all', '--bulk', '-a', '--force-all', '--everything']);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
/** Conservative: the version is echoed in output, so it must be inert text. */
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/** The only role whose RLS policies let this query see anything (012, 086). */
export const REQUIRED_DB_ROLE = 'jale_ai';
const ROLE_PATTERN = /^[A-Za-z0-9_]{1,63}$/;

/**
 * Assessments that (a) still exist in a state worth extracting, (b) actually
 * contain at least one non-blank answer, and (c) have no USABLE extraction row
 * at this version — no row at all, or one left `failed`/`pending`. Matching
 * only the JOIN misses would skip exactly the rows an outage leaves behind.
 *
 * The `answers` column is NEVER selected — only `id`, `user_id` and
 * `profession_key` leave the database, which is what makes "this tool cannot
 * print a worker's words" a property of the query rather than of the printing
 * code. The non-blank test mirrors the extractor's own "fewer than 1 non-empty
 * answer" rule so this tool does not queue work the extractor would only
 * complete as empty.
 *
 * `failed` assessments are excluded: there is nothing to extract from an
 * assessment the scoring lane itself rejected.
 */
export const REEXTRACT_SELECT_SQL = `
  SELECT a.id, a.user_id, a.profession_key
    FROM worker_trust_assessments a
    LEFT JOIN worker_trust_extractions e
      ON e.assessment_id = a.id
     AND e.extractor_version = $1
   WHERE a.status IN ('pending','scoring','scored')
     AND (e.id IS NULL OR e.status IN ('failed','pending'))
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(coalesce(a.answers, '[]'::jsonb)) AS answer
            WHERE btrim(coalesce(answer->>'answer_text', '')) <> ''
         )
   ORDER BY a.created_at ASC
   LIMIT $2`;

/** Strict base-10 integer in [1, MAX_LIMIT]; rejects signs, decimals, padding. */
function parseLimit(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

/**
 * Parses and strictly validates argv. Pure: no DB connection, no AWS call, no
 * environment read. Error messages name the offending FLAG, never the value.
 */
export function parseArgs(argv: string[]): ParseReextractArgsResult {
  const values = new Map<string, string>();
  let execute = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (BULK_FLAGS.has(arg)) {
      return { ok: false, error: `Bulk/all operations are not supported: ${arg} (use --limit)` };
    }
    if (!ALL_FLAGS.has(arg)) {
      // `--extractor-version=v1` would otherwise slip past the value parser;
      // only the flag name before any `=` is ever echoed.
      const flagName = arg.split('=')[0];
      return arg.startsWith('--')
        ? { ok: false, error: `Unknown flag: ${flagName} (use \`${flagName} <value>\`, not \`=\`)` }
        : { ok: false, error: 'Unexpected positional argument (value redacted)' };
    }
    if (arg === '--execute') {
      if (execute) return { ok: false, error: 'Duplicate flag: --execute' };
      execute = true;
      continue;
    }
    if (arg === '--dry-run') {
      if (dryRun) return { ok: false, error: 'Duplicate flag: --dry-run' };
      dryRun = true;
      continue;
    }
    if (values.has(arg)) return { ok: false, error: `Duplicate flag: ${arg}` };

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `Missing value for ${arg}` };
    }
    values.set(arg, value);
    index += 1;
  }

  if (execute && dryRun) {
    return { ok: false, error: '--dry-run and --execute are mutually exclusive' };
  }

  const extractorVersion = values.get('--extractor-version');
  if (extractorVersion === undefined) {
    return { ok: false, error: '--extractor-version is required' };
  }
  if (!VERSION_PATTERN.test(extractorVersion)) {
    return {
      ok: false,
      error: '--extractor-version must be 1-32 chars of [A-Za-z0-9._-] (value redacted)',
    };
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = values.get('--limit');
  if (rawLimit !== undefined) {
    const parsed = parseLimit(rawLimit);
    if (parsed === null) {
      return { ok: false, error: `--limit must be an integer between 1 and ${MAX_LIMIT}` };
    }
    limit = parsed;
  }

  const value: ReextractArgs = { extractorVersion, execute, limit };

  const allowRole = values.get('--allow-role');
  if (allowRole !== undefined) {
    if (!ROLE_PATTERN.test(allowRole)) {
      return {
        ok: false,
        error: '--allow-role must be 1-63 chars of [A-Za-z0-9_] (value redacted)',
      };
    }
    value.allowRole = allowRole;
  }

  return { ok: true, value };
}

/**
 * SDK error messages routinely quote the queue URL (and so the account id), so
 * only the error's `name` is ever surfaced.
 */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return 'UnknownError';
}

async function defaultSend(
  client: SqsCommandClient,
  queueUrl: string,
  body: string,
): Promise<unknown> {
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  return client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}

export async function run(deps: ReextractDeps): Promise<ReextractResult> {
  const { db, args } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const send = deps.send ?? defaultSend;

  // Checked BEFORE the query so a misconfigured operator does not discover the
  // problem after a 5000-row scan.
  if (args.execute && !deps.queueUrl) {
    logError(
      'TRUST_EXTRACTION_QUEUE_URL is not set; refusing to --execute. '
        + '(Set it to the trust-extraction-queue URL and retry.)',
    );
    return { kind: 'queue_not_configured', selected: 0, queued: 0 };
  }

  // Checked before the backlog query: as the wrong role RLS silently returns
  // zero rows, and "0 rows" is indistinguishable from "all done".
  const expectedRole = args.allowRole ?? REQUIRED_DB_ROLE;
  const roleResult = await db.query('SELECT current_user');
  const actualRole = roleResult.rows[0]?.current_user;
  if (typeof actualRole !== 'string' || actualRole !== expectedRole) {
    logError(
      `connected as ${typeof actualRole === 'string' ? actualRole : '(unknown role)'}, `
        + `expected ${expectedRole}. worker_trust_assessments and `
        + 'worker_trust_extractions are FORCE row-level security (RLS) and only '
        + `${REQUIRED_DB_ROLE} can read them unconditionally, so any other role would `
        + 'see zero rows and this tool would report "nothing to re-extract" while '
        + `silently doing nothing. Set DB_USER=${REQUIRED_DB_ROLE}, or pass `
        + '--allow-role <role> if you really mean it.',
    );
    return { kind: 'wrong_role', selected: 0, queued: 0 };
  }

  const selected = await db.query(REEXTRACT_SELECT_SQL, [args.extractorVersion, args.limit]);
  const rows = selected.rows as Array<{ id: string; user_id: string; profession_key: string }>;

  log(
    `extractor_version=${args.extractorVersion} limit=${args.limit}: `
      + `${rows.length} assessment(s) with at least one answer and no extraction row.`,
  );
  // Assessment UUIDs only. `user_id`/`profession_key` travel in the message
  // body but are never printed, and `answers` never leaves the database.
  for (const row of rows) log(`  ${row.id}`);

  if (rows.length === 0) {
    log('nothing to re-extract.');
    return { kind: 'nothing_to_do', selected: 0, queued: 0 };
  }

  if (!args.execute) {
    log(`dry run: would send ${rows.length} message(s). Re-run with --execute to send.`);
    return { kind: 'dry_run', selected: rows.length, queued: 0 };
  }

  const client = deps.sqs;
  if (!client) {
    logError('SQS client unavailable');
    return { kind: 'aws_error', selected: rows.length, queued: 0 };
  }

  let queued = 0;
  for (const row of rows) {
    try {
      await send(
        client,
        deps.queueUrl!,
        JSON.stringify({
          assessmentId: row.id,
          userId: row.user_id,
          professionKey: row.profession_key,
        }),
      );
      queued += 1;
    } catch (error) {
      // One bad send must not abandon the rest of the backlog; the extractor's
      // claim is idempotent, so re-running this tool is always safe.
      logError(`send failed for ${row.id}: ${errorName(error)}`);
    }
  }

  log(`queued ${queued} of ${rows.length} message(s).`);
  return {
    kind: queued === rows.length ? 'executed' : 'aws_error',
    selected: rows.length,
    queued,
  };
}

const FAILURE_KINDS = new Set<ReextractResultKind>(['aws_error', 'queue_not_configured', 'wrong_role']);

/** An empty backlog is the desired end state, so it exits 0. */
export function resolveExitCode(result: ReextractResult): number {
  return FAILURE_KINDS.has(result.kind) ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  // Same connection idiom as replay-domain-event.ts / whatsapp-runtime-controls.ts.
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? REQUIRED_DB_ROLE,
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

  const queueUrl = process.env.TRUST_EXTRACTION_QUEUE_URL;
  let sqs: SqsCommandClient | undefined;
  if (parsed.value.execute && queueUrl) {
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    sqs = new SQSClient({}) as unknown as SqsCommandClient;
  }

  await client.connect();
  try {
    const result = await run({ db: client as unknown as Queryable, args: parsed.value, sqs, queueUrl });
    process.exitCode = resolveExitCode(result);
  } catch (error) {
    console.error(`reextract-trust failed: ${errorName(error)}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('unexpected reextract failure (details redacted)');
    process.exitCode = 1;
  });
}
