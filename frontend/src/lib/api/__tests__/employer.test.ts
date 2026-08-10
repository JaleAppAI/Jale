import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, clearIdempotencyKey, getIdempotencyKey, isDefinitiveError } from '../employer';
import { ApiError as SharedApiError } from '../errors';

// vitest.config.ts runs this suite in the 'node' environment, which has no
// sessionStorage global. getIdempotencyKey only touches window/sessionStorage
// when `typeof window !== 'undefined'`, so we install a minimal in-memory
// stub on `globalThis.window` for the duration of these tests rather than
// pulling in jsdom as a dependency.
class FakeSessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

let fakeSessionStorage: FakeSessionStorage;

beforeEach(() => {
  fakeSessionStorage = new FakeSessionStorage();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: fakeSessionStorage,
  };
});

describe('getIdempotencyKey', () => {
  it('reuses the stored key when the body is identical', () => {
    const body = { planCode: 'employer_pro', successUrl: '/en/employer/billing?billing=success' };
    const first = getIdempotencyKey('billing-checkout', body);
    const second = getIdempotencyKey('billing-checkout', { ...body });
    expect(second).toBe(first);
  });

  it('reuses the key regardless of object key order (canonical JSON)', () => {
    const first = getIdempotencyKey('billing-checkout', { a: 1, b: 2 });
    const second = getIdempotencyKey('billing-checkout', { b: 2, a: 1 });
    expect(second).toBe(first);
  });

  it('rotates the key when the body changes', () => {
    const first = getIdempotencyKey('billing-checkout', {
      planCode: 'employer_pro',
      successUrl: '/en/employer/billing?billing=success',
    });
    const second = getIdempotencyKey('billing-checkout', {
      planCode: 'employer_pro',
      successUrl: '/es/employer/billing?billing=success',
    });
    expect(second).not.toBe(first);
  });

  it('rotates the key when it encounters a legacy bare-UUID stored value', () => {
    const storageKey = 'jale.idempotency.billing-portal';
    fakeSessionStorage.setItem(storageKey, '11111111-2222-4333-8444-555555555555');
    const body = { returnUrl: '/en/employer/billing' };
    const key = getIdempotencyKey('billing-portal', body);
    expect(key).not.toBe('11111111-2222-4333-8444-555555555555');
    // And the new value round-trips: a subsequent call with the same body reuses it.
    const again = getIdempotencyKey('billing-portal', body);
    expect(again).toBe(key);
  });

  it('rotating the key persists the new canonical body so a matching retry reuses it', () => {
    const bodyA = { returnUrl: '/en/employer/billing' };
    const bodyB = { returnUrl: '/es/employer/billing' };
    const keyA = getIdempotencyKey('billing-portal', bodyA);
    const keyB = getIdempotencyKey('billing-portal', bodyB);
    expect(keyB).not.toBe(keyA);
    const keyBAgain = getIdempotencyKey('billing-portal', bodyB);
    expect(keyBAgain).toBe(keyB);
  });

  it('clears the structured payload so the next identical request gets a new key', () => {
    const action = 'billing-checkout';
    const body = { planCode: 'employer_pro' };
    const storageKey = `jale.idempotency.${action}`;
    const first = getIdempotencyKey(action, body);

    expect(JSON.parse(fakeSessionStorage.getItem(storageKey)!)).toEqual({
      key: first,
      canonicalBody: JSON.stringify(body),
    });

    clearIdempotencyKey(action);
    expect(fakeSessionStorage.getItem(storageKey)).toBeNull();
    expect(getIdempotencyKey(action, body)).not.toBe(first);
  });
});

describe('ApiError re-export', () => {
  // Components and pages import ApiError from '@/lib/api/employer' and check
  // `err instanceof ApiError`. That only holds while the re-export is the very
  // same class the throwers construct.
  it('is the same class as the shared one in lib/api/errors', () => {
    expect(ApiError).toBe(SharedApiError);
    expect(new SharedApiError(409, 'job_limit_reached')).toBeInstanceOf(ApiError);
  });

  it('keeps message === code and exposes the allowlisted payload PostJobModal reads', () => {
    const err = new ApiError(409, 'job_limit_reached', { active_job_limit: 1, active_jobs: 1 });
    expect(err.message).toBe('job_limit_reached');
    expect(err.payload.active_job_limit).toBe(1);
  });
});

describe('isDefinitiveError', () => {
  it('treats non-ApiError values as indeterminate (not definitive)', () => {
    expect(isDefinitiveError(new Error('network failure'))).toBe(false);
    expect(isDefinitiveError('some string')).toBe(false);
    expect(isDefinitiveError(undefined)).toBe(false);
  });

  it('treats 2xx as definitive', () => {
    expect(isDefinitiveError(new ApiError(200, 'ok'))).toBe(true);
  });

  it('treats 503 (provider_retryable) as indeterminate', () => {
    expect(isDefinitiveError(new ApiError(503, 'provider_retryable'))).toBe(false);
  });

  it('treats plain 500 as indeterminate', () => {
    expect(isDefinitiveError(new ApiError(500, 'internal_error'))).toBe(false);
  });

  it('treats 409 operation_in_progress as indeterminate', () => {
    expect(isDefinitiveError(new ApiError(409, 'operation_in_progress'))).toBe(false);
  });

  it('treats other 409s (e.g. idempotency_key_conflict) as definitive', () => {
    expect(isDefinitiveError(new ApiError(409, 'idempotency_key_conflict'))).toBe(true);
  });

  it('treats 502 provider_error as definitive', () => {
    expect(isDefinitiveError(new ApiError(502, 'provider_error'))).toBe(true);
  });

  it('treats terminal 4xx validation errors as definitive', () => {
    expect(isDefinitiveError(new ApiError(400, 'invalid_plan'))).toBe(true);
    expect(isDefinitiveError(new ApiError(404, 'user_not_provisioned'))).toBe(true);
  });
});
