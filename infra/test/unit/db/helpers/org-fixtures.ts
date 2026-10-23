import type { Client } from 'pg';

/**
 * Companies for DB fixtures.
 *
 * Every real employer is the active owner of a company (migration 118, and
 * post-confirmation since Phase 1). Billing rows belong to the payer's company:
 * migration 127 stamps billing_customers / subscriptions.organization_id from
 * the payer's membership and makes it NOT NULL, so a fixture that pays needs a
 * company first. Run on the superuser fixture connection.
 */

/**
 * Makes `userId` the active owner of a one-person company, unless they already
 * belong to one, and returns the company id. Idempotent: suites whose fixture
 * users survive between runs call it every time.
 */
export async function ensureOwnerCompany(client: Client, userId: string, name = 'Fixture Company'): Promise<string> {
  const existing = await client.query<{ organization_id: string; role: string; status: string }>(
    'SELECT organization_id, role, status FROM organization_members WHERE user_id = $1',
    [userId],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.role === 'owner' && row.status === 'active') return row.organization_id;
    throw new Error(`ensureOwnerCompany: ${userId} already belongs to a company as ${row.role}/${row.status}`);
  }
  const org = (await client.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  )).rows[0].id;
  await client.query(
    `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
    [userId, org],
  );
  return org;
}

/**
 * Removes companies a suite created. Call it after the suite's billing rows
 * are deleted: from 127 on they restrict their company (ON DELETE RESTRICT).
 */
export async function dropCompanies(client: Client, organizationIds: string[]): Promise<void> {
  const ids = organizationIds.filter(Boolean);
  if (ids.length === 0) return;
  await client.query('DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])', [ids]);
  await client.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [ids]);
}
