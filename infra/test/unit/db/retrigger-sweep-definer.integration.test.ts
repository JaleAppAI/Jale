import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: retrigger sweep definer PostgreSQL gate was not run', () => {
    console.warn('[retrigger-sweep-definer] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('retrigger_deferred_ready_workers definer (migration 071)', () => {
  it('executes as jale_whatsapp and returns zero counts on empty data', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      const result = await client.query(
        `SELECT workers_swept, events_enqueued FROM retrigger_deferred_ready_workers($1, $2)`,
        ['r71-test-run', 10],
      );
      expect(result.rows).toEqual([{ workers_swept: 0, events_enqueued: 0 }]);
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  });

  it('rejects invalid inputs', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await expect(
        client.query(`SELECT * FROM retrigger_deferred_ready_workers('', 10)`),
      ).rejects.toThrow(/retrigger_sweep_invalid_run_id/);
      await expect(
        client.query(`SELECT * FROM retrigger_deferred_ready_workers('r71', 0)`),
      ).rejects.toThrow(/retrigger_sweep_invalid_limit/);
    } finally { await client.end(); }
  });

  it('keeps the reviewed ACL: no PUBLIC execute, jale_whatsapp can execute', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const acl = await client.query(
        `SELECT has_function_privilege('jale_whatsapp',
                  'public.retrigger_deferred_ready_workers(TEXT, INTEGER)', 'EXECUTE') AS wa_exec,
                NOT EXISTS (
                  SELECT 1 FROM pg_proc p,
                       LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure('public.retrigger_deferred_ready_workers(TEXT, INTEGER)')
                     AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
                ) AS no_public_exec`,
      );
      expect(acl.rows[0]).toEqual({ wa_exec: true, no_public_exec: true });
    } finally { await client.end(); }
  });
});
