// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIGNUP_SOURCE_CODES,
  SIGNUP_SOURCE_STORAGE_KEY,
  captureSignupSource,
  clearSignupSource,
  normalizeSignupSourceCode,
  readSignupSource,
  signupSourceBody,
} from '../signup-source';

const NOW = new Date('2026-10-14T12:00:00.000Z');

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('normalizeSignupSourceCode', () => {
  it('accepts every listed code, exactly', () => {
    for (const code of SIGNUP_SOURCE_CODES) expect(normalizeSignupSourceCode(code)).toBe(code);
  });
  it('refuses anything else: case, length, characters, unknown codes', () => {
    for (const bad of [null, undefined, '', 'Flyer', ' flyer', 'q', 'a'.repeat(33), 'face book', 'newsletter']) {
      expect(normalizeSignupSourceCode(bad)).toBeNull();
    }
  });
});

describe('captureSignupSource — first touch wins (T-c)', () => {
  it('stashes the first touch under jale.signup-source', () => {
    captureSignupSource({ src: 'flyer', entry: 'app' }, NOW);
    expect(JSON.parse(sessionStorage.getItem(SIGNUP_SOURCE_STORAGE_KEY) as string)).toEqual({
      src: 'flyer', entry: 'app', capturedAt: NOW.toISOString(),
    });
  });

  it('never overwrites it', () => {
    captureSignupSource({ src: null, entry: 'job_link' }, NOW);
    captureSignupSource({ src: 'qr', entry: 'app' }, NOW);
    expect(readSignupSource()).toEqual({ src: null, entry: 'job_link', capturedAt: NOW.toISOString() });
  });

  it('drops a code that is not listed but keeps the touch', () => {
    captureSignupSource({ src: 'evil-code', entry: 'signup_page' }, NOW);
    expect(readSignupSource()).toMatchObject({ src: null, entry: 'signup_page' });
  });

  it('treats an unreadable stash as no stash', () => {
    sessionStorage.setItem(SIGNUP_SOURCE_STORAGE_KEY, '{not json');
    expect(readSignupSource()).toBeNull();
    captureSignupSource({ src: 'sms', entry: 'app' }, NOW);
    expect(readSignupSource()).toMatchObject({ src: 'sms' });
  });

  it('treats a tampered stash as no stash', () => {
    sessionStorage.setItem(SIGNUP_SOURCE_STORAGE_KEY, JSON.stringify({ src: 'EVIL', entry: 'app', capturedAt: 'x' }));
    expect(readSignupSource()).toBeNull();
    sessionStorage.setItem(SIGNUP_SOURCE_STORAGE_KEY, JSON.stringify({ src: 'qr', entry: 'homepage', capturedAt: 'x' }));
    expect(readSignupSource()).toBeNull();
  });
});

describe('the body and the clean-up', () => {
  it('hands the K3.6 wire shape, without the capture time', () => {
    captureSignupSource({ src: 'partner', entry: 'signup_page' }, NOW);
    expect(signupSourceBody()).toEqual({ src: 'partner', entry: 'signup_page' });
  });
  it('is null with nothing stashed, and after clearing', () => {
    expect(signupSourceBody()).toBeNull();
    captureSignupSource({ src: 'qr', entry: 'app' }, NOW);
    clearSignupSource();
    expect(signupSourceBody()).toBeNull();
  });
});

describe('storage that refuses (private mode, in-app web views)', () => {
  it('never throws, and reads as nothing stashed', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => captureSignupSource({ src: 'qr', entry: 'app' }, NOW)).not.toThrow();
    expect(readSignupSource()).toBeNull();
    expect(signupSourceBody()).toBeNull();
    expect(() => clearSignupSource()).not.toThrow();
  });
});
