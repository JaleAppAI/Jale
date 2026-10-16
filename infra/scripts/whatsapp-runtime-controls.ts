/**
 * Operator CLI: WhatsApp v2 runtime controls (whatsapp_runtime_controls, 042,
 * 051).
 *
 * Reads/writes the `deferred_delivery_enabled` and `voice_intake_enabled`
 * control rows. `--show` prints hashes only (never raw phones) and prints no
 * other table. `--allow-phone`/`--deny-phone` write/remove only the SHA-256
 * hash of the supplied phone via `hashNormalizedPhone` — the raw phone is
 * never persisted or printed.
 *
 * `--allow-phone`, `--deny-phone`, and `--go-global` default to targeting
 * `voice_intake_enabled` — the only phone-scoped control. `--control
 * voice_intake` may still be passed explicitly for clarity; `--control` only
 * accepts phone-scoped controls (`voice_intake`) — `deferred_delivery` has no
 * per-phone allowlist or global flag of its own.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx tsx scripts/whatsapp-runtime-controls.ts --show
 *   npx tsx scripts/whatsapp-runtime-controls.ts --enable deferred_delivery
 *   npx tsx scripts/whatsapp-runtime-controls.ts --allow-phone +19155550123
 *   npx tsx scripts/whatsapp-runtime-controls.ts --go-global
 *
 *   # Voice intake (051): same actions, targeted via --control
 *   npx tsx scripts/whatsapp-runtime-controls.ts --enable voice_intake
 *   npx tsx scripts/whatsapp-runtime-controls.ts --allow-phone +19155550123 --control voice_intake
 *   npx tsx scripts/whatsapp-runtime-controls.ts --go-global --control voice_intake
 *
 *   # Verify Twilio Content Template SIDs against approval state and WhatsApp
 *   # category — needs only AWS credentials (reads the jale/whatsapp/twilio
 *   # secret), no DB env:
 *   npx tsx scripts/whatsapp-runtime-controls.ts --verify-templates
 *
 *   # Before the deploy that retires the unversioned admin_support_reply_<lang>
 *   # keys: a retired key that is still mapped prints as a NOTICE instead of a
 *   # failure; every other rule still fails the run. After the deploy, remove
 *   # the pair with `node scripts/seed-whatsapp-twilio-templates.mjs
 *   # --unset-template <key>` and run the plain --verify-templates above.
 *   npx tsx scripts/whatsapp-runtime-controls.ts --verify-templates --before-deploy
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import { hashNormalizedPhone } from '../lambda/whatsapp/lib/runtime-controls';
import { retriggerDeferredReadyWorkers } from '../lambda/whatsapp/lib/delivery-retrigger-sweep';
import type { VerifyTemplatesResult } from './lib/verify-twilio-templates';

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/**
 * Maps the CLI's short control names to the seeded control_key values: the
 * `whatsapp_runtime_controls` table and the `deferred_delivery_enabled` row
 * were created/seeded in 042; 051 added the `voice_intake_enabled` row.
 */
const CONTROL_KEY_MAP: Record<string, string> = {
  deferred_delivery: 'deferred_delivery_enabled',
  voice_intake: 'voice_intake_enabled',
};

/**
 * Controls that carry their own phone-hash allowlist and global flag — the
 * only ones `--allow-phone`, `--deny-phone`, and `--go-global` can target.
 * `deferred_delivery_enabled` is a plain on/off switch with no per-phone
 * scoping, so it is deliberately excluded here.
 */
const PHONE_SCOPED_CONTROL_MAP: Record<string, string> = {
  voice_intake: 'voice_intake_enabled',
};

const DEFAULT_PHONE_SCOPED_CONTROL_KEY = 'voice_intake_enabled';

export type ControlsAction =
  | { kind: 'show' }
  | { kind: 'enable'; controlKey: string }
  | { kind: 'disable'; controlKey: string }
  | { kind: 'allow-phone'; phone: string; controlKey: string }
  | { kind: 'deny-phone'; phone: string; controlKey: string }
  | { kind: 'go-global'; controlKey: string };

export type ParseControlsArgsResult =
  | { ok: true; value: ControlsAction }
  | { ok: false; error: string };

const KNOWN_FLAGS = new Set([
  '--show',
  '--enable',
  '--disable',
  '--allow-phone',
  '--deny-phone',
  '--go-global',
]);

/**
 * Parses and strictly validates argv for the runtime-controls CLI. Never
 * opens a DB connection. Exactly one action flag is required per invocation;
 * an unknown flag or unknown control name is reported here so the caller can
 * exit non-zero before any connection is attempted.
 *
 * `--go-global`, `--allow-phone`, and `--deny-phone` accept an optional
 * trailing `--control <name>` selector (name is one of
 * PHONE_SCOPED_CONTROL_MAP's keys). Omitting it targets `voice_intake` — the
 * only phone-scoped control.
 */
export function parseControlsArgs(argv: string[]): ParseControlsArgsResult {
  const supportsControlSelector =
    argv[0] === '--go-global' || argv[0] === '--allow-phone' || argv[0] === '--deny-phone';

  let controlKey = DEFAULT_PHONE_SCOPED_CONTROL_KEY;
  let rest = argv;

  if (
    supportsControlSelector &&
    argv.length >= 2 &&
    argv[argv.length - 2] === '--control'
  ) {
    const controlName = argv[argv.length - 1];
    const mapped = PHONE_SCOPED_CONTROL_MAP[controlName];
    if (!mapped) {
      // Never echo the supplied value — it could be a misplaced raw phone.
      return {
        ok: false,
        error: 'Unknown --control value (must be voice_intake)',
      };
    }
    controlKey = mapped;
    rest = argv.slice(0, argv.length - 2);
  }

  return parseBaseControlsArgs(rest, controlKey);
}

/**
 * Original argv parsing, unchanged from before the `--control` selector
 * existed, except that `allow-phone` / `deny-phone` / `go-global` now carry
 * whichever `controlKey` the caller resolved (defaulting to
 * `voice_intake_enabled`).
 */
function parseBaseControlsArgs(
  argv: string[],
  phoneScopedControlKey: string,
): ParseControlsArgsResult {
  if (argv.length === 0) {
    return { ok: false, error: 'Missing required action flag' };
  }

  const flag = argv[0];
  if (!KNOWN_FLAGS.has(flag)) {
    // Never echo a bare (non `--`) argument — a misplaced positional value
    // could be a raw phone number.
    return {
      ok: false,
      error: flag.startsWith('--')
        ? `Unrecognized flag: ${flag}`
        : 'Unrecognized argument (redacted)',
    };
  }
  if (argv.length > 2) {
    return { ok: false, error: 'Only one action flag is allowed per invocation' };
  }

  if (flag === '--show') {
    return { ok: true, value: { kind: 'show' } };
  }
  if (flag === '--go-global') {
    return { ok: true, value: { kind: 'go-global', controlKey: phoneScopedControlKey } };
  }

  const value = argv[1];
  if (value === undefined || value.startsWith('--')) {
    return { ok: false, error: `Missing value for flag: ${flag}` };
  }

  if (flag === '--enable' || flag === '--disable') {
    const controlKey = CONTROL_KEY_MAP[value];
    if (!controlKey) {
      // Never echo the supplied value — it could be a misplaced raw phone.
      return {
        ok: false,
        error: 'Unknown control name (must be deferred_delivery or voice_intake)',
      };
    }
    return {
      ok: true,
      value: { kind: flag === '--enable' ? 'enable' : 'disable', controlKey },
    };
  }

  if (flag === '--allow-phone' || flag === '--deny-phone') {
    if (value.trim().length === 0) {
      return { ok: false, error: `--${flag.replace('--', '')} must not be empty` };
    }
    return {
      ok: true,
      value: {
        kind: flag === '--allow-phone' ? 'allow-phone' : 'deny-phone',
        phone: value.trim(),
        controlKey: phoneScopedControlKey,
      },
    };
  }

  return { ok: false, error: `Unrecognized flag: ${flag}` };
}

export interface ShowResult {
  controlKey: string;
  enabled: boolean;
  globalEnabled: boolean;
  phoneHashes: string[];
}

export function resolveOperator(): string {
  return process.env.RESET_OPERATOR ?? process.env.USER ?? 'unknown-operator';
}

/**
 * Executes the parsed action against `whatsapp_runtime_controls`. `--show`
 * issues only a SELECT and prints only phone_hashes (never raw phones) and no
 * other table. All mutations set `updated_by` to the operator identity.
 */
export async function runControlsAction(
  client: Queryable,
  action: ControlsAction,
  operator: string,
): Promise<ShowResult[] | void> {
  if (action.kind === 'show') {
    const result = await client.query(
      `SELECT control_key, enabled, global_enabled, phone_hashes
         FROM whatsapp_runtime_controls
        WHERE control_key = ANY($1::text[])
        ORDER BY control_key`,
      [Object.values(CONTROL_KEY_MAP)],
    );
    const rows: ShowResult[] = result.rows.map((row) => ({
      controlKey: row.control_key as string,
      enabled: row.enabled as boolean,
      globalEnabled: row.global_enabled as boolean,
      phoneHashes: (row.phone_hashes as string[] | undefined) ?? [],
    }));
    console.log(JSON.stringify(rows, null, 2));
    return rows;
  }

  if (action.kind === 'enable' || action.kind === 'disable') {
    // O1 (deferred re-trigger sweep, D1): enabling `deferred_delivery_enabled`
    // must also re-emit `worker.ready` events for any ready worker whose
    // business intents piled up as 'deferred' while the control was off —
    // see delivery-retrigger-sweep.ts for why that re-trigger is required at
    // all. `--disable` must NEVER sweep (there would be nothing useful to
    // enqueue, and it would just churn events that immediately re-defer).
    //
    // Atomicity choice (binding for this CLI): the enable UPDATE and the
    // sweep run in ONE explicit transaction on this same connection. If the
    // sweep throws, the whole transaction rolls back, so the control is
    // never left "enabled but not yet retriggered" — a state an operator
    // could easily miss, since nothing else prompts a re-run. This is safe
    // to prefer over "sweep is independently re-runnable, so let enable
    // commit alone": the sweep IS also independently re-runnable (see the
    // idempotency reasoning in delivery-retrigger-sweep.ts) and every
    // subsequent `--enable deferred_delivery` invocation still finds and
    // enqueues any still-outstanding deferred intents, but there is no
    // reason to accept a silent partial success when a single transaction
    // gives us all-or-nothing for free.
    const shouldSweep = action.kind === 'enable' && action.controlKey === 'deferred_delivery_enabled';

    if (!shouldSweep) {
      await client.query(
        `UPDATE whatsapp_runtime_controls
            SET enabled = $2, updated_by = $3, updated_at = now()
          WHERE control_key = $1`,
        [action.controlKey, action.kind === 'enable', operator],
      );
      return;
    }

    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE whatsapp_runtime_controls
            SET enabled = $2, updated_by = $3, updated_at = now()
          WHERE control_key = $1`,
        [action.controlKey, true, operator],
      );
      await retriggerDeferredReadyWorkers(client as unknown as Parameters<typeof retriggerDeferredReadyWorkers>[0]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return;
  }

  if (action.kind === 'allow-phone' || action.kind === 'deny-phone') {
    const phoneHash = hashNormalizedPhone(action.phone);
    let result;
    if (action.kind === 'allow-phone') {
      result = await client.query(
        `UPDATE whatsapp_runtime_controls
            SET phone_hashes = CASE
                  WHEN $1 = ANY(phone_hashes) THEN phone_hashes
                  ELSE array_append(phone_hashes, $1)
                END,
                updated_by = $2,
                updated_at = now()
          WHERE control_key = $3`,
        [phoneHash, operator, action.controlKey],
      );
    } else {
      result = await client.query(
        `UPDATE whatsapp_runtime_controls
            SET phone_hashes = array_remove(phone_hashes, $1),
                updated_by = $2,
                updated_at = now()
          WHERE control_key = $3`,
        [phoneHash, operator, action.controlKey],
      );
    }
    // If the control row is missing (e.g. the seeding migration has not
    // been applied yet), the UPDATE matches zero rows and would otherwise
    // report success having changed nothing.
    if (!result.rowCount) {
      throw new Error(
        `whatsapp_runtime_controls has no row for control_key '${action.controlKey}' — has the seeding migration been applied?`,
      );
    }
    return;
  }

  if (action.kind === 'go-global') {
    const result = await client.query(
      `UPDATE whatsapp_runtime_controls
          SET global_enabled = true, updated_by = $1, updated_at = now()
        WHERE control_key = $2`,
      [operator, action.controlKey],
    );
    if (!result.rowCount) {
      throw new Error(
        `whatsapp_runtime_controls has no row for control_key '${action.controlKey}' — has the seeding migration been applied?`,
      );
    }
    return;
  }
}

/**
 * One `--verify-templates` line: key, SID, existence, approval status, and --
 * since 2026-09-04 -- the WhatsApp CATEGORY.
 *
 * Category is on the line because status alone hid the defect that stopped
 * two employer notifications: Meta had recategorised three of the four
 * pending `application_*` templates to MARKETING, and a MARKETING template
 * cannot carry a transactional message outside the 24-hour session window.
 * All four still reported `pending`, so the command showed nothing wrong.
 *
 * Exported (and pure) so the formatting is testable without a Twilio account:
 * `main()` is not reachable from a test.
 */
export function formatTemplateVerificationRow(row: {
  key: string;
  sid: string;
  exists: boolean;
  whatsappStatus: string | null;
  whatsappCategory: string | null;
}): string {
  return [
    row.key,
    row.sid,
    row.exists ? 'exists' : 'MISSING',
    row.whatsappStatus ?? '-',
    row.whatsappCategory ?? '-',
  ].join('\t');
}

/**
 * `--verify-templates [--before-deploy]`. Reads the options after the
 * subcommand, runs the check, and prints one line per template, then each
 * notice (stdout, `NOTICE:`), then each failure (stderr, `FAIL:`). Returns the
 * exit code: 1 for an unknown option or any failure, otherwise 0. A notice
 * never fails the run.
 *
 * `--before-deploy` passes `beforeDeploy` to the check: a retired template key
 * that is still mapped is a notice instead of a failure. Every other rule is
 * unchanged. Notices also report an employer template whose WhatsApp category
 * is not UTILITY, with or without the option.
 *
 * Exported with the check injected so the parsing and the pass-through are
 * testable without AWS or Twilio; `main()` supplies verifyTwilioTemplates.
 */
export async function runVerifyTemplates(
  argv: string[],
  verify: (options: { beforeDeploy: boolean }) => Promise<VerifyTemplatesResult>,
  out: { log: (line: string) => void; error: (line: string) => void } = console,
): Promise<number> {
  let beforeDeploy = false;
  for (const arg of argv.slice(1)) {
    if (arg === '--before-deploy') {
      beforeDeploy = true;
      continue;
    }
    // Never echo a bare (non `--`) argument: it could be a misplaced raw phone.
    out.error(
      arg.startsWith('--')
        ? `Unrecognized flag for --verify-templates: ${arg}`
        : 'Unrecognized argument (redacted)',
    );
    return 1;
  }

  const result = await verify({ beforeDeploy });
  for (const row of result.rows) out.log(formatTemplateVerificationRow(row));
  for (const notice of result.notices) out.log(`NOTICE: ${notice}`);
  for (const failure of result.failures) out.error(`FAIL: ${failure}`);
  return result.failures.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--verify-templates') {
    const { verifyTwilioTemplates } = await import('./lib/verify-twilio-templates');
    const code = await runVerifyTemplates(
      process.argv.slice(2),
      (options) => verifyTwilioTemplates(options),
    );
    if (code !== 0) process.exitCode = code;
    return;
  }

  const parsed = parseControlsArgs(process.argv.slice(2));
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
    await runControlsAction(client, parsed.value, resolveOperator());
  } catch (err) {
    console.error(
      'whatsapp-runtime-controls failed:',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
