import { Client } from 'pg';

export interface ComplianceResult {
  compliant: boolean;
  currentVersion: string | null;
}

/**
 * Check whether a user has accepted the required ToS version.
 *
 * This is a shared utility function (not a Lambda handler) intended to be
 * imported by other Lambda handlers that need to gate access on legal
 * compliance before proceeding with their primary logic.
 */
export async function checkCompliance(
  dbClient: Client,
  cognitoSub: string,
  requiredTosVersion: string,
): Promise<ComplianceResult> {
  const result = await dbClient.query(
    'SELECT tos_version FROM users WHERE cognito_sub = $1',
    [cognitoSub],
  );

  if (result.rows.length === 0) {
    return { compliant: false, currentVersion: null };
  }

  const user = result.rows[0];
  return {
    compliant: user.tos_version === requiredTosVersion,
    currentVersion: user.tos_version ?? null,
  };
}
