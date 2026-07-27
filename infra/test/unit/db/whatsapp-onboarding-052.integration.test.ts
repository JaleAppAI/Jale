/**
 * whatsapp-onboarding-052.integration.test.ts (Task 4/B2)
 *
 * PostgreSQL-backed gate for migration 052's `worker_skills` DELETE grant
 * and policy, exercised through the REAL repository/adapter functions
 * (`resetPendingTrustAssessmentAndSkills`, `saveTrustAnswer`,
 * `findPreviousStepKey`) against REAL PostgreSQL 16 with migrations
 * 001-052 applied. No `pg` mock — every assertion reads back through a
 * superuser connection what the `jale_whatsapp` role actually wrote.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an
 * isolated, disposable database (see db/local/bootstrap-testbed.sh).
 */
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import {
  resetPendingTrustAssessmentAndSkills,
  findPreviousStepKey,
} from '../../../lambda/whatsapp/lib/onboarding-repository';
import { createOnboardingV2Adapters } from '../../../lambda/whatsapp/lib/onboarding-adapters';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: whatsapp-onboarding-052 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-onboarding-052] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-052 applied to run the ' +
        'real-PostgreSQL RESTART/BACK reset gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

/** Structural cast — the real modules under test type their client
 * parameter as `PoolClient` but only ever call query/BEGIN/COMMIT on it. */
function pc(client: Client): PoolClient {
  return client as unknown as PoolClient;
}

async function connectAsWhatsapp(workerId?: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE jale_whatsapp');
  if (workerId) {
    await setInternalUserRlsContext(client as unknown as PoolClient, workerId);
  }
  return client;
}

async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

maybeDescribe('migration 052: worker_skills reset + trust-answer upsert (real Postgres)', () => {
  const workerId = randomUUID();
  const cognitoSub = `wa-052-${workerId}`;
  let setup: Client;

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`,
      [workerId, cognitoSub],
    );
  });

  afterAll(async () => {
    await setup.query('DELETE FROM worker_workflow_transitions WHERE run_id IN (SELECT id FROM worker_workflow_runs WHERE user_id = $1)', [workerId]);
    await setup.query('DELETE FROM worker_workflow_runs WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM worker_skills WHERE worker_id = $1', [workerId]);
    await setup.query('DELETE FROM worker_trust_assessments WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM users WHERE id = $1', [workerId]);
    await setup.end();
  });

  test('migration 052 self-audit: jale_whatsapp has DELETE on worker_skills, guarded by a worker-scoped policy', async () => {
    const grant = await setup.query<{ has_delete: boolean }>(
      `SELECT has_table_privilege('jale_whatsapp', 'public.worker_skills', 'DELETE') AS has_delete`,
    );
    expect(grant.rows[0].has_delete).toBe(true);

    const policy = await setup.query(
      `SELECT 1 FROM pg_policies WHERE tablename = 'worker_skills' AND policyname = 'worker_skills_whatsapp_delete'`,
    );
    expect(policy.rowCount).toBe(1);
  });

  test('resetPendingTrustAssessmentAndSkills deletes worker_skills and resets ONLY the pending assessment, leaving a scored one untouched', async () => {
    await setup.query(`INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'electrician'), ($1, 'general_labor')`, [workerId]);

    const pendingId = randomUUID();
    const scoredId = randomUUID();
    await setup.query(
      `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status)
       VALUES ($1, $2, 'electrician', '[{"question_index":0,"answer_text":"abandoned trade answer"}]'::jsonb, 'pending')`,
      [pendingId, workerId],
    );
    await setup.query(
      `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status, competency_score, scored_at)
       VALUES ($1, $2, 'plumber', '[{"question_index":0,"answer_text":"already scored"}]'::jsonb, 'scored', 80, now())`,
      [scoredId, workerId],
    );

    const client = await connectAsWhatsapp(workerId);
    try {
      await resetPendingTrustAssessmentAndSkills(pc(client), workerId);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const skills = await setup.query('SELECT skill FROM worker_skills WHERE worker_id = $1', [workerId]);
    expect(skills.rowCount).toBe(0);

    const pending = await setup.query('SELECT answers, status FROM worker_trust_assessments WHERE id = $1', [pendingId]);
    expect(pending.rows[0]).toEqual({ answers: [], status: 'pending' });

    // A scored assessment must NEVER be touched by a RESTART reset.
    const scored = await setup.query('SELECT answers, status, competency_score FROM worker_trust_assessments WHERE id = $1', [scoredId]);
    expect(scored.rows[0]).toEqual({
      answers: [{ question_index: 0, answer_text: 'already scored' }],
      status: 'scored',
      competency_score: 80,
    });

    await setup.query('DELETE FROM worker_trust_assessments WHERE id = ANY($1)', [[pendingId, scoredId]]);
  });

  test('saveTrustAnswer REPLACES the element sharing question_index (BACK + re-answer) against a REAL row, never appends a duplicate', async () => {
    const adapters = createOnboardingV2Adapters({
      reconcileUserRow: async () => ({ userId: workerId, tosVersion: null }),
    });

    const client = await connectAsWhatsapp(workerId);
    try {
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 0,
        qEn: 'Q0 original',
        qEs: 'Q0 original es',
        answerText: 'original answer',
        answerSource: 'text',
      });
      // BACK, then re-answer the SAME question — must replace, not append.
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 0,
        qEn: 'Q0 corrected',
        qEs: 'Q0 corrected es',
        answerText: 'corrected answer',
        answerSource: 'text',
      });
      // A distinct question index still appends normally.
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 1,
        qEn: 'Q1',
        qEs: 'Q1 es',
        answerText: 'answer to Q1',
        answerSource: 'text',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const row = await setup.query<{ answers: Array<{ question_index: number; answer_text: string }> }>(
      `SELECT answers FROM worker_trust_assessments
        WHERE user_id = $1 AND profession_key = 'concrete' AND status = 'pending'`,
      [workerId],
    );
    expect(row.rowCount).toBe(1);
    const answers = row.rows[0].answers;
    expect(answers).toHaveLength(2);
    expect(answers.filter((a) => a.question_index === 0)).toHaveLength(1);
    expect(answers.find((a) => a.question_index === 0)?.answer_text).toBe('corrected answer');
    expect(answers.find((a) => a.question_index === 1)?.answer_text).toBe('answer to Q1');

    await setup.query(`DELETE FROM worker_trust_assessments WHERE user_id = $1 AND profession_key = 'concrete'`, [workerId]);
  });

  test('findPreviousStepKey excludes worker_back/worker_restart transitions and voice holding steps against REAL rows', async () => {
    const run = await setup.query<{ id: string }>(
      `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key)
       VALUES ($1, 1, 'trust.question.2') RETURNING id`,
      [workerId],
    );
    const runId = run.rows[0].id;

    // A genuine forward-progress history: legal.review -> profile.name ->
    // ... -> trust.question.1 -> trust.question.2, followed by a BACK/typed-
    // answer/BACK oscillation exactly like the production defect.
    const transitions: Array<[string | null, string, string]> = [
      [null, 'legal.review', 'otp_verified'],
      ['legal.review', 'profile.voice_choice', 'legal_accept'],
      ['profile.voice_choice', 'profile.voice_processing', 'profile_voice_ingest_started'],
      ['profile.voice_processing', 'profile.name', 'profile_voice_processing_timeout'],
      ['profile.name', 'trust.question.1', 'profile_answered'],
      ['trust.question.1', 'trust.question.2', 'trust_answer_recorded'],
      // First BACK: trust.question.2 -> trust.question.1.
      ['trust.question.2', 'trust.question.1', 'worker_back'],
      // Re-answer: trust.question.1 -> trust.question.2 again.
      ['trust.question.1', 'trust.question.2', 'trust_answer_recorded'],
    ];
    for (const [fromStepKey, toStepKey, reason] of transitions) {
      await setup.query(
        `INSERT INTO worker_workflow_transitions (run_id, from_step_key, to_step_key, reason)
         VALUES ($1, $2, $3, $4)`,
        [runId, fromStepKey, toStepKey, reason],
      );
    }

    const client = await connectAsWhatsapp(workerId);
    try {
      // A SECOND BACK from trust.question.2 must walk to trust.question.1 —
      // never bounce forward via the FIRST BACK's own `worker_back` row.
      const prev = await findPreviousStepKey(pc(client), runId, 'trust.question.2');
      expect(prev).toBe('trust.question.1');

      // BACK from profile.name must never land on either voice holding step,
      // even though the real transition history passed through them.
      const prevFromName = await findPreviousStepKey(pc(client), runId, 'profile.name');
      expect(prevFromName).not.toBe('profile.voice_choice');
      expect(prevFromName).not.toBe('profile.voice_processing');
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });
});
