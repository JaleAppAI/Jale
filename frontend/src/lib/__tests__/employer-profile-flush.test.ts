// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEmployerProfile = vi.fn();
const updateEmployerProfile = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  getEmployerProfile: (...args: unknown[]) => getEmployerProfile(...args),
  updateEmployerProfile: (...args: unknown[]) => updateEmployerProfile(...args),
}));

import * as flushModule from '../employer-profile-flush';
import { loadEmployerProfileWithPendingFlush } from '../employer-profile-flush';

type Flush = (token: string) => Promise<unknown>;
const flushPending = (token: string) =>
  (flushModule as unknown as { flushPendingEmployerProfile: Flush }).flushPendingEmployerProfile(token);

const PENDING = { company_name: 'Prueba Co', hiring_trades: ['concrete'] };
const STASH = { src: 'partner', entry: 'signup_page', capturedAt: '2026-10-14T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  getEmployerProfile.mockResolvedValue({ id: 'e1', company_name: null });
  updateEmployerProfile.mockResolvedValue({ id: 'e1', company_name: 'Prueba Co' });
});

describe('the first profile save after sign-up (K3.6)', () => {
  it('carries the signup source with the pending profile, then forgets both', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));

    const loaded = await loadEmployerProfileWithPendingFlush('tok');

    expect(updateEmployerProfile).toHaveBeenCalledWith('tok', {
      ...PENDING,
      signup_source: { src: 'partner', entry: 'signup_page' },
    });
    expect(loaded).toEqual({ id: 'e1', company_name: 'Prueba Co' });
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
    expect(sessionStorage.getItem('jale.signup-source')).toBeNull();
  });

  it('sends the pending profile alone when no source was captured', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    await loadEmployerProfileWithPendingFlush('tok');
    expect(updateEmployerProfile).toHaveBeenCalledWith('tok', PENDING);
  });

  it('does nothing beyond the read on an ordinary visit, and keeps the source for the real first save', async () => {
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));
    await loadEmployerProfileWithPendingFlush('tok');
    expect(updateEmployerProfile).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('jale.signup-source')).not.toBeNull();
  });

  it('keeps both when the save fails, for the next load to retry', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));
    updateEmployerProfile.mockRejectedValue(new Error('offline'));

    await expect(loadEmployerProfileWithPendingFlush('tok')).rejects.toThrow('offline');
    expect(sessionStorage.getItem('pendingEmployerProfile')).not.toBeNull();
    expect(sessionStorage.getItem('jale.signup-source')).not.toBeNull();
  });
});

/*
 * The dashboard flushes the same answers (a new employer now lands there, not
 * on Profile), so the profile page and the dashboard can both ask at once --
 * and StrictMode runs effects twice. One PATCH per pending payload, whoever
 * asks first.
 */
describe('flushing the pending sign-up answers from anywhere', () => {
  it('sends one PATCH for concurrent asks, and clears the store once it lands', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    let land: (value: unknown) => void = () => {};
    updateEmployerProfile.mockReturnValue(new Promise((resolve) => { land = resolve; }));

    const first = flushPending('tok');
    const second = flushPending('tok');
    const fromProfile = loadEmployerProfileWithPendingFlush('tok');
    await Promise.resolve();
    land({ id: 'e1', company_name: 'Prueba Co' });
    await Promise.all([first, second, fromProfile]);

    expect(updateEmployerProfile).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
    expect(await fromProfile).toEqual({ id: 'e1', company_name: 'Prueba Co' });
  });

  it('does nothing when there is nothing pending', async () => {
    await expect(flushPending('tok')).resolves.toBeNull();
    expect(updateEmployerProfile).not.toHaveBeenCalled();
  });

  it('keeps the store after a failure, and the next ask retries', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    updateEmployerProfile.mockRejectedValueOnce(new Error('offline'));

    await expect(flushPending('tok')).rejects.toThrow('offline');
    expect(sessionStorage.getItem('pendingEmployerProfile')).not.toBeNull();

    await flushPending('tok');
    expect(updateEmployerProfile).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
  });
});
