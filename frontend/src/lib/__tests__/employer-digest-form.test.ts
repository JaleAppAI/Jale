import { describe, expect, it } from 'vitest';
import {
    DIGEST_DEFAULTS,
    DIGEST_HOURS,
    DIGEST_LANGUAGES,
    DIGEST_TIMEZONES,
    digestHourLabel,
    digestTimezoneLabelKey,
    digestTimezoneOptions,
    isValidDigestHour,
    isValidDigestLanguage,
    isValidDigestTimezone,
    normalizeDigestSettings,
} from '../employer-digest-form';

/**
 * The employer digest settings panel is a client component, and this repo runs
 * vitest in the `node` environment with no jsdom (see `vitest.config.mts` and
 * the note at the top of `api/__tests__/abort-signal.test.ts`). So every
 * branchy decision the panel makes lives in `lib/employer-digest-form.ts` and
 * is asserted here instead: what the panel accepts from the API, what it
 * offers in each `<Select>`, and how an hour becomes a wall-clock label.
 */

describe('the curated constants', () => {
    it('offers exactly the nine approved canonical zones, in the approved order', () => {
        expect(DIGEST_TIMEZONES).toEqual([
            'America/New_York',
            'America/Chicago',
            'America/Denver',
            'America/Phoenix',
            'America/Los_Angeles',
            'America/Anchorage',
            'Pacific/Honolulu',
            'America/Mexico_City',
            'America/Puerto_Rico',
        ]);
    });

    it('offers all 24 hours of the day', () => {
        expect(DIGEST_HOURS).toHaveLength(24);
        expect(DIGEST_HOURS[0]).toBe(0);
        expect(DIGEST_HOURS[23]).toBe(23);
    });

    it('offers exactly the two product locales', () => {
        expect(DIGEST_LANGUAGES).toEqual(['en', 'es']);
    });

    it('defaults to the contract defaults for an employer with no stored row', () => {
        expect(DIGEST_DEFAULTS).toEqual({
            enabled: false,
            send_hour_local: 8,
            timezone: 'America/Chicago',
            language: 'en',
        });
    });

    it('has a default timezone that is itself offered in the picker', () => {
        // Otherwise the untouched default would render as an "unsupported"
        // extra option on every first visit.
        expect(DIGEST_TIMEZONES).toContain(DIGEST_DEFAULTS.timezone);
    });
});

describe('isValidDigestHour', () => {
    it.each([0, 1, 8, 12, 23])('accepts the in-range integer %i', (hour) => {
        expect(isValidDigestHour(hour)).toBe(true);
    });

    it.each([-1, 24, 25, 100])('rejects the out-of-range integer %i', (hour) => {
        expect(isValidDigestHour(hour)).toBe(false);
    });

    it('rejects a fractional hour', () => {
        expect(isValidDigestHour(8.5)).toBe(false);
    });

    it('rejects -0 dressed up as a number-like string, and other non-numbers', () => {
        // The API contract says `send_hour_local` is a number. A numeric STRING
        // is the shape a hand-rolled JSON body or a form value would produce,
        // and silently accepting it would put a string into a `<Select value>`
        // comparison that then never matches.
        expect(isValidDigestHour('8')).toBe(false);
        expect(isValidDigestHour(null)).toBe(false);
        expect(isValidDigestHour(undefined)).toBe(false);
        expect(isValidDigestHour(NaN)).toBe(false);
        expect(isValidDigestHour(Infinity)).toBe(false);
        expect(isValidDigestHour(true)).toBe(false);
        expect(isValidDigestHour({})).toBe(false);
    });
});

describe('isValidDigestTimezone', () => {
    it('accepts every offered zone', () => {
        for (const zone of DIGEST_TIMEZONES) {
            expect(isValidDigestTimezone(zone)).toBe(true);
        }
    });

    it('is case-sensitive, because the database validates case-sensitively', () => {
        expect(isValidDigestTimezone('america/chicago')).toBe(false);
        expect(isValidDigestTimezone('AMERICA/CHICAGO')).toBe(false);
        expect(isValidDigestTimezone('America/chicago')).toBe(false);
    });

    it('rejects a real IANA zone that is not on the curated list', () => {
        expect(isValidDigestTimezone('Europe/Madrid')).toBe(false);
    });

    it('rejects non-strings and blanks', () => {
        expect(isValidDigestTimezone('')).toBe(false);
        expect(isValidDigestTimezone('   ')).toBe(false);
        expect(isValidDigestTimezone(null)).toBe(false);
        expect(isValidDigestTimezone(undefined)).toBe(false);
        expect(isValidDigestTimezone(8)).toBe(false);
    });
});

describe('isValidDigestLanguage', () => {
    it('accepts the two product locales', () => {
        expect(isValidDigestLanguage('en')).toBe(true);
        expect(isValidDigestLanguage('es')).toBe(true);
    });

    it('rejects anything else, case included', () => {
        expect(isValidDigestLanguage('EN')).toBe(false);
        expect(isValidDigestLanguage('en-US')).toBe(false);
        expect(isValidDigestLanguage('fr')).toBe(false);
        expect(isValidDigestLanguage('')).toBe(false);
        expect(isValidDigestLanguage(null)).toBe(false);
        expect(isValidDigestLanguage(undefined)).toBe(false);
    });
});

describe('normalizeDigestSettings', () => {
    it('passes a fully valid row through unchanged', () => {
        expect(normalizeDigestSettings({
            enabled: true,
            send_hour_local: 17,
            timezone: 'America/Los_Angeles',
            language: 'es',
        })).toEqual({
            enabled: true,
            send_hour_local: 17,
            timezone: 'America/Los_Angeles',
            language: 'es',
        });
    });

    it('falls back to the contract defaults for a missing body', () => {
        expect(normalizeDigestSettings(null)).toEqual(DIGEST_DEFAULTS);
        expect(normalizeDigestSettings(undefined)).toEqual(DIGEST_DEFAULTS);
        expect(normalizeDigestSettings({})).toEqual(DIGEST_DEFAULTS);
    });

    it('falls back to the defaults for a non-object body', () => {
        expect(normalizeDigestSettings('nope')).toEqual(DIGEST_DEFAULTS);
        expect(normalizeDigestSettings(42)).toEqual(DIGEST_DEFAULTS);
        expect(normalizeDigestSettings([])).toEqual(DIGEST_DEFAULTS);
    });

    it('coerces only truthy `enabled` to true — a missing flag means off', () => {
        expect(normalizeDigestSettings({ enabled: true }).enabled).toBe(true);
        expect(normalizeDigestSettings({ enabled: false }).enabled).toBe(false);
        expect(normalizeDigestSettings({ enabled: 'yes' }).enabled).toBe(false);
        expect(normalizeDigestSettings({}).enabled).toBe(false);
    });

    it('replaces an out-of-range or non-integer hour with the default hour', () => {
        expect(normalizeDigestSettings({ send_hour_local: 24 }).send_hour_local).toBe(8);
        expect(normalizeDigestSettings({ send_hour_local: -3 }).send_hour_local).toBe(8);
        expect(normalizeDigestSettings({ send_hour_local: 6.5 }).send_hour_local).toBe(8);
        expect(normalizeDigestSettings({ send_hour_local: '9' }).send_hour_local).toBe(8);
    });

    it('keeps hour 0 rather than treating midnight as absent', () => {
        // `??`/`||` confusion is the classic bug here: midnight is a real,
        // deliberately-chosen send hour and must survive normalization.
        expect(normalizeDigestSettings({ send_hour_local: 0 }).send_hour_local).toBe(0);
    });

    it('PRESERVES a stored timezone that is not on the curated list', () => {
        // The row is authoritative. Snapping an off-list zone to the default
        // would silently move the employer's send time the next time they
        // touched any other control on the panel.
        expect(normalizeDigestSettings({ timezone: 'Europe/Madrid' }).timezone).toBe('Europe/Madrid');
    });

    it('trims surrounding whitespace off a stored timezone', () => {
        expect(normalizeDigestSettings({ timezone: '  America/Denver  ' }).timezone)
            .toBe('America/Denver');
    });

    it('replaces a blank or non-string timezone with the default zone', () => {
        expect(normalizeDigestSettings({ timezone: '' }).timezone).toBe('America/Chicago');
        expect(normalizeDigestSettings({ timezone: '   ' }).timezone).toBe('America/Chicago');
        expect(normalizeDigestSettings({ timezone: 7 }).timezone).toBe('America/Chicago');
        expect(normalizeDigestSettings({ timezone: null }).timezone).toBe('America/Chicago');
    });

    it('replaces an unsupported language with the default language', () => {
        expect(normalizeDigestSettings({ language: 'fr' }).language).toBe('en');
        expect(normalizeDigestSettings({ language: 'ES' }).language).toBe('en');
        expect(normalizeDigestSettings({ language: null }).language).toBe('en');
    });

    it('normalizes each field independently', () => {
        expect(normalizeDigestSettings({
            enabled: true,
            send_hour_local: 99,
            timezone: 'Pacific/Honolulu',
            language: 'de',
        })).toEqual({
            enabled: true,
            send_hour_local: 8,
            timezone: 'Pacific/Honolulu',
            language: 'en',
        });
    });

    it('ignores unrelated keys the backend may add later', () => {
        const result = normalizeDigestSettings({
            enabled: true,
            send_hour_local: 8,
            timezone: 'America/Chicago',
            language: 'en',
            updated_at: '2026-08-21T00:00:00Z',
        });
        expect(Object.keys(result).sort())
            .toEqual(['enabled', 'language', 'send_hour_local', 'timezone']);
    });
});

describe('digestTimezoneOptions', () => {
    it('is exactly the curated list when the current zone is on it', () => {
        expect(digestTimezoneOptions('America/Denver')).toEqual([...DIGEST_TIMEZONES]);
    });

    it('appends an off-list current zone so the picker can show what is stored', () => {
        // A `<Select>` whose `value` matches no `<option>` renders the FIRST
        // option instead, which would show the employer a zone they never
        // chose and write it back on their next save.
        const options = digestTimezoneOptions('Europe/Madrid');
        expect(options).toEqual([...DIGEST_TIMEZONES, 'Europe/Madrid']);
    });

    it('never appends a duplicate', () => {
        const options = digestTimezoneOptions('America/Chicago');
        expect(new Set(options).size).toBe(options.length);
    });

    it('appends a case-variant, since the list match is case-sensitive', () => {
        expect(digestTimezoneOptions('america/chicago'))
            .toEqual([...DIGEST_TIMEZONES, 'america/chicago']);
    });

    it('appends nothing for a blank or missing current zone', () => {
        expect(digestTimezoneOptions('')).toEqual([...DIGEST_TIMEZONES]);
        expect(digestTimezoneOptions('   ')).toEqual([...DIGEST_TIMEZONES]);
    });

    it('does not mutate the curated constant', () => {
        digestTimezoneOptions('Europe/Madrid');
        expect(DIGEST_TIMEZONES).toHaveLength(9);
    });
});

describe('digestTimezoneLabelKey', () => {
    it('maps every curated zone to a distinct message-key segment', () => {
        const keys = DIGEST_TIMEZONES.map((zone) => digestTimezoneLabelKey(zone));
        expect(keys.every((key) => typeof key === 'string' && key !== '')).toBe(true);
        expect(new Set(keys).size).toBe(DIGEST_TIMEZONES.length);
    });

    it('produces dot-free, slash-free segments (next-intl splits paths on dots)', () => {
        for (const zone of DIGEST_TIMEZONES) {
            expect(digestTimezoneLabelKey(zone)).toMatch(/^[a-z0-9_]+$/);
        }
    });

    it('maps the known zones to their expected segments', () => {
        expect(digestTimezoneLabelKey('America/New_York')).toBe('america_new_york');
        expect(digestTimezoneLabelKey('Pacific/Honolulu')).toBe('pacific_honolulu');
        expect(digestTimezoneLabelKey('America/Mexico_City')).toBe('america_mexico_city');
    });

    it('returns null for an off-list zone so the caller shows the raw id instead', () => {
        // Returning a derived key would ask next-intl for a message that does
        // not exist, which renders the key path to the employer.
        expect(digestTimezoneLabelKey('Europe/Madrid')).toBeNull();
        expect(digestTimezoneLabelKey('america/chicago')).toBeNull();
        expect(digestTimezoneLabelKey('')).toBeNull();
    });
});

describe('digestHourLabel', () => {
    /**
     * Formatted the way `job-detail-display.ts`'s `shiftHoursLabel` formats a
     * shift time: an hour with no date and no zone of its own, anchored to a
     * fixed UTC instant and rendered with `timeZone: 'UTC'` so it means the
     * same thing for every reader. The assertions use `\s?` around the
     * meridiem exactly as `job-detail-display.test.ts` does — ICU emits a
     * narrow no-break space there, and its width has changed between ICU
     * releases.
     */
    it('renders a morning hour as a 12-hour English clock time', () => {
        expect(digestHourLabel(8, 'en')).toMatch(/^8:00\s?AM$/);
    });

    it('renders an afternoon hour as a 12-hour English clock time', () => {
        expect(digestHourLabel(17, 'en')).toMatch(/^5:00\s?PM$/);
    });

    it('renders midnight and noon without a 0 or 24 o’clock', () => {
        expect(digestHourLabel(0, 'en')).toMatch(/^12:00\s?AM$/);
        expect(digestHourLabel(12, 'en')).toMatch(/^12:00\s?PM$/);
    });

    it('renders a Spanish label for the es locale', () => {
        // Asserted as an invariant, not an exact string: the ES meridiem
        // punctuation ("a.m." vs "a. m.") is ICU-version dependent.
        const label = digestHourLabel(8, 'es');
        expect(label).toContain('8:00');
        expect(label.toLowerCase()).toContain('m');
        expect(label).not.toMatch(/AM|PM/);
    });

    it('produces a distinct, non-empty label for every hour in both locales', () => {
        for (const locale of ['en', 'es']) {
            const labels = DIGEST_HOURS.map((hour) => digestHourLabel(hour, locale));
            expect(labels.every((label) => label.trim() !== '')).toBe(true);
            expect(new Set(labels).size).toBe(24);
        }
    });

    it('falls back to the English tag for an unknown locale rather than throwing', () => {
        expect(digestHourLabel(8, 'de')).toMatch(/^8:00\s?AM$/);
    });

    it('returns an empty string for an hour outside 0–23 rather than a wrong time', () => {
        // A bad hour must not silently wrap into a plausible-looking label
        // (24 -> "12:00 AM" the next day), which would misreport when the
        // employer's digest is actually sent.
        expect(digestHourLabel(24, 'en')).toBe('');
        expect(digestHourLabel(-1, 'en')).toBe('');
        expect(digestHourLabel(8.5, 'en')).toBe('');
    });
});
