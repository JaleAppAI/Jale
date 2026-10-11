/**
 * audit-posture.integration.test.ts -- the audit checks of the posture run
 * (infra/db/access/posture-audit.ts) on a real bed.
 *
 *   - As the catalog-only posture login, the audit reads succeed and a correct
 *     bed is clean, alone and together with the core checks and the merged
 *     manifest (fragment included).
 *   - Each fault is named: a disabled change-record trigger, a disabled guard
 *     trigger, a dropped one, a grant on an audit table, and a personal
 *     operator login holding a table privilege. Faults are made and read in
 *     one superuser transaction that is rolled back, so no other suite ever
 *     sees them.
 */
import { Client } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { checkPosture } from '../../../db/access/posture';
import { auditPosture } from '../../../db/access/posture-audit';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit posture PostgreSQL gate was not run', () => {
    console.warn('[audit-posture] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('audit posture', () => {
  const manifest = loadManifest();

  it('the posture login reads the audit catalog, and a correct bed is clean', async () => {
    const violations = await withLoginClient('jale_posture', async (c) => auditPosture.evaluate(await auditPosture.read(c), manifest));
    expect(violations).toEqual([]);
  });

  it('the whole run, core checks included, is complete and clean with the audit checks and the merged manifest', async () => {
    const result = await withLoginClient('jale_posture', (c) => checkPosture(c, manifest, [auditPosture]));
    expect(result.violations).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('names each fault: disabled and dropped triggers, an audit-table grant, a personal login with a table privilege', async () => {
    const su = new Client({ connectionString: databaseUrl });
    await su.connect();
    try {
      await su.query('BEGIN');
      await su.query('ALTER TABLE public.users DISABLE TRIGGER users_audit_change_update');
      await su.query('DROP TRIGGER worker_skills_audit_change_truncate ON public.worker_skills');
      await su.query('ALTER TABLE jale_audit.events DISABLE TRIGGER events_append_only');
      await su.query('ALTER TABLE public.admin_audit_log DISABLE TRIGGER admin_audit_log_scrub');
      await su.query('GRANT SELECT ON jale_audit.changes TO jale_api');
      await su.query(`CREATE ROLE jale_person_tst LOGIN VALID UNTIL '2099-01-01'`);
      await su.query('GRANT jale_ops_readonly TO jale_person_tst WITH INHERIT TRUE, SET FALSE');
      await su.query('GRANT SELECT ON public.jobs TO jale_person_tst');
      const violations = auditPosture.evaluate(await auditPosture.read(su), manifest);
      expect(violations).toEqual([
        { check: 'audit_change_trigger', object: 'public.users.users_audit_change_update', detail: 'not enabled (tgenabled D)' },
        { check: 'audit_change_trigger', object: 'public.worker_skills.worker_skills_audit_change_truncate', detail: 'missing' },
        { check: 'audit_guard_trigger', object: 'jale_audit.events.events_append_only', detail: 'not enabled (tgenabled D)' },
        { check: 'audit_guard_trigger', object: 'public.admin_audit_log.admin_audit_log_scrub', detail: 'not enabled (tgenabled D)' },
        { check: 'audit_table_grants', object: 'jale_audit.changes', detail: 'jale_api holds SELECT' },
        { check: 'person_login_privileges', object: 'jale_person_tst', detail: 'holds 1 table, column or sequence privilege' },
      ]);
    } finally {
      await su.query('ROLLBACK');
      await su.end();
    }
  });
});
