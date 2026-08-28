/**
 * Worker-profile vocabularies — one source of truth.
 *
 * Four closed enumerations describe a worker: main trade, experience band,
 * availability, and whether they have their own transportation. Their slugs
 * are pinned by CHECK constraints on `users.main_trade`,
 * `users.years_experience` and `users.availability`, and they are written and
 * read by five different surfaces (WhatsApp onboarding v2, the WhatsApp v1
 * profile builder, the web profile editor, the worker API, the frontend).
 * Before this module each surface hand-typed its own copy, so a change had to
 * be made in N places and drift was invisible until it reached a worker.
 *
 * This module owns the keys and the bilingual labels; every backend consumer
 * derives from it. The labels are a verbatim MOVE of copy that already ships:
 *   - trades       <- `whatsapp/onboarding/constants.ts` TRADE_LABELS
 *   - experience   <- `whatsapp/lib/templates.ts` `ask_experience`
 *   - availability <- `whatsapp/lib/templates.ts` `ask_availability`
 *   - transport    <- `whatsapp/lib/templates.ts` `ask_transportation`
 * They are ASCII-only on both sides, matching every other WhatsApp-rendered
 * string (Twilio content templates and SMS fallbacks render accents
 * inconsistently). Keep them ASCII.
 *
 * The frontend keeps its own copy at `frontend/src/lib/worker-vocab.ts` (it
 * cannot import across the package boundary); the KEYS on both sides are held
 * together by `test/unit/lambda/lib/worker-vocab-frontend-parity.test.ts`.
 * Bump `WORKER_VOCAB_VERSION` when a key list changes, and update the
 * frontend copy in the same change.
 */

// ── Keys ────────────────────────────────────────────────────────

/** Canonical trade slugs, in list-picker order. Mirrors the
 *  `users.main_trade` CHECK constraint. `other` is a pointer at the worker's
 *  free-text `main_trade_other`, not a trade. */
export const TRADE_KEYS = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
export type TradeKey = (typeof TRADE_KEYS)[number];

/** The real trades — `TRADE_KEYS` without the `other` escape hatch. Used
 *  wherever a trade must name actual work (trust-question seeding, trade
 *  alias generation, employer hiring-trade pickers). */
export type StandardTradeKey = Exclude<TradeKey, 'other'>;
export const STANDARD_TRADE_KEYS = [
  'electrician', 'plumber', 'carpenter', 'concrete', 'painting',
] as const satisfies readonly StandardTradeKey[];

/** Experience bands, ascending. Mirrors the `users.years_experience` CHECK
 *  constraint. Bands, not integers: the worker API also accepts a numeric
 *  year count and maps it onto these. */
export const EXPERIENCE_KEYS = ['0-1', '2-4', '5-9', '10+'] as const;
export type ExperienceKey = (typeof EXPERIENCE_KEYS)[number];

/** Availability slugs. Mirrors the `users.availability` CHECK constraint. */
export const AVAILABILITY_KEYS = ['full_time', 'part_time', 'weekends', 'flexible'] as const;
export type AvailabilityKey = (typeof AVAILABILITY_KEYS)[number];

/** Transportation is stored as the boolean `users.has_transportation`; these
 *  keys exist only so the question has a labelled, ordered option list like
 *  the other three. Use `transportKeyToBoolean` / `booleanToTransportKey` at
 *  the storage boundary rather than comparing against the strings. */
export const TRANSPORT_KEYS = ['yes', 'no'] as const;
export type TransportKey = (typeof TRANSPORT_KEYS)[number];

// ── Labels ──────────────────────────────────────────────────────

export interface BilingualLabel {
  en: string;
  es: string;
}

export const TRADE_LABELS: Record<TradeKey, BilingualLabel> = {
  electrician: { en: 'Electrician', es: 'Electricista' },
  plumber: { en: 'Plumber', es: 'Plomero' },
  carpenter: { en: 'Carpenter', es: 'Carpintero' },
  concrete: { en: 'Concrete', es: 'Concreto' },
  painting: { en: 'Painting', es: 'Pintura' },
  other: { en: 'Other', es: 'Otro' },
};

export const EXPERIENCE_LABELS: Record<ExperienceKey, BilingualLabel> = {
  '0-1': { en: '0-1 years', es: '0-1 anos' },
  '2-4': { en: '2-4 years', es: '2-4 anos' },
  '5-9': { en: '5-9 years', es: '5-9 anos' },
  '10+': { en: '10+ years', es: '10+ anos' },
};

export const AVAILABILITY_LABELS: Record<AvailabilityKey, BilingualLabel> = {
  full_time: { en: 'Full-time', es: 'Tiempo completo' },
  part_time: { en: 'Part-time', es: 'Medio tiempo' },
  weekends: { en: 'Weekends', es: 'Fines de semana' },
  flexible: { en: 'Flexible', es: 'Flexible' },
};

export const TRANSPORT_LABELS: Record<TransportKey, BilingualLabel> = {
  yes: { en: 'Yes', es: 'Si' },
  no: { en: 'No', es: 'No' },
};

// ── Guards + conversions ────────────────────────────────────────

function isMember(keys: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && keys.includes(value);
}

export function isTradeKey(value: unknown): value is TradeKey {
  return isMember(TRADE_KEYS, value);
}

export function isStandardTradeKey(value: unknown): value is StandardTradeKey {
  return isMember(STANDARD_TRADE_KEYS, value);
}

export function isExperienceKey(value: unknown): value is ExperienceKey {
  return isMember(EXPERIENCE_KEYS, value);
}

export function isAvailabilityKey(value: unknown): value is AvailabilityKey {
  return isMember(AVAILABILITY_KEYS, value);
}

export function isTransportKey(value: unknown): value is TransportKey {
  return isMember(TRANSPORT_KEYS, value);
}

/** `has_transportation` is a boolean column; these two keep the mapping in
 *  one place so no caller has to remember which way round it goes. */
export function transportKeyToBoolean(key: TransportKey): boolean {
  return key === 'yes';
}

export function booleanToTransportKey(value: boolean): TransportKey {
  return value ? 'yes' : 'no';
}

// ── Wire manifest ───────────────────────────────────────────────

/** Bump when any key list above changes shape or order, and update
 *  `frontend/src/lib/worker-vocab.ts` in the same change. */
export const WORKER_VOCAB_VERSION = 1;

/** Plain, JSON-serialisable view of the key lists — safe to put in an API
 *  response body and the value the frontend parity test compares against. */
export const WORKER_VOCAB = {
  version: WORKER_VOCAB_VERSION,
  trades: [...TRADE_KEYS],
  standardTrades: [...STANDARD_TRADE_KEYS],
  experience: [...EXPERIENCE_KEYS],
  availability: [...AVAILABILITY_KEYS],
  transport: [...TRANSPORT_KEYS],
} as const;
