import type { Client, PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';

/**
 * Who is calling an employer route, and whose jobs they may act on.
 *
 * Every employer login belongs to one company (organization_members,
 * migration 118). A foreman acts on their own jobs; the company's active
 * owner acts on every member's jobs (the database agrees: migration 119's
 * *_org_owner policies). Handlers scope SQL with
 * `employer_id = ANY($n::uuid[])` and `scopeUserIds`, and create rows as
 * `userId`.
 *
 * Call after BEGIN and setRlsContext(client, cognitoSub). On success the
 * transaction's app.current_internal_user_id is the caller.
 */
export type EmployerRole = 'owner' | 'foreman';

export interface EmployerActor {
  userId: string;
  organizationId: string;
  role: EmployerRole;
  /** The owner: every member (any status), the owner first. A foreman: [userId]. */
  scopeUserIds: string[];
}

export type EmployerActorFailure =
  | { ok: false; status: 409; error: 'user_not_provisioned' }
  | { ok: false; status: 403; error: 'no_organization' | 'membership_inactive' };

export type EmployerActorResult = { ok: true; actor: EmployerActor } | EmployerActorFailure;

type CallerRow = {
  user_id: string;
  organization_id: string | null;
  role: EmployerRole | null;
  status: 'active' | 'suspended' | 'removed' | null;
};

export async function resolveEmployerActor(
  client: Client | PoolClient,
  cognitoSub: string,
  options: { lockUser?: boolean } = {},
): Promise<EmployerActorResult> {
  const caller = await client.query<CallerRow>(
    `SELECT u.id AS user_id, m.organization_id, m.role, m.status
       FROM users u
       LEFT JOIN organization_members m ON m.user_id = u.id
      WHERE u.cognito_sub = $1
        AND u.user_type = 'employer'${options.lockUser ? '\n      FOR UPDATE OF u' : ''}`,
    [cognitoSub],
  );
  const row = caller.rows[0];
  if (!row) return { ok: false, status: 409, error: 'user_not_provisioned' };
  if (!row.organization_id || !row.role) return { ok: false, status: 403, error: 'no_organization' };
  if (row.status !== 'active') return { ok: false, status: 403, error: 'membership_inactive' };

  await setInternalUserRlsContext(client, row.user_id);

  let scopeUserIds = [row.user_id];
  if (row.role === 'owner') {
    const members = await client.query<{ user_id: string }>(
      `SELECT user_id
         FROM organization_members
        WHERE organization_id = $1
        ORDER BY (user_id = $2) DESC, joined_at, user_id`,
      [row.organization_id, row.user_id],
    );
    scopeUserIds = members.rows.map((m) => m.user_id);
  }

  return {
    ok: true,
    actor: { userId: row.user_id, organizationId: row.organization_id, role: row.role, scopeUserIds },
  };
}

export function employerActorFailureResponse(
  failure: EmployerActorFailure,
  headers: Record<string, string>,
): { statusCode: number; headers: Record<string, string>; body: string } {
  return { statusCode: failure.status, headers, body: JSON.stringify({ error: failure.error }) };
}
