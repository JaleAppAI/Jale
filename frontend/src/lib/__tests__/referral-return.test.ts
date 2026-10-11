import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateJobId,
  stashPendingReferral,
  readPendingReferral,
  clearPendingReferral,
  markAuthFlowCompleting,
  isAuthFlowCompleting,
  clearAuthFlowCompleting,
  jobIdFromReturnPath,
  settleWithin,
  CLAIM_WAIT_MS,
} from '@/lib/referral-return';

const JOB_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('validateJobId', () => {
  it('accepts a bare job uuid', () => {
    expect(validateJobId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    );
  });

  it('rejects a path built around a uuid', () => {
    expect(validateJobId('/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  it('rejects absolute URLs', () => {
    expect(validateJobId('https://evil.com')).toBeNull();
  });

  it('rejects protocol-relative values', () => {
    expect(validateJobId('//evil.com')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(validateJobId('../../evil')).toBeNull();
  });

  it('rejects a uuid-less value', () => {
    expect(validateJobId('not-a-uuid')).toBeNull();
    expect(validateJobId('')).toBeNull();
  });

  it('rejects null/undefined', () => {
    expect(validateJobId(null)).toBeNull();
    expect(validateJobId(undefined)).toBeNull();
  });
});

function installFakeSessionStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

describe('pendingReferral sessionStorage helpers', () => {
  beforeEach(() => {
    installFakeSessionStorage();
  });

  it('round-trips a stashed referral', () => {
    stashPendingReferral({ jobId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', shareCode: 'abc123' });
    expect(readPendingReferral()).toEqual({
      jobId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      shareCode: 'abc123',
    });
  });

  it('returns null when nothing stashed', () => {
    expect(readPendingReferral()).toBeNull();
  });

  it('tolerates garbage JSON', () => {
    sessionStorage.setItem('pendingReferral', '{not valid json');
    expect(readPendingReferral()).toBeNull();
  });

  it('tolerates a non-object JSON value', () => {
    sessionStorage.setItem('pendingReferral', '"just a string"');
    expect(readPendingReferral()).toBeNull();
  });

  it('clears the stash', () => {
    stashPendingReferral({ jobId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', shareCode: null });
    clearPendingReferral();
    expect(readPendingReferral()).toBeNull();
  });
});

describe('auth-flow-completing flag helpers', () => {
  beforeEach(() => {
    installFakeSessionStorage();
  });

  it('is false until marked', () => {
    expect(isAuthFlowCompleting()).toBe(false);
  });

  it('is true once marked', () => {
    markAuthFlowCompleting();
    expect(isAuthFlowCompleting()).toBe(true);
  });

  it('is false again once cleared', () => {
    markAuthFlowCompleting();
    clearAuthFlowCompleting();
    expect(isAuthFlowCompleting()).toBe(false);
  });
});

/**
 * A sign-in bounced from a job page (`useRequireAuth` sends the visitor to
 * `/{locale}/auth/worker?returnUrl=/{locale}/worker/jobs/<uuid>`) is about that
 * job, exactly as a `?job=` link is. This reads the job back out of the return
 * path -- and nothing else: it is the same carry-through as `validateJobId`, so
 * the only thing that can ever come out of it is a bare UUID.
 */
describe('jobIdFromReturnPath', () => {
  it('reads the job from a locale-prefixed job page path', () => {
    expect(jobIdFromReturnPath(`/en/worker/jobs/${JOB_ID}`)).toBe(JOB_ID);
    expect(jobIdFromReturnPath(`/es/worker/jobs/${JOB_ID}`)).toBe(JOB_ID);
  });

  it('ignores the query and fragment the page carried', () => {
    expect(jobIdFromReturnPath(`/es/worker/jobs/${JOB_ID}?ref=wa`)).toBe(JOB_ID);
    expect(jobIdFromReturnPath(`/en/worker/jobs/${JOB_ID}#apply`)).toBe(JOB_ID);
  });

  it('accepts only a job DETAIL page, not something under it', () => {
    expect(jobIdFromReturnPath(`/en/worker/jobs/${JOB_ID}/apply`)).toBeNull();
    expect(jobIdFromReturnPath(`/en/worker/jobs/${JOB_ID}/`)).toBeNull();
    expect(jobIdFromReturnPath('/en/worker/jobs')).toBeNull();
    expect(jobIdFromReturnPath('/en/worker/home')).toBeNull();
  });

  it('accepts only the worker side and only a known locale', () => {
    expect(jobIdFromReturnPath(`/en/employer/jobs/${JOB_ID}`)).toBeNull();
    expect(jobIdFromReturnPath(`/worker/jobs/${JOB_ID}`)).toBeNull();
    expect(jobIdFromReturnPath(`/fr/worker/jobs/${JOB_ID}`)).toBeNull();
  });

  it('accepts only a UUID as the job', () => {
    expect(jobIdFromReturnPath('/en/worker/jobs/abc')).toBeNull();
    expect(jobIdFromReturnPath('/en/worker/jobs/..%2F..%2Fevil')).toBeNull();
  });

  it('refuses anything that is not a same-origin relative path', () => {
    expect(jobIdFromReturnPath(`https://evil.com/en/worker/jobs/${JOB_ID}`)).toBeNull();
    expect(jobIdFromReturnPath(`//evil.com/en/worker/jobs/${JOB_ID}`)).toBeNull();
    expect(jobIdFromReturnPath(`/\\evil.com/en/worker/jobs/${JOB_ID}`)).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(jobIdFromReturnPath(null)).toBeNull();
    expect(jobIdFromReturnPath(undefined)).toBeNull();
    expect(jobIdFromReturnPath('')).toBeNull();
  });
});

/**
 * Sign-in records the job server-side BEFORE the session starts, while the form
 * is still on screen -- and must never be held hostage by that request. This
 * is the bound: whatever the claim does, the wait is over in about four
 * seconds, and it never rejects.
 *
 * It does NOT cancel the claim. That is the point: a slow claim keeps going
 * after the form unmounts and still lands, and the onboarding read picks the
 * job up on a later poll.
 */
describe('settleWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits about four seconds by default', () => {
    expect(CLAIM_WAIT_MS).toBe(4_000);
  });

  it('is over as soon as the work settles', async () => {
    await expect(settleWithin(async () => ({ claimed: true }), CLAIM_WAIT_MS)).resolves.toBe('settled');
  });

  it('treats a rejection as settled rather than passing it on', async () => {
    await expect(settleWithin(async () => { throw new Error('500'); }, CLAIM_WAIT_MS)).resolves.toBe('settled');
  });

  it('treats a synchronous throw the same way', async () => {
    await expect(settleWithin(() => { throw new Error('boom'); }, CLAIM_WAIT_MS)).resolves.toBe('settled');
  });

  it('stops waiting at the bound when the work never answers', async () => {
    vi.useFakeTimers();
    let done: string | null = null;
    void settleWithin(() => new Promise(() => {}), CLAIM_WAIT_MS).then((outcome) => { done = outcome; });

    await vi.advanceTimersByTimeAsync(CLAIM_WAIT_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe('timed_out');
  });

  it('hands the work nothing it could be cancelled through', async () => {
    // No AbortSignal, no controller: once the wait is over the request is on
    // its own, and `apiFetch`'s per-attempt timeout is the only clock it has.
    vi.useFakeTimers();
    const work = vi.fn(() => new Promise<never>(() => {}));
    const waited = settleWithin(work, 10);
    await vi.advanceTimersByTimeAsync(10);

    await expect(waited).resolves.toBe('timed_out');
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith();
  });

  it('leaves no timer behind once the work has settled', async () => {
    vi.useFakeTimers();
    await settleWithin(async () => 'ok', CLAIM_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Storage the browser will not hand over. Where site data is blocked the
 * `sessionStorage` property access itself throws (SecurityError), and where
 * storage is switched off (some in-app web views) the property is null. Sign-in
 * runs every helper here around a correct code, so none may throw: a refusal
 * reads as "nothing stashed" and "not completing".
 */
describe('storage that cannot be used', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  function storageIs(get: () => unknown) {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get });
  }

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };

  it.each<[string, () => unknown]>([
    ['a property access that throws', blocked],
    ['a property that is null', () => null],
  ])('every helper gives its empty answer for %s, and none throws', (_label, get) => {
    storageIs(get);
    expect(() => stashPendingReferral({ jobId: JOB_ID, shareCode: null })).not.toThrow();
    expect(readPendingReferral()).toBeNull();
    expect(() => clearPendingReferral()).not.toThrow();
    expect(() => markAuthFlowCompleting()).not.toThrow();
    expect(isAuthFlowCompleting()).toBe(false);
    expect(() => clearAuthFlowCompleting()).not.toThrow();
  });

  it('reads nothing when getItem itself throws', () => {
    installFakeSessionStorage();
    const store = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
    store.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: null }));
    store.getItem = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(readPendingReferral()).toBeNull();
    expect(isAuthFlowCompleting()).toBe(false);
  });
});
