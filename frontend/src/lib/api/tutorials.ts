import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';

/**
 * Tutorial progress (contract K1): which first-time tutorials this account has
 * already finished or skipped, kept per account on the server so a tutorial
 * that was dismissed once does not return on another device or browser.
 *
 * The ids are stored by the backend, so an id is never renamed once released.
 * The lists below (two tutorial lists, two tour lists) are the whole
 * vocabulary; the backend keeps the same lists and rejects anything else,
 * including an id of the other role.
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

/**
 * The app tours (K1-v2): one per role, recorded like a tutorial (completed or
 * skipped, first outcome wins) but drawn by the tour overlay, not the slide
 * player. They are not tutorials: Help does not list them as guides, and they
 * can never be muted. The backend keeps the same two lists.
 */
export const EMPLOYER_TOUR_IDS = ['employer_app_tour'] as const;

export const WORKER_TOUR_IDS = ['worker_app_tour'] as const;

export type EmployerTutorialId = (typeof EMPLOYER_TUTORIAL_IDS)[number];
export type WorkerTutorialId = (typeof WORKER_TUTORIAL_IDS)[number];
export type TutorialId = EmployerTutorialId | WorkerTutorialId;
export type TourId = (typeof EMPLOYER_TOUR_IDS)[number] | (typeof WORKER_TOUR_IDS)[number];
/** Anything the progress endpoint records an outcome for. */
export type ProgressId = TutorialId | TourId;
export type TutorialOutcome = 'completed' | 'skipped';
export type TutorialRecord = {
  tutorial_id: ProgressId;
  outcome: TutorialOutcome;
  /** ISO 8601. */
  recorded_at: string;
};

/**
 * The account's guide settings (K1-v2), kept per account on the server.
 *  - `always_show`: guides open every time their task starts, not only the
 *    first time.
 *  - `muted`: tutorials the person turned off with "Don't show this again".
 *    Only this role's tutorial ids; a tour id is never muted.
 * An account with no stored settings reads as `DEFAULT_TUTORIAL_SETTINGS`.
 */
export type TutorialSettings = {
  always_show: boolean;
  muted: TutorialId[];
};

export const DEFAULT_TUTORIAL_SETTINGS: Readonly<TutorialSettings> = Object.freeze({
  always_show: false,
  muted: [],
});

/** What `GET /{role}/tutorials` answers (K1-v2). */
export type TutorialProgress = {
  tutorials: TutorialRecord[];
  settings: TutorialSettings;
};

/** `PATCH /{role}/tutorials`: either field, or both. `muted` replaces the whole list. */
export type TutorialSettingsPatch = Partial<TutorialSettings>;

/** Which signed-in shell is asking. It picks the path, and so the authorizer. */
export type TutorialRole = 'employer' | 'worker';

/** This role's tutorial ids: the only ids its `muted` list may hold. */
function tutorialIdsOf(role: TutorialRole): readonly TutorialId[] {
  return role === 'employer' ? EMPLOYER_TUTORIAL_IDS : WORKER_TUTORIAL_IDS;
}

/**
 * The settings as this client may use them, or null when the value is not an
 * object with a boolean `always_show` and a `muted` list. From `muted`,
 * anything that is not one of this role's tutorial ids is dropped (and each id
 * is kept once).
 */
function readSettings(raw: unknown, role: TutorialRole): TutorialSettings | null {
  const value = raw as { always_show?: unknown; muted?: unknown } | null;
  if (!value || typeof value !== 'object' || typeof value.always_show !== 'boolean' || !Array.isArray(value.muted)) {
    return null;
  }
  const ids: readonly string[] = tutorialIdsOf(role);
  const muted: TutorialId[] = [];
  for (const id of value.muted) {
    if (typeof id === 'string' && ids.includes(id) && !muted.includes(id as TutorialId)) muted.push(id as TutorialId);
  }
  return { always_show: value.always_show, muted };
}

/**
 * `GET /employer/tutorials` or `GET /worker/tutorials`: the records this
 * account has for this role (`[]` when it has none) and its guide settings.
 * Throws `ApiError` on any failure (404 `not_found` when the account has no
 * users row yet).
 *
 * A 200 whose body carries no `tutorials` array is treated as a failure too,
 * not as an empty list: an empty list means "eligible to auto-open", so a
 * malformed answer must not be read as one. Missing or malformed `settings`
 * read as `DEFAULT_TUTORIAL_SETTINGS` instead.
 */
export async function getTutorialProgress(
  token: string,
  role: TutorialRole,
  signal?: AbortSignal,
): Promise<TutorialProgress> {
  const res = await apiFetch(`/${role}/tutorials`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'tutorial_progress_failed');
  const body = await res.json();
  if (!Array.isArray(body?.tutorials)) throw new ApiError(res.status, 'tutorial_progress_failed');
  // The web may ship before the API that serves settings: an account then
  // sees each guide the first time only, as before.
  const settings = readSettings(body.settings, role) ?? { ...DEFAULT_TUTORIAL_SETTINGS, muted: [] };
  return { tutorials: body.tutorials, settings };
}

/**
 * `PATCH /employer/tutorials` or `PATCH /worker/tutorials`: saves either
 * setting, or both (`muted` replaces the whole list), and answers with the
 * STORED settings, read the same way as `getTutorialProgress` reads them.
 *
 * A MUTATION, so no AbortSignal (see `recordTutorialOutcome`). Throws
 * `ApiError`: 400 `invalid_settings`, 404 `not_found`, and
 * `tutorial_settings_failed` for anything else, a 200 without usable
 * settings included.
 */
export async function updateTutorialSettings(
  token: string,
  role: TutorialRole,
  patch: TutorialSettingsPatch,
): Promise<TutorialSettings> {
  const res = await apiFetch(`/${role}/tutorials`, { method: 'PATCH', body: JSON.stringify(patch) }, token);
  if (!res.ok) throw await parseApiError(res, 'tutorial_settings_failed');
  const body = await res.json();
  const settings = readSettings(body?.settings, role);
  if (settings === null) throw new ApiError(res.status, 'tutorial_settings_failed');
  return settings;
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
  tutorialId: ProgressId,
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
