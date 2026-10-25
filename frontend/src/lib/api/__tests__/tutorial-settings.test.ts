import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TUTORIAL_SETTINGS,
  getTutorialProgress,
  updateTutorialSettings,
  type TutorialRecord,
  type TutorialRole,
  type TutorialSettingsPatch,
} from '../tutorials';
import { ApiError } from '../errors';

/**
 * The guide settings on the tutorial client (K1-v2): the read carries them
 * beside the records, and a PATCH saves them. The web ships before or with the
 * API that serves them, so a read without settings (or with settings it cannot
 * use) is the defaults, never a failure.
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getTutorialProgress: the settings', () => {
  it('returns the records and the settings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      tutorials: [RECORD],
      settings: { always_show: true, muted: ['employer_post_job'] },
    }));

    await expect(getTutorialProgress(TOKEN, 'employer')).resolves.toEqual({
      tutorials: [RECORD],
      settings: { always_show: true, muted: ['employer_post_job'] },
    });
  });

  it('reads an answer with no settings (the API before K1-v2) as the defaults', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tutorials: [RECORD] }));

    const progress = await getTutorialProgress(TOKEN, 'employer');

    expect(progress.tutorials).toEqual([RECORD]);
    expect(progress.settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
  });

  it.each([
    ['null', null],
    ['a string', 'always'],
    ['an array', []],
    ['always_show that is not a boolean', { always_show: 'yes', muted: [] }],
    ['muted that is not a list', { always_show: true, muted: 'employer_welcome' }],
    ['no always_show', { muted: [] }],
    ['no muted list', { always_show: true }],
  ])('reads malformed settings (%s) as the defaults', async (_label, settings) => {
    fetchMock.mockResolvedValue(jsonResponse({ tutorials: [], settings }));

    const progress = await getTutorialProgress(TOKEN, 'employer');

    expect(progress.settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
  });

  it('drops muted ids that are not this role’s tutorials: the other role’s, tours, unknown ids and non-strings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      tutorials: [],
      settings: {
        always_show: false,
        muted: ['worker_apply', 'employer_messages', 'employer_app_tour', 'employer_retired', 7, null, 'employer_welcome'],
      },
    }));

    const progress = await getTutorialProgress(TOKEN, 'employer');

    expect(progress.settings).toEqual({ always_show: false, muted: ['employer_messages', 'employer_welcome'] });
  });

  it('keeps a worker’s own ids on the worker path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      tutorials: [],
      settings: { always_show: true, muted: ['employer_welcome', 'worker_profile', 'worker_profile'] },
    }));

    const progress = await getTutorialProgress(TOKEN, 'worker');

    expect(progress.settings).toEqual({ always_show: true, muted: ['worker_profile'] });
  });

  it('still fails when the records are missing, settings or not', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ settings: { always_show: true, muted: [] } }));

    const err = await getTutorialProgress(TOKEN, 'employer').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('tutorial_progress_failed');
  });

  it('never hands out the shared default list itself', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tutorials: [] }));

    const progress = await getTutorialProgress(TOKEN, 'worker');

    expect(progress.settings.muted).not.toBe(DEFAULT_TUTORIAL_SETTINGS.muted);
  });
});

describe('updateTutorialSettings', () => {
  it.each<[TutorialRole, TutorialSettingsPatch]>([
    ['employer', { always_show: true }],
    ['worker', { muted: ['worker_apply'] }],
    ['employer', { always_show: false, muted: [] }],
  ])('sends PATCH /%s/tutorials with the patch and returns the stored settings', async (role, patch) => {
    const stored = { always_show: true, muted: role === 'worker' ? ['worker_apply'] : [] };
    fetchMock.mockResolvedValue(jsonResponse({ settings: stored }));

    const result = await updateTutorialSettings(TOKEN, role, patch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/${role}/tutorials`);
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(JSON.parse(init.body)).toEqual(patch);
    expect(result).toEqual(stored);
  });

  it('reads the stored settings the same way as the read: foreign ids dropped', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ settings: { always_show: false, muted: ['worker_apply', 'employer_welcome'] } }));

    await expect(updateTutorialSettings(TOKEN, 'employer', { muted: ['employer_welcome'] })).resolves.toEqual({
      always_show: false,
      muted: ['employer_welcome'],
    });
  });

  it('treats a 200 without settings as a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const err = await updateTutorialSettings(TOKEN, 'worker', { always_show: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('tutorial_settings_failed');
  });

  it.each([
    [400, 'invalid_settings'],
    [404, 'not_found'],
  ])('maps a %s to %s', async (status, code) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: code }, status));

    const err = await updateTutorialSettings(TOKEN, 'employer', { muted: ['employer_welcome'] }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it('falls back to tutorial_settings_failed when the body names no code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    const err = await updateTutorialSettings(TOKEN, 'employer', { always_show: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('tutorial_settings_failed');
  });
});
