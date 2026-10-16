/**
 * Contract K1.2 (sprint 28): trusted-browser sign-in. BE-1 owns this module.
 *
 * "Trust this browser for 7 days" lets an admin skip the authenticator code
 * on one browser for seven days. The admin pool remembers a device only when
 * the server says so (DeviceOnlyRememberedOnUserPrompt), and a remembered
 * device stands in for the code (ChallengeRequiredOnNewDevice). Cognito keeps
 * no time limit, so the seven days live here: admin_trusted_devices
 * (migration 120) holds the sha256 of each trusted device key and its window,
 * and POST /api/session applies the rules below on every sign-in. The
 * database record is the authority: a Cognito call that fails never opens
 * trust; a sign-in that needs one fails closed.
 *
 * The device key comes from the verified ACCESS token (`device_key`; the ID
 * token has none). Cognito confirms a device on every code sign-in by itself;
 * this module never asks whether a confirmation is pending: it remembers the
 * device whenever the admin ticked the box and the device is not remembered.
 * The record is written before the pool remembers the device, and ended if
 * the pool refuses, so the pool never remembers a device without a live
 * record.
 */
import { createHash } from 'node:crypto';
import type { AdminDirectory } from './cognito-admin';

/** The device-trust spike passed (2026-10-14): trusted browsers ship. */
export const DEVICE_TRUST_ENABLED = true;
/** How long a trusted browser skips the code. Migration 120 enforces the same. */
export const DEVICE_TRUST_DAYS = 7;

/** Whether the sign-in form offers "Trust this browser for 7 days". */
export function isDeviceTrustEnabled(): boolean {
  return DEVICE_TRUST_ENABLED;
}

/** The sha256 of a device key: the only form of it the database keeps. */
export function hashDeviceKey(deviceKey: string): string {
  return createHash('sha256').update(deviceKey).digest('hex');
}

type QueryResult<Row> = { rows: Row[] };
export type DeviceTrustDb = {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
};

/**
 * What a sign-in's device means for the session:
 *   no_device       no device key in the access token (or trust is off)
 *   trusted_device  a remembered device with a live trust younger than 7
 *                   days: signed in without a code
 *   code_sign_in    a device the pool does not remember: the admin entered a
 *                   code; `trusted` when it is remembered from now on
 *   trust_expired   a remembered device without a live trust: un-remembered
 *                   and its record ended; the sign-in is refused
 */
export type DeviceTrustResult =
  | { outcome: 'no_device' }
  | { outcome: 'trusted_device' }
  | { outcome: 'code_sign_in'; trusted: boolean }
  | { outcome: 'trust_expired' };

export type DeviceTrustInput = {
  db: DeviceTrustDb;
  directory: AdminDirectory;
  adminUserId: string;
  /** The verified access token's `username` claim. */
  username: string;
  /** The verified access token's `device_key` claim. */
  deviceKey?: string;
  /** The admin ticked "Trust this browser for 7 days" on this sign-in. */
  trustDevice: boolean;
};

const END_LIVE_TRUST_SQL = `UPDATE admin_trusted_devices
    SET ended_at = now(), end_reason = 'expired'
  WHERE admin_user_id = $1 AND device_key_hash = $2 AND ended_at IS NULL`;

/** Cognito's remembered status, read strictly: anything else is an error. */
function isRemembered(status: string | undefined): boolean {
  if (status === 'remembered') return true;
  if (status === 'not_remembered' || status === undefined) return false;
  throw new Error('Cognito reported an unknown device remembered status');
}

/**
 * Applies K1.2 to one sign-in. Throws on a Cognito or database error; the
 * caller refuses the sign-in then.
 */
export async function applyDeviceTrust(input: DeviceTrustInput): Promise<DeviceTrustResult> {
  const { db, directory, adminUserId, username, deviceKey, trustDevice } = input;
  if (!DEVICE_TRUST_ENABLED || !deviceKey) {
    return { outcome: 'no_device' };
  }
  const deviceHash = hashDeviceKey(deviceKey);
  // Only 'remembered' is remembered; 'not_remembered' or no status is not (a
  // code was asked). Any other value throws: the sign-in fails closed.
  const remembered = isRemembered(await directory.getDeviceRememberedStatus(username, deviceKey));

  if (remembered) {
    // The admin skipped the code. Accept only a live trust younger than 7
    // days, on the database's clock.
    const { rows } = await db.query<{ id: string; fresh: boolean }>(
      `SELECT id, expires_at > now() AS fresh
         FROM admin_trusted_devices
        WHERE admin_user_id = $1 AND device_key_hash = $2 AND ended_at IS NULL`,
      [adminUserId, deviceHash],
    );
    if (rows[0]?.fresh === true) {
      return { outcome: 'trusted_device' };
    }
    // Trust is over: end the record, then have the pool ask for a code again.
    await db.query(END_LIVE_TRUST_SQL, [adminUserId, deviceHash]);
    await directory.setDeviceRemembered(username, deviceKey, false);
    return { outcome: 'trust_expired' };
  }

  // The admin entered a code. A live record for a device the pool does not
  // remember is over; a new trust starts from this sign-in.
  await db.query(END_LIVE_TRUST_SQL, [adminUserId, deviceHash]);
  if (!trustDevice) {
    return { outcome: 'code_sign_in', trusted: false };
  }
  // The record first, then the pool. If the pool refuses, the record ends at
  // once, so a remembered device always has a live record behind it.
  const { rows: [added] } = await db.query<{ id: string }>(
    `INSERT INTO admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
     VALUES ($1, $2, now() + interval '7 days')
     RETURNING id`,
    [adminUserId, deviceHash],
  );
  try {
    await directory.setDeviceRemembered(username, deviceKey, true);
  } catch (error) {
    if (added) {
      await db.query(
        `UPDATE admin_trusted_devices
            SET ended_at = now(), end_reason = 'expired'
          WHERE id = $1 AND ended_at IS NULL`,
        [added.id],
      );
    }
    throw error;
  }
  return { outcome: 'code_sign_in', trusted: true };
}

/** Why a trusted browser ended (migration 120's end_reason). */
export type TrustEndReason = 'expired' | 'admin_deactivated' | 'signed_out_everywhere';

/**
 * Ends every live trusted browser of an admin in the database, with a reason,
 * and says how many. The sign-in check reads these rows, so once this returns
 * no browser of the admin skips the code, whatever the pool still remembers.
 * (Deactivation ends them inside migration 120's definer instead, in the
 * same statement scope as its guards.)
 */
export async function endAdminTrust(db: DeviceTrustDb, adminUserId: string, reason: TrustEndReason): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE admin_trusted_devices
        SET ended_at = now(), end_reason = $2
      WHERE admin_user_id = $1 AND ended_at IS NULL
     RETURNING id`,
    [adminUserId, reason],
  );
  return rows.length;
}

/**
 * Ends every trusted browser an admin has, in the pool: lists the user's
 * devices and forgets each one. Signing out everywhere does not end a
 * remembered device in Cognito, so every path that ends trust calls this
 * after its database change (deactivation, and revoking every session).
 * Throws on a Cognito error; the database change stands, and a retry
 * finishes the job.
 */
export async function forgetAllDevices(directory: AdminDirectory, username: string): Promise<number> {
  const keys = await directory.listDeviceKeys(username);
  for (const key of keys) {
    await directory.forgetDevice(username, key);
  }
  return keys.length;
}
