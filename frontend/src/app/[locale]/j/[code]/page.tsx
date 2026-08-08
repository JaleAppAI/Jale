import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Badge, JobStatusBadge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { Link } from '@/i18n/navigation';
import { formatStartDate } from '@/lib/date';
import { getPublicJob, isClosedJob, PublicJobNotFoundError } from '@/lib/api/publicJob';
import type { PublicJobActive, PublicJobDocType } from '@/lib/api/publicJob';
import { buildJobPostingJsonLd, serializeJsonLd } from '@/lib/seo/jobPostingJsonLd';
import { buildJobPageUrls } from '@/lib/seo/siteUrl';
import { ApplyButton, ApplyButtonSkeleton } from './ApplyButton';
import { WebApplyButton, WebApplyButtonSkeleton } from './WebApplyButton';
import { ReferralContext, ReferralRibbonSkeleton } from './ReferralContext';

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
// way a trade worker decides -- title, then PAY (promoted out of the fact list
// into its own strip), then everything else as stacked label/value rows in
// dedicated cards below. The navy band up top echoes the chat header they just
// left; the teal referral ribbon (rendered by `ReferralContext`, a client
// component) shows ONLY when a share tag is present, because structure should
// encode what is true. Teal is reserved for the referral thread and used
// nowhere else on the page.
//
// Every label/value pair on this page goes through the shared `KVList` and
// every status/type chip through the shared dot+text `Badge`, so the page
// speaks the same visual language as the signed-in app even though it has none
// of its chrome. Pay is the single exception, promoted to a headline figure
// because it is the fact this reader decides on.
//
// Nothing in this file (or generateMetadata below) may read `searchParams`
// -- doing so forces this route into dynamic (force-dynamic-equivalent)
// rendering, defeating the `revalidate = 60` ISR config above. The `?r=`
// share tag is read entirely client-side, by `ReferralContext`,
// `ApplyButton`, and `WebApplyButton` via `useSearchParams()`. That is also
// why each of those three sits behind its own Suspense boundary: reading
// searchParams opts an island out of the static render, and the boundary's
// fallback is what the ISR HTML actually ships. Each fallback traces its
// island's final geometry so nothing pops in or shifts on hydration.

const OG_IMAGE_PATH = '/brand/wordmark-navy.png';

/** The foundation card recipe, with `overflow-hidden` so the referral ribbon's
 * top corners follow the card's radius. `DashboardPanel` is the same recipe but
 * renders a `<section>`; the job itself is an `<article>`. */
const ARTICLE_CARD =
  'overflow-hidden rounded-2xl border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)]';

/** Small uppercase label that titles each card. */
const CARD_LABEL =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--jale-ink-2)]';

/**
 * `Button`'s primary recipe applied to an anchor, for the closed branch's CTA.
 *
 * This deliberately does NOT use the kit's `StateAction`, and the reason is a
 * measured bug, not taste: `globals.css` has an unlayered `a { color: inherit }`
 * which outranks every Tailwind text utility (they live in the `utilities`
 * layer), so `StateAction`'s `text-white` never lands on its link form. In the
 * light theme that leaves navy `--jale-ink` on a `--jale-blue-500` fill, ~3.5:1
 * -- under AA for a 14px label. Setting the colour inline is the only way to
 * beat an unlayered rule, and inline is exactly what `LandingNav` and
 * `WebApplyButton` already do for the same reason. Filed as a kit fix; this can
 * go back to `StateAction` the moment that lands.
 */
const CLOSED_CTA_CLASSES = [
  'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold',
  'bg-[var(--jale-blue-500)] shadow-[var(--shadow-btn)]',
  'transition-all duration-150 hover:bg-[var(--jale-blue-600)] active:scale-[0.98]',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

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
 * the visitor just came from.
 *
 * BRAND SURFACE: this band is navy in BOTH themes. `--jale-blue-900` is one of
 * the brand-ramp tokens the dark theme deliberately does not re-point (unlike
 * `--jale-blue-50/700`), so naming it here keeps the page token-only while the
 * band stays the fixed brand navy a visitor recognises from WhatsApp. The white
 * wordmark asset only works on that navy, which is the other half of the
 * reason. */
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
          <div className="anim-fade-in max-w-md md:max-w-2xl mx-auto">
            <article className={ARTICLE_CARD}>
              {/* A closed job still had a real visit -- record the open
                  beacon (and the referral banner, if any) same as the
                  active branch below, so opens aren't undercounted just
                  because the job happened to close first. */}
              <Suspense fallback={<ReferralRibbonSkeleton />}>
                <ReferralContext code={job.code} />
              </Suspense>

              <div className="p-5">
                {/* Terminal state, stated before anything else: the badge's
                    neutral dot says "not open" in the same shape the signed-in
                    app uses for a closed job, so the reader does not have to
                    reach the explanation below to know. */}
                <JobStatusBadge status="closed">{t('closed_badge')}</JobStatusBadge>

                <h1 className="mt-2 text-2xl font-extrabold leading-tight text-[var(--jale-ink)]">
                  {job.title}
                </h1>
                <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
                  {job.company} · {job.location}
                </p>

                <div className="mt-5 rounded-xl border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] p-4">
                  <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('closed_title')}</p>
                  <p className="mt-1 text-sm text-[var(--jale-ink-2)]">{t('closed_body')}</p>
                </div>

                <div className="mt-5 flex">
                  <Link href="/" className={CLOSED_CTA_CLASSES} style={{ color: '#fff' }}>
                    {t('browse_jobs')}
                  </Link>
                </div>
              </div>
            </article>

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

  // Minor facts become quiet badges: scannable on a phone, no label-grid.
  // The language badge carries an `aria-label` prefixed with the
  // `language_preference` label ("Language: English") since the visible
  // badge text is bare, for screen-reader clarity.
  const badges: { text: string; ariaLabel?: string; capitalize?: boolean }[] = [];
  if (jobTypeLabel) badges.push({ text: jobTypeLabel, capitalize: true });
  if (active.language_preference && active.language_preference.length > 0) {
    const languageText = active.language_preference.map(languageLabel).join(' / ');
    badges.push({ text: languageText, ariaLabel: `${t('language_preference')}: ${languageText}` });
  }
  if (active.number_of_workers_needed != null && active.number_of_workers_needed > 1) {
    badges.push({ text: t('openings_chip', { count: active.number_of_workers_needed }) });
  }

  // "What you need": only what the applicant must bring or accept. Docs and
  // certifications group into a single row each (rather than one row per item)
  // so the card stays compact, and the boolean requirements read as
  // label/"Required" pairs like every other fact on the page.
  const needRows: KVItem[] = [];
  if (active.required_docs.length > 0) {
    needRows.push({
      label: t('required_docs'),
      value: active.required_docs.map((d) => docLabel(t, d)).join(', '),
    });
  }
  if (active.certifications && active.certifications.length > 0) {
    needRows.push({ label: t('certifications'), value: active.certifications.join(', ') });
  }
  const experienceText = formatExperience(
    t,
    active.required_experience_years,
    active.required_experience_months,
  );
  if (experienceText) needRows.push({ label: t('required_experience'), value: experienceText });
  if (active.transportation_required) {
    needRows.push({ label: t('transportation'), value: t('yes') });
  }
  if (active.work_authorization_required) {
    needRows.push({ label: t('work_authorization'), value: t('yes') });
  }

  // "Details": every remaining fact, in the order a decided applicant checks
  // them -- when it starts, what the days look like, how long it runs, then the
  // taxonomy/provenance rows.
  const detailRows: KVItem[] = [];
  if (startDate) detailRows.push({ label: t('start_date'), value: startDate });
  if (active.shift_schedule) {
    detailRows.push({ label: t('shift_schedule'), value: active.shift_schedule });
  }
  if (active.expected_duration) {
    detailRows.push({ label: t('duration'), value: active.expected_duration });
  }
  if (active.trade_category) {
    // Only the raw `trade_category` value benefits from title-casing (it's an
    // unlabeled taxonomy string, e.g. "electrician"). Dates and numbers must
    // NOT get this -- `capitalize` mangles Spanish month names and
    // prepositions (e.g. "1 de enero" -> "1 De Enero").
    detailRows.push({
      label: t('trade_category'),
      value: <span className="capitalize">{active.trade_category}</span>,
    });
  }
  if (active.number_of_workers_needed != null) {
    detailRows.push({ label: t('openings'), value: String(active.number_of_workers_needed) });
  }
  detailRows.push({ label: t('posted'), value: postedDate });

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
        <div className="anim-fade-in max-w-md md:max-w-2xl mx-auto space-y-4">
          <article className={ARTICLE_CARD}>
            {/* The signature: rendered ONLY when this visit carries a share
                tag. Teal marks the referral thread and nothing else. */}
            <Suspense fallback={<ReferralRibbonSkeleton />}>
              <ReferralContext code={active.code} />
            </Suspense>

            <div className="p-5">
              <JobStatusBadge status="active">{t('eyebrow')}</JobStatusBadge>

              <h1 className="mt-2 text-2xl font-extrabold leading-tight text-[var(--jale-ink)]">
                {active.title}
              </h1>
              {headerLine && <p className="text-sm text-[var(--jale-ink-2)] mt-1.5">{headerLine}</p>}

              {/* Pay is THE deciding fact for this reader; it gets a headline,
                  not a row. Everything else is a KVList row further down. */}
              {showPay && (
                <div className="mt-4 rounded-xl bg-[var(--jale-paper-2)] px-4 py-3.5">
                  <p className="text-[11px] uppercase tracking-wide text-[var(--jale-ink-2)]">
                    {t('pay_range')}
                  </p>
                  <p className="text-lg font-bold text-[var(--jale-success)]">{active.pay}</p>
                </div>
              )}

              {badges.length > 0 && (
                <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {badges.map((badge) => (
                    <li key={badge.text} aria-label={badge.ariaLabel} className="min-w-0">
                      <Badge className={badge.capitalize ? 'capitalize' : undefined}>
                        {badge.text}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>

          {active.description && (
            <DashboardPanel className="p-5">
              <p className={`${CARD_LABEL} mb-2`}>{t('about_job')}</p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--jale-ink)]">
                {active.description}
              </p>
            </DashboardPanel>
          )}

          {needRows.length > 0 && (
            <DashboardPanel className="p-5">
              <p className={`${CARD_LABEL} mb-1`}>{t('what_you_need')}</p>
              <KVList items={needRows} />
            </DashboardPanel>
          )}

          {detailRows.length > 0 && (
            <DashboardPanel className="p-5">
              <p className={`${CARD_LABEL} mb-1`}>{t('details')}</p>
              <KVList items={detailRows} />
            </DashboardPanel>
          )}

          <div>
            <Suspense fallback={<ApplyButtonSkeleton />}>
              <ApplyButton code={active.code} />
            </Suspense>
            <p className="text-center text-xs text-[var(--jale-ink-2)] mt-3">{t('apply_hint')}</p>
            {active.id && (
              <Suspense fallback={<WebApplyButtonSkeleton />}>
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
