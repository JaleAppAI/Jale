/**
 * The on-device context of a problem report: the screen, the build, the
 * device, and the last few requests, errors and screens.
 *
 * Everything here describes, and nothing here identifies. Requests and screens
 * are kept as patterns ("/worker/jobs/:id/apply"), errors are scrubbed and
 * shortened, and request bodies are never seen.
 *
 * The buffers live in this module's memory only: they are never written to
 * localStorage, sessionStorage or a cookie, they are emptied on sign-out
 * (`clearReportBuffers`), and they leave the device only inside a report the
 * person chose to send (`collectReportContext`). Where there is no `window`
 * (the server), every `record*` function does nothing.
 */

import { currentLocale, currentTheme, deviceSummary, type DeviceSummary } from './device';
import { apiPathPattern, routePattern } from './patterns';
import { scrubMessage } from './scrub';

export { routePattern };

/** The content hash of the frontend sources, inlined by `next.config.mjs`. */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_JALE_BUILD || 'unknown';

export type CaptureSummary = { outcome: 'ok' | 'timeout' | 'failed' | 'removed' | 'attached' | 'none'; ms: number };

/** One request: method, path pattern, status (0 = no response seen), duration, API request id. */
export type ReportRequest = { m: string; p: string; s: number; ms: number; rid?: string };
export type ReportError = { k: 'error' | 'rejection' | 'api'; msg: string; at: string };

/** Context schema v1. Without technical details only `v`, `screen.pattern`, `app.build` and `app.locale` are present. */
export type ReportContextV1 = {
  v: 1;
  screen: { pattern: string; refs?: Record<string, string> };
  screens?: string[];
  app: { build: string; locale: 'en' | 'es'; theme?: 'light' | 'dark' };
  device?: DeviceSummary;
  requests?: ReportRequest[];
  errors?: ReportError[];
  capture?: CaptureSummary;
};

/** The largest serialized context a report carries. */
export const MAX_CONTEXT_BYTES = 32 * 1024;

const MAX_REQUESTS = 20;
const MAX_ERRORS = 10;
const MAX_SCREENS = 5;
const MAX_METHOD_LENGTH = 10;
const MAX_REQUEST_ID_LENGTH = 64;
/** The largest duration or status kept; anything larger is clamped, so it fits a 32-bit column. */
const MAX_INTEGER = 2_147_483_647;
const REQUEST_ID_SHAPE = /^[A-Za-z0-9-]+$/;
/** An API error code as the API writes them ("invalid_input"); anything else is not kept. */
const ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_KINDS = new Set<ReportError['k']>(['error', 'rejection', 'api']);

type Screen = { pattern: string; refs: Record<string, string> };

const requests: ReportRequest[] = [];
const errors: ReportError[] = [];
const screens: string[] = [];
let currentScreen: Screen | null = null;

function onDevice(): boolean {
  return typeof window !== 'undefined' && window !== null;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function push<T>(buffer: T[], entry: T, max: number): void {
  buffer.push(entry);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}

function integer(value: number, max = MAX_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), max);
}

function method(value: string): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, MAX_METHOD_LENGTH) || 'GET';
}

function requestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !REQUEST_ID_SHAPE.test(value)) return undefined;
  return value.slice(0, MAX_REQUEST_ID_LENGTH);
}

/** The API request id of a response, if it carries one; never throws. */
function requestIdOf(res: unknown): string | undefined {
  try {
    const value = (res as Partial<Response> | null)?.headers?.get?.('x-amzn-requestid');
    return requestId(value);
  } catch {
    return undefined;
  }
}

/**
 * Records one request. `url` may be an absolute URL or an API path; both are
 * kept as the API route's pattern. The literal `s3:upload` stands for a
 * presigned upload, whose address is never passed here. Status 0 means no
 * response was observed (a network failure, an abort, or a beacon).
 */
export function recordRequest(e: { method: string; url: string; status: number; ms: number; requestId?: string }): void {
  if (!onDevice()) return;
  const entry: ReportRequest = { m: method(e.method), p: apiPathPattern(e.url), s: integer(e.status, 999), ms: integer(e.ms) };
  const rid = requestId(e.requestId);
  if (rid !== undefined) entry.rid = rid;
  push(requests, entry, MAX_REQUESTS);
}

/**
 * Runs one raw request and records it: its status, duration and request id,
 * or status 0 when it never got a response. The result, or the error, is
 * handed back untouched.
 */
export async function recordFetch<T extends Pick<Response, 'status'>>(
  request: { method: string; url: string },
  send: () => Promise<T>,
): Promise<T> {
  if (!onDevice()) return send();
  const started = now();
  let res: T;
  try {
    res = await send();
  } catch (err) {
    recordRequest({ method: request.method, url: request.url, status: 0, ms: now() - started });
    throw err;
  }
  recordRequest({ method: request.method, url: request.url, status: res.status, ms: now() - started, requestId: requestIdOf(res) });
  return res;
}

/** Records an error, scrubbed of anything value-shaped and shortened to 200 characters. */
export function recordError(e: { kind: 'error' | 'rejection' | 'api'; message: string }): void {
  if (!onDevice()) return;
  push(errors, {
    k: ERROR_KINDS.has(e.kind) ? e.kind : 'error',
    msg: scrubMessage(e.message),
    at: new Date().toISOString(),
  }, MAX_ERRORS);
}

/** Records an API failure as "<status> <code>", or the status alone when there is no code-shaped code. */
export function recordApiError(status: number, code?: unknown): void {
  const shaped = typeof code === 'string' && ERROR_CODE_SHAPE.test(code) ? ` ${code}` : '';
  recordError({ kind: 'api', message: `${integer(status, 999)}${shaped}` });
}

/**
 * Records a failed API response as "<status> <code>". The code is read from a
 * copy of the body, so the caller's response is left unread, and only the
 * `error` field is looked at: never the message or any other part of the
 * payload.
 */
export function recordApiErrorResponse(res: Pick<Response, 'status'>): void {
  if (!onDevice()) return;
  const status = res.status;
  let body: Promise<unknown>;
  try {
    body = Promise.resolve((res as Response).clone().json());
  } catch {
    recordApiError(status);
    return;
  }
  body
    .then((value) => (value !== null && typeof value === 'object' ? (value as { error?: unknown }).error : undefined), () => undefined)
    .then((code) => recordApiError(status, code))
    .catch(() => {});
}

/**
 * Records the screen in view, from next-intl's locale-free pathname and the
 * route's `useParams()` without `locale`. A screen recorded twice in a row is
 * kept once.
 */
export function recordScreen(pathname: string, params: Record<string, string | string[]>): void {
  if (!onDevice()) return;
  const screen = routePattern(pathname, params);
  currentScreen = screen;
  if (screens[screens.length - 1] !== screen.pattern) push(screens, screen.pattern, MAX_SCREENS);
}

/** Empties every buffer and forgets the current screen. Called when a session ends. */
export function clearReportBuffers(): void {
  requests.length = 0;
  errors.length = 0;
  screens.length = 0;
  currentScreen = null;
}

function errorText(value: unknown): string | null {
  if (value instanceof Error) {
    const name = typeof value.name === 'string' && value.name !== '' ? value.name : 'Error';
    return typeof value.message === 'string' && value.message !== '' ? `${name}: ${value.message}` : name;
  }
  return null;
}

function onWindowError(event: Event): void {
  const { message, error } = event as ErrorEvent;
  const text = typeof message === 'string' && message !== '' ? message : errorText(error);
  recordError({ kind: 'error', message: text ?? 'Uncaught error' });
}

function onUnhandledRejection(event: Event): void {
  const { reason } = event as PromiseRejectionEvent;
  // Only an Error's name and message, or a plain string, are read. Any other
  // reason is named by its type alone: an object can hold anything.
  const text = errorText(reason) ?? (typeof reason === 'string' ? reason : `Unhandled rejection (${reason === null ? 'null' : typeof reason})`);
  recordError({ kind: 'rejection', message: text });
}

let captureInstalls = 0;

/**
 * Listens for uncaught errors and unhandled rejections until the returned
 * function is called. Installing twice adds the listeners once; they go when
 * the last installer uninstalls.
 */
export function installErrorCapture(): () => void {
  if (!onDevice()) return () => {};
  if (captureInstalls === 0) {
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
  }
  captureInstalls += 1;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    captureInstalls -= 1;
    if (captureInstalls === 0 && onDevice()) {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    }
  };
}

/** The screen in view: the last one recorded, or else the address bar's, without refs. */
function screenInView(): Screen {
  if (currentScreen) return { pattern: currentScreen.pattern, refs: { ...currentScreen.refs } };
  if (!onDevice()) return { pattern: '/', refs: {} };
  const pathname = (window.location?.pathname ?? '/').replace(/^\/(en|es)(?=\/|$)/, '');
  return { pattern: routePattern(pathname || '/', {}).pattern, refs: {} };
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The context cut down to `budget` bytes of JSON: the oldest requests and
 * errors go first, taking turns; then the oldest screens. If that is still
 * not enough, only what a report without technical details carries is left.
 */
export function fitContextToBudget(ctx: ReportContextV1, budget: number = MAX_CONTEXT_BYTES): ReportContextV1 {
  if (byteSize(ctx) <= budget) return ctx;
  const kept = { requests: [...(ctx.requests ?? [])], errors: [...(ctx.errors ?? [])], screens: [...(ctx.screens ?? [])] };
  const build = (): ReportContextV1 => ({
    ...ctx,
    ...(ctx.requests ? { requests: kept.requests } : {}),
    ...(ctx.errors ? { errors: kept.errors } : {}),
    ...(ctx.screens ? { screens: kept.screens } : {}),
  });

  let requestsTurn = true;
  while (kept.requests.length + kept.errors.length > 0) {
    if (byteSize(build()) <= budget) return build();
    if ((requestsTurn && kept.requests.length > 0) || kept.errors.length === 0) kept.requests.shift();
    else kept.errors.shift();
    requestsTurn = !requestsTurn;
  }
  while (kept.screens.length > 0 && byteSize(build()) > budget) kept.screens.shift();
  const trimmed = build();
  if (byteSize(trimmed) <= budget) return trimmed;
  return { v: 1, screen: { pattern: ctx.screen.pattern }, app: { build: ctx.app.build, locale: ctx.app.locale } };
}

/**
 * The context for a report, schema v1. With technical details it carries the
 * screen and its refs, the last screens, the app, the device, the request
 * and error buffers and the capture outcome, within 32 KB; without, only the
 * screen pattern, the build and the locale. Every part is a copy.
 */
export function collectReportContext(o: { includeTechnical: boolean; capture: CaptureSummary }): ReportContextV1 {
  const screen = screenInView();
  const locale = currentLocale();
  if (!o.includeTechnical) {
    return { v: 1, screen: { pattern: screen.pattern }, app: { build: BUILD_ID, locale } };
  }
  return fitContextToBudget({
    v: 1,
    screen,
    screens: [...screens],
    app: { build: BUILD_ID, locale, theme: currentTheme() },
    device: deviceSummary(),
    requests: requests.map((entry) => ({ ...entry })),
    errors: errors.map((entry) => ({ ...entry })),
    capture: { outcome: o.capture.outcome, ms: integer(o.capture.ms) },
  });
}
