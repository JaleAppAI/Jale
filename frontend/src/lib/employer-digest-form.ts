// ---------------------------------------------------------------------------
// Employer daily-digest notification settings — the pure decision layer.
//
// The panel that uses this (`components/employer/DigestSettingsPanel.tsx`) is
// a client component, and this repo runs vitest in the `node` environment with
// no jsdom and no React testing library (see the note at the top of
// `lib/api/__tests__/abort-signal.test.ts`). So every branchy decision the
// panel makes lives here, where it can actually be unit-tested: what a GET/
// PATCH body is allowed to mean, which options each `<Select>` offers, and how
// an hour-of-day becomes a wall-clock label.
//
// Mirrors `lib/employer-profile-form.ts`'s role for the profile form on the
// same page.
// ---------------------------------------------------------------------------

/**
 * The zones offered in the picker.
 *
 * Deliberately curated rather than derived from `Intl.supportedValuesOf`: the
 * product serves the US plus Mexico and Puerto Rico, and a 400-entry select is
 * not a control anyone can use on a phone.
 *
 * CASE IS LOAD-BEARING. The backend column validates these case-sensitively,
 * so `america/chicago` is a different (rejected) value from `America/Chicago`.
 * Keep the canonical IANA spellings exactly as written.
 */
export const DIGEST_TIMEZONES = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Mexico_City',
    'America/Puerto_Rico',
] as const;

export type DigestTimezone = (typeof DIGEST_TIMEZONES)[number];

/** The digest email's language — independent of the reader's UI locale. */
export const DIGEST_LANGUAGES = ['en', 'es'] as const;

export type DigestLanguage = (typeof DIGEST_LANGUAGES)[number];

/** Every hour of the day, in the employer's own zone. */
export const DIGEST_HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

/** The stored row, exactly as `GET/PATCH /employer/settings/digest` returns it. */
export type DigestSettings = {
    enabled: boolean;
    send_hour_local: number;
    timezone: string;
    language: DigestLanguage;
};

/**
 * What the API answers with for an employer who has no row yet. Kept here so
 * the panel renders the same values the backend would have defaulted to,
 * rather than an arbitrary local guess that a later save would silently write.
 */
export const DIGEST_DEFAULTS: DigestSettings = {
    enabled: false,
    send_hour_local: 8,
    timezone: 'America/Chicago',
    language: 'en',
};

/** A real hour of the day: an integer in `[0, 23]`, and nothing that merely looks like one. */
export function isValidDigestHour(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/** On the curated list, compared case-sensitively — see the note on `DIGEST_TIMEZONES`. */
export function isValidDigestTimezone(value: unknown): value is DigestTimezone {
    return typeof value === 'string' && (DIGEST_TIMEZONES as readonly string[]).includes(value);
}

export function isValidDigestLanguage(value: unknown): value is DigestLanguage {
    return typeof value === 'string' && (DIGEST_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Coerces any response body into a shape the panel's controls can render.
 *
 * The API contract is fixed, but a control that binds straight to an unchecked
 * payload has two failure modes worth spending code on: a `<Select value>` that
 * matches no `<option>` silently displays the FIRST option (so the employer
 * sees a setting they never chose, and writes it back on their next save), and
 * an out-of-range hour would be shown as a plausible but wrong send time.
 *
 * `timezone` is the deliberate exception: an off-list but non-empty zone is
 * PRESERVED rather than snapped to the default. The row is authoritative — if
 * something else set the employer's zone to `Europe/Madrid`, editing the send
 * hour must not quietly move their digest to Chicago. `digestTimezoneOptions`
 * is what makes such a value renderable.
 */
export function normalizeDigestSettings(raw: unknown): DigestSettings {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DIGEST_DEFAULTS };

    const row = raw as Record<string, unknown>;
    const timezone = typeof row.timezone === 'string' ? row.timezone.trim() : '';

    return {
        // Strictly `=== true`: a truthy non-boolean ('yes', 1) is a malformed
        // flag, and defaulting an unrecognised value to "off" is the safe
        // direction for an email opt-in.
        enabled: row.enabled === true,
        // `isValidDigestHour` rather than `?? DEFAULT`, so hour 0 (a real,
        // deliberately chosen midnight) survives instead of being read as absent.
        send_hour_local: isValidDigestHour(row.send_hour_local)
            ? row.send_hour_local
            : DIGEST_DEFAULTS.send_hour_local,
        timezone: timezone === '' ? DIGEST_DEFAULTS.timezone : timezone,
        language: isValidDigestLanguage(row.language) ? row.language : DIGEST_DEFAULTS.language,
    };
}

/**
 * The zone `<Select>`'s options: the curated list, plus `current` appended when
 * it is a non-blank value the list does not already contain.
 *
 * Without the append, a stored off-list zone would render as the first curated
 * option — showing the employer a zone they never picked, and writing it back
 * the next time they touched any control on the panel.
 */
export function digestTimezoneOptions(current: string): string[] {
    const options: string[] = [...DIGEST_TIMEZONES];
    const trimmed = current.trim();
    if (trimmed !== '' && !options.includes(trimmed)) options.push(trimmed);
    return options;
}

/**
 * `'America/New_York'` -> `'america_new_york'`, the message-key segment under
 * `employer.digest.timezones`. `null` for anything off the curated list, so the
 * caller falls back to showing the raw IANA id — asking next-intl for a message
 * that does not exist renders the key PATH to the employer.
 *
 * The mapping is derived rather than hand-written so a zone added to
 * `DIGEST_TIMEZONES` cannot silently keep an old key; `employer-digest-i18n-keys.test.ts`
 * asserts a catalogue entry exists for every zone the picker can offer.
 */
export function digestTimezoneLabelKey(zone: string): string | null {
    if (!isValidDigestTimezone(zone)) return null;
    return zone.replace('/', '_').toLowerCase();
}

/**
 * Locale tags for `Intl`. Duplicated from `lib/date.ts` for the same reason
 * `lib/job-detail-display.ts` duplicates it: that module keeps `LOCALE_TAGS`
 * module-private, and this one stays decoupled from it.
 */
const LOCALE_TAGS: Record<string, string> = { en: 'en-US', es: 'es-MX' };
const FALLBACK_TAG = 'en-US';

function tagFor(locale: string): string {
    return LOCALE_TAGS[locale] ?? FALLBACK_TAG;
}

/**
 * `8` -> `'8:00 AM'` (en) / `'8:00 a.m.'` (es).
 *
 * `send_hour_local` is a wall-clock hour in the employer's own `timezone`, with
 * no zone of its own from the reader's point of view — exactly like
 * `shiftHoursLabel` in `lib/job-detail-display.ts`. So it is anchored to a
 * fixed UTC instant and formatted with `timeZone: 'UTC'`, which keeps the label
 * from sliding with the offset of whoever happens to be reading the page.
 *
 * Returns `''` for an hour outside `[0, 23]` rather than a wrong-but-plausible
 * label: `Date.UTC(..., 24, 0)` rolls into the next day and would render `24`
 * as "12:00 AM", misreporting when the digest is actually sent.
 */
export function digestHourLabel(hour: number, locale: string): string {
    if (!isValidDigestHour(hour)) return '';
    return new Intl.DateTimeFormat(tagFor(locale), {
        timeStyle: 'short',
        timeZone: 'UTC',
    }).format(new Date(Date.UTC(2000, 0, 1, hour, 0)));
}
