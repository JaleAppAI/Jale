// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEmployerProfile = vi.fn();
const updateEmployerProfile = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  getEmployerProfile: (...args: unknown[]) => getEmployerProfile(...args),
  updateEmployerProfile: (...args: unknown[]) => updateEmployerProfile(...args),
}));

import { ApiError } from '../api/errors';
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

/*
 * The dashboard calls this from an effect and only handles a rejection, so it
 * must never throw synchronously: storage can be blocked (some webviews, a
 * "block all cookies" setting), and a stash can be unreadable.
 */
describe('flushing when storage cannot be trusted', () => {
  it('resolves to null, without throwing, when storage access is blocked', async () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      let result: Promise<unknown> | undefined;
      expect(() => { result = flushPending('tok'); }).not.toThrow();
      await expect(result).resolves.toBeNull();
      expect(updateEmployerProfile).not.toHaveBeenCalled();
    } finally {
      blocked.mockRestore();
    }
  });

  it('keeps an unreadable stash and sends nothing', async () => {
    sessionStorage.setItem('pendingEmployerProfile', '{not json');

    let result: Promise<unknown> | undefined;
    expect(() => { result = flushPending('tok'); }).not.toThrow();
    await expect(result).resolves.toBeNull();
    expect(updateEmployerProfile).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBe('{not json');
  });

  it('treats a stash that is not an object as unreadable', async () => {
    sessionStorage.setItem('pendingEmployerProfile', '"just text"');

    await expect(flushPending('tok')).resolves.toBeNull();
    expect(updateEmployerProfile).not.toHaveBeenCalled();
  });
});

/*
 * The dashboard's PATCH can still be in flight when the employer opens
 * Profile. The profile load must not answer from a read served before that
 * PATCH landed: it flushes (or joins the flush) first, and reads only when
 * nothing was pending.
 */
describe('the profile load while the dashboard is still saving', () => {
  it('answers with the saved answers, not a read served before the save landed', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    let landPatch: (value: unknown) => void = () => {};
    updateEmployerProfile.mockReturnValue(new Promise((resolve) => { landPatch = resolve; }));
    let serveGet: (value: unknown) => void = () => {};
    getEmployerProfile.mockReturnValue(new Promise((resolve) => { serveGet = resolve; }));

    const fromDashboard = flushPending('tok');
    const fromProfile = loadEmployerProfileWithPendingFlush('tok');
    await Promise.resolve();
    // The PATCH lands first, then a read the server answered before it.
    landPatch({ id: 'e1', company_name: 'Prueba Co' });
    await fromDashboard;
    serveGet({ id: 'e1', company_name: null });

    expect(await fromProfile).toEqual({ id: 'e1', company_name: 'Prueba Co' });
    expect(updateEmployerProfile).toHaveBeenCalledTimes(1);
  });

  it('reads the profile when nothing is pending', async () => {
    expect(await loadEmployerProfileWithPendingFlush('tok')).toEqual({ id: 'e1', company_name: null });
    expect(getEmployerProfile).toHaveBeenCalledTimes(1);
  });
});

/*
 * Phase 3 (Task 16, I4): an invited foreman's sign-up stages only
 * `{ contact_name, phone }`. A foreman may not write company fields, and
 * `signup_source` is a company sign-up's analytics, so the flush adds it only
 * when the stash carries `company_name` -- otherwise the first save after an
 * invite sign-up would carry a company sign-up's source.
 */
describe('an invite sign-up\'s first save (Phase 3)', () => {
  it('invite-mode pending profile has only contact_name and phone; the flush sends no signup_source', async () => {
    const invitePending = { contact_name: 'Ana Ruiz', phone: '+12105550100' };
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(invitePending));
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));

    await flushPending('tok');

    expect(updateEmployerProfile).toHaveBeenCalledTimes(1);
    expect(updateEmployerProfile).toHaveBeenCalledWith('tok', invitePending);
    // Both stashes are spent once the save lands, as for any sign-up.
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
    expect(sessionStorage.getItem('jale.signup-source')).toBeNull();
  });

  it('a company stash refused 403 owner_required (the login became a foreman) resends only contact_name and phone, then forgets it', async () => {
    const companyStash = { ...PENDING, contact_name: 'Ana Ruiz', phone: '+12105550100', city: 'Austin' };
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(companyStash));
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));
    updateEmployerProfile
      .mockRejectedValueOnce(new ApiError(403, 'owner_required'))
      .mockResolvedValueOnce({ id: 'e1', contact_name: 'Ana Ruiz' });

    await expect(flushPending('tok')).resolves.toEqual({ id: 'e1', contact_name: 'Ana Ruiz' });

    expect(updateEmployerProfile).toHaveBeenCalledTimes(2);
    expect(updateEmployerProfile).toHaveBeenLastCalledWith('tok', { contact_name: 'Ana Ruiz', phone: '+12105550100' });
    expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
    expect(sessionStorage.getItem('jale.signup-source')).toBeNull();
  });

  it('another 403 is not retried and keeps the stash', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    updateEmployerProfile.mockRejectedValueOnce(new ApiError(403, 'employer_required'));

    await expect(flushPending('tok')).rejects.toMatchObject({ code: 'employer_required' });
    expect(updateEmployerProfile).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('pendingEmployerProfile')).not.toBeNull();
  });

  it('still adds signup_source to a company sign-up\'s stash', async () => {
    sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
    sessionStorage.setItem('jale.signup-source', JSON.stringify(STASH));

    await flushPending('tok');

    expect(updateEmployerProfile).toHaveBeenCalledWith('tok', {
      ...PENDING,
      signup_source: { src: 'partner', entry: 'signup_page' },
    });
  });
});

describe('the stored invite (Phase 3)', () => {
  it('stores { token, email } with the email normalised, and reads it back', async () => {
    const { storePendingInvite, readPendingInvite, PENDING_INVITE_KEY } = await import('../employer-profile-flush');

    storePendingInvite({ token: 'tok-1', email: '  Ana@Example.COM ' });

    expect(PENDING_INVITE_KEY).toBe('pendingInvite');
    expect(JSON.parse(sessionStorage.getItem(PENDING_INVITE_KEY) as string)).toEqual({ token: 'tok-1', email: 'ana@example.com' });
    expect(readPendingInvite()).toEqual({ token: 'tok-1', email: 'ana@example.com' });
  });

  it('matches the stored invite only to its own email, case-insensitive and trimmed', async () => {
    const { storePendingInvite, storedInviteTokenFor } = await import('../employer-profile-flush');

    storePendingInvite({ token: 'tok-1', email: 'ana@example.com' });

    expect(storedInviteTokenFor(' ANA@example.com ')).toBe('tok-1');
    expect(storedInviteTokenFor('someone@example.com')).toBeNull();
    expect(storedInviteTokenFor('')).toBeNull();
  });

  it('reads a malformed or missing stash as none, and clears it', async () => {
    const { readPendingInvite, clearPendingInvite, storedInviteTokenFor } = await import('../employer-profile-flush');

    expect(readPendingInvite()).toBeNull();
    sessionStorage.setItem('pendingInvite', '{not json');
    expect(readPendingInvite()).toBeNull();
    sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 42, email: 'a@b.c' }));
    expect(readPendingInvite()).toBeNull();
    expect(storedInviteTokenFor('a@b.c')).toBeNull();

    sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 't', email: 'a@b.c' }));
    clearPendingInvite();
    expect(sessionStorage.getItem('pendingInvite')).toBeNull();
  });
});
