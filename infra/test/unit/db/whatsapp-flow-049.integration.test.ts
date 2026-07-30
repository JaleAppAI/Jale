import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: migration 049 PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-flow-049] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a disposable PostgreSQL 16 database.');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

async function asWhatsapp(sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    await client.query(sql, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

maybeDescribe('migration 049 WhatsApp v2 full-flow privileges', () => {
  const workerId = randomUUID();
  const cognitoSub = `wa-049-${workerId}`;
  const assessmentId = randomUUID();
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
    await setup.query('DELETE FROM worker_trust_assessments WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM legal_consent_log WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM users WHERE id = $1', [workerId]);
    await setup.end();
  });

  test('keeps grants column-scoped while exposing every legal and trust column the flow uses', async () => {
    const privileges = await setup.query<{
      privacy_read: boolean;
      rubric_read: boolean;
      rubric_insert: boolean;
      answers_update: boolean;
      rubric_update: boolean;
      model_update: boolean;
      broad_users_select: boolean;
      broad_trust_select: boolean;
      broad_trust_update: boolean;
    }>(`SELECT
      has_column_privilege('jale_whatsapp', 'public.users', 'privacy_accepted_at', 'SELECT') AS privacy_read,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'SELECT') AS rubric_read,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'INSERT') AS rubric_insert,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'answers', 'UPDATE') AS answers_update,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'UPDATE') AS rubric_update,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'scoring_model_id', 'UPDATE') AS model_update,
      has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') AS broad_users_select,
      has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'SELECT') AS broad_trust_select,
      has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'UPDATE') AS broad_trust_update`);

    expect(privileges.rows[0]).toEqual({
      privacy_read: true,
      rubric_read: true,
      rubric_insert: true,
      answers_update: true,
      rubric_update: true,
      model_update: true,
      broad_users_select: false,
      broad_trust_select: false,
      broad_trust_update: false,
    });
  });

  test('executes the canonical Legal Accept update and immutable consent insert as jale_whatsapp', async () => {
    await asWhatsapp(`
      WITH rls_context AS (
        SELECT set_config('app.current_user_id', $2, true)
      )
      UPDATE users
         SET tos_version = $3,
             tos_accepted_at = CASE WHEN tos_version IS DISTINCT FROM $3 THEN now() ELSE tos_accepted_at END,
             privacy_version = $3,
             privacy_accepted_at = CASE WHEN privacy_version IS DISTINCT FROM $3 THEN now() ELSE privacy_accepted_at END
        FROM rls_context
       WHERE id = $1
         AND (tos_version IS DISTINCT FROM $3 OR privacy_version IS DISTINCT FROM $3)`,
    [workerId, cognitoSub, '1.0']);

    await asWhatsapp(`INSERT INTO legal_consent_log
      (user_id, document_type, document_version, ip_address, user_agent)
      SELECT $1, document_type, $2, NULL, 'whatsapp'
        FROM (VALUES ('tos'), ('privacy')) AS documents(document_type)`,
    [workerId, '1.0']);

    const accepted = await setup.query(
      `SELECT tos_version, privacy_version, tos_accepted_at, privacy_accepted_at
         FROM users WHERE id = $1`,
      [workerId],
    );
    expect(accepted.rows[0]).toMatchObject({ tos_version: '1.0', privacy_version: '1.0' });
    expect(accepted.rows[0].tos_accepted_at).toBeTruthy();
    expect(accepted.rows[0].privacy_accepted_at).toBeTruthy();
    expect((await setup.query('SELECT 1 FROM legal_consent_log WHERE user_id = $1', [workerId])).rowCount).toBe(2);
  });

  test('inserts and appends trust answers with scoring provenance as jale_whatsapp', async () => {
    await asWhatsapp(`INSERT INTO worker_trust_assessments
      (id, user_id, profession_key, answers, status, rubric_version, scoring_model_id)
      VALUES ($1, $2, 'electrician', '[{"question_index":0}]'::jsonb, 'pending', 'rubric-v1', 'model-v1')`,
    [assessmentId, workerId]);

    await asWhatsapp(`UPDATE worker_trust_assessments
      SET answers = '[{"question_index":0},{"question_index":1}]'::jsonb,
          rubric_version = COALESCE('rubric-v2', rubric_version),
          scoring_model_id = COALESCE('model-v2', scoring_model_id)
      WHERE id = $1`, [assessmentId]);

    const assessment = await setup.query(
      `SELECT answers, rubric_version, scoring_model_id
         FROM worker_trust_assessments WHERE id = $1`,
      [assessmentId],
    );
    expect(assessment.rows[0]).toEqual({
      answers: [{ question_index: 0 }, { question_index: 1 }],
      rubric_version: 'rubric-v2',
      scoring_model_id: 'model-v2',
    });
  });
});
