import { createHash, randomBytes } from 'node:crypto';
import type { AdminRole } from '../types';
import type { AdminIdentity } from './session-claims';

type QueryResult<Row> = {
  rows: Row[];
};

export type AdminSessionDb = {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
};

/** The admin and session an expiry or a sign-out applied to. */
export type EndedAdminSession = {
  sessionId: string;
  adminUserId: string;
  role: AdminRole;
};

/**
 * A session ended at sign-out, and whether it was still live then. A session
 * already past its expiry ended by expiring, and is marked expired.
 */
export type RevokedAdminSession = EndedAdminSession & { live: boolean };

type SessionStoreOptions = {
  now?: () => Date;
  randomToken?: () => string;
  /**
   * Called by the one resolve that marks an expired session revoked. Parallel
   * resolves of the same expired session never call it twice.
   */
  onExpired?: (expired: EndedAdminSession) => Promise<void>;
};

type SessionRow = {
  session_id: string;
  admin_user_id: string;
  cognito_sub: string;
  admin_email: string;
  role: AdminRole;
  expires_at: Date;
  active: boolean;
  /** Whether the last touch is a minute old or more. */
  needs_touch?: boolean;
};

export type ActiveAdminSession = AdminIdentity & {
  sessionId: string;
  adminUserId: string;
  expiresAt: Date;
};

/** A session ends after this long without a request (contract K1.3). */
export const ADMIN_SESSION_IDLE_SECONDS = 60 * 60;
/** A session ends this long after sign-in, however busy (contract K1.3). */
export const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;
/**
 * A resolve moves the idle window at most this often, so a page that resolves
 * the session several times writes once.
 */
export const ADMIN_SESSION_TOUCH_SECONDS = 60;
const IDLE_MS = ADMIN_SESSION_IDLE_SECONDS * 1000;
const MAX_MS = ADMIN_SESSION_MAX_SECONDS * 1000;
const TOUCH_MS = ADMIN_SESSION_TOUCH_SECONDS * 1000;

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
  private readonly onExpired?: (expired: EndedAdminSession) => Promise<void>;

  constructor(
    private readonly db: AdminSessionDb,
    options: SessionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.onExpired = options.onExpired;
  }

  /**
   * The active admin a verified sign-in names, or undefined. Sign-in reads it
   * before anything else: device trust is kept per admin.
   */
  async findActiveAdmin(sub: string): Promise<{ id: string; role: AdminRole } | undefined> {
    const result = await this.db.query<{ id: string; role: AdminRole }>(
      `SELECT id, role FROM admin_users
        WHERE cognito_sub = $1
          AND active = true
          AND role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')`,
      [sub],
    );
    return result.rows[0];
  }

  async create(
    identity: AdminIdentity,
    metadata: { userAgent?: string } = {},
  ): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = this.randomToken();
    const expiresAt = new Date(this.now().getTime() + IDLE_MS);
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

    // Expiry is computed rather than filtered, so that an expired session is
    // seen once more: the resolve that marks it revoked records the expiry.
    // A session has ended at its stored expiry, after an idle hour (no touch
    // since), or eight hours after sign-in, whichever comes first. Every time
    // comes from the store's clock.
    const now = this.now();
    const result = await this.db.query<SessionRow>(
      `SELECT
         s.id AS session_id,
         u.id AS admin_user_id,
         u.cognito_sub,
         u.admin_email,
         u.role,
         s.expires_at,
         (s.expires_at > $2 AND s.last_seen_at > $3 AND s.created_at > $4) AS active,
         s.last_seen_at <= $5 AS needs_touch
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND u.active = true
        AND u.cognito_sub IS NOT NULL
        AND u.role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')
      LIMIT 1`,
      [
        hashAdminSessionToken(rawToken),
        now,
        new Date(now.getTime() - IDLE_MS),
        new Date(now.getTime() - MAX_MS),
        new Date(now.getTime() - TOUCH_MS),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    if (row.active !== true) {
      await this.expire(row);
      return undefined;
    }

    const expiresAt = row.needs_touch === true
      ? await this.touch(row, now)
      : new Date(row.expires_at);

    return {
      sessionId: row.session_id,
      adminUserId: row.admin_user_id,
      sub: row.cognito_sub,
      email: row.admin_email,
      role: row.role,
      groups: [row.role],
      expiresAt,
    };
  }

  /**
   * Moves the idle window to `now`: last_seen_at = now and expires_at = the
   * earlier of now + the idle hour and sign-in + eight hours. Called only when
   * the last touch is a minute old, so the session row is written at most once
   * a minute. A failed touch leaves the session as it was.
   */
  private async touch(row: SessionRow, now: Date): Promise<Date> {
    try {
      const touched = await this.db.query<{ expires_at: Date }>(
        `UPDATE admin_sessions
            SET last_seen_at = $2,
                expires_at = LEAST($3::timestamptz, created_at + make_interval(secs => $4))
          WHERE id = $1 AND revoked_at IS NULL
         RETURNING expires_at`,
        [row.session_id, now, new Date(now.getTime() + IDLE_MS), ADMIN_SESSION_MAX_SECONDS],
      );
      const updated = touched.rows[0]?.expires_at;
      return new Date(updated ?? row.expires_at);
    } catch {
      return new Date(row.expires_at);
    }
  }

  // One conditional UPDATE: of any number of parallel resolves, only the one
  // that gets the row back reports the expiry.
  private async expire(row: SessionRow): Promise<void> {
    const marked = await this.db.query<{ id: string }>(
      `UPDATE admin_sessions
          SET revoked_at = NOW(), revoke_reason = 'expired'
        WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [row.session_id],
    );

    if (marked.rows.length !== 1 || !this.onExpired) {
      return;
    }

    try {
      await this.onExpired({ sessionId: row.session_id, adminUserId: row.admin_user_id, role: row.role });
    } catch {
      // Recording never turns a session lookup into an error.
    }
  }

  /**
   * Ends a session at sign-out and says whose it was, or undefined when it had
   * already ended. A live session takes `reason`. One already past its expiry
   * (on the clock resolve uses) ended by expiring: it is marked expired, and
   * the result says it was not live. The one conditional UPDATE also decides
   * between a sign-out and a parallel resolve of the same session: only one
   * of them gets the row back, so the ending is reported once.
   */
  async revoke(rawToken: string, reason: string): Promise<RevokedAdminSession | undefined> {
    if (!rawToken) {
      return undefined;
    }

    const result = await this.db.query<{ session_id: string; admin_user_id: string; role: AdminRole; live: boolean }>(
      `UPDATE admin_sessions s
          SET revoked_at = NOW(),
              revoke_reason = CASE WHEN s.expires_at > $3 THEN $2::text ELSE 'expired' END
         FROM admin_users u
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND u.id = s.admin_user_id
       RETURNING s.id AS session_id, u.id AS admin_user_id, u.role, s.expires_at > $3 AS live`,
      [hashAdminSessionToken(rawToken), reason, this.now()],
    );

    const row = result.rows[0];
    return row
      ? { sessionId: row.session_id, adminUserId: row.admin_user_id, role: row.role, live: row.live === true }
      : undefined;
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
