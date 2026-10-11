/**
 * The device a report was sent from, in coarse terms: what kind of device,
 * which browser and OS family, the screen size, whether it was online, and
 * the local time and time zone. Never the raw user-agent string.
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop';
export type BrowserFamily = 'chrome' | 'safari' | 'firefox' | 'edge' | 'samsung' | 'opera' | 'webview' | 'other';
export type OsFamily = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other';

export type DeviceSummary = {
  kind: DeviceKind;
  browser: BrowserFamily;
  os: OsFamily;
  viewport: [number, number];
  online: boolean;
  tz: string;
  local_time: string;
};

/** Below this short side, a touch screen is a phone. */
const PHONE_MAX_SHORT_SIDE = 600;
/** Without pointer information, a window this wide or wider is a desktop. */
const DESKTOP_MIN_WIDTH = 1024;

function isAppleTouch(ua: string, maxTouchPoints: number): boolean {
  // iPadOS asks for desktop pages as "Macintosh"; only touch gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

export function osFamily(ua: string, maxTouchPoints = 0): OsFamily {
  if (isAppleTouch(ua, maxTouchPoints)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export function browserFamily(ua: string, maxTouchPoints = 0): BrowserFamily {
  // In-app browsers (WhatsApp and other apps open links in one) come first:
  // they borrow the engine's name but behave differently.
  if (/; wv\)|FBAN|FBAV|Instagram|Line\//.test(ua)) return 'webview';
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  // An iOS app's own web view drops the "Safari/" token.
  if (isAppleTouch(ua, maxTouchPoints) && /AppleWebKit\//.test(ua)) return 'webview';
  return 'other';
}

/**
 * Phone, tablet or desktop, from the viewport and the pointer: a fine pointer
 * is a desktop however narrow the window, a touch screen is a phone or a
 * tablet by its short side. `coarsePointer` is null when the browser cannot say.
 */
export function deviceKind([width, height]: [number, number], coarsePointer: boolean | null): DeviceKind {
  if (coarsePointer === false) return 'desktop';
  if (coarsePointer === true) return Math.min(width, height) < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  if (width < PHONE_MAX_SHORT_SIDE) return 'phone';
  return width < DESKTOP_MIN_WIDTH ? 'tablet' : 'desktop';
}

function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0');
}

/** ISO-8601 local time with its offset, for example "2026-10-02T08:03:05-06:00". */
export function localIsoTime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

function timeZone(): string {
  try {
    return (Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown').slice(0, 64);
  } catch {
    return 'unknown';
  }
}

function coarsePointer(): boolean | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : null;
  } catch {
    return null;
  }
}

/** The app's locale: the address bar's prefix first, then the page's lang. */
export function currentLocale(): 'en' | 'es' {
  if (typeof window === 'undefined') return 'en';
  const prefix = /^\/(en|es)(?=\/|$)/.exec(window.location?.pathname ?? '');
  if (prefix) return prefix[1] as 'en' | 'es';
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return lang === 'es' ? 'es' : 'en';
}

/** The theme in force, from the `.dark` class the theme script sets on <html>. */
export function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function deviceSummary(now: Date = new Date()): DeviceSummary {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = nav?.userAgent ?? '';
  const touchPoints = nav?.maxTouchPoints ?? 0;
  const viewport: [number, number] =
    typeof window === 'undefined'
      ? [0, 0]
      : [Math.max(0, Math.round(window.innerWidth || 0)), Math.max(0, Math.round(window.innerHeight || 0))];
  return {
    kind: typeof window === 'undefined' ? 'desktop' : deviceKind(viewport, coarsePointer()),
    browser: browserFamily(ua, touchPoints),
    os: osFamily(ua, touchPoints),
    viewport,
    online: typeof nav?.onLine === 'boolean' ? nav.onLine : true,
    tz: timeZone(),
    local_time: localIsoTime(now),
  };
}
