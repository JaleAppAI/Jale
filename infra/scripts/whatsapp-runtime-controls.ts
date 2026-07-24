/**
 * Operator CLI: WhatsApp v2 runtime controls (whatsapp_runtime_controls, 042).
 *
 * Reads/writes the `onboarding_v2_enabled` and `deferred_delivery_enabled`
 * control rows. `--show` prints hashes only (never raw phones) and prints no
 * other table. `--allow-phone`/`--deny-phone` write/remove only the SHA-256
 * hash of the supplied phone via `hashNormalizedPhone` — the raw phone is
 * never persisted or printed.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/whatsapp-runtime-controls.ts --show
 *   npx ts-node scripts/whatsapp-runtime-controls.ts --enable onboarding_v2
 *   npx ts-node scripts/whatsapp-runtime-controls.ts --allow-phone +19152272188
 *   npx ts-node scripts/whatsapp-runtime-controls.ts --go-global
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import { hashNormalizedPhone } from '../lambda/whatsapp/lib/runtime-controls';
import { retriggerDeferredReadyWorkers } from '../lambda/whatsapp/lib/delivery-retrigger-sweep';

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** Maps the CLI's short control names to the seeded 042 control_key values. */
const CONTROL_KEY_MAP: Record<string, string> = {
  onboarding_v2: 'onboarding_v2_enabled',
  deferred_delivery: 'deferred_delivery_enabled',
};

export type ControlsAction =
  | { kind: 'show' }
  | { kind: 'enable'; controlKey: string }
  | { kind: 'disable'; controlKey: string }
  | { kind: 'allow-phone'; phone: string }
  | { kind: 'deny-phone'; phone: string }
  | { kind: 'go-global' };

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
 */
export function parseControlsArgs(argv: string[]): ParseControlsArgsResult {
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
    return { ok: true, value: { kind: 'go-global' } };
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
        error: 'Unknown control name (must be onboarding_v2 or deferred_delivery)',
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
    if (action.kind === 'allow-phone') {
      await client.query(
        `UPDATE whatsapp_runtime_controls
            SET phone_hashes = CASE
                  WHEN $1 = ANY(phone_hashes) THEN phone_hashes
                  ELSE array_append(phone_hashes, $1)
                END,
                updated_by = $2,
                updated_at = now()
          WHERE control_key = 'onboarding_v2_enabled'`,
        [phoneHash, operator],
      );
    } else {
      await client.query(
        `UPDATE whatsapp_runtime_controls
            SET phone_hashes = array_remove(phone_hashes, $1),
                updated_by = $2,
                updated_at = now()
          WHERE control_key = 'onboarding_v2_enabled'`,
        [phoneHash, operator],
      );
    }
    return;
  }

  if (action.kind === 'go-global') {
    await client.query(
      `UPDATE whatsapp_runtime_controls
          SET global_enabled = true, updated_by = $1, updated_at = now()
        WHERE control_key = 'onboarding_v2_enabled'`,
      [operator],
    );
    return;
  }
}

async function main(): Promise<void> {
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
