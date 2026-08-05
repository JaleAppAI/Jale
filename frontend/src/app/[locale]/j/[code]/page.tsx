import type { Metadata } from 'next';
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

export const dynamic = 'force-dynamic';

interface PageParams {
  locale: string;
  code: string;
}

interface PageProps {
  params: PageParams;
  searchParams?: { r?: string | string[] };
}

// Never render employer contact details here -- the public API cannot return
// them, so this component must never grow a second call that tries.
//
// Design notes (first-contact page): the reader is a referred stranger on a
// phone, arriving from a chat app, deciding in seconds. Facts are ranked the
// way a trade worker decides -- title, then PAY (promoted out of the detail
// grid into its own strip), then where/when, then everything else as quiet
// chips. The navy band up top echoes the chat header they just left; the teal
// referral ribbon renders ONLY when a share tag is present, because structure
// should encode what is true. Teal is reserved for the referral thread and
// used nowhere else on the page.

const OG_IMAGE_PATH = '/brand/wordmark-navy.png';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'public_job' });
  const shareCode = firstParam(searchParams?.r);

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
    // visit, so the open-recording side effect on the API fires only once.
    const job = await getPublicJob(params.code, shareCode);

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
      <div className="max-w-md mx-auto">
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

export default async function PublicJobPage({ params, searchParams }: PageProps) {
  const t = await getTranslations({ locale: params.locale, namespace: 'public_job' });
  const shareCode = firstParam(searchParams?.r);

  let job;
  try {
    job = await getPublicJob(params.code, shareCode);
  } catch (err) {
    if (err instanceof PublicJobNotFoundError) notFound();
    throw err;
  }

  if (isClosedJob(job)) {
    return (
      <div className="min-h-screen bg-[var(--jale-paper)]">
        <BrandBand />
        <main className="px-4 -mt-10">
          <div className="max-w-md mx-auto">
            <div className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm p-6">
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
  const showPay = Boolean(active.pay && active.pay !== 'Pay not specified');

  // Minor facts become quiet chips: scannable on a phone, no label-grid.
  const chips: string[] = [];
  if (jobTypeLabel) chips.push(jobTypeLabel);
  if (active.trade_category) chips.push(active.trade_category);
  if (active.language_preference && active.language_preference.length > 0) {
    chips.push(active.language_preference.map(languageLabel).join(' / '));
  }
  if (active.required_experience_years != null && active.required_experience_years > 0) {
    chips.push(t('experience_chip', { years: active.required_experience_years }));
  }
  if (active.number_of_workers_needed != null && active.number_of_workers_needed > 1) {
    chips.push(t('openings_chip', { count: active.number_of_workers_needed }));
  }

  // Requirements: only what the applicant must bring or accept.
  const requirements: string[] = [];
  for (const d of active.required_docs) requirements.push(docLabel(t, d));
  if (active.certifications && active.certifications.length > 0) {
    for (const c of active.certifications) requirements.push(c);
  }
  if (active.transportation_required) requirements.push(t('transportation_required'));
  if (active.work_authorization_required) requirements.push(t('work_authorization_required'));

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
        <div className="max-w-md mx-auto">
          <article className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-2xl shadow-sm overflow-hidden">
            {/* The signature: rendered ONLY when this visit carries a share
                tag. Teal marks the referral thread and nothing else. */}
            {shareCode && (
              <p className="flex items-center gap-2 bg-[var(--jale-teal-50)] text-[var(--jale-ink)] text-[13px] font-medium px-5 py-2.5 border-b border-[var(--jale-divider)]">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full bg-[var(--jale-teal-500)] shrink-0"
                />
                {t('referred_banner')}
              </p>
            )}

            <div className="p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-1.5">
                {t('eyebrow')}
              </p>
              <h1 className="text-2xl font-bold leading-tight text-[var(--jale-ink)]">{active.title}</h1>
              <p className="text-sm text-[var(--jale-ink-2)] mt-1.5 mb-4">
                {active.company} · {active.location}
              </p>

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

              {active.description && (
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--jale-ink)] mb-4">
                  {active.description}
                </p>
              )}

              {chips.length > 0 && (
                <ul className="flex flex-wrap gap-2 mb-1">
                  {chips.map((chip) => (
                    <li
                      key={chip}
                      className="text-xs capitalize text-[var(--jale-ink-2)] bg-[var(--jale-paper-2)] border border-[var(--jale-divider)] rounded-full px-3 py-1"
                    >
                      {chip}
                    </li>
                  ))}
                </ul>
              )}

              {requirements.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[var(--jale-divider)]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)] mb-2">
                    {t('requirements')}
                  </p>
                  <ul className="space-y-1.5">
                    {requirements.map((r) => (
                      <li key={r} className="flex items-start gap-2 text-sm text-[var(--jale-ink)]">
                        <span aria-hidden="true" className="text-[var(--jale-ink-2)] mt-px">
                          –
                        </span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </article>

          <div className="mt-4">
            <ApplyButton code={active.code} shareCode={shareCode} />
            <p className="text-center text-xs text-[var(--jale-ink-2)] mt-3">{t('apply_hint')}</p>
            {active.id && (
              <WebApplyButton jobId={active.id} shareCode={shareCode} label={t('apply_web')} />
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
