/**
 * analytics-capture.ts -- the admin analytics capture calls (sprint 28,
 * contract K3.6; migration 124): where a signup started (#16), a signed-in
 * job view (#17) and the jobs a worker was shown (#20).
 *
 * Every call is best-effort. It runs inside the caller's open transaction
 * under its own savepoint, so the caller's RLS context applies and nothing
 * else in the transaction is touched. If the capture function fails for any
 * reason, the savepoint is rolled back, one static line is logged (the
 * capture's name and the SQLSTATE, never an id or a value) and the caller
 * carries on: a capture never fails the request it rides on.
 *
 * The functions (jale_cap.record_*) re-check everything themselves: the
 * worker is the transaction's own app.current_internal_user_id, a repeat is a
 * no-op, and a job removed meanwhile records nothing.
 */
import type { SignupSource } from './signup-source';

export interface CaptureClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export type CaptureName = 'signup_source' | 'job_view' | 'feed_impressions' | 'whatsapp_impressions';

/** Where a signed-in worker came to a job page from (K3.6). */
export const JOB_VIEW_SOURCES = ['feed', 'public_link', 'whatsapp', 'direct'] as const;
export type JobViewSource = (typeof JOB_VIEW_SOURCES)[number];

const VIEW_SOURCES: ReadonlySet<string> = new Set(JOB_VIEW_SOURCES);

export function isJobViewSource(value: unknown): value is JobViewSource {
  return typeof value === 'string' && VIEW_SOURCES.has(value);
}

const SAVEPOINT = 'analytics_capture';
/** The capture functions take at most this many jobs per call. */
const MAX_JOBS_PER_CALL = 200;

function skipped(name: CaptureName, err: unknown): void {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
  console.warn(JSON.stringify({ metric: 'AnalyticsCaptureSkipped', capture: name, code }));
}

/** Runs one capture statement under a savepoint; true when it ran, false when it was skipped. Never throws. */
export async function captureBestEffort(client: CaptureClient, name: CaptureName, sql: string, params: unknown[]): Promise<boolean> {
  try {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
  } catch (err) {
    skipped(name, err);
    return false;
  }
  try {
    await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return true;
  } catch (err) {
    skipped(name, err);
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch {
      // The caller's own next statement reports a broken transaction.
    }
    return false;
  }
}

/** Where a new web account's signup started (worker signup, employer first profile save). */
export function recordSignupSource(client: CaptureClient, userId: string, source: SignupSource): Promise<boolean> {
  return captureBestEffort(
    client,
    'signup_source',
    'SELECT jale_cap.record_signup_source($1, $2, $3, $4)',
    [userId, 'web', source.entry, source.src],
  );
}

/** The calling worker opened a job page (the worker comes from the transaction's context). */
export function recordJobView(client: CaptureClient, jobId: string, source: JobViewSource): Promise<boolean> {
  return captureBestEffort(client, 'job_view', 'SELECT jale_cap.record_job_view($1, $2)', [jobId, source]);
}

/** The jobs the web feed returned to the calling worker. */
export async function recordFeedImpressions(client: CaptureClient, jobIds: readonly string[]): Promise<boolean> {
  if (jobIds.length === 0) return false;
  return captureBestEffort(
    client,
    'feed_impressions',
    'SELECT jale_cap.record_feed_impressions($1::uuid[])',
    [jobIds.slice(0, MAX_JOBS_PER_CALL)],
  );
}

/** The jobs a WhatsApp job alert (with its intent) or job list (no intent) showed the calling worker. */
export async function recordWhatsAppImpressions(
  client: CaptureClient,
  jobIds: readonly string[],
  alertIntentId: string | null,
): Promise<boolean> {
  if (jobIds.length === 0) return false;
  return captureBestEffort(
    client,
    'whatsapp_impressions',
    'SELECT jale_cap.record_whatsapp_impressions($1::uuid[], $2::uuid)',
    [jobIds.slice(0, MAX_JOBS_PER_CALL), alertIntentId],
  );
}
