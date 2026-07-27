/**
 * Operator CLI: targeted, non-destructive WhatsApp v2 onboarding repair.
 *
 * The counterpart to `reset-whatsapp-onboarding-v2.ts` for the cases where a
 * full wipe is overkill: a worker's run is wedged on one step (e.g. a
 * poisoned message DLQ'd during the 2026-07-26 saveLocation incident) and
 * simply needs its `current_step_key` moved so the next inbound message
 * dispatches to a healthy handler. Nothing is deleted; the run's own
 * transition history records the repair.
 *
 * Modes (both require --user-id AND --phone to match the same worker, like
 * the reset CLI):
 *
 *   Inspect (default, read-only — no --set-step):
 *     npx ts-node scripts/repair-whatsapp-onboarding-v2.ts \
 *       --user-id <uuid> --phone <e164>
 *
 *   Repair (--set-step; exactly one of --dry-run|--execute):
 *     npx ts-node scripts/repair-whatsapp-onboarding-v2.ts \
 *       --user-id <uuid> --phone <e164> --set-step profile.location \
 *       --reason "<why>" --dry-run|--execute
 *
 * Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD [DB_SSL=true]
 *
 * Never prints or logs a raw phone number anywhere (the `--phone` value is
 * validated and bound as a parameter, never echoed; only its SHA-256 hash
 * appears in output).
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import { hashNormalizedPhone } from '../lambda/whatsapp/lib/runtime-controls';

/**
 * Mirrors `WorkflowStepKey` (lambda/whatsapp/lib/onboarding-types.ts),
 * duplicated as a local constant for the same reason the reset script
 * duplicates WHATSAPP_V2_WORKFLOW_VERSION: operator scripts must not import
 * lambda process code beyond the already-approved runtime-controls hashing
 * helper. The DB's own step-key CHECK (migration 050, seventeen values) is
 * the final authority; this list exists to fail fast with a readable error
 * before touching the database. `repair-cli.test.ts` pins it against the
 * type's source file so the two cannot drift silently.
 */
export const WORKFLOW_STEP_KEYS = [
  'start.choose_language',
  'identity.verify_otp',
  'legal.review',
  'profile.voice_choice',
  'profile.voice_processing',
  'profile.name',
  'profile.location',
  'profile.trade',
  'profile.custom_trade',
  'profile.experience',
  'profile.transportation',
  'profile.availability',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
  'profile.photo',
  'profile.photo_type',
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface RepairArgs {
  userId: string;
  phone: string;
  setStep: string | null; // null = inspect mode
  reason: string | null; // required iff setStep is present
  dryRun: boolean; // meaningful iff setStep is present
}

export type ParseRepairArgsResult =
  | { ok: true; value: RepairArgs }
  | { ok: false; error: string };

/**
 * Parses and strictly validates argv. Never opens a DB connection; a
 * missing, empty, duplicated, or unrecognized flag is reported here so the
 * caller can exit non-zero before any connection is attempted. Never echoes
 * a bare argument (it could be a raw phone number).
 */
export function parseRepairArgs(argv: string[]): ParseRepairArgsResult {
  const known = new Set([
    '--user-id',
    '--phone',
    '--reason',
    '--set-step',
    '--dry-run',
    '--execute',
  ]);

  const collected: Record<string, string[]> = {
    '--user-id': [],
    '--phone': [],
    '--reason': [],
    '--set-step': [],
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

  for (const required of ['--user-id', '--phone'] as const) {
    if (collected[required].length === 0) {
      return { ok: false, error: `Missing required flag: ${required}` };
    }
    if (collected[required].length > 1) {
      return { ok: false, error: `${required} may only be supplied once` };
    }
  }
  if (collected['--set-step'].length > 1) {
    return { ok: false, error: '--set-step may only be supplied once' };
  }
  if (collected['--reason'].length > 1) {
    return { ok: false, error: '--reason may only be supplied once' };
  }

  const userId = collected['--user-id'][0].trim();
  const phone = collected['--phone'][0].trim();
  const setStep = collected['--set-step'][0]?.trim() ?? null;
  const reason = collected['--reason'][0]?.trim() ?? null;

  if (userId.length === 0 || !UUID_PATTERN.test(userId)) {
    return { ok: false, error: '--user-id must be a syntactic UUID' };
  }
  if (phone.length === 0) {
    return { ok: false, error: '--phone must not be empty' };
  }

  if (setStep === null) {
    // Inspect mode is read-only: repair-only flags are rejected so a typo'd
    // --set-step can never silently degrade an intended repair to a no-op.
    if (dryRunFlag || executeFlag) {
      return {
        ok: false,
        error: '--dry-run/--execute require --set-step (inspect mode is always read-only)',
      };
    }
    if (reason !== null) {
      return { ok: false, error: '--reason requires --set-step' };
    }
    return { ok: true, value: { userId, phone, setStep: null, reason: null, dryRun: false } };
  }

  if (!(WORKFLOW_STEP_KEYS as readonly string[]).includes(setStep)) {
    return {
      ok: false,
      error: `--set-step must be one of: ${WORKFLOW_STEP_KEYS.join(', ')}`,
    };
  }
  if (reason === null || reason.length === 0) {
    return { ok: false, error: 'Missing required flag: --reason' };
  }
  if (dryRunFlag === executeFlag) {
    return {
      ok: false,
      error: 'Exactly one of --dry-run or --execute is required with --set-step',
    };
  }

  return { ok: true, value: { userId, phone, setStep, reason, dryRun: dryRunFlag } };
}

// ── Inspect ────────────────────────────────────────────────────────────

export interface InspectReport {
  phoneHash: string;
  lifecycle: string | null;
  run: Record<string, unknown> | null;
  profileFields: Record<string, boolean>;
  preAuthStatus: string | null;
  recentTransitions: Array<Record<string, unknown>>;
  recentErrorSids: Array<Record<string, unknown>>;
}

/**
 * Read-only snapshot of everything an operator needs to decide whether (and
 * where) to repair. No BEGIN — every statement is a bare SELECT.
 */
export async function runInspect(
  client: Queryable,
  args: { userId: string; phone: string },
): Promise<InspectReport> {
  const { userId, phone } = args;
  const phoneHash = hashNormalizedPhone(phone);

  const resolved = await client.query(
    `SELECT id FROM users WHERE id = $1 AND user_type = 'worker' AND whatsapp_number = $2`,
    [userId, phone],
  );
  if (resolved.rows.length !== 1) {
    throw new Error(
      'No matching worker found for the supplied --user-id and --phone (verified phone mismatch or user not found).',
    );
  }

  const lifecycle = await client.query(
    `SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`,
    [userId],
  );

  // Same latest-run preference as the router's loadWorkerGate: an active
  // run first, then most recent.
  const run = await client.query(
    `SELECT id, workflow_version, current_step_key, status, lock_version,
            created_at, updated_at
       FROM worker_workflow_runs
      WHERE user_id = $1
      ORDER BY (status = 'active') DESC, created_at DESC, id DESC
      LIMIT 1`,
    [userId],
  );

  const profile = await client.query(
    `SELECT full_name IS NOT NULL AS full_name,
            city IS NOT NULL AS city,
            main_trade IS NOT NULL AS main_trade,
            main_trade_other IS NOT NULL AS main_trade_other,
            years_experience IS NOT NULL AS years_experience,
            has_transportation IS NOT NULL AS has_transportation,
            availability IS NOT NULL AS availability
       FROM users WHERE id = $1`,
    [userId],
  );

  const preAuth = await client.query(
    `SELECT status FROM worker_identity_challenges
      WHERE phone_hash = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [phoneHash],
  );

  const transitions = await client.query(
    `SELECT t.from_step_key, t.to_step_key, t.reason, t.created_at
       FROM worker_workflow_transitions t
       JOIN worker_workflow_runs r ON r.id = t.run_id
      WHERE r.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 10`,
    [userId],
  );

  // The processor's error fallback records failed messages as `<sid>#err`
  // rows with the throw text in last_error — the fastest way to see WHY a
  // run is stuck without opening CloudWatch.
  const errorSids = await client.query(
    `SELECT message_sid, last_error, first_seen_at
       FROM whatsapp_processed_messages
      WHERE whatsapp_number = $1
        AND message_sid LIKE '%#err'
      ORDER BY first_seen_at DESC
      LIMIT 5`,
    [phone],
  );

  return {
    phoneHash,
    lifecycle: (lifecycle.rows[0]?.lifecycle as string | undefined) ?? null,
    run: run.rows[0] ?? null,
    profileFields: (profile.rows[0] as Record<string, boolean> | undefined) ?? {},
    preAuthStatus: (preAuth.rows[0]?.status as string | undefined) ?? null,
    recentTransitions: transitions.rows,
    recentErrorSids: errorSids.rows,
  };
}

// ── Repair ─────────────────────────────────────────────────────────────

export interface RepairOutcome {
  dryRun: boolean;
  runId: string;
  fromStepKey: string;
  toStepKey: string;
  newLockVersion?: number;
}

/**
 * Moves the worker's ACTIVE run to the requested step inside one
 * transaction, mirroring the repository's advanceWorkflow contract:
 * optimistic lock_version check, lock_version bump, and a transition row so
 * the run's history shows the operator intervention. Refuses non-active
 * runs — a completed or declined run is not "stuck", and repairing it would
 * fork history (reset is the tool for those).
 */
export async function runRepair(
  client: Queryable,
  args: { userId: string; phone: string; setStep: string; reason: string; dryRun: boolean; operator: string },
): Promise<RepairOutcome> {
  const { userId, phone, setStep, reason, dryRun, operator } = args;

  await client.query('BEGIN');
  try {
    const resolved = await client.query(
      `SELECT id FROM users WHERE id = $1 AND user_type = 'worker' AND whatsapp_number = $2`,
      [userId, phone],
    );
    if (resolved.rows.length !== 1) {
      throw new Error(
        'No matching worker found for the supplied --user-id and --phone (verified phone mismatch or user not found).',
      );
    }

    const run = await client.query(
      `SELECT id, current_step_key, status, lock_version
         FROM worker_workflow_runs
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [userId],
    );
    const row = run.rows[0] as
      | { id: string; current_step_key: string; status: string; lock_version: number }
      | undefined;
    if (!row) {
      throw new Error(
        'No ACTIVE workflow run for this worker — nothing to repair (use the reset CLI to restart a completed/declined worker).',
      );
    }
    if (row.current_step_key === setStep) {
      throw new Error(
        `Run is already at ${setStep} — nothing to repair.`,
      );
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      return {
        dryRun: true,
        runId: row.id,
        fromStepKey: row.current_step_key,
        toStepKey: setStep,
      };
    }

    const updated = await client.query(
      `UPDATE worker_workflow_runs
          SET current_step_key = $1,
              lock_version = lock_version + 1,
              updated_at = now()
        WHERE id = $2 AND lock_version = $3
        RETURNING lock_version`,
      [setStep, row.id, row.lock_version],
    );
    if (updated.rows.length !== 1) {
      // FOR UPDATE above makes this unreachable in practice, but the
      // optimistic check stays — it is the advanceWorkflow contract, and a
      // silent 0-row UPDATE here would report success without repairing.
      throw new Error('Concurrent modification detected (lock_version moved) — re-run the repair.');
    }

    await client.query(
      `INSERT INTO worker_workflow_transitions
         (run_id, from_step_key, to_step_key, reason, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        row.id,
        row.current_step_key,
        setStep,
        `operator_repair: ${reason}`,
        JSON.stringify({ operator, tool: 'repair-whatsapp-onboarding-v2' }),
      ],
    );

    await client.query('COMMIT');
    return {
      dryRun: false,
      runId: row.id,
      fromStepKey: row.current_step_key,
      toStepKey: setStep,
      newLockVersion: (updated.rows[0] as { lock_version: number }).lock_version,
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
  const parsed = parseRepairArgs(process.argv.slice(2));
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
    if (parsed.value.setStep === null) {
      const report = await runInspect(client, parsed.value);
      console.log(JSON.stringify(report, null, 2));
    } else {
      const outcome = await runRepair(client, {
        userId: parsed.value.userId,
        phone: parsed.value.phone,
        setStep: parsed.value.setStep,
        reason: parsed.value.reason!,
        dryRun: parsed.value.dryRun,
        operator: resolveOperator(),
      });
      if (outcome.dryRun) {
        console.log(
          `Dry run: would move run ${outcome.runId} from ${outcome.fromStepKey} to ${outcome.toStepKey}. No changes were made.`,
        );
      } else {
        console.log(
          `Repair complete: run ${outcome.runId} moved ${outcome.fromStepKey} -> ${outcome.toStepKey} (lock_version ${outcome.newLockVersion}).`,
        );
      }
    }
  } catch (err) {
    console.error('Repair failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
