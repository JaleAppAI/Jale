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
 * Diacritic- and case-folds `s` for matching purposes only (never for
 * display): decomposes accented characters (NFD) and strips the combining
 * diacritical marks, then lowercases. This is required for this audience --
 * a bilingual blue-collar user typing on a phone keyboard routinely omits
 * accents (`proteccion`, `grua`), and must still find `Protección`, `grúa`.
 */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Diacritic- and case-insensitive substring search over the curated
 * certification list.
 *
 * Matches against BOTH `label_en` and `label_es` regardless of `locale` --
 * a Spanish speaker typing an English cert name (or vice versa) must still
 * find it. `locale` only affects ordering: entries whose *active-locale*
 * label matches the query sort first (alphabetically, by that label),
 * followed by entries that matched only through the other language's label
 * (also sorted alphabetically by the active-locale label). Sorting compares
 * the unfolded active-locale label -- only matching is fold-insensitive.
 *
 * An empty or whitespace-only query returns `[]`.
 */
export function searchCertifications(query: string, locale: 'en' | 'es'): CuratedCertification[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = fold(trimmed);

  const activeKey: 'label_en' | 'label_es' = locale === 'es' ? 'label_es' : 'label_en';
  const compareLocale = locale === 'es' ? 'es' : 'en';

  const matches = CERTIFICATIONS.filter(
    (cert) => fold(cert.label_en).includes(needle) || fold(cert.label_es).includes(needle),
  );

  // Partition into active-locale matches (query found in the requester's own
  // language) and other-locale-only matches (found only via the other
  // language's label); each group sorted alphabetically by the active-locale
  // label so the whole result reads consistently in the requester's language.
  const activeMatches = matches.filter((cert) => fold(cert[activeKey]).includes(needle));
  const otherMatches = matches.filter((cert) => !fold(cert[activeKey]).includes(needle));

  const byActiveLabel = (a: CuratedCertification, b: CuratedCertification) =>
    a[activeKey].localeCompare(b[activeKey], compareLocale);

  return [...activeMatches.sort(byActiveLabel), ...otherMatches.sort(byActiveLabel)];
}

/** The label text for `cert` in `locale`. Anything other than `'es'` falls back to English. */
export function certificationLabel(cert: CuratedCertification, locale: 'en' | 'es'): string {
  return locale === 'es' ? cert.label_es : cert.label_en;
}

/**
 * Look up a curated certification by exact (trimmed, diacritic- and
 * case-insensitive) name match against either `label_en` or `label_es`.
 * Returns `null` when `name` is empty/whitespace-only or matches nothing.
 */
export function findCertificationByName(name: string): CuratedCertification | null {
  const trimmed = fold(name.trim());
  if (!trimmed) return null;
  const found = CERTIFICATIONS.find(
    (cert) => fold(cert.label_en) === trimmed || fold(cert.label_es) === trimmed,
  );
  return found ?? null;
}
