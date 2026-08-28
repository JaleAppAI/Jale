// ---------------------------------------------------------------------------
// Worker vocabulary — the single closed set of trade / experience /
// transportation / availability values the WEB onboarding flow and the
// WhatsApp v2 engine both speak.
//
// SHARED CONTRACT. A backend parity test reads THIS FILE AS TEXT and matches
// the array literals below, so every one of them must stay on ONE line, in
// this exact order, with no derived values (`TRADE_KEYS.filter(...)` is
// invisible to a text match). Bump `WORKER_VOCAB_VERSION` whenever a set
// changes so the backend's own copy can fail loudly instead of drifting.
//
// Deliberately dependency-free and framework-free: no `'use client'`, no React,
// no next-intl. Labels are i18n, and i18n is the caller's job — the helpers at
// the bottom return message paths RELATIVE to the `worker_vocab` namespace, so
// a component does `const t = useTranslations('worker_vocab'); t(tradeLabelKey(k))`.
// ---------------------------------------------------------------------------

export const TRADE_KEYS = ['electrician','plumber','carpenter','concrete','painting','other'] as const;
export const STANDARD_TRADE_KEYS = ['electrician','plumber','carpenter','concrete','painting'] as const;
export const EXPERIENCE_KEYS = ['0-1','2-4','5-9','10+'] as const;
export const AVAILABILITY_KEYS = ['full_time','part_time','weekends','flexible'] as const;
export const TRANSPORT_KEYS = ['yes','no'] as const;

/** Bump on ANY change to the sets above — the backend parity test pins it. */
export const WORKER_VOCAB_VERSION = 1;

export type TradeKey = (typeof TRADE_KEYS)[number];
export type StandardTradeKey = (typeof STANDARD_TRADE_KEYS)[number];
export type ExperienceKey = (typeof EXPERIENCE_KEYS)[number];
export type AvailabilityKey = (typeof AVAILABILITY_KEYS)[number];
export type TransportKey = (typeof TRANSPORT_KEYS)[number];

/** The i18n namespace every label helper below is relative to. */
export const WORKER_VOCAB_NAMESPACE = 'worker_vocab';

export function isTradeKey(value: unknown): value is TradeKey {
  return typeof value === 'string' && (TRADE_KEYS as readonly string[]).includes(value);
}

export function isExperienceKey(value: unknown): value is ExperienceKey {
  return typeof value === 'string' && (EXPERIENCE_KEYS as readonly string[]).includes(value);
}

export function isAvailabilityKey(value: unknown): value is AvailabilityKey {
  return typeof value === 'string' && (AVAILABILITY_KEYS as readonly string[]).includes(value);
}

export function tradeLabelKey(key: TradeKey): string {
  return `trade.${key}`;
}

export function experienceLabelKey(key: ExperienceKey): string {
  return `experience.${key}`;
}

export function availabilityLabelKey(key: AvailabilityKey): string {
  return `availability.${key}`;
}

export function transportLabelKey(key: TransportKey): string {
  return `transport.${key}`;
}

/**
 * What a worker's trade is CALLED on screen. `other` has no canonical label —
 * the worker typed their own — so the free-text value wins whenever it is
 * present, and the generic "Other" label is only the fallback for a row that
 * has no custom text yet.
 */
export function tradeLabel(
  t: (key: string) => string,
  trade: TradeKey | null | undefined,
  other?: string | null,
): string | null {
  if (!trade) return null;
  if (trade === 'other') {
    const custom = (other ?? '').trim();
    return custom.length > 0 ? custom : t(tradeLabelKey('other'));
  }
  return t(tradeLabelKey(trade));
}
