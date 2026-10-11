import { createHash, randomBytes } from 'node:crypto';
import type { AdminRole } from '../types';
import type { AdminSession } from './session-claims';

type QueryResult<Row> = {
  rows: Row[];
};

export type AdminSessionDb = {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
};

type SessionStoreOptions = {
  now?: () => Date;
  randomToken?: () => string;
};

type SessionRow = {
  session_id: string;
  admin_user_id: string;
  cognito_sub: string;
  admin_email: string;
  role: AdminRole;
  expires_at: Date;
};

export type ActiveAdminSession = AdminSession & {
  sessionId: string;
  adminUserId: string;
  expiresAt: Date;
};

const SESSION_TTL_MS = 60 * 60 * 1000;

export function hashAdminSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function hashUserAgent(userAgent: string | undefined): string | null {
  const normalized = userAgent?.trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

export class AdminSessionStore {
  private readonly now: () => Date;
  private readonly randomToken: () => string;

  constructor(
    private readonly db: AdminSessionDb,
    options: SessionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async create(
    identity: AdminSession,
    metadata: { userAgent?: string } = {},
  ): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = this.randomToken();
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    const result = await this.db.query<{ expires_at: Date }>(
      `INSERT INTO admin_sessions
         (token_hash, admin_user_id, cognito_jti, expires_at, user_agent_hash)
       SELECT $1, id, NULL, $3, $4
         FROM admin_users
        WHERE cognito_sub = $2
          AND active = true
          AND role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')
       RETURNING expires_at`,
      [
        hashAdminSessionToken(rawToken),
        identity.sub,
        expiresAt,
        hashUserAgent(metadata.userAgent),
      ],
    );

    if (result.rows.length !== 1) {
      throw new Error('Admin account is inactive or not provisioned');
    }

    return {
      rawToken,
      expiresAt: new Date(result.rows[0].expires_at),
    };
  }

  async resolve(rawToken: string): Promise<ActiveAdminSession | undefined> {
    if (!rawToken) {
      return undefined;
    }

    const result = await this.db.query<SessionRow>(
      `SELECT
         s.id AS session_id,
         u.id AS admin_user_id,
         u.cognito_sub,
         u.admin_email,
         u.role,
         s.expires_at
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
        AND u.active = true
        AND u.cognito_sub IS NOT NULL
        AND u.role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')
      LIMIT 1`,
      [hashAdminSessionToken(rawToken), this.now()],
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      sessionId: row.session_id,
      adminUserId: row.admin_user_id,
      sub: row.cognito_sub,
      email: row.admin_email,
      role: row.role,
      groups: [row.role],
      expiresAt: new Date(row.expires_at),
    };
  }

  async revoke(rawToken: string, reason: string): Promise<void> {
    if (!rawToken) {
      return;
    }

    await this.db.query(
      `UPDATE admin_sessions
          SET revoked_at = COALESCE(revoked_at, NOW()),
              revoke_reason = COALESCE(revoke_reason, $2)
        WHERE token_hash = $1`,
      [hashAdminSessionToken(rawToken), reason],
    );
  }

  async revokeAllForAdmin(adminUserId: string, reason: string): Promise<number> {
    const result = await this.db.query<{ revoked_count: number }>(
      `WITH revoked AS (
         UPDATE admin_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()),
                revoke_reason = COALESCE(revoke_reason, $2)
          WHERE admin_user_id = $1
            AND revoked_at IS NULL
         RETURNING id
       )
       SELECT COUNT(*)::int AS revoked_count FROM revoked`,
      [adminUserId, reason],
    );

    return Number(result.rows[0]?.revoked_count ?? 0);
  }
}
