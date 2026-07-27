/**
 * whatsapp-onboarding-reset.integration.test.ts
 *
 * PostgreSQL-backed gate for the operator reset CLI's `runReset`, against
 * REAL PostgreSQL 16 with migrations 001-052 applied. Exists because the
 * CLI shipped with a bind-list bug no mock could catch: every per-table
 * statement was handed the full [userId, phone, phoneHash] list, and the
 * extended query protocol rejects a Bind carrying more parameters than the
 * statement's highest `$n` — the very first `user_id = $1` step failed with
 * "bind message supplies 3 parameters, but prepared statement requires 1"
 * on its first real production run. The unit-test fake client accepted any
 * bind list, so only a real database can hold this gate.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an
 * isolated, disposable database (see db/local/bootstrap-testbed.sh).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { runReset, bindStatement } from '../../../scripts/reset-whatsapp-onboarding-v2';
import { hashNormalizedPhone } from '../../../lambda/whatsapp/lib/runtime-controls';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: whatsapp-onboarding-reset PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-onboarding-reset] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-052 applied to run the ' +
        'real-PostgreSQL reset-CLI gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

describe('bindStatement', () => {
  const params = ['uid', '+15555550000', 'hash'];

  it('binds only the referenced parameters, renumbered densely', () => {
    expect(bindStatement('user_id = $1', params)).toEqual({
      text: 'user_id = $1',
      values: ['uid'],
    });
    // $2-only: the statement must not carry an untyped, unused $1.
    expect(bindStatement('whatsapp_number = $2', params)).toEqual({
      text: 'whatsapp_number = $1',
      values: ['+15555550000'],
    });
    // $1 + $3 skipping $2 — the exact shape that produced
    // "could not determine data type of parameter $2" in production.
    expect(bindStatement('a = $1 AND b = $3', params)).toEqual({
      text: 'a = $1 AND b = $2',
      values: ['uid', 'hash'],
    });
    // Repeated references stay consistent; a dense set is left unchanged.
    expect(bindStatement('a = $2 OR b = $2 OR c = $1', params)).toEqual({
      text: 'a = $2 OR b = $2 OR c = $1',
      values: ['uid', '+15555550000'],
    });
    // $2 + $3 skipping $1 renumbers both.
    expect(bindStatement('a = $2 AND b = $3', params)).toEqual({
      text: 'a = $1 AND b = $2',
      values: ['+15555550000', 'hash'],
    });
  });

  it('returns an empty bind list for a statement with no placeholders', () => {
    expect(bindStatement('SELECT now()', params)).toEqual({
      text: 'SELECT now()',
      values: [],
    });
  });
});

maybeDescribe('reset CLI runReset against real PostgreSQL', () => {
  const workerId = randomUUID();
  const phone = '+15555550099';
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO users (id, cognito_sub, user_type, phone, whatsapp_number, full_name, main_trade, city)
       VALUES ($1, $2, 'worker', $3, $4, 'Reset Target', 'electrician', 'El Paso')`,
      [workerId, `reset-gate-${workerId}`, phone, phone],
    );
    await admin.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'ready')`,
      [workerId],
    );
    await admin.query(
      `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
       VALUES ($1, 1, 'trust.question.3', 'completed')`,
      [workerId],
    );
    await admin.query(
      `INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'electrician')`,
      [workerId],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM worker_reset_audit WHERE user_id = $1', [workerId]);
    await admin.query('DELETE FROM worker_workflow_runs WHERE user_id = $1', [workerId]);
    await admin.query('DELETE FROM worker_onboarding_state WHERE user_id = $1', [workerId]);
    await admin.query('DELETE FROM worker_skills WHERE worker_id = $1', [workerId]);
    await admin.query('DELETE FROM users WHERE id = $1', [workerId]);
    await admin.end();
  });

  it('dry-run counts every table without mutating anything', async () => {
    const outcome = await runReset(admin, {
      userId: workerId,
      phone,
      reason: 'integration gate dry-run',
      dryRun: true,
      operator: 'reset-gate',
    });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.tableCounts.worker_workflow_runs).toBe(1);
    expect(outcome.tableCounts.worker_skills).toBe(1);
    expect(outcome.tableCounts.users).toBe(1);

    // Nothing was touched: run still completed, skill still present.
    const run = await admin.query(
      `SELECT status FROM worker_workflow_runs WHERE user_id = $1`,
      [workerId],
    );
    expect(run.rows).toEqual([{ status: 'completed' }]);
  });

  it('refuses a phone that does not match the verified whatsapp_number', async () => {
    await expect(
      runReset(admin, {
        userId: workerId,
        phone: '+15555559999',
        reason: 'integration gate mismatch',
        dryRun: true,
        operator: 'reset-gate',
      }),
    ).rejects.toThrow(/No matching worker/);
  });

  it('execute wipes state, seeds NO run, and the verified bind then creates one at legal.review', async () => {
    const outcome = await runReset(admin, {
      userId: workerId,
      phone,
      reason: 'integration gate execute',
      dryRun: false,
      operator: 'reset-gate',
    });

    expect(outcome.dryRun).toBe(false);
    expect(outcome.auditId).toBeDefined();

    // Incident pin (2026-07-27): the reset must NOT seed a run. An earlier
    // version seeded one at 'start.choose_language'; the verified-OTP
    // rebind (046 semantics) reused it untouched and the bound router then
    // crashed on every message ("unhandled bound step"), softlocking the
    // worker. Runs are only legitimately born in
    // bind_verified_identity_and_start_workflow, at 'legal.review'.
    const runs = await admin.query(
      `SELECT 1 FROM worker_workflow_runs WHERE user_id = $1`,
      [workerId],
    );
    expect(runs.rowCount).toBe(0);

    const state = await admin.query(
      `SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`,
      [workerId],
    );
    expect(state.rows).toEqual([{ lifecycle: 'onboarding' }]);

    // Prove the post-reset flow end-to-end at the SQL layer: a fresh
    // conversation + pending challenge (what the pre-auth lane creates),
    // then the verified bind — which must create the run at legal.review.
    const conversationId = randomUUID();
    const phoneHash = hashNormalizedPhone(phone);
    await admin.query(
      `INSERT INTO whatsapp_conversations (id, user_id, whatsapp_number, conversation_state)
       VALUES ($1, NULL, $2, 'awaiting_otp')`,
      [conversationId, phone],
    );
    const bindClient = new Client({ connectionString: databaseUrl });
    await bindClient.connect();
    try {
      await bindClient.query('BEGIN');
      await bindClient.query('SET LOCAL ROLE jale_whatsapp');
      await bindClient.query('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [
        phoneHash,
        JSON.stringify({
          provider_challenge_id: 'reset-gate-provider',
          current_step_key: 'identity.verify_otp',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }),
      ]);
      const bound = await bindClient.query(
        'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,1,$4,$5,$6::jsonb)',
        [phoneHash, workerId, conversationId, 'es', 'SMreset-gate-bind', '{}'],
      );
      expect(bound.rows).toHaveLength(1);
      await bindClient.query('COMMIT');
    } finally {
      await bindClient.end();
    }

    const bornRun = await admin.query(
      `SELECT current_step_key, status FROM worker_workflow_runs WHERE user_id = $1`,
      [workerId],
    );
    expect(bornRun.rows).toEqual([{ current_step_key: 'legal.review', status: 'active' }]);

    await admin.query('DELETE FROM worker_workflow_transitions WHERE run_id IN (SELECT id FROM worker_workflow_runs WHERE user_id = $1)', [workerId]);
    await admin.query('DELETE FROM worker_workflow_runs WHERE user_id = $1', [workerId]);
    await admin.query('DELETE FROM worker_identity_challenges WHERE phone_hash = $1', [phoneHash]);
    await admin.query('DELETE FROM whatsapp_conversations WHERE id = $1', [conversationId]);

    const skills = await admin.query(
      `SELECT 1 FROM worker_skills WHERE worker_id = $1`,
      [workerId],
    );
    expect(skills.rowCount).toBe(0);

    const cleared = await admin.query(
      `SELECT full_name, main_trade, city FROM users WHERE id = $1`,
      [workerId],
    );
    expect(cleared.rows).toEqual([{ full_name: null, main_trade: null, city: null }]);

    const audit = await admin.query(
      `SELECT operator, dry_run FROM worker_reset_audit WHERE id = $1`,
      [outcome.auditId],
    );
    expect(audit.rows).toEqual([{ operator: 'reset-gate', dry_run: false }]);
  });
});
