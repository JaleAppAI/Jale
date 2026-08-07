import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { formatStartDate } from '@/lib/date';
import { getPublicJob, isClosedJob, PublicJobNotFoundError } from '@/lib/api/publicJob';
import type { PublicJobActive, PublicJobDocType } from '@/lib/api/publicJob';
import { buildJobPostingJsonLd, serializeJsonLd } from '@/lib/seo/jobPostingJsonLd';
import { buildJobPageUrls } from '@/lib/seo/siteUrl';
import { ApplyButton } from './ApplyButton';
import { WebApplyButton } from './WebApplyButton';
import { ReferralContext } from './ReferralContext';

export const revalidate = 60;

interface PageParams {
  locale: string;
  code: string;
}

interface PageProps {
  params: PageParams;
}

// Never render employer contact details here -- the public API cannot return
// them, so this component must never grow a second call that tries.
//
// Design notes (first-contact page): the reader is a referred stranger on a
// phone, arriving from a chat app, deciding in seconds. Facts are ranked the
// way a trade worker decides -- title, then PAY (promoted out of the detail
// grid into its own strip), then where/when, then everything else in
// dedicated cards below. The navy band up top echoes the chat header they
// just left; the teal referral ribbon (rendered by `ReferralContext`, a
// client component) shows ONLY when a share tag is present, because
// structure should encode what is true. Teal is reserved for the referral
// thread and used nowhere else on the page.
//
// Nothing in this file (or generateMetadata below) may read `searchParams`
// -- doing so forces this route into dynamic (force-dynamic-equivalent)
// rendering, defeating the `revalidate = 60` ISR config above. The `?r=`
// share tag is read entirely client-side, by `ReferralContext`,
// `ApplyButton`, and `WebApplyButton` via `useSearchParams()`.

const OG_IMAGE_PATH = '/brand/wordmark-navy.png';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'public_job' });

  // Canonical decision (fixed): the `/en/` URL is canonical for BOTH
  // locales -- one job, one indexed URL, no en/es duplicate-content split.
  // This only depends on the code param, not on locale or fetch success, so
  // it applies identically to every branch below (active, closed, error).
  const { en: canonicalUrl, es: esUrl } = buildJobPageUrls(params.code);
  const alternates: Metadata['alternates'] = {
    canonical: canonicalUrl,
    languages: { en: canonicalUrl, es: esUrl },
  };

  try {
    // Same call (same URL + options) as the page component below -- Next's
    // fetch request memoization dedupes these into one network request per
    // revalidation window.
    const job = await getPublicJob(params.code);

    if (isClosedJob(job)) {
      const title = t('meta_title', { title: job.title, company: job.company });
      const description = t('meta_description_closed', { company: job.company });
      return {
        title,
        description,
        alternates,
        openGraph: { title, description, images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }] },
        twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE_PATH] },
      };
    }

    const title = t('meta_title', { title: job.title, company: job.company });
    const description = t('meta_description', { title: job.title, location: job.location });
    return {
      title,
      description,
      alternates,
      openGraph: { title, description, images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }], type: 'website' },
      twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE_PATH] },
    };
  } catch {
    return {
      title: t('meta_title_generic'),
      description: t('meta_description_generic'),
      alternates,
      openGraph: { images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }] },
      twitter: { card: 'summary_large_image', images: [OG_IMAGE_PATH] },
    };
  }
}

/** Navy brand band. The card below overlaps it, echoing the chat-app header
 * the visitor just came from. */
function BrandBand() {
  return (
    <header className="bg-[var(--jale-blue-900)] pt-7 pb-16 px-4">
      <div className="max-w-md md:max-w-2xl mx-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark-white.png" alt="Jale" className="h-7 w-auto" />
      </div>
    </header>
  );
}

/** One quiet line of trust for someone who has never heard of Jale. */
function TrustFooter({ text }: { text: string }) {
  return (
    <p className="text-center text-xs text-[var(--jale-ink-2)] mt-8 pb-10 max-w-xs mx-auto leading-relaxed">
      {text}
    </p>
  );
}

/** One row in the "Details" kv grid. Skips rendering when value is falsy so
 * callers can build the array unconditionally. */
interface DetailRow {
  label: string;
  value: string;
  /** Only the raw `trade_category` value benefits from title-casing (it's
   * an unlabeled taxonomy string, e.g. "electrician"). Dates and numbers
   * must NOT get this -- `capitalize` mangles Spanish month names and
   * prepositions (e.g. "1 de enero" -> "1 De Enero"). */
  capitalizeValue?: boolean;
}

function DetailsGrid({ rows }: { rows: DetailRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
      {rows.map((row) => (
        <div key={row.label}>
          <p className="text-[11px] uppercase tracking-wide text-[var(--jale-ink-2)]">{row.label}</p>
          <p
            className={`text-sm font-semibold text-[var(--jale-ink)] ${row.capitalizeValue ? 'capitalize' : ''}`}
          >
            {row.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export default async function PublicJobPage({ params }: PageProps) {
  const t = await getTranslations({ locale: params.locale, namespace: 'public_job' });

  let job;
  try {
    job = await getPublicJob(params.code);
  } catch (err) {
    if (err instanceof PublicJobNotFoundError) notFound();
    throw err;
  }

  if (isClosedJob(job)) {
    return (
      <div className="min-h-screen bg-[var(--jale-paper)]">
        <BrandBand />
        <main className="px-4 -mt-10">
          <div className="max-w-md md:max-w-2xl mx-auto">
            <div className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm overflow-hidden">
              {/* A closed job still had a real visit -- record the open
                  beacon (and the referral banner, if any) same as the
                  active branch below, so opens aren't undercounted just
                  because the job happened to close first. */}
              <Suspense fallback={null}>
                <ReferralContext code={job.code} />
              </Suspense>
              <div className="p-6">
                <h1 className="text-xl font-bold text-[var(--jale-ink)] mb-1">{job.title}</h1>
                <p className="text-sm text-[var(--jale-ink-2)] mb-5">
                  {job.company} · {job.location}
                </p>
                <div className="rounded-xl bg-[var(--jale-paper-2)] p-4">
                  <p className="text-sm font-semibold text-[var(--jale-ink)] mb-1">{t('closed_title')}</p>
                  <p className="text-sm text-[var(--jale-ink-2)]">{t('closed_body')}</p>
                </div>
                <Link
                  href="/"
                  className="mt-5 flex w-full items-center justify-center rounded-xl bg-[var(--jale-blue-500)] px-4 py-3.5 text-sm font-semibold text-white hover:bg-[var(--jale-blue-600)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jale-blue-500)]"
                >
                  {t('browse_jobs')}
                </Link>
              </div>
            </div>
            <TrustFooter text={t('about_jale')} />
          </div>
        </main>
      </div>
    );
  }

  const active: PublicJobActive = job;
  // Canonical URL, same derivation as generateMetadata's `alternates` --
  // the `/en/` URL is canonical for both locales, so this is what
  // schema.org JobPosting.url points at regardless of which locale is
  // being rendered.
  const { en: canonicalUrl } = buildJobPageUrls(active.code);
  const jobPostingJsonLd = buildJobPostingJsonLd(active, canonicalUrl);
  const jobTypeLabel = active.job_type ? active.job_type.replace('-', ' ') : '';
  const languageLabel = (code: 'any' | 'en' | 'es') => t(`language_${code}`);
  const startDate = active.start_date
    ? (formatStartDate(active.start_date, params.locale) ?? active.start_date)
    : null;
  const postedDate = formatStartDate(active.created_at, params.locale) ?? active.created_at;
  const showPay = Boolean(active.pay && active.pay !== 'Pay not specified');

  // The header location line: company, then whichever of the structured
  // city/state_region pair and the free-text location field actually exist.
  const cityState =
    active.city && active.state_region ? `${active.city}, ${active.state_region}` : null;
  const headerLine = [active.company, cityState, active.location].filter(Boolean).join(' · ');

  // Minor facts become quiet chips: scannable on a phone, no label-grid.
  // Trade and experience move into dedicated cards below (Details / What
  // you need); only job type, openings, and language stay as chips here.
  // The language chip carries an `aria-label` prefixed with the
  // `language_preference` label ("Language: English") since the visible
  // chip text is bare, for screen-reader clarity.
  const chips: { text: string; ariaLabel?: string }[] = [];
  if (jobTypeLabel) chips.push({ text: jobTypeLabel });
  if (active.language_preference && active.language_preference.length > 0) {
    const languageText = active.language_preference.map(languageLabel).join(' / ');
    chips.push({ text: languageText, ariaLabel: `${t('language_preference')}: ${languageText}` });
  }
  if (active.number_of_workers_needed != null && active.number_of_workers_needed > 1) {
    chips.push({ text: t('openings_chip', { count: active.number_of_workers_needed }) });
  }

  // "What you need" checklist: only what the applicant must bring or
  // accept. Rendered as one row per requirement kind (docs and
  // certifications group into a single row each, rather than one row per
  // item) so the card stays compact.
  const needRows: string[] = [];
  if (active.required_docs.length > 0) {
    needRows.push(`${t('required_docs')}: ${active.required_docs.map((d) => docLabel(t, d)).join(', ')}`);
  }
  if (active.certifications && active.certifications.length > 0) {
    needRows.push(`${t('certifications')}: ${active.certifications.join(', ')}`);
  }
  const experienceText = formatExperience(t, active.required_experience_years, active.required_experience_months);
  if (experienceText) needRows.push(`${t('required_experience')}: ${experienceText}`);
  if (active.transportation_required) needRows.push(t('transportation_required'));
  if (active.work_authorization_required) needRows.push(t('work_authorization_required'));

  // "Details" grid: secondary facts a decided applicant might still check.
  const detailRows: DetailRow[] = [];
  if (active.expected_duration) detailRows.push({ label: t('duration'), value: active.expected_duration });
  if (active.trade_category) {
    detailRows.push({ label: t('trade_category'), value: active.trade_category, capitalizeValue: true });
  }
  detailRows.push({ label: t('posted'), value: postedDate });
  if (active.number_of_workers_needed != null) {
    detailRows.push({ label: t('openings'), value: String(active.number_of_workers_needed) });
  }

  return (
    <div className="min-h-screen bg-[var(--jale-paper)]">
      {/* Structured data for search engines -- active jobs only, never for
          the closed/error branches above. Escaping the employer-authored
          description against script-breakout XSS happens inside
          serializeJsonLd, not here. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jobPostingJsonLd) }}
      />
      <BrandBand />

      <main className="px-4 -mt-10">
        <div className="max-w-md md:max-w-2xl mx-auto space-y-4">
          <article className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm overflow-hidden">
            {/* The signature: rendered ONLY when this visit carries a share
                tag. Teal marks the referral thread and nothing else. */}
            <Suspense fallback={null}>
              <ReferralContext code={active.code} />
            </Suspense>

            <div className="p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-1.5">
                {t('eyebrow')}
              </p>
              <h1 className="text-2xl font-bold leading-tight text-[var(--jale-ink)]">{active.title}</h1>
              {headerLine && <p className="text-sm text-[var(--jale-ink-2)] mt-1.5 mb-4">{headerLine}</p>}

              {/* Pay is THE deciding fact for this reader; it gets a strip,
                  not a grid cell. Start/schedule ride along when present. */}
              {(showPay || startDate || active.shift_schedule) && (
                <div className="rounded-xl bg-[var(--jale-paper-2)] px-4 py-3.5 mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  {showPay && (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--jale-ink-2)]">
                        {t('pay_range')}
                      </p>
                      <p className="text-lg font-bold text-[var(--jale-success)]">{active.pay}</p>
                    </div>
                  )}
                  {startDate && (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--jale-ink-2)]">
                        {t('start_date')}
                      </p>
                      <p className="text-sm font-semibold text-[var(--jale-ink)]">{startDate}</p>
                    </div>
                  )}
                  {active.shift_schedule && (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--jale-ink-2)]">
                        {t('shift_schedule')}
                      </p>
                      <p className="text-sm font-semibold text-[var(--jale-ink)]">{active.shift_schedule}</p>
                    </div>
                  )}
                </div>
              )}

              {chips.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {chips.map((chip) => (
                    <li
                      key={chip.text}
                      aria-label={chip.ariaLabel}
                      className="text-xs capitalize text-[var(--jale-ink-2)] bg-[var(--jale-paper-2)] border border-[var(--jale-divider)] rounded-full px-3 py-1"
                    >
                      {chip.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>

          {active.description && (
            <section className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-2">
                {t('about_job')}
              </p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--jale-ink)]">
                {active.description}
              </p>
            </section>
          )}

          {needRows.length > 0 && (
            <section className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-2">
                {t('what_you_need')}
              </p>
              <ul className="space-y-1.5">
                {needRows.map((row) => (
                  <li key={row} className="flex items-start gap-2 text-sm text-[var(--jale-ink)]">
                    <span aria-hidden="true" className="text-[var(--jale-success)] mt-px">
                      &#10003;
                    </span>
                    {row}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-3">
              {t('details')}
            </p>
            <DetailsGrid rows={detailRows} />
          </section>

          <div>
            <Suspense fallback={null}>
              <ApplyButton code={active.code} />
            </Suspense>
            <p className="text-center text-xs text-[var(--jale-ink-2)] mt-3">{t('apply_hint')}</p>
            {active.id && (
              <Suspense fallback={null}>
                <WebApplyButton jobId={active.id} label={t('apply_web')} />
              </Suspense>
            )}
          </div>

          <TrustFooter text={t('about_jale')} />
        </div>
      </main>
    </div>
  );
}

function docLabel(t: Awaited<ReturnType<typeof getTranslations>>, doc: PublicJobDocType): string {
  if (doc === 'resume') return t('doc_resume');
  if (doc === 'driver_license') return t('doc_driver_license');
  return t('doc_ssn');
}

/** Combines required_experience_years/months into one localized phrase
 * ("2 years 6 months", "3 years", "6 months"). Returns null when neither
 * field is set (or both are zero), so callers can skip the row entirely. */
function formatExperience(
  t: Awaited<ReturnType<typeof getTranslations>>,
  years: number | null | undefined,
  months: number | null | undefined,
): string | null {
  const parts: string[] = [];
  if (years) parts.push(t('experience_years_unit', { n: years }));
  if (months) parts.push(t('experience_months_unit', { n: months }));
  return parts.length > 0 ? parts.join(' ') : null;
}
