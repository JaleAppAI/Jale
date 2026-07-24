// start_date is a date-only value (YYYY-MM-DD). Format in UTC so the day
// doesn't shift in negative-offset timezones, and localize the month name.
export function formatStartDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(locale === 'es' ? 'es-MX' : 'en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}
