/**
 * Operator CLI: exact-target WhatsApp v2 onboarding reset.
 *
 * Resets exactly ONE worker's onboarding/profile/trust state back to the
 * pre-auth entry point, so the WhatsApp onboarding v2 flow can be retested
 * for that account: the next inbound message gets the language choice, then
 * the OTP, and the verified bind creates the workflow run at 'legal.review'
 * exactly like a brand-new worker (bind_verified_identity_and_start_workflow,
 * migration 047). No worker_workflow_runs row is seeded — see the comment at
 * the seed site for the softlock an earlier seeded-run version caused. There
 * is no list mode, no wildcard, no phone-only mode, and no all-users mode:
 * `--user-id` and `--phone` must both be supplied exactly once, and `--phone`
 * must match the resolved user's verified (whatsapp_number) phone before
 * anything is touched.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/reset-whatsapp-onboarding-v2.ts \
 *     --user-id <uuid> --phone <e164> --reason "<why>" --dry-run|--execute
 *
 * Never prints or logs a raw phone number anywhere (the `--phone` value is
 * validated and bound as a parameter, never echoed; only its SHA-256 hash is
 * ever persisted or printed).
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import { hashNormalizedPhone } from '../lambda/whatsapp/lib/runtime-controls';


const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface ResetArgs {
  userId: string;
  phone: string;
  reason: string;
  dryRun: boolean;
}

export type ParseResetArgsResult =
  | { ok: true; value: ResetArgs }
  | { ok: false; error: string };

/**
 * Parses and strictly validates argv for the reset CLI. Never opens a DB
 * connection; a missing, empty, duplicated, or unrecognized flag is reported
 * here so the caller can exit non-zero before any connection is attempted.
 */
export function parseResetArgs(argv: string[]): ParseResetArgsResult {
  const known = new Set([
    '--user-id',
    '--phone',
    '--reason',
    '--dry-run',
    '--execute',
  ]);

  const collected: Record<string, string[]> = {
    '--user-id': [],
    '--phone': [],
    '--reason': [],
  };
  let dryRunFlag = false;
  let executeFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!known.has(flag)) {
      // Never echo a bare (non `--`) argument — a misplaced positional value
      // could be a raw phone number.
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

  if (collected['--user-id'].length === 0) {
    return { ok: false, error: 'Missing required flag: --user-id' };
  }
  if (collected['--user-id'].length > 1) {
    return { ok: false, error: '--user-id may only be supplied once' };
  }
  if (collected['--phone'].length === 0) {
    return { ok: false, error: 'Missing required flag: --phone' };
  }
  if (collected['--phone'].length > 1) {
    return { ok: false, error: '--phone may only be supplied once' };
  }
  if (collected['--reason'].length === 0) {
    return { ok: false, error: 'Missing required flag: --reason' };
  }
  if (collected['--reason'].length > 1) {
    return { ok: false, error: '--reason may only be supplied once' };
  }

  const userId = collected['--user-id'][0].trim();
  const phone = collected['--phone'][0].trim();
  const reason = collected['--reason'][0].trim();

  if (userId.length === 0 || !UUID_PATTERN.test(userId)) {
    return { ok: false, error: '--user-id must be a syntactic UUID' };
  }
  if (phone.length === 0) {
    return { ok: false, error: '--phone must not be empty' };
  }
  if (reason.length === 0) {
    return { ok: false, error: '--reason must not be empty' };
  }
  if (dryRunFlag === executeFlag) {
    return {
      ok: false,
      error: 'Exactly one of --dry-run or --execute is required',
    };
  }

  return { ok: true, value: { userId, phone, reason, dryRun: dryRunFlag } };
}

/**
 * DELETE steps in exact FK-safe order (matches cleanup-whatsapp-rds-user.ps1).
 * Every predicate is scoped to the single target user (by uid, phone, or
 * phone_hash) — never a bare `DELETE FROM <table>`. Bind order is always
 * [userId, phone, phoneHash] -> $1, $2, $3.
 */
export const DELETE_STEPS: Array<{ table: string; predicate: string }> = [
  { table: 'worker_message_intents', predicate: 'user_id = $1' },
  { table: 'worker_domain_outbox', predicate: 'aggregate_id = $1' },
  {
    table: 'worker_workflow_transitions',
    predicate:
      'run_id IN (SELECT id FROM worker_workflow_runs WHERE user_id = $1)',
  },
  { table: 'worker_workflow_runs', predicate: 'user_id = $1' },
  {
    table: 'worker_identity_challenges',
    predicate:
      'verified_user_id = $1 OR candidate_user_id = $1 OR phone_hash = $3',
  },
  { table: 'worker_onboarding_state', predicate: 'user_id = $1' },
  {
    table: 'whatsapp_outbox',
    predicate:
      'whatsapp_number = $2 OR inbound_message_sid IN (SELECT message_sid FROM whatsapp_processed_messages WHERE whatsapp_number = $2)',
  },
  { table: 'whatsapp_processed_messages', predicate: 'whatsapp_number = $2' },
  {
    table: 'whatsapp_conversations',
    predicate: 'whatsapp_number = $2 OR user_id = $1',
  },
  {
    table: 'job_conversation_messages',
    predicate:
      'conversation_id IN (SELECT id FROM job_conversations WHERE worker_id = $1)',
  },
  {
    table: 'job_message_outbox',
    predicate:
      'conversation_id IN (SELECT id FROM job_conversations WHERE worker_id = $1)',
  },
  { table: 'job_conversations', predicate: 'worker_id = $1' },
  { table: 'job_applications', predicate: 'worker_id = $1' },
  { table: 'worker_job_impressions', predicate: 'worker_id = $1' },
  { table: 'worker_match_log', predicate: 'worker_id = $1' },
  { table: 'job_candidates', predicate: 'worker_id = $1' },
  { table: 'worker_trust_assessments', predicate: 'user_id = $1' },
  { table: 'worker_profile_ai_extractions', predicate: 'user_id = $1' },
  { table: 'worker_profile_media', predicate: 'user_id = $1' },
  { table: 'worker_skills', predicate: 'worker_id = $1' },
];

/**
 * Column clears (UPDATE, never DELETE — the row and its identity columns are
 * kept). Every cleared column is enumerated explicitly below.
 *
 * worker_profiles — keep `user_id` (PK/FK identity) and `phone` (mirrors the
 * user's identity phone, not a profile *answer*). Clear every profile-answer
 * column: full_name, availability, years_experience, bio, experience_months
 * (-> NULL), certifications (-> '{}'::text[] — NOT NULL since migration 033).
 * The five location columns (latitude, longitude, location_source,
 * location_confidence, location_updated_at) are cleared together because the
 * `worker_profiles_location_complete` CHECK (migration 009) requires them to
 * be either all-NULL or all-set — clearing a subset would violate the CHECK.
 * `skills` was dropped in migration 008 and must not be referenced.
 */
const WORKER_PROFILES_UPDATE = `
  UPDATE worker_profiles
     SET full_name = NULL,
         availability = NULL,
         years_experience = NULL,
         location = NULL,
         bio = NULL,
         latitude = NULL,
         longitude = NULL,
         location_source = NULL,
         location_confidence = NULL,
         location_updated_at = NULL,
         experience_months = NULL,
         certifications = '{}'::text[]
   WHERE user_id = $1
`;

/**
 * users — PRESERVE (never clear): id, cognito_sub, phone, whatsapp_number,
 * whatsapp_linked_at, user_type, tenant_id, created_at, email, and all legal
 * columns (tos_accepted_at, tos_version, privacy_accepted_at,
 * privacy_version). CLEAR (onboarding/profile answers + trades + trust):
 * city, main_trade, main_trade_other, years_experience, has_transportation,
 * availability, full_name (a profile.name answer), trade_competency_score
 * (-> NULL).
 *
 * `trust_signals` / `trust_signals_completed_at` used to be reset here too.
 * They were migration 006's v1 trust layer; v2 keeps its answers in
 * worker_trust_assessments (reset separately, above) and its extractions in
 * worker_trust_extractions, and migration 092 DROPS both columns. Naming
 * either one here after 092 is applied is a 42703 that aborts the whole
 * single-transaction reset, so they are gone from this statement.
 */
const USERS_UPDATE = `
  UPDATE users
     SET city = NULL,
         main_trade = NULL,
         main_trade_other = NULL,
         years_experience = NULL,
         has_transportation = NULL,
         availability = NULL,
         full_name = NULL,
         trade_competency_score = NULL
   WHERE id = $1
`;

export interface ResetOutcome {
  dryRun: boolean;
  tableCounts: Record<string, number>;
  auditId?: string;
}

/**
 * Runs the reset inside ONE transaction (BEGIN/COMMIT/ROLLBACK issued here)
 * against the target user resolved by UUID AND normalized verified phone in
 * one query. Aborts before any DELETE if the phone does not match. Never
 * prints or logs the raw phone; only its 64-hex SHA-256 hash is used or
 * persisted.
 */
/**
 * Rewrites a statement to bind exactly — and only — the parameters it
 * references from the shared [userId, phone, phoneHash] list. PostgreSQL's
 * extended query protocol rejects both a Bind carrying more parameters than
 * the statement's highest `$n` ("bind message supplies 3 parameters, but
 * prepared statement requires 1") and a supplied placeholder the statement
 * never references ("could not determine data type of parameter $2", for a
 * predicate using $1 and $3 but not $2). So the referenced placeholders are
 * renumbered densely ($1 $3 -> $1 $2) and the value list is built to match.
 * The unit-test fake client enforced neither rule, which is how the
 * original full-list binding shipped; found on the first real production
 * run, gated by whatsapp-onboarding-reset.integration.test.ts since.
 */
export function bindStatement(
  sql: string,
  params: unknown[],
): { text: string; values: unknown[] } {
  const used = [
    ...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);
  const renumbered = new Map(used.map((original, i) => [original, i + 1]));
  const text = sql.replace(/\$(\d+)/g, (_, n) => `$${renumbered.get(Number(n))}`);
  return { text, values: used.map((n) => params[n - 1]) };
}

export async function runReset(
  client: Queryable,
  args: ResetArgs & { operator: string },
): Promise<ResetOutcome> {
  const { userId, phone, reason, dryRun, operator } = args;
  const phoneHash = hashNormalizedPhone(phone);
  const params = [userId, phone, phoneHash];

  await client.query('BEGIN');

  try {
    const resolved = await client.query(
      `SELECT id FROM users WHERE id = $1 AND user_type = $2 AND whatsapp_number = $3`,
      [userId, 'worker', phone],
    );

    if (resolved.rows.length !== 1) {
      // Let the single outer catch below issue the ROLLBACK — issuing one
      // here too would emit a harmless but noisy "no transaction in
      // progress" NOTICE against a real Postgres connection.
      throw new Error(
        'No matching worker found for the supplied --user-id and --phone (verified phone mismatch or user not found).',
      );
    }

    const tableCounts: Record<string, number> = {};

    for (const step of DELETE_STEPS) {
      const bound = bindStatement(
        `SELECT count(*)::int AS count FROM ${step.table} WHERE ${step.predicate}`,
        params,
      );
      const result = await client.query(bound.text, bound.values);
      const row = result.rows[0] as { count: number } | undefined;
      tableCounts[step.table] = row?.count ?? 0;
    }

    const profileCount = await client.query(
      `SELECT count(*)::int AS count FROM worker_profiles WHERE user_id = $1`,
      [userId],
    );
    tableCounts['worker_profiles'] =
      (profileCount.rows[0] as { count: number } | undefined)?.count ?? 0;

    const userCount = await client.query(
      `SELECT count(*)::int AS count FROM users WHERE id = $1`,
      [userId],
    );
    tableCounts['users'] =
      (userCount.rows[0] as { count: number } | undefined)?.count ?? 0;

    // Print the per-table count JSON before any mutation, in both modes.
    console.log(JSON.stringify(tableCounts, null, 2));

    if (dryRun) {
      await client.query('ROLLBACK');
      return { dryRun: true, tableCounts };
    }

    for (const step of DELETE_STEPS) {
      const bound = bindStatement(
        `DELETE FROM ${step.table} WHERE ${step.predicate}`,
        params,
      );
      await client.query(bound.text, bound.values);
    }

    const profilesUpdate = bindStatement(WORKER_PROFILES_UPDATE, params);
    await client.query(profilesUpdate.text, profilesUpdate.values);
    const usersUpdate = bindStatement(USERS_UPDATE, params);
    await client.query(usersUpdate.text, usersUpdate.values);

    await client.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding')`,
      [userId],
    );
    // Deliberately NO worker_workflow_runs seed. 'start.choose_language' and
    // 'identity.verify_otp' belong to the pre-auth worker_identity_challenges
    // lane; a bound run is only ever legitimately created by
    // bind_verified_identity_and_start_workflow (migration 047), which starts
    // it at 'legal.review' on the first correct OTP. An earlier version
    // seeded a run at 'start.choose_language' here, and the verified-OTP
    // rebind then reused that run as-is — softlocking the worker on
    // "unhandled bound step: start.choose_language" with every subsequent
    // message. The reset deletes the conversation above, so the next inbound
    // always enters the pre-auth lane and the account restarts exactly like
    // a brand-new worker: language -> OTP -> bind creates the run.

    const auditResult = await client.query(
      `INSERT INTO worker_reset_audit
         (user_id, phone_hash, operator, reason, table_counts, dry_run)
       VALUES ($1, $2, $3, $4, $5::jsonb, false)
       RETURNING id`,
      [userId, phoneHash, operator, reason, JSON.stringify(tableCounts)],
    );

    await client.query('COMMIT');

    return {
      dryRun: false,
      tableCounts,
      auditId: auditResult.rows[0]?.id as string | undefined,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best-effort rollback; the original error is what matters.
    }
    throw err;
  }
}

export function resolveOperator(): string {
  return process.env.RESET_OPERATOR ?? process.env.USER ?? 'unknown-operator';
}

async function main(): Promise<void> {
  const parsed = parseResetArgs(process.argv.slice(2));
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
    const outcome = await runReset(client, {
      ...parsed.value,
      operator: resolveOperator(),
    });
    if (outcome.dryRun) {
      console.log('Dry run complete. No changes were made.');
    } else {
      console.log(`Reset complete. Audit row: ${outcome.auditId ?? 'unknown'}`);
    }
  } catch (err) {
    console.error('Reset failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
