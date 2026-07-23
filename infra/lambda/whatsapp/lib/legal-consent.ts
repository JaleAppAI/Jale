import type { PoolClient } from 'pg';
import { setRlsContext } from '../../lib/db';

/**
 * Records WhatsApp legal acceptance on the caller-owned transaction.
 * The canonical user fields and immutable audit rows are repaired
 * independently so a partial historical write remains recoverable.
 */
export async function recordCanonicalWhatsAppConsent(
  client: PoolClient,
  input: { workerId: string; documentVersion: string },
): Promise<void> {
  const user = await client.query<{ cognito_sub: string }>(
    'SELECT cognito_sub FROM users WHERE id = $1',
    [input.workerId],
  );
  if ((user.rowCount ?? 0) === 0) {
    throw new Error('user missing at consent time');
  }

  await setRlsContext(client, user.rows[0].cognito_sub);

  await client.query(
    `UPDATE users
        SET tos_version = $2,
            tos_accepted_at = CASE WHEN tos_version IS DISTINCT FROM $2 THEN now() ELSE tos_accepted_at END,
            privacy_version = $2,
            privacy_accepted_at = CASE WHEN privacy_version IS DISTINCT FROM $2 THEN now() ELSE privacy_accepted_at END
      WHERE id = $1
        AND (tos_version IS DISTINCT FROM $2 OR privacy_version IS DISTINCT FROM $2)`,
    [input.workerId, input.documentVersion],
  );

  await client.query(
    `INSERT INTO legal_consent_log
        (user_id, document_type, document_version, ip_address, user_agent)
     SELECT $1, d.document_type, $2, NULL, 'whatsapp'
       FROM (VALUES ('tos'), ('privacy')) AS d(document_type)
      WHERE NOT EXISTS (
        SELECT 1
          FROM legal_consent_log existing
         WHERE existing.user_id = $1
           AND existing.document_type = d.document_type
           AND existing.document_version = $2
      )`,
    [input.workerId, input.documentVersion],
  );
}
