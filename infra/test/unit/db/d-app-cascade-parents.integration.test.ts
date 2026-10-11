/**
 * d-app-cascade-parents.integration.test.ts
 *
 * The static writer check (test/unit/lambda/audit-writers.test.ts) counts a
 * DELETE on a table outside the change log as a covered write when the
 * delete reaches a covered table through foreign keys. Its list of those
 * tables, CASCADE_PARENTS, is checked here against the catalog of a bed
 * with the whole migration chain applied, by the change triggers' own rule:
 *
 *   - ON DELETE CASCADE removes the child rows, a covered change whenever
 *     the child is covered or itself reaches a covered table;
 *   - SET NULL and SET DEFAULT update the child's key columns, which writes
 *     a change record only when one of those columns is covered, and goes no
 *     further;
 *   - reach is transitive.
 *
 * The list must match exactly: a missing parent would let an uncounted
 * delete change covered rows, an extra one would demand context where no
 * covered row can change.
 */
import { Client } from 'pg';
import { CASCADE_PARENTS, loadChangeLogTables } from '../lambda/audit-source-scan';
import { describeInProfiles } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

interface ForeignKey {
  child: string;
  parent: string;
  action: 'c' | 'n' | 'd';
  columns: string[];
}

describeInProfiles(['request', 'owner-unrestricted'], 'cascade parents of the change-log tables match the catalog', () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su?.end();
  });

  it('CASCADE_PARENTS is exactly the set of tables whose deletes reach a covered column', async () => {
    const { rows: keys } = await su.query<ForeignKey>(
      `SELECT format('%I.%I', cn.nspname, cc.relname) AS child,
              format('%I.%I', pn.nspname, pc.relname) AS parent,
              c.confdeltype::text AS action,
              ARRAY(
                SELECT a.attname::text
                  FROM unnest(CASE WHEN c.confdeltype IN ('n', 'd') AND cardinality(c.confdelsetcols) > 0
                                   THEN c.confdelsetcols ELSE c.conkey END) AS k(attnum)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS columns
         FROM pg_constraint c
         JOIN pg_class cc ON cc.oid = c.conrelid
         JOIN pg_namespace cn ON cn.oid = cc.relnamespace
         JOIN pg_class pc ON pc.oid = c.confrelid
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd')`,
    );
    expect(keys.length).toBeGreaterThan(0);

    const covered = new Map<string, ReadonlySet<string>>();
    for (const [table, columns] of loadChangeLogTables().columns) covered.set(`public.${table}`, columns);

    const reaches = new Set<string>(covered.keys());
    for (let grew = true; grew;) {
      grew = false;
      for (const key of keys) {
        if (reaches.has(key.parent)) continue;
        const coveredColumns = covered.get(key.child);
        const reached = key.action === 'c'
          ? reaches.has(key.child)
          : coveredColumns !== undefined && key.columns.some((column) => coveredColumns.has(column));
        if (reached) {
          reaches.add(key.parent);
          grew = true;
        }
      }
    }

    const parents = [...reaches]
      .filter((table) => !covered.has(table))
      .map((table) => (table.startsWith('public.') ? table.slice('public.'.length) : table))
      .sort();
    expect(parents).toEqual([...CASCADE_PARENTS].sort());
  });
});

if (!databaseUrl) {
  test('CONCERN: the cascade parents DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
