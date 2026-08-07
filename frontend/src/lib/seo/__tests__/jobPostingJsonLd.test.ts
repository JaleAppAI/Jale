import { describe, expect, it } from 'vitest';
import { buildJobPostingJsonLd, serializeJsonLd } from '../jobPostingJsonLd';
import type { PublicJobActive } from '@/lib/api/publicJob';

const BASE_JOB: PublicJobActive = {
  code: 'ABC123',
  title: 'Warehouse Associate',
  company: 'Acme Co',
  location: 'Austin, TX',
  job_type: 'full-time',
  description: 'Lift boxes',
  required_docs: [],
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
};

const CANONICAL_URL = 'https://jaleapp.ai/en/j/ABC123';

describe('buildJobPostingJsonLd', () => {
  it('produces the base schema.org shape', () => {
    const result = buildJobPostingJsonLd(BASE_JOB, CANONICAL_URL) as Record<string, unknown>;
    expect(result['@context']).toBe('https://schema.org');
    expect(result['@type']).toBe('JobPosting');
    expect(result.title).toBe('Warehouse Associate');
    expect(result.datePosted).toBe('2026-01-01');
    expect(result.url).toBe(CANONICAL_URL);
    expect(result.hiringOrganization).toEqual({ '@type': 'Organization', name: 'Acme Co' });
    expect(result.identifier).toEqual({ '@type': 'PropertyValue', name: 'Jale', value: 'ABC123' });
    expect(result.description).toBe('Lift boxes');
  });

  it('converts \\n to <br> in the description and adds no other HTML', () => {
    const job: PublicJobActive = { ...BASE_JOB, description: 'Line one\nLine two\nLine three' };
    const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
    expect(result.description).toBe('Line one<br>Line two<br>Line three');
  });

  it('omits description when null', () => {
    const job: PublicJobActive = { ...BASE_JOB, description: null };
    const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
    expect(result).not.toHaveProperty('description');
  });

  describe('validThrough', () => {
    it('is created_at + 60 days', () => {
      const result = buildJobPostingJsonLd(BASE_JOB, CANONICAL_URL) as Record<string, unknown>;
      expect(result.validThrough).toBe('2026-03-02T00:00:00.000Z');
    });
  });

  describe('employmentType mapping', () => {
    it('maps full-time -> FULL_TIME', () => {
      const result = buildJobPostingJsonLd({ ...BASE_JOB, job_type: 'full-time' }, CANONICAL_URL) as Record<string, unknown>;
      expect(result.employmentType).toBe('FULL_TIME');
    });

    it('maps part-time -> PART_TIME', () => {
      const result = buildJobPostingJsonLd({ ...BASE_JOB, job_type: 'part-time' }, CANONICAL_URL) as Record<string, unknown>;
      expect(result.employmentType).toBe('PART_TIME');
    });

    it('maps contract -> CONTRACTOR', () => {
      const result = buildJobPostingJsonLd({ ...BASE_JOB, job_type: 'contract' }, CANONICAL_URL) as Record<string, unknown>;
      expect(result.employmentType).toBe('CONTRACTOR');
    });

    it('omits employmentType for an unknown job_type', () => {
      const result = buildJobPostingJsonLd({ ...BASE_JOB, job_type: 'seasonal' }, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('employmentType');
    });
  });

  describe('baseSalary', () => {
    it('omits baseSalary entirely for pay_interval "fixed"', () => {
      const job: PublicJobActive = { ...BASE_JOB, pay_interval: 'fixed', pay_min: 500, pay_max: 500 };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('baseSalary');
    });

    it('omits baseSalary when pay_interval is missing', () => {
      const job: PublicJobActive = { ...BASE_JOB, pay_interval: null, pay_min: 20, pay_max: 30 };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('baseSalary');
    });

    it('omits baseSalary when the interval maps cleanly but pay is missing', () => {
      const job: PublicJobActive = { ...BASE_JOB, pay_interval: 'hourly', pay_min: null, pay_max: null };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('baseSalary');
    });

    it('emits an hourly range as minValue/maxValue', () => {
      const job: PublicJobActive = { ...BASE_JOB, pay_interval: 'hourly', pay_min: 18, pay_max: 24 };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result.baseSalary).toEqual({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', unitText: 'HOUR', minValue: 18, maxValue: 24 },
      });
    });

    it.each([
      ['daily', 'DAY'],
      ['weekly', 'WEEK'],
      ['monthly', 'MONTH'],
    ] as const)('maps pay_interval %s -> unitText %s', (interval, unitText) => {
      const job: PublicJobActive = { ...BASE_JOB, pay_interval: interval, pay_min: 100, pay_max: null };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect((result.baseSalary as Record<string, unknown>).value).toMatchObject({ unitText, value: 100 });
    });
  });

  describe('hiringOrganization', () => {
    it('omits hiringOrganization entirely (never {name: null}) when company is empty', () => {
      const job: PublicJobActive = { ...BASE_JOB, company: '' };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('hiringOrganization');
    });

    it('emits hiringOrganization when company is present', () => {
      const result = buildJobPostingJsonLd(BASE_JOB, CANONICAL_URL) as Record<string, unknown>;
      expect(result.hiringOrganization).toEqual({ '@type': 'Organization', name: 'Acme Co' });
    });
  });

  describe('jobLocation', () => {
    it('omits jobLocation entirely when city and state_region are both absent', () => {
      const job: PublicJobActive = { ...BASE_JOB, city: null, state_region: null };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('jobLocation');
    });

    it('omits jobLocation when only city is present (never a country-only address)', () => {
      const job: PublicJobActive = { ...BASE_JOB, city: 'Austin', state_region: null };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('jobLocation');
    });

    it('omits jobLocation when only state_region is present', () => {
      const job: PublicJobActive = { ...BASE_JOB, city: null, state_region: 'TX' };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result).not.toHaveProperty('jobLocation');
    });

    it('emits a full Place/PostalAddress when both are present', () => {
      const job: PublicJobActive = { ...BASE_JOB, city: 'Austin', state_region: 'TX' };
      const result = buildJobPostingJsonLd(job, CANONICAL_URL) as Record<string, unknown>;
      expect(result.jobLocation).toEqual({
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Austin',
          addressRegion: 'TX',
          addressCountry: 'US',
        },
      });
    });
  });
});

describe('serializeJsonLd', () => {
  it('neutralizes a </script><script>alert(1)</script> breakout attempt in the description', () => {
    const job: PublicJobActive = {
      ...BASE_JOB,
      description: 'Great job</script><script>alert(1)</script>',
    };
    const jsonLd = buildJobPostingJsonLd(job, CANONICAL_URL);
    const serialized = serializeJsonLd(jsonLd);

    expect(serialized).not.toContain('</');
    expect(serialized).not.toContain('<script>alert(1)</script>');

    // The value round-trips through JSON.parse back to the original text --
    // the escaping must be reversible for legitimate consumers (Google's
    // structured-data parser), not just opaque.
    const parsed = JSON.parse(serialized);
    expect(parsed.description).toBe('Great job</script><script>alert(1)</script>');
  });

  it('escapes every literal "<", including the one from the \\n -> <br> conversion', () => {
    const job: PublicJobActive = { ...BASE_JOB, description: 'Line one\nLine two' };
    const jsonLd = buildJobPostingJsonLd(job, CANONICAL_URL);
    const serialized = serializeJsonLd(jsonLd);
    // Only `<` is escaped per the mandated regex -- the closing `>` is left
    // as a literal character, which is safe (it cannot open a new tag).
    expect(serialized).not.toContain('<');
    expect(serialized).toContain('\\u003cbr>');
  });
});
