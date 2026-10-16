/**
 * F19 hire details, as pure rules (contract K4.2–K4.4).
 *
 * The employer form, the worker's hired card and the banners only render what
 * these decide: what is valid, whether there is anything to show, how a phone
 * number becomes a tap-to-call link, and when "Remind my employer" comes back.
 * The server re-validates everything; these rules are never looser than its.
 */

import type { HireDetailsInput } from './api/worker';
import { accountScopedKey } from './account-key';

/** K4.2 limits. Counted as `String.length` -- what an input's `maxLength` enforces. */
export const HIRE_DETAILS_LIMITS = {
  report_location: 200,
  contact_name: 80,
  contact_phone: 32,
  notes: 1000,
} as const;

/** K4.3: 1–2000 characters after trimming. */
export const WORKER_MESSAGE_MAX = 2000;

/** K4.4: one reminder per application per 24 hours. */
export const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type HireDetailsField = keyof HireDetailsInput;

export const HIRE_DETAILS_FIELDS: readonly HireDetailsField[] = [
  'start_date',
  'report_location',
  'contact_name',
  'contact_phone',
  'notes',
];

export type HireDetailsFieldError = 'date' | 'too_long' | 'phone';
export type HireDetailsForm = Record<HireDetailsField, string>;
export type HireDetailsValidation =
  | { ok: true; payload: HireDetailsInput }
  | { ok: false; errors: Partial<Record<HireDetailsField, HireDetailsFieldError>> };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE_PATTERN = /^[0-9 +()-]+$/;
const REMIND_KEY_BASE = 'jale.hire-remind';

/** The form's text state, seeded from saved details (blank strings for nulls). */
export function hireDetailsFormFrom(details: HireDetailsInput | null | undefined): HireDetailsForm {
  return {
    start_date: details?.start_date ?? '',
    report_location: details?.report_location ?? '',
    contact_name: details?.contact_name ?? '',
    contact_phone: details?.contact_phone ?? '',
    notes: details?.notes ?? '',
  };
}

/** `YYYY-MM-DD` naming a day that exists. */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** K4.2, exactly. Reports every invalid field at once; the payload always carries all five keys. */
export function validateHireDetails(form: HireDetailsForm): HireDetailsValidation {
  const clean = (field: HireDetailsField): string | null => {
    const trimmed = form[field].trim();
    return trimmed === '' ? null : trimmed;
  };
  const payload: HireDetailsInput = {
    start_date: clean('start_date'),
    report_location: clean('report_location'),
    contact_name: clean('contact_name'),
    contact_phone: clean('contact_phone'),
    notes: clean('notes'),
  };
  const errors: Partial<Record<HireDetailsField, HireDetailsFieldError>> = {};
  if (payload.start_date !== null && !isCalendarDate(payload.start_date)) errors.start_date = 'date';
  for (const field of ['report_location', 'contact_name', 'contact_phone', 'notes'] as const) {
    const value = payload[field];
    if (value !== null && value.length > HIRE_DETAILS_LIMITS[field]) errors[field] = 'too_long';
  }
  if (
    payload.contact_phone !== null
    && errors.contact_phone === undefined
    && !PHONE_PATTERN.test(payload.contact_phone)
  ) {
    errors.contact_phone = 'phone';
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, payload };
}

/**
 * Whether there is anything to show. `null` until the employer saves, and a
 * save of five blanks is still "nothing" -- the worker keeps seeing the
 * reach-out copy and the remind button in both cases.
 */
export function hasHireDetails(details: HireDetailsInput | null | undefined): details is HireDetailsInput {
  if (!details) return false;
  return HIRE_DETAILS_FIELDS.some((field) => {
    const value = details[field];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/** A `tel:` link from what the employer typed: the digits, with a leading plus kept. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${digits}`;
}

export type WorkerMessageCheck = { ok: true; body: string } | { ok: false; reason: 'empty' | 'too_long' };

/** K4.3: 1–2000 characters after trimming. */
export function checkWorkerMessage(raw: string): WorkerMessageCheck {
  const body = raw.trim();
  if (body.length === 0) return { ok: false, reason: 'empty' };
  if (body.length > WORKER_MESSAGE_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, body };
}

/** Why "Remind my employer" is unavailable, and for how many more whole hours. */
export type RemindBlock = { reason: 'sent' | 'recent'; hours: number };

function remindKey(applicationId: string, account: string): string {
  return accountScopedKey(`${REMIND_KEY_BASE}.${applicationId}`, account);
}

/**
 * When this account last reminded the employer about this application, on
 * this device. A convenience only: the server's 429 is the authority (K4.4),
 * and a reminder sent from another device simply shows up as that 429.
 */
export function readRemindedAt(applicationId: string, account: string | null): number | null {
  if (account === null) return null;
  try {
    const raw = localStorage.getItem(remindKey(applicationId, account));
    const at = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

export function writeRemindedAt(applicationId: string, account: string | null, at: number): void {
  if (account === null) return;
  try {
    localStorage.setItem(remindKey(applicationId, account), String(at));
  } catch {
    // Storage unavailable: the server's 429 still holds the line.
  }
}

/** The block a stored reminder still imposes at `now`, or null once 24 hours have passed. */
export function remindBlockFrom(remindedAt: number | null, now: number): RemindBlock | null {
  if (remindedAt === null) return null;
  const remaining = remindedAt + REMIND_COOLDOWN_MS - now;
  return remaining > 0 ? { reason: 'recent', hours: wholeHours(remaining) } : null;
}

/** Whole hours, rounded up, never 0 ("in 0 hours" is not a wait). */
export function wholeHours(ms: number): number {
  return Math.max(1, Math.ceil(ms / 3_600_000));
}

/** Whole minutes from seconds, rounded up, never 0. */
export function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}
