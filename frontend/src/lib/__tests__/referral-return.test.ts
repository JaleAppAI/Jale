import { beforeEach, describe, expect, it } from 'vitest';
import {
  validateJobId,
  stashPendingReferral,
  readPendingReferral,
  clearPendingReferral,
  markAuthFlowCompleting,
  isAuthFlowCompleting,
  clearAuthFlowCompleting,
} from '@/lib/referral-return';

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
