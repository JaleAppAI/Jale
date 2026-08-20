import { describe, expect, it } from 'vitest';
import certificationsData from '@/data/certifications.json';
import {
  certificationLabel,
  findCertificationByName,
  searchCertifications,
  type CuratedCertification,
} from '@/lib/certifications';

type CertificationsFile = {
  certifications: CuratedCertification[];
  _meta: { source: string; note: string; retrieved: string };
};

const data = certificationsData as unknown as CertificationsFile;

describe('certifications.json structure', () => {
  it('has exactly 30 curated certifications', () => {
    expect(data.certifications).toHaveLength(30);
  });

  it('has unique ids', () => {
    const ids = data.certifications.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-empty label_en and label_es for every entry', () => {
    for (const cert of data.certifications) {
      expect(typeof cert.id).toBe('string');
      expect(cert.id.trim().length).toBeGreaterThan(0);
      expect(typeof cert.label_en).toBe('string');
      expect(cert.label_en.trim().length).toBeGreaterThan(0);
      expect(typeof cert.label_es).toBe('string');
      expect(cert.label_es.trim().length).toBeGreaterThan(0);
    }
  });

  it('records a _meta block with source and note fields', () => {
    expect(typeof data._meta.source).toBe('string');
    expect(data._meta.source.length).toBeGreaterThan(0);
    expect(typeof data._meta.note).toBe('string');
    expect(data._meta.note.length).toBeGreaterThan(0);
  });

  it('includes the required curated vocabulary (spot-check a sample)', () => {
    const ids = new Set(data.certifications.map((c) => c.id));
    for (const id of ['osha_10', 'osha_30', 'cdl_class_a', 'cdl_class_b', 'twic_card', 'em_385_1_1']) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe('searchCertifications', () => {
  it('returns [] for an empty query', () => {
    expect(searchCertifications('', 'en')).toEqual([]);
  });

  it('returns [] for a whitespace-only query', () => {
    expect(searchCertifications('   ', 'en')).toEqual([]);
  });

  it('finds both OSHA 10 and OSHA 30 case-insensitively', () => {
    const results = searchCertifications('osha', 'en');
    const ids = results.map((c) => c.id);
    expect(ids).toContain('osha_10');
    expect(ids).toContain('osha_30');
  });

  it('finds a Spanish-label substring while locale is "en" (Spanish speaker typing an English name is not the only supported direction)', () => {
    // "montacargas" only appears in label_es ("Operador de montacargas"),
    // never in label_en ("Forklift Operator").
    const results = searchCertifications('montacargas', 'en');
    expect(results.map((c) => c.id)).toContain('forklift_operator');
  });

  it('finds an English-label substring while locale is "es"', () => {
    // "forklift" only appears in label_en, never in label_es.
    const results = searchCertifications('forklift', 'es');
    expect(results.map((c) => c.id)).toContain('forklift_operator');
  });

  it('returns [] for a query matching nothing', () => {
    expect(searchCertifications('zzz-not-a-real-certification-zzz', 'en')).toEqual([]);
  });

  it('sorts active-locale label matches before other-locale-only matches, each tier alphabetical', () => {
    // "or" is deliberately common: under locale='en' it matches 10 curated
    // entries. 6 contain "or" in label_en (active-locale matches -- e.g.
    // "Forklift Operator", "Scissor Lift", "Respirator Fit Test"); the other
    // 4 have no "or" in label_en and match only through label_es
    // (aerial_lift and boom_lift via "plataf-OR-ma", rigging_signal_person
    // via "Apareja-dOR", powder_actuated_tools via "p-OR pólvora").
    const results = searchCertifications('or', 'en');
    const activeMatchFlags = results.map((c) => c.label_en.toLowerCase().includes('or'));

    // Guard against a vacuous property: both groups must actually be present.
    expect(activeMatchFlags).toContain(true);
    expect(activeMatchFlags).toContain(false);

    // Every active-locale match must precede every other-locale-only match.
    const lastActiveIndex = activeMatchFlags.lastIndexOf(true);
    const firstOtherIndex = activeMatchFlags.indexOf(false);
    expect(lastActiveIndex).toBeLessThan(firstOtherIndex);

    // Within each tier, entries sort alphabetically by the active-locale label.
    const activeLabels = results.slice(0, lastActiveIndex + 1).map((c) => c.label_en);
    expect([...activeLabels].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(activeLabels);
    const otherLabels = results.slice(lastActiveIndex + 1).map((c) => c.label_en);
    expect([...otherLabels].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(otherLabels);
  });

  it('matches diacritic-insensitively: an unaccented query finds an accented label_es', () => {
    // "Protección contra caídas" (fall_protection) -- typed without accents,
    // as is common on a phone keyboard.
    const results = searchCertifications('proteccion', 'es');
    expect(results.map((c) => c.id)).toContain('fall_protection');
  });

  it('matches diacritic-insensitively across locales too', () => {
    // Same entry, other-locale direction: locale='en' query hits label_es only.
    const results = searchCertifications('caidas', 'en');
    expect(results.map((c) => c.id)).toContain('fall_protection');
  });

  it('still matches when the query itself carries accents', () => {
    const results = searchCertifications('protección', 'es');
    expect(results.map((c) => c.id)).toContain('fall_protection');
  });
});

describe('certificationLabel', () => {
  const cert: CuratedCertification = { id: 'osha_10', label_en: 'OSHA 10', label_es: 'OSHA 10' };
  const bilingualCert: CuratedCertification = {
    id: 'forklift_operator', label_en: 'Forklift Operator', label_es: 'Operador de montacargas',
  };

  it('returns label_en for locale "en"', () => {
    expect(certificationLabel(bilingualCert, 'en')).toBe('Forklift Operator');
  });

  it('returns label_es for locale "es"', () => {
    expect(certificationLabel(bilingualCert, 'es')).toBe('Operador de montacargas');
  });

  it('works for a cert whose labels happen to be identical', () => {
    expect(certificationLabel(cert, 'en')).toBe('OSHA 10');
    expect(certificationLabel(cert, 'es')).toBe('OSHA 10');
  });
});

describe('findCertificationByName', () => {
  it('finds by English label with surrounding whitespace and mixed case', () => {
    const found = findCertificationByName('  osha 10 ');
    expect(found?.id).toBe('osha_10');
  });

  it('finds by Spanish label with surrounding whitespace and mixed case', () => {
    const found = findCertificationByName('  operador DE montacargas  ');
    expect(found?.id).toBe('forklift_operator');
  });

  it('returns null for an unknown name', () => {
    expect(findCertificationByName('not a real certification')).toBeNull();
  });

  it('returns null for an empty or whitespace-only name', () => {
    expect(findCertificationByName('')).toBeNull();
    expect(findCertificationByName('   ')).toBeNull();
  });

  it('finds by Spanish label typed without accents (phone-keyboard input)', () => {
    // Stored label_es is "Operador de grúa (NCCCO)".
    const found = findCertificationByName('operador de grua (nccco)');
    expect(found?.id).toBe('crane_operator_nccco');
  });
});
