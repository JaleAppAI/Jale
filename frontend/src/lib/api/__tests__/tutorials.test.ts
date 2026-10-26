import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DEFAULT_TUTORIAL_SETTINGS,
  EMPLOYER_TUTORIAL_IDS,
  WORKER_TUTORIAL_IDS,
  getTutorialProgress,
  recordTutorialOutcome,
  type EmployerTutorialId,
  type TutorialId,
  type TutorialRecord,
  type TutorialRole,
  type WorkerTutorialId,
} from '../tutorials';
import { ApiError } from '../errors';

/**
 * The tutorial progress client (contract K1.2-K1.4): the paths, methods and
 * bodies, and how each answer is read. A wrong path or body here would show
 * nothing on screen -- a tutorial would simply keep re-opening -- so it is
 * pinned at this level rather than only through the player.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const TOKEN = 'id-token-abc';
const BASE = 'https://api.example.test';

const RECORD: TutorialRecord = {
  tutorial_id: 'employer_welcome',
  outcome: 'completed',
  recorded_at: '2026-10-21T12:00:00.000Z',
};

describe('tutorial ids', () => {
  it('lists the four employer and four worker ids, in contract order', () => {
    expect(EMPLOYER_TUTORIAL_IDS).toEqual([
      'employer_welcome',
      'employer_post_job',
      'employer_applicants',
      'employer_messages',
    ]);
    expect(WORKER_TUTORIAL_IDS).toEqual([
      'worker_onboarding',
      'worker_apply',
      'worker_details',
      'worker_profile',
    ]);
  });

  it('types match the K1.1 unions', () => {
    expectTypeOf<EmployerTutorialId>().toEqualTypeOf<
      'employer_welcome' | 'employer_post_job' | 'employer_applicants' | 'employer_messages'
    >();
    expectTypeOf<WorkerTutorialId>().toEqualTypeOf<
      'worker_onboarding' | 'worker_apply' | 'worker_details' | 'worker_profile'
    >();
    expectTypeOf<TutorialId>().toEqualTypeOf<EmployerTutorialId | WorkerTutorialId>();
  });
});

describe('tutorial progress client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTutorialProgress', () => {
    it.each(['employer', 'worker'] as const)('reads GET /%s/tutorials and returns the tutorials array with the settings', async (role: TutorialRole) => {
      fetchMock.mockResolvedValue(jsonResponse({ tutorials: [RECORD] }));

      const result = await getTutorialProgress(TOKEN, role);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/${role}/tutorials`);
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.headers.Authorization).toBe(TOKEN);
      expect(result.tutorials).toEqual([RECORD]);
      expect(result.settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
    });

    it('returns an empty list as an empty list', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ tutorials: [] }));
      await expect(getTutorialProgress(TOKEN, 'worker')).resolves.toMatchObject({ tutorials: [] });
    });

    it('forwards a caller signal, so aborting rejects the read', async () => {
      // A fetch that only ever ends by abort: without the signal reaching it,
      // the read would hang and the test would time out.
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        if (init.signal?.aborted) return reject(abortError());
        init.signal?.addEventListener('abort', () => reject(abortError()));
      }));
      const controller = new AbortController();
      const pending = getTutorialProgress(TOKEN, 'employer', controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('treats a 200 without a tutorials array as a failure, not as "nothing recorded"', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const err = await getTutorialProgress(TOKEN, 'employer').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('tutorial_progress_failed');
    });

    it('maps a 404 to not_found', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));
      const err = await getTutorialProgress(TOKEN, 'worker').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(404);
      expect(err.code).toBe('not_found');
    });

    it('falls back to tutorial_progress_failed when the body names no code', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 500));
      const err = await getTutorialProgress(TOKEN, 'employer').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(500);
      expect(err.code).toBe('tutorial_progress_failed');
    });
  });

  describe('recordTutorialOutcome', () => {
    it.each([
      ['employer', 'employer_post_job', 'skipped'],
      ['worker', 'worker_apply', 'completed'],
    ] as const)('posts to /%s/tutorials with the id and outcome', async (role, tutorialId, outcome) => {
      const stored: TutorialRecord = { tutorial_id: tutorialId, outcome, recorded_at: '2026-10-21T12:00:00.000Z' };
      fetchMock.mockResolvedValue(jsonResponse({ tutorial: stored }));

      const result = await recordTutorialOutcome(TOKEN, role, tutorialId, outcome);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/${role}/tutorials`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(TOKEN);
      expect(JSON.parse(init.body)).toEqual({ tutorial_id: tutorialId, outcome });
      expect(result).toEqual(stored);
    });

    it('returns the stored record, which may differ from the outcome just sent', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ tutorial: RECORD }));
      const result = await recordTutorialOutcome(TOKEN, 'employer', 'employer_welcome', 'skipped');
      expect(result.outcome).toBe('completed');
    });

    it('treats a 200 without a tutorial object as a failure', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const err = await recordTutorialOutcome(TOKEN, 'worker', 'worker_profile', 'skipped').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('tutorial_record_failed');
    });

    it('maps a 400 to invalid_tutorial', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_tutorial' }, 400));
      const err = await recordTutorialOutcome(TOKEN, 'employer', 'employer_messages', 'completed').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(400);
      expect(err.code).toBe('invalid_tutorial');
    });

    it('falls back to tutorial_record_failed when the body names no code', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 500));
      const err = await recordTutorialOutcome(TOKEN, 'worker', 'worker_details', 'completed').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(500);
      expect(err.code).toBe('tutorial_record_failed');
    });
  });
});
