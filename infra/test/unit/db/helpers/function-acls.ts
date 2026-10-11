/**
 * function-acls.ts -- put function EXECUTE grants back after a suite replays a
 * migration.
 *
 * A migration that drops and recreates its functions also drops the EXECUTE
 * grants later migrations added to them, and the recreated functions follow
 * the default privileges in force at replay time, not at first apply. A suite
 * that replays such a migration saves every function's EXECUTE holders first
 * and restores them afterwards, so the suites that run after it see the bed
 * the chain built. Run both as the superuser.
 */
import type { ClientBase } from 'pg';

/** EXECUTE holders per function, keyed by its schema-qualified signature. */
export type ExecuteGrants = Map<string, Set<string>>;

/** A holder as `role` or `role*` (WITH GRANT OPTION); PUBLIC is `PUBLIC`. */
export async function readExecuteGrants(client: ClientBase): Promise<ExecuteGrants> {
  const { rows } = await client.query<{ fn: string; holders: string[] }>(`
    SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname)
             || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS fn,
           COALESCE(array_agg(
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
               || CASE WHEN a.is_grantable THEN '*' ELSE '' END
           ) FILTER (WHERE a.privilege_type = 'EXECUTE'), '{}') AS holders
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a ON true
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%'
     GROUP BY n.nspname, p.proname, p.oid`);
  return new Map(rows.map((row) => [row.fn, new Set(row.holders)]));
}

/**
 * Grants and revokes EXECUTE until every function in `saved` that still exists
 * has exactly its saved holders. Returns the statements it ran.
 */
export async function restoreExecuteGrants(client: ClientBase, saved: ExecuteGrants): Promise<string[]> {
  const current = await readExecuteGrants(client);
  const statements: string[] = [];
  for (const [fn, before] of saved) {
    const now = current.get(fn);
    if (!now) continue;
    for (const holder of now) {
      if (!before.has(holder)) statements.push(`REVOKE EXECUTE ON FUNCTION ${fn} FROM ${holder.replace(/\*$/, '')} CASCADE`);
    }
    for (const holder of before) {
      if (now.has(holder)) continue;
      const grantable = holder.endsWith('*');
      statements.push(`GRANT EXECUTE ON FUNCTION ${fn} TO ${holder.replace(/\*$/, '')}${grantable ? ' WITH GRANT OPTION' : ''}`);
    }
  }
  for (const sql of statements) await client.query(sql);
  return statements;
}
