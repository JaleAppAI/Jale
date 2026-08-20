import certificationsData from '@/data/certifications.json';

/**
 * Pure wrapper around `data/certifications.json` (a curated, bilingual
 * construction/blue-collar certification vocabulary for the employer's
 * certification picker). Kept dependency-free -- no React, no next-intl --
 * same profile as `lib/trade-samples.ts`, so it's importable from a plain
 * node-environment vitest test without dragging in a component tree.
 */
export type CuratedCertification = { id: string; label_en: string; label_es: string };

type CertificationsFile = {
  certifications: CuratedCertification[];
  _meta: { source: string; note: string; retrieved: string };
};

const data = certificationsData as unknown as CertificationsFile;

const CERTIFICATIONS: readonly CuratedCertification[] = data.certifications;

/**
 * Case-insensitive substring search over the curated certification list.
 *
 * Matches against BOTH `label_en` and `label_es` regardless of `locale` --
 * a Spanish speaker typing an English cert name (or vice versa) must still
 * find it. `locale` only affects ordering: entries whose *active-locale*
 * label matches the query sort first (alphabetically, by that label),
 * followed by entries that matched only through the other language's label
 * (also sorted alphabetically by the active-locale label).
 *
 * An empty or whitespace-only query returns `[]`.
 */
export function searchCertifications(query: string, locale: 'en' | 'es'): CuratedCertification[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = trimmed.toLowerCase();

  const activeKey: 'label_en' | 'label_es' = locale === 'es' ? 'label_es' : 'label_en';
  const compareLocale = locale === 'es' ? 'es' : 'en';

  const matches = CERTIFICATIONS.filter(
    (cert) => cert.label_en.toLowerCase().includes(needle) || cert.label_es.toLowerCase().includes(needle),
  );

  // Partition into active-locale matches (query found in the requester's own
  // language) and other-locale-only matches (found only via the other
  // language's label); each group sorted alphabetically by the active-locale
  // label so the whole result reads consistently in the requester's language.
  const activeMatches = matches.filter((cert) => cert[activeKey].toLowerCase().includes(needle));
  const otherMatches = matches.filter((cert) => !cert[activeKey].toLowerCase().includes(needle));

  const byActiveLabel = (a: CuratedCertification, b: CuratedCertification) =>
    a[activeKey].localeCompare(b[activeKey], compareLocale);

  return [...activeMatches.sort(byActiveLabel), ...otherMatches.sort(byActiveLabel)];
}

/** The label text for `cert` in `locale`. Anything other than `'es'` falls back to English. */
export function certificationLabel(cert: CuratedCertification, locale: 'en' | 'es'): string {
  return locale === 'es' ? cert.label_es : cert.label_en;
}

/**
 * Look up a curated certification by exact (trimmed, case-insensitive) name
 * match against either `label_en` or `label_es`. Returns `null` when `name`
 * is empty/whitespace-only or matches nothing.
 */
export function findCertificationByName(name: string): CuratedCertification | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  const found = CERTIFICATIONS.find(
    (cert) => cert.label_en.toLowerCase() === trimmed || cert.label_es.toLowerCase() === trimmed,
  );
  return found ?? null;
}
