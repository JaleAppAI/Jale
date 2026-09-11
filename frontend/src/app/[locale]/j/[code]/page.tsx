import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Badge, JobStatusBadge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import {
  JobFactsCard,
  type JobFactRequirement,
  type JobFactTile,
} from '@/components/jobs/JobFactsCard';
import { Link } from '@/i18n/navigation';
import { formatLongDate, formatStartDate } from '@/lib/date';
import { formatPay } from '@/lib/pay';
import { durationLabel, scheduleSummary, tradeLabel, type Translator } from '@/lib/job-detail-display';
import { getPublicJob, isClosedJob, PublicJobNotFoundError } from '@/lib/api/publicJob';
import type { PublicJobActive, PublicJobDocType } from '@/lib/api/publicJob';
import { buildJobPostingJsonLd, serializeJsonLd } from '@/lib/seo/jobPostingJsonLd';
import { buildJobPageUrls } from '@/lib/seo/siteUrl';
import { ApplyButton, ApplyButtonSkeleton } from './ApplyButton';
import { WebApplyButton, WebApplyButtonSkeleton } from './WebApplyButton';
import { LocaleToggle, LocaleToggleFallback } from './LocaleToggle';
import { ReferralContext, ReferralRibbonSkeleton } from './ReferralContext';

export const revalidate = 60;

interface PageParams {
  locale: string;
  code: string;
}

interface PageProps {
  // Next hands `params` over as a promise and no longer offers the synchronous
  // shim that used to let this file read a param straight off the object, so
  // both exported functions below await it once at the top.
  params: Promise<PageParams>;
}

// Never render employer contact details here -- the public API cannot return
// them, so this component must never grow a second call that tries.
//
// Design notes (first-contact page): the reader is a referred stranger on a
// phone, arriving from a chat app, deciding in seconds. So the page is a hero
// -- status, title, company and location -- and then ONE facts card. The navy
// band up top echoes the chat header they just left; the teal referral ribbon
// (rendered by `ReferralContext`, a client component) shows ONLY when a share
// tag is present, because structure should encode what is true. Teal is
// reserved for the referral thread and used nowhere else on the page.
//
// That facts card is `JobFactsCard`, the SAME component and the same locked
// section order the worker and employer job pages render -- pay as a headline
// figure, eight label-over-value tiles, requirement chips, the description.
// Before it, this page stacked three cards of `KVList` rows (about / "What you
// need" / "Details") that had drifted into a different fact list from the two
// signed-in pages, which is the drift the shared component exists to end: a
// stranger reads the job the app shows, not a variant of it.
//
// Nothing in this file (or generateMetadata below) may read `searchParams`
// -- doing so forces this route into dynamic (force-dynamic-equivalent)
// rendering, defeating the `revalidate = 60` ISR config above. The `?r=`
// share tag is read entirely client-side, by `ReferralContext`,
// `ApplyButton`, `WebApplyButton`, and `LocaleToggle` via
// `useSearchParams()`. That is also why each of those four sits behind its own
// Suspense boundary: Next requires one above any `useSearchParams()` caller,
// and on a static render that fallback is what the HTML ships. Each fallback
// traces its island's final geometry so nothing pops in or shifts on
// hydration.
//
// (Measured on a production build: this route currently renders per request --
// `Cache-Control: no-store`, and the islands resolve their real content during
// SSR -- so the fallbacks are mostly a safety net rather than the common path.
// That predates the toggle and is not what this file assumes; the rule above
// still holds, because reading searchParams here would make the dynamic
// rendering unconditional and permanent.)
//
// `LocaleToggle`'s fallback goes further than the other three: it is a working
// link rather than a skeleton, so the language switch keeps working in the
// static-render case and for a visitor whose JavaScript never runs.

const OG_IMAGE_PATH = '/brand/wordmark-navy.png';

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
  const { locale, code } = await params;
  const t = await getTranslations({ locale, namespace: 'public_job' });

  // Canonical decision (fixed): the `/en/` URL is canonical for BOTH
  // locales -- one job, one indexed URL, no en/es duplicate-content split.
  // This only depends on the code param, not on locale or fetch success, so
  // it applies identically to every branch below (active, closed, error).
  const { en: canonicalUrl, es: esUrl } = buildJobPageUrls(code);
  const alternates: Metadata['alternates'] = {
    canonical: canonicalUrl,
    languages: { en: canonicalUrl, es: esUrl },
  };

  try {
    // Same call (same URL + options) as the page component below -- Next's
    // fetch request memoization dedupes these into one network request per
    // revalidation window.
    const job = await getPublicJob(code);

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

interface BrandBandProps {
  /** Locale-less path of this very page, e.g. `/j/ABC123`, for the toggle. */
  path: string;
  otherLocale: string;
  languageLabel: string;
}

/** Navy brand band. The card below overlaps it, echoing the chat-app header
 * the visitor just came from.
 *
 * BRAND SURFACE: this band is navy in BOTH themes. `--jale-blue-900` is one of
 * the brand-ramp tokens the dark theme deliberately does not re-point (unlike
 * `--jale-blue-50/700`), so naming it here keeps the page token-only while the
 * band stays the fixed brand navy a visitor recognises from WhatsApp. The white
 * wordmark asset only works on that navy, which is the other half of the
 * reason.
 *
 * This band is also the page's ONLY chrome -- the global `Header` suppresses
 * itself on `/j` so a referred stranger does not meet two stacked wordmarks --
 * which makes it the only place a language toggle can live. It has to be here:
 * a shared job link is a single URL handed to both audiences, so a Spanish
 * speaker who is sent an `/en/j/...` link has no other way out of English. */
function BrandBand({ path, otherLocale, languageLabel }: BrandBandProps) {
  return (
    <header className="bg-[var(--jale-blue-900)] pt-7 pb-16 px-4">
      <div className="max-w-md md:max-w-2xl mx-auto flex items-center justify-between gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark-white.png" alt="Jale" className="h-7 w-auto" />
        {/* The fallback is a working link, not a skeleton -- see LocaleToggle. */}
        <Suspense
          fallback={
            <LocaleToggleFallback path={path} otherLocale={otherLocale} label={languageLabel} />
          }
        >
          <LocaleToggle path={path} otherLocale={otherLocale} label={languageLabel} />
        </Suspense>
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
  const { locale, code } = await params;
  const t = await getTranslations({ locale, namespace: 'public_job' });
  const tPay = await getTranslations({ locale, namespace: 'pay' });

  let job;
  try {
    job = await getPublicJob(code);
  } catch (err) {
    // This route deliberately has NO `loading.tsx`, and must not grow one. A
    // route-level skeleton opens a Suspense boundary at the segment, which
    // makes Next flush the response head -- status 200 -- before this
    // component ever runs. `notFound()` below then only swaps the body, so a
    // dead job link answers 200 with 404 content: a soft-404 that leaves
    // Google Jobs indexing expired postings. Rendering this segment to
    // completion before anything is sent is what lets `notFound()` set a real
    // 404 status. The unbranded wait on this ISR-cached page is the accepted
    // cost.
    if (err instanceof PublicJobNotFoundError) notFound();
    throw err;
  }

  // Language toggle inputs, shared by both branches below.
  //
  // `header.language_toggle` is reused rather than duplicated into
  // `public_job`: that key already resolves to the OTHER language's own name
  // in each catalogue (en -> "Español", es -> "English"), which is exactly
  // what this pill needs, and it is the same string the global Header and
  // AuthShell show, so the app says one thing everywhere.
  //
  // The path is built from the `code` param, not from the fetched job's `code`:
  // the toggle's job is to re-open THIS url in the other locale, so it has to
  // preserve the code exactly as the visitor's link spelled it.
  const tHeader = await getTranslations({ locale, namespace: 'header' });
  const otherLocale = locale === 'es' ? 'en' : 'es';
  const localePath = `/j/${encodeURIComponent(code)}`;

  if (isClosedJob(job)) {
    return (
      <div className="min-h-screen bg-[var(--jale-paper)]">
        <BrandBand
          path={localePath}
          otherLocale={otherLocale}
          languageLabel={tHeader('language_toggle')}
        />
        <main className="px-4 -mt-10">
          <div className="anim-fade-in max-w-md md:max-w-2xl mx-auto">
            {/* The job is an `<article>`, not a `<section>`: a self-contained
                syndicatable item, on a page that exists to be shared.
                `overflow-hidden` keeps the referral ribbon's top corners on the
                card's radius. */}
            <DashboardPanel as="article" className="overflow-hidden">
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
            </DashboardPanel>

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
  // `null` when the job has no description -- an incomplete JobPosting
  // (missing a required property) is worse for search than no structured
  // data at all, so the <script> tag below is skipped entirely in that case.
  const jobPostingJsonLd = buildJobPostingJsonLd(active, canonicalUrl);
  const jobTypeLabel = active.job_type ? active.job_type.replace('-', ' ') : '';
  const languageLabel = (lang: 'any' | 'en' | 'es') => t(`language_${lang}`);
  const startDate = active.start_date
    ? (formatStartDate(active.start_date, locale) ?? active.start_date)
    : null;
  // `created_at` is an INSTANT, not a calendar day. This page renders on the
  // server, so it resolves in the server's zone (UTC on Lambda) -- the same
  // string the UTC-pinned `formatStartDate` produced, but now for the right
  // reason and consistent with every other "posted" line in the app.
  const postedDate = formatLongDate(active.created_at, locale) ?? active.created_at;
  const pay = formatPay(active, tPay);

  // Structured trade/duration/schedule/certification display, added by a
  // parallel backend task (migrations 077-079). Every field here is
  // optional -- see this task's summary for the exact fallback matrix.
  //
  // `job-detail-display.ts`'s `Translator` type is deliberately structural
  // (a plain `(key, values?) => string`) so its formatters stay unit-testable
  // without a next-intl runtime -- see that module's doc comment. next-intl
  // v4's server translator is generic over its own namespace's message keys,
  // which is narrower than that structural type for the `values` parameter,
  // so passing it directly fails `tsc` (verified). The next line is a thin
  // widening adapter at that boundary, not a behavior change.
  const tCommonRaw = await getTranslations({ locale, namespace: 'common' });
  const tCommon: Translator = (key, values) =>
    (tCommonRaw as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values);
  // `worker_job_detail.what_you_need.proof_needed` is reused rather than
  // duplicated into `public_job`: its text ("Proof needed") carries no
  // worker-app-specific framing, so it reads correctly here too -- the same
  // justified cross-namespace borrow this page already makes for
  // `header.language_toggle`.
  const tWorkerJobDetail = await getTranslations({ locale, namespace: 'worker_job_detail' });
  /* The app's ONE required/optional vocabulary, restored here: this page read
     `job_requirements.states.*` for its certification tiers before this lane,
     and every job page reads it now (owner ruling, fix round 1). */
  const tRequirement = await getTranslations({ locale, namespace: 'job_requirements' });
  // `tradeLabel` resolves the trade SLUG as a relative key, and
  // `employer_dashboard.modal.trade.*` is the one catalogue carrying all eight
  // of migration 023's tokens -- `public_job` has no per-slug catalogue of its
  // own, which is exactly why this page used to render the raw slug title-cased
  // by CSS. Same widening cast as `tCommon` above, same reason.
  const tTradeRaw = await getTranslations({ locale, namespace: 'employer_dashboard.modal.trade' });
  const tTrade: Translator = (key) => (tTradeRaw as unknown as (k: string) => string)(key);
  const tDetail: Translator = (key, values) =>
    (t as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values);

  const durationText = durationLabel(active, tCommon);
  const schedule = scheduleSummary(active, locale, tCommon);

  // The header location line: company, then whichever of the structured
  // city/state_region pair and the free-text location field actually exist.
  const cityState =
    active.city && active.state_region ? `${active.city}, ${active.state_region}` : null;
  const headerLine = [active.company, cityState, active.location].filter(Boolean).join(' · ');

  /*
   * The job's facts, as the ONE card body all three job pages render.
   *
   * This replaces three cards -- the description panel, "What you need" and
   * "Details" -- with one, in the order locked for the worker and employer
   * pages too, so a stranger sent this link reads the same posting the signed-in
   * app shows. Every value is still built here, by this page's own formatters.
   */
  // ONE Horario tile: the days and the hours are one fact to a reader planning
  // a ride. `scheduleSummary` already suppresses `legacy` whenever any
  // structured schedule data exists, so this cannot show both.
  const scheduleText = schedule.legacy
    ?? ([schedule.days.length > 0 ? schedule.days.join(', ') : null, schedule.hours]
      .filter(Boolean)
      .join(' · ') || null);
  const tradeText = tradeLabel(active, tTrade, tDetail);
  const experienceText = formatExperience(
    t,
    active.required_experience_years,
    active.required_experience_months,
  );
  const languageText = active.language_preference && active.language_preference.length > 0
    ? active.language_preference.map(languageLabel).join(' / ')
    : null;

  const scheduleTiles: JobFactTile[] = [];
  if (scheduleText) {
    scheduleTiles.push({ key: 'shift', label: t('shift_schedule'), value: scheduleText });
  }
  if (durationText) {
    scheduleTiles.push({ key: 'duration', label: t('duration'), value: durationText });
  }
  scheduleTiles.push({
    key: 'start',
    label: t('start_date'),
    // `tabular-nums` on the two numeric tiles, matching the signed-in pages:
    // a date and a headcount are figures, and they should not reflow as the
    // digits change.
    value: startDate ? <span className="tabular-nums">{startDate}</span> : t('facts.start_unknown'),
    muted: !startDate,
  });
  if (active.number_of_workers_needed != null) {
    // The public projection carries no `hired_count`/`open_count` -- and must
    // not: how far along an employer's hiring is is not a stranger's business.
    // So this tile is the total, which is what this page has always shown.
    scheduleTiles.push({
      key: 'openings',
      label: t('openings'),
      value: <span className="tabular-nums">{String(active.number_of_workers_needed)}</span>,
    });
  }

  const whereTiles: JobFactTile[] = [
    { key: 'location', label: t('facts.location'), value: cityState ?? active.location },
  ];
  if (tradeText) {
    whereTiles.push({ key: 'trade', label: t('trade_category'), value: tradeText });
  }
  if (experienceText) {
    whereTiles.push({ key: 'experience', label: t('required_experience'), value: experienceText });
  }
  if (languageText) {
    whereTiles.push({ key: 'language', label: t('language_preference'), value: languageText });
  }

  /*
   * Requirement chips, in THREE labelled rows rather than one flat strip
   * (owner ruling, fix round 1): a policy the job sets, a credential the
   * worker must already hold and a file they must bring are three different
   * asks, and a stranger deciding whether they qualify has to be able to tell
   * which is which. Each row is dropped when empty.
   */
  const requiredWord = tRequirement('states.required');
  const policyChips: JobFactRequirement[] = [];
  if (active.transportation_required) {
    policyChips.push({
      key: 'transportation',
      label: t('transportation'),
      state: 'required',
      stateLabel: requiredWord,
    });
  }
  if (active.work_authorization_required) {
    policyChips.push({
      key: 'work_authorization',
      label: t('work_authorization'),
      state: 'required',
      stateLabel: requiredWord,
    });
  }

  // Structured per-cert tiers when the job has them, else the legacy
  // `certifications` name list, stated as `required` (a tier that data does not
  // carry -- see the employer page's identical fallback). Keyed by index, not
  // by name: `parseJobFields` dedupes names case-insensitively on write, but
  // this page renders whatever the row holds.
  const certificationChips: JobFactRequirement[] = [];
  if (active.certification_requirements && active.certification_requirements.length > 0) {
    active.certification_requirements.forEach((cert, index) => {
      certificationChips.push({
        key: `cert-${index}`,
        // The proof note stays part of the chip's LABEL rather than being
        // dropped: it is a second, independent demand ("bring the card, not
        // just the claim") that the required/optional state does not say, and
        // this page is the only one of the three that shows it.
        label: cert.proof_required
          ? `${cert.name} · ${tWorkerJobDetail('what_you_need.proof_needed')}`
          : cert.name,
        state: cert.tier,
        stateLabel: tRequirement(`states.${cert.tier}`),
      });
    });
  } else if (active.certifications && active.certifications.length > 0) {
    active.certifications.forEach((cert, index) => {
      certificationChips.push({
        key: `legacy-cert-${index}`,
        label: cert,
        state: 'required',
        stateLabel: requiredWord,
      });
    });
  }

  const documentChips: JobFactRequirement[] = active.required_docs.map((doc, index) => ({
    key: `doc-${index}`,
    label: docLabel(t, doc),
    state: 'required' as const,
    stateLabel: requiredWord,
  }));

  return (
    <div className="min-h-screen bg-[var(--jale-paper)]">
      {/* Structured data for search engines -- active jobs only, never for
          the closed/error branches above, and never when the builder
          returned null (no description). Escaping the employer-authored
          description against script-breakout XSS happens inside
          serializeJsonLd, not here. */}
      {jobPostingJsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(jobPostingJsonLd) }}
        />
      ) : null}
      <BrandBand
        path={localePath}
        otherLocale={otherLocale}
        languageLabel={tHeader('language_toggle')}
      />

      <main className="px-4 -mt-10">
        <div className="anim-fade-in max-w-md md:max-w-2xl mx-auto space-y-4">
          {/* The job is an `<article>`, not a `<section>`: a self-contained
              syndicatable item, on a page that exists to be shared.
              `overflow-hidden` keeps the referral ribbon's top corners on the
              card's radius. */}
          <DashboardPanel as="article" className="overflow-hidden">
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
              {headerLine ? (
                <p className="text-sm text-[var(--jale-ink-2)] mt-1.5">{headerLine}</p>
              ) : null}
            </div>
          </DashboardPanel>

          {/* The three cards this page used to stack -- about / "What you
              need" / "Details" -- are ONE card now, the same one the worker
              and the employer read, and it keeps the "Details" card's own
              title. Pay moves into it as the headline (it was the hero's own
              strip); the job-type chip and the posted date move to the panel
              header, where both signed-in pages show them; language and
              openings were quiet hero badges and are now tiles, so they are
              not repeated up there. */}
          <DashboardPanel>
            <PanelHeader
              title={t('details')}
              action={
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {jobTypeLabel ? <Badge className="capitalize">{jobTypeLabel}</Badge> : null}
                  {/* Not in the About label: a forwarded link is often days
                      old, and a job with no description must still say when it
                      was posted (owner ruling, fix round 1). */}
                  <Badge>{`${t('posted')} ${postedDate}`}</Badge>
                </span>
              }
            />
            <JobFactsCard
              pay={pay ? { label: t('pay_range'), figure: pay } : null}
              schedule={{ label: t('facts.schedule'), tiles: scheduleTiles }}
              where={{
                label: t('facts.where'),
                tiles: whereTiles,
                chips: [
                  { key: 'policy', label: t('facts.requirements'), items: policyChips },
                  { key: 'certifications', label: t('certifications'), items: certificationChips },
                  { key: 'documents', label: t('required_docs'), items: documentChips },
                ],
              }}
              /* A stranger has no document vault, so the job's documents are
                 chips in the row above, exactly as on the employer page. */
              documents={null}
              about={
                active.description
                  ? { label: t('about_job'), text: active.description }
                  : null
              }
            />
          </DashboardPanel>

          <div>
            <Suspense fallback={<ApplyButtonSkeleton />}>
              <ApplyButton code={active.code} />
            </Suspense>
            <p className="text-center text-xs text-[var(--jale-ink-2)] mt-3">{t('apply_hint')}</p>
            {active.id ? (
              <Suspense fallback={<WebApplyButtonSkeleton />}>
                <WebApplyButton jobId={active.id} label={t('apply_web')} />
              </Suspense>
            ) : null}
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
