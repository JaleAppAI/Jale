import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';

/**
 * Tutorial progress (contract K1): which first-time tutorials this account has
 * already finished or skipped, kept per account on the server so a tutorial
 * that was dismissed once does not return on another device or browser.
 *
 * The ids are stored by the backend, so an id is never renamed once released.
 * The two lists below are the whole vocabulary; the backend keeps the same two
 * lists and rejects anything else, including an id of the other role.
 */
export const EMPLOYER_TUTORIAL_IDS = [
  'employer_welcome',
  'employer_post_job',
  'employer_applicants',
  'employer_messages',
] as const;

export const WORKER_TUTORIAL_IDS = [
  'worker_onboarding',
  'worker_apply',
  'worker_details',
  'worker_profile',
] as const;

export type EmployerTutorialId = (typeof EMPLOYER_TUTORIAL_IDS)[number];
export type WorkerTutorialId = (typeof WORKER_TUTORIAL_IDS)[number];
export type TutorialId = EmployerTutorialId | WorkerTutorialId;
export type TutorialOutcome = 'completed' | 'skipped';
export type TutorialRecord = {
  tutorial_id: TutorialId;
  outcome: TutorialOutcome;
  /** ISO 8601. */
  recorded_at: string;
};

/** Which signed-in shell is asking. It picks the path, and so the authorizer. */
export type TutorialRole = 'employer' | 'worker';

/**
 * `GET /employer/tutorials` or `GET /worker/tutorials`: the records this
 * account has for this role, `[]` when it has none. Throws `ApiError` on any
 * failure (404 `not_found` when the account has no users row yet).
 *
 * A 200 whose body carries no `tutorials` array is treated as a failure too,
 * not as an empty list: an empty list means "eligible to auto-open", so a
 * malformed answer must not be read as one.
 */
export async function getTutorialProgress(
  token: string,
  role: TutorialRole,
  signal?: AbortSignal,
): Promise<TutorialRecord[]> {
  const res = await apiFetch(`/${role}/tutorials`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'tutorial_progress_failed');
  const body = await res.json();
  if (!Array.isArray(body?.tutorials)) throw new ApiError(res.status, 'tutorial_progress_failed');
  return body.tutorials;
}

/**
 * `POST /employer/tutorials` or `POST /worker/tutorials`: records how an
 * auto-opened tutorial was dismissed. The first outcome ever recorded wins, and
 * the answer is the STORED record, which may differ from the one just sent.
 *
 * A MUTATION, so no AbortSignal: a record the server already took must be
 * reported, not discarded (same as `acknowledgeHire`). Throws `ApiError`:
 * 400 `invalid_tutorial` / `invalid_outcome`, 404 `not_found`.
 */
export async function recordTutorialOutcome(
  token: string,
  role: TutorialRole,
  tutorialId: TutorialId,
  outcome: TutorialOutcome,
): Promise<TutorialRecord> {
  const res = await apiFetch(
    `/${role}/tutorials`,
    { method: 'POST', body: JSON.stringify({ tutorial_id: tutorialId, outcome }) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'tutorial_record_failed');
  const body = await res.json();
  if (!body?.tutorial || typeof body.tutorial !== 'object') throw new ApiError(res.status, 'tutorial_record_failed');
  return body.tutorial;
}
