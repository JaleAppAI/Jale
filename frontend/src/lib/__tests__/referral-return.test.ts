import { beforeEach, describe, expect, it } from 'vitest';
import {
  validateReturnTo,
  stashPendingReferral,
  readPendingReferral,
  clearPendingReferral,
} from '@/lib/referral-return';

describe('validateReturnTo', () => {
  it('accepts a real /worker/jobs/{uuid} path', () => {
    expect(validateReturnTo('/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(
      '/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    );
  });

  it('rejects absolute URLs', () => {
    expect(validateReturnTo('https://evil.com')).toBeNull();
    expect(validateReturnTo('https://evil.com/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  it('rejects protocol-relative URLs', () => {
    expect(validateReturnTo('//evil.com')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(validateReturnTo('/worker/jobs/../../evil')).toBeNull();
  });

  it('rejects other role paths', () => {
    expect(validateReturnTo('/employer/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBeNull();
  });

  it('rejects a uuid-less path', () => {
    expect(validateReturnTo('/worker/jobs/not-a-uuid')).toBeNull();
    expect(validateReturnTo('/worker/jobs/')).toBeNull();
  });

  it('rejects null/undefined', () => {
    expect(validateReturnTo(null)).toBeNull();
    expect(validateReturnTo(undefined)).toBeNull();
    expect(validateReturnTo('')).toBeNull();
  });
});

describe('pendingReferral sessionStorage helpers', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size; },
    } as Storage;
  });

  it('round-trips a stashed referral', () => {
    stashPendingReferral({ returnTo: '/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6', shareCode: 'abc123' });
    expect(readPendingReferral()).toEqual({
      returnTo: '/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6',
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
    stashPendingReferral({ returnTo: '/worker/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6', shareCode: null });
    clearPendingReferral();
    expect(readPendingReferral()).toBeNull();
  });
});
