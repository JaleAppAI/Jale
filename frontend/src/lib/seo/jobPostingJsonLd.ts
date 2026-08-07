// Builds a schema.org JobPosting JSON-LD object for the public job page.
//
// This is pure data transformation -- no fetching, no React. The page
// component is responsible for injecting the result into a
// `<script type="application/ld+json">` tag via `serializeJsonLd`.
//
// Field names mirror `PublicJobActive` in `src/lib/api/publicJob.ts`, which
// mirrors `infra/lambda/api/public-job.ts`'s PUBLIC_JOB_COLUMNS.

import type { PublicJobActive } from '@/lib/api/publicJob';

const EMPLOYMENT_TYPE_MAP: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACTOR',
};

const PAY_INTERVAL_UNIT_MAP: Record<string, string> = {
  hourly: 'HOUR',
  daily: 'DAY',
  weekly: 'WEEK',
  monthly: 'MONTH',
};

const VALID_THROUGH_DAYS = 60;

/** created_at -> date-only string (YYYY-MM-DD), per schema.org `datePosted`. */
function toDateOnly(isoString: string): string {
  return new Date(isoString).toISOString().slice(0, 10);
}

/**
 * created_at + VALID_THROUGH_DAYS, full ISO timestamp.
 *
 * This is a conservative backstop, not the real removal signal -- if a job
 * closes before this window elapses, actual de-indexing happens via the
 * Google Indexing API (a ping sent when the job closes), not by waiting for
 * this field to lapse. Search engines are not required to respect
 * validThrough promptly, so keep the window short enough that a forgotten
 * ping still self-heals.
 */
function computeValidThrough(isoString: string): string {
  const d = new Date(isoString);
  d.setUTCDate(d.getUTCDate() + VALID_THROUGH_DAYS);
  return d.toISOString();
}

/** `\n` -> `<br>`; otherwise the employer's text passes through untouched.
 * No other HTML transformation is applied (no linkification, no markdown).
 * Any literal `<`/`>` the employer typed (including a `</script>` breakout
 * attempt) is neutralized later by `serializeJsonLd`, not here. */
function formatDescription(description: string): string {
  return description.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}

function buildEmploymentType(jobType: string): string | undefined {
  return EMPLOYMENT_TYPE_MAP[jobType];
}

function buildBaseSalary(job: PublicJobActive): object | undefined {
  if (!job.pay_interval) return undefined;
  const unitText = PAY_INTERVAL_UNIT_MAP[job.pay_interval];
  if (!unitText) return undefined; // 'fixed' or an unmapped interval -- omit entirely

  const min = job.pay_min ?? null;
  const max = job.pay_max ?? null;
  if (min == null && max == null) return undefined; // interval with no actual pay -- nothing to report

  const value: Record<string, unknown> = { '@type': 'QuantitativeValue', unitText };
  if (min != null && max != null) {
    value.minValue = min;
    value.maxValue = max;
  } else {
    value.value = min ?? max;
  }

  return {
    '@type': 'MonetaryAmount',
    currency: 'USD',
    value,
  };
}

function buildJobLocation(job: PublicJobActive): object | undefined {
  if (!job.city || !job.state_region) return undefined; // never emit a country-only address
  return {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: job.city,
      addressRegion: job.state_region,
      addressCountry: 'US',
    },
  };
}

/**
 * Pure builder: PublicJobActive + the page's canonical URL -> a schema.org
 * JobPosting object. Caller is responsible for JSON-serializing the result
 * (via `serializeJsonLd`) before injecting it into a `<script>` tag.
 */
export function buildJobPostingJsonLd(job: PublicJobActive, canonicalUrl: string): object {
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    datePosted: toDateOnly(job.created_at),
    validThrough: computeValidThrough(job.created_at),
    identifier: {
      '@type': 'PropertyValue',
      name: 'Jale',
      value: job.code,
    },
    url: canonicalUrl,
  };

  // Never emit `hiringOrganization: { name: null }` -- schema.org consumers
  // treat a present-but-null name as worse than an absent property. If the
  // API ever returns a blank company, drop the whole property instead.
  if (job.company) {
    jsonLd.hiringOrganization = {
      '@type': 'Organization',
      name: job.company,
    };
  }

  if (job.description) {
    jsonLd.description = formatDescription(job.description);
  }

  const employmentType = buildEmploymentType(job.job_type);
  if (employmentType) jsonLd.employmentType = employmentType;

  const baseSalary = buildBaseSalary(job);
  if (baseSalary) jsonLd.baseSalary = baseSalary;

  const jobLocation = buildJobLocation(job);
  if (jobLocation) jsonLd.jobLocation = jobLocation;

  return jsonLd;
}

/**
 * Serializes a JSON-LD object for safe injection into
 * `<script type="application/ld+json">`.
 *
 * MANDATORY escaping: the page injects employer-authored free text (job
 * description) into this script tag. An unescaped `</script>` inside that
 * text would close the script early and let arbitrary attacker-controlled
 * markup that follows execute as HTML -- a classic script-breakout XSS. The
 * blanket `<` -> `<` replacement (not just `</script>`) is the standard,
 * safe mitigation: JSON parsers unescape `<` back to a literal `<` when
 * reading the value, so semantics are preserved for consumers (Google's
 * rich-results parser, etc.) while no raw `<` ever reaches the DOM parser.
 */
export function serializeJsonLd(obj: object): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}
