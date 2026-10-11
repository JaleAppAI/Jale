import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserFamily, deviceKind, localIsoTime, osFamily } from '../device';

// Representative user-agent strings of each family, shortened. They describe
// a browser build, never a person.
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneInApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  macOpera:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('browserFamily and osFamily', () => {
  it.each([
    ['iphoneSafari', 'safari', 'ios', 5],
    ['iphoneChrome', 'chrome', 'ios', 5],
    ['iphoneInApp', 'webview', 'ios', 5],
    ['ipadDesktopMode', 'safari', 'ios', 5],
    ['androidChrome', 'chrome', 'android', 5],
    ['androidWebView', 'webview', 'android', 5],
    ['androidSamsung', 'samsung', 'android', 5],
    ['windowsEdge', 'edge', 'windows', 0],
    ['windowsChrome', 'chrome', 'windows', 0],
    ['macFirefox', 'firefox', 'macos', 0],
    ['macOpera', 'opera', 'macos', 0],
    ['linuxFirefox', 'firefox', 'linux', 0],
    ['chromebook', 'chrome', 'chromeos', 0],
  ] as const)('%s is %s on %s', (name, browser, os, touchPoints) => {
    expect(browserFamily(UA[name], touchPoints)).toBe(browser);
    expect(osFamily(UA[name], touchPoints)).toBe(os);
  });

  it('a Mac without touch stays macOS', () => {
    expect(osFamily(UA.ipadDesktopMode, 0)).toBe('macos');
  });

  it('falls back to other for anything unknown, and never echoes the input', () => {
    const odd = 'SomeAgent/1.0 (custom build 5550100199)';
    expect(browserFamily(odd, 0)).toBe('other');
    expect(osFamily(odd, 0)).toBe('other');
    expect(browserFamily('', 0)).toBe('other');
  });
});

describe('deviceKind', () => {
  it('reads a touch screen by its short side', () => {
    expect(deviceKind([390, 844], true)).toBe('phone');
    expect(deviceKind([844, 390], true)).toBe('phone');
    expect(deviceKind([820, 1180], true)).toBe('tablet');
  });

  it('calls a fine pointer a desktop, however narrow the window', () => {
    expect(deviceKind([1440, 900], false)).toBe('desktop');
    expect(deviceKind([390, 844], false)).toBe('desktop');
  });

  it('falls back to the width when the pointer is unknown', () => {
    expect(deviceKind([390, 844], null)).toBe('phone');
    expect(deviceKind([800, 1000], null)).toBe('tablet');
    expect(deviceKind([1440, 900], null)).toBe('desktop');
  });
});

describe('localIsoTime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is ISO-8601 with the local offset, and names the same instant', () => {
    const now = new Date('2026-10-02T14:03:05.678Z');
    const out = localIsoTime(now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Date.parse(out)).toBe(Date.parse('2026-10-02T14:03:05Z'));
  });

  it('writes the offset of the time zone in force', () => {
    vi.stubEnv('TZ', 'America/Mexico_City');
    expect(localIsoTime(new Date('2026-10-02T14:03:05Z'))).toBe('2026-10-02T08:03:05-06:00');
    vi.stubEnv('TZ', 'Asia/Kolkata');
    expect(localIsoTime(new Date('2026-10-02T14:03:05Z'))).toBe('2026-10-02T19:33:05+05:30');
    vi.stubEnv('TZ', 'UTC');
    expect(localIsoTime(new Date('2026-10-02T14:03:05Z'))).toBe('2026-10-02T14:03:05+00:00');
  });
});
