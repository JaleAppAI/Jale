// Small shared helpers for `src/app/feed.xml/route.ts`. Split out so the
// escaping logic (the security-relevant part) is unit-testable without
// importing a route.ts module.

/**
 * XML-escapes untrusted text (employer job titles/descriptions) for
 * interpolation into RSS/XML. All five predefined XML entities must be
 * escaped -- `&` first, so it doesn't double-escape the entities it
 * introduces for the other four characters.
 */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC-822/1123 date string for RSS `<pubDate>`. Falls back to the Unix
 * epoch on an unparseable input rather than emitting "Invalid Date" into
 * the feed. */
export function toRfc822(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return new Date(0).toUTCString();
  return d.toUTCString();
}
