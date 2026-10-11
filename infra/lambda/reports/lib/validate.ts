/**
 * Request validation for "report a problem": the body schemas of the intake
 * routes and schema v1 of the report context.
 *
 * Everything here runs before the database sees the request. A top-level
 * body field that is missing or of the wrong shape answers 400
 * `invalid_request` with the field NAMES only, never a value. The context is
 * different: it is reduced, never refused. Unknown keys are dropped, an
 * over-long string is cut, an optional field of the wrong shape is dropped,
 * and value-shaped content (addresses, phone numbers, long numbers, ids,
 * tokens, links) is replaced with a placeholder as defence in depth. With
 * technical details off only the screen pattern, the build and the locale
 * survive.
 *
 * Text the database cannot store never reaches it: a NUL, or half of a
 * surrogate pair standing alone. The description and the contact refuse it
 * (400, naming the field); the context drops a NUL and replaces a lone half
 * with U+FFFD.
 */
import { isUuid } from '../../lib/uuid';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_CONTACT_CHARS = 200;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export type ReportRole = 'worker' | 'employer' | 'unknown';
const ROLES: readonly ReportRole[] = ['worker', 'employer', 'unknown'];

const WORKER_CATEGORIES = ['sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'] as const;
const EMPLOYER_CATEGORIES = [
  'account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile', 'other',
] as const;
const ALL_CATEGORIES: readonly string[] = Array.from(new Set<string>([...WORKER_CATEGORIES, ...EMPLOYER_CATEGORIES]));

/** The categories a role may choose. A signed-out report with no role uses the worker list. */
export function categoriesFor(role: ReportRole): readonly string[] {
  return role === 'employer' ? EMPLOYER_CATEGORIES : WORKER_CATEGORIES;
}

// ── Body ──

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 413; error: 'payload_too_large' }
  | { ok: false; status: 400; error: 'invalid_request'; fields: string[] };

/**
 * The request body as a JSON object. Over 64 KB (in bytes, after any base64
 * decoding) is 413; anything that is not a JSON object is 400.
 */
export function readJsonBody(event: { body?: string | null; isBase64Encoded?: boolean }): BodyResult {
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'invalid_request', fields: ['body'] };
  }
  if (!isRecord(value)) return { ok: false, status: 400, error: 'invalid_request', fields: ['body'] };
  return { ok: true, value };
}

export type Invalid = { ok: false; fields: string[] };
export type Valid<T> = { ok: true; value: T };

export interface ImageDeclaration {
  contentType: ImageType;
  byteSize: number;
}

export interface CreateInput {
  clientKey: string;
  category: string;
  description: string;
  stopsWork: boolean | null;
  locale: 'es' | 'en';
  includeTechnical: boolean;
  context: ContextV1;
  image: ImageDeclaration | null;
}

export interface PublicCreateInput extends CreateInput {
  roleClaimed: ReportRole;
  contact: string | null;
}

export interface UploadInput {
  reportId: string;
  attachToken: string;
  image: ImageDeclaration;
}

export interface AttachInput {
  reportId: string;
  attachToken: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 32 random bytes, base64url without padding: 43 characters. */
const ATTACH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Length in characters (code points), as PostgreSQL's char_length counts. */
function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * PostgreSQL stores neither a NUL (in text or jsonb) nor, in jsonb, half of a
 * surrogate pair standing alone. Regular expressions rather than
 * `isWellFormed` and `toWellFormed`, which the ES2022 library does not declare.
 * `search` ignores `lastIndex`, so the global flag is safe to share with
 * `replace` below.
 */
const NUL = /\u0000/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function storable(text: string): boolean {
  return text.search(NUL) === -1 && text.search(LONE_SURROGATE) === -1;
}

/** The text with every NUL dropped and every lone surrogate replaced by U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(NUL, '').replace(LONE_SURROGATE, '�');
}

function imageDeclaration(value: unknown): ImageDeclaration | undefined {
  if (!isRecord(value)) return undefined;
  const { content_type: contentType, byte_size: byteSize } = value;
  if (typeof contentType !== 'string' || !(IMAGE_TYPES as readonly string[]).includes(contentType)) return undefined;
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_IMAGE_BYTES) {
    return undefined;
  }
  return { contentType: contentType as ImageType, byteSize };
}

type Door = { door: 'signed_in'; role: ReportRole } | { door: 'signed_out'; role: ReportRole | undefined };

/** The fields both doors share. `fields` collects the names that fail. */
function commonCreate(body: Record<string, unknown>, door: Door, fields: string[]): Omit<CreateInput, 'context'> {
  const clientKey = typeof body.client_key === 'string' && UUID_V4.test(body.client_key)
    ? body.client_key.toLowerCase()
    : undefined;
  if (!clientKey) fields.push('client_key');

  // Signed in, the account decides the role in SQL when the sign-in cannot
  // tell; any known category passes here and SQL pairs it with the role.
  const allowed = door.door === 'signed_in' && door.role === 'unknown'
    ? ALL_CATEGORIES
    : door.role === undefined ? [] : categoriesFor(door.role);
  const category = typeof body.category === 'string' && allowed.includes(body.category) ? body.category : undefined;
  // A signed-out body with a bad role is reported once, on the role.
  if (!category && !(door.door === 'signed_out' && door.role === undefined)) fields.push('category');

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const descriptionLength = charLength(description);
  if (descriptionLength < 1 || descriptionLength > MAX_DESCRIPTION_CHARS || !storable(description)) {
    fields.push('description');
  }

  // Only employers answer "does this stop your work?". A signed-in role the
  // account decides may carry it; SQL keeps it for employers only.
  const stopsWorkRaw = body.stops_work ?? null;
  const mayStopWork = door.role === 'employer' || (door.door === 'signed_in' && door.role === 'unknown');
  const stopsWorkValid = stopsWorkRaw === null || (mayStopWork && typeof stopsWorkRaw === 'boolean');
  if (!stopsWorkValid) fields.push('stops_work');

  const locale = body.locale === 'es' || body.locale === 'en' ? body.locale : undefined;
  if (!locale) fields.push('locale');

  const includeTechnical = typeof body.include_technical === 'boolean' ? body.include_technical : undefined;
  if (includeTechnical === undefined) fields.push('include_technical');

  let image: ImageDeclaration | null = null;
  if (body.image !== undefined && body.image !== null) {
    const declared = imageDeclaration(body.image);
    if (declared) image = declared;
    else fields.push('image');
  }

  return {
    clientKey: clientKey ?? '',
    category: category ?? '',
    description,
    stopsWork: stopsWorkValid ? (stopsWorkRaw as boolean | null) : null,
    locale: locale ?? 'es',
    includeTechnical: includeTechnical ?? false,
    image,
  };
}

/** The signed-in create body. `role` is the role the sign-in implies. */
export function validateCreate(body: unknown, role: ReportRole): Valid<CreateInput> | Invalid {
  if (!isRecord(body)) return { ok: false, fields: ['body'] };
  const fields: string[] = [];
  const common = commonCreate(body, { door: 'signed_in', role }, fields);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { ...common, context: sanitizeContext(body.context, common.includeTechnical) } };
}

/** The signed-out create body: the common fields plus `role_claimed` and `contact`. */
export function validatePublicCreate(body: unknown): Valid<PublicCreateInput> | Invalid {
  if (!isRecord(body)) return { ok: false, fields: ['body'] };
  const fields: string[] = [];
  const roleClaimed = typeof body.role_claimed === 'string' && (ROLES as readonly string[]).includes(body.role_claimed)
    ? (body.role_claimed as ReportRole)
    : undefined;
  const common = commonCreate(body, { door: 'signed_out', role: roleClaimed }, fields);
  if (!roleClaimed) fields.push('role_claimed');

  let contact: string | null = null;
  if (body.contact !== undefined && body.contact !== null) {
    if (typeof body.contact !== 'string') {
      fields.push('contact');
    } else {
      const trimmed = body.contact.trim();
      if (charLength(trimmed) > MAX_CONTACT_CHARS || !storable(trimmed)) fields.push('contact');
      else contact = trimmed === '' ? null : trimmed;
    }
  }

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      ...common,
      roleClaimed: roleClaimed as ReportRole,
      contact,
      context: sanitizeContext(body.context, common.includeTechnical),
    },
  };
}

function reportAndToken(body: Record<string, unknown>, fields: string[]): AttachInput {
  const reportId = typeof body.report_id === 'string' && isUuid(body.report_id) ? body.report_id.toLowerCase() : undefined;
  if (!reportId) fields.push('report_id');
  const attachToken = typeof body.attach_token === 'string' && ATTACH_TOKEN.test(body.attach_token)
    ? body.attach_token
    : undefined;
  if (!attachToken) fields.push('attach_token');
  return { reportId: reportId ?? '', attachToken: attachToken ?? '' };
}

export function validateUpload(body: unknown): Valid<UploadInput> | Invalid {
  if (!isRecord(body)) return { ok: false, fields: ['body'] };
  const fields: string[] = [];
  const ids = reportAndToken(body, fields);
  const image = imageDeclaration(body.image);
  if (!image) fields.push('image');
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { ...ids, image: image as ImageDeclaration } };
}

export function validateAttach(body: unknown): Valid<AttachInput> | Invalid {
  if (!isRecord(body)) return { ok: false, fields: ['body'] };
  const fields: string[] = [];
  const ids = reportAndToken(body, fields);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: ids };
}

// ── Scrubbing ──

const URLS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+|\b(?:data|blob):[^\s<>"'`]+/gi;
const SIGN_IN_TOKENS = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
// Anchored on the character before the address, so a long run of letters is
// scanned once rather than once per position.
const EMAILS = /(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RECORD_IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_TOKENS = /\b[0-9a-f]{32,}\b/gi;
const LONG_NUMBERS = /\d{7,}/g;
/** Digits with optional +, spaces, dots, dashes or brackets; a phone when it holds 7 or more digits. */
const PHONE_SHAPES = /(^|[^A-Za-z0-9_+])(\+?\(?\d[\d\s().-]*\d)/g;
/** Only this much of a string is scrubbed, which bounds the work on a long one. */
const SCRUB_WINDOW = 1000;

function digitCount(value: string): number {
  let count = 0;
  for (const char of value) if (char >= '0' && char <= '9') count += 1;
  return count;
}

/** Replaces value-shaped content with placeholders. */
export function scrubText(text: string): string {
  return text
    .replace(URLS, '[url]')
    .replace(SIGN_IN_TOKENS, '[token]')
    .replace(EMAILS, (_match, lead: string) => `${lead}[email]`)
    .replace(RECORD_IDS, '[id]')
    .replace(HEX_TOKENS, '[token]')
    .replace(LONG_NUMBERS, '[number]')
    .replace(PHONE_SHAPES, (match, lead: string, run: string) => (digitCount(run) >= 7 ? `${lead}[phone]` : match));
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Made storable, scrubbed, then cut, so a cut can never leave half an address
 * behind.
 */
function scrubbedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = wellFormed(value).replace(/\s+/g, ' ').trim();
  if (text.length > SCRUB_WINDOW) {
    // The value the window cuts through goes too: a fragment of it could be
    // too short to recognise.
    text = text.slice(0, SCRUB_WINDOW).replace(/[\d\s().+-]*\S*$/, '');
  }
  const out = cut(scrubText(text), max);
  return out === '' ? undefined : out;
}

// ── Context schema v1 ──

export type ContextV1 = { v: 1 } & Record<string, unknown>;

const PATTERN_MAX = 200;
const MESSAGE_MAX = 200;
const TZ_MAX = 64;
const FAMILY_MAX = 32;
const RID_MAX = 64;
const METHOD_MAX = 10;
const MAX_REQUESTS = 20;
const MAX_ERRORS = 10;
const MAX_SCREENS = 5;
const MAX_REFS = 10;
const MAX_INTEGER = 2_147_483_647;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const FAMILY = /^[A-Za-z0-9 ._-]+$/;
const TIME_ZONE = /^[A-Za-z0-9_+/-]+$/;
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** A string whose characters must all match `shape`; cut to `max` when longer. */
function shaped(value: unknown, shape: RegExp, max: number): string | undefined {
  if (typeof value !== 'string' || value === '' || !shape.test(value)) return undefined;
  return cut(value, max);
}

function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && ISO_TIME.test(value) ? value : undefined;
}

/** Keeps only the defined fields; undefined when none survive. */
function compact(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

function lastOf(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(-max) : [];
}

function screenRefs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, ref] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_REFS) break;
    if (REF_NAME.test(name) && typeof ref === 'string' && isUuid(ref)) out[name] = ref.toLowerCase();
  }
  return out;
}

function request(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return compact({
    m: shaped(value.m, /^[A-Z]+$/, METHOD_MAX),
    p: scrubbedText(value.p, PATTERN_MAX),
    s: intIn(value.s, 0, 999),
    ms: intIn(value.ms, 0, MAX_INTEGER),
    rid: shaped(value.rid, /^[A-Za-z0-9-]+$/, RID_MAX),
  });
}

function error(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return compact({
    k: oneOf(value.k, ['error', 'rejection', 'api'] as const),
    msg: scrubbedText(value.msg, MESSAGE_MAX),
    at: isoTime(value.at),
  });
}

function viewport(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const width = intIn(value[0], 0, 100_000);
  const height = intIn(value[1], 0, 100_000);
  return width === undefined || height === undefined ? undefined : [width, height];
}

/**
 * Schema v1, reduced to what it allows. Never throws and never refuses: the
 * worst input becomes `{ v: 1 }`.
 */
export function sanitizeContext(raw: unknown, includeTechnical: boolean): ContextV1 {
  const ctx = isRecord(raw) ? raw : {};
  const screen = isRecord(ctx.screen) ? ctx.screen : {};
  const app = isRecord(ctx.app) ? ctx.app : {};
  const pattern = scrubbedText(screen.pattern, PATTERN_MAX);
  const build = typeof app.build === 'string' && /^[0-9a-f]{12}$/i.test(app.build) ? app.build : undefined;
  const locale = oneOf(app.locale, ['es', 'en'] as const);

  if (!includeTechnical) {
    return {
      v: 1,
      ...defined('screen', compact({ pattern })),
      ...defined('app', compact({ build, locale })),
    };
  }

  const device = isRecord(ctx.device) ? ctx.device : {};
  const capture = isRecord(ctx.capture) ? ctx.capture : {};
  const screens = lastOf(ctx.screens, MAX_SCREENS)
    .map((entry) => scrubbedText(entry, PATTERN_MAX))
    .filter((entry): entry is string => entry !== undefined);
  const requests = lastOf(ctx.requests, MAX_REQUESTS)
    .map(request)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const errors = lastOf(ctx.errors, MAX_ERRORS)
    .map(error)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);

  return {
    v: 1,
    ...defined('screen', compact({ pattern, refs: screenRefs(screen.refs) })),
    ...defined('screens', screens.length > 0 ? screens : undefined),
    ...defined('app', compact({ build, locale, theme: oneOf(app.theme, ['light', 'dark'] as const) })),
    ...defined('device', compact({
      kind: oneOf(device.kind, ['phone', 'tablet', 'desktop'] as const),
      browser: shaped(device.browser, FAMILY, FAMILY_MAX),
      os: shaped(device.os, FAMILY, FAMILY_MAX),
      viewport: viewport(device.viewport),
      online: typeof device.online === 'boolean' ? device.online : undefined,
      tz: shaped(device.tz, TIME_ZONE, TZ_MAX),
      local_time: isoTime(device.local_time),
    })),
    ...defined('requests', requests.length > 0 ? requests : undefined),
    ...defined('errors', errors.length > 0 ? errors : undefined),
    ...defined('capture', compact({
      outcome: oneOf(capture.outcome, ['ok', 'timeout', 'failed', 'removed', 'attached', 'none'] as const),
      ms: intIn(capture.ms, 0, MAX_INTEGER),
    })),
  };
}

function defined(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}
