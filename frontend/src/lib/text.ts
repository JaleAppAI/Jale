/**
 * Split a comma-separated input into a trimmed, de-duplicated list, dropping
 * empties. Used for free-text skill/certification inputs.
 *
 * @param caseInsensitive when true, dedupes case-insensitively while preserving
 *   the first-seen original casing (skills); otherwise dedupes exactly (certs).
 */
export function splitDedupe(value: string, { caseInsensitive = false }: { caseInsensitive?: boolean } = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const key = caseInsensitive ? item.toLowerCase() : item;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
