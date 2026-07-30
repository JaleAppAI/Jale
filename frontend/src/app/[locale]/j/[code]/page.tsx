import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { formatStartDate } from '@/lib/date';
import { getPublicJob, isClosedJob, PublicJobNotFoundError } from '@/lib/api/publicJob';
import type { PublicJobActive, PublicJobDocType } from '@/lib/api/publicJob';
import { ApplyButton } from './ApplyButton';

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

const OG_IMAGE_PATH = '/brand/wordmark-navy.png';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'public_job' });
  const shareCode = firstParam(searchParams?.r);

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
        openGraph: { title, description, images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }] },
        twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE_PATH] },
      };
    }

    const title = t('meta_title', { title: job.title, company: job.company });
    const description = t('meta_description', { title: job.title, location: job.location });
    return {
      title,
      description,
      openGraph: { title, description, images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }], type: 'website' },
      twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE_PATH] },
    };
  } catch {
    return {
      title: t('meta_title_generic'),
      description: t('meta_description_generic'),
      openGraph: { images: [{ url: OG_IMAGE_PATH, width: 1800, height: 918 }] },
      twitter: { card: 'summary_large_image', images: [OG_IMAGE_PATH] },
    };
  }
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
      <div className="min-h-screen bg-[var(--jale-paper)] px-4 py-10 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto text-center">
          <p className="text-2xl font-bold text-[var(--jale-blue-900)] mb-6">Jale</p>
          <div className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-xl p-6 text-left">
            <h1 className="text-lg font-semibold mb-1">{job.title}</h1>
            <p className="text-sm text-[var(--jale-ink-2)] mb-4">{job.company} · {job.location}</p>
            <p className="text-sm font-semibold text-[var(--jale-ink)] mb-1">{t('closed_title')}</p>
            <p className="text-sm text-[var(--jale-ink-2)]">{t('closed_body')}</p>
          </div>
          <Link
            href="/"
            className="inline-block mt-6 text-sm font-semibold text-[var(--jale-blue-700)] underline"
          >
            {t('browse_jobs')}
          </Link>
        </div>
      </div>
    );
  }

  const active: PublicJobActive = job;
  const jobTypeLabel = active.job_type ? active.job_type.replace('-', ' ') : '';
  const languageLabel = (code: 'any' | 'en' | 'es') => t(`language_${code}`);

  return (
    <div className="min-h-screen bg-[var(--jale-paper)] px-4 py-8">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <p className="text-2xl font-bold text-[var(--jale-blue-900)]">Jale</p>
        </div>

        <div className="bg-[var(--jale-card)] border border-[var(--jale-divider)] rounded-xl p-5 mb-4">
          <h1 className="text-lg font-bold mb-1">{active.title}</h1>
          <p className="text-sm text-[var(--jale-ink-2)] mb-3">
            {active.company} · {active.location}
          </p>
          {jobTypeLabel && (
            <p className="inline-block text-xs uppercase tracking-wide text-[var(--jale-ink-2)] capitalize bg-[var(--jale-paper-2)] rounded-full px-2.5 py-1 mb-4">
              {jobTypeLabel}
            </p>
          )}

          {active.description && (
            <p className="text-sm whitespace-pre-wrap mb-4">{active.description}</p>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm mb-2">
            {active.pay && active.pay !== 'Pay not specified' && (
              <Detail label={t('pay_range')} value={active.pay} />
            )}
            {active.start_date && (
              <Detail
                label={t('start_date')}
                value={formatStartDate(active.start_date, params.locale) ?? active.start_date}
              />
            )}
            {active.shift_schedule && <Detail label={t('shift_schedule')} value={active.shift_schedule} />}
            {active.trade_category && <Detail label={t('trade_category')} value={active.trade_category} />}
            {active.required_experience_years != null && (
              <Detail label={t('required_experience')} value={`${active.required_experience_years}`} />
            )}
            {active.number_of_workers_needed != null && (
              <Detail label={t('openings')} value={`${active.number_of_workers_needed}`} />
            )}
            {active.certifications && active.certifications.length > 0 && (
              <Detail label={t('certifications')} value={active.certifications.join(', ')} />
            )}
            {active.language_preference && active.language_preference.length > 0 && (
              <Detail
                label={t('language_preference')}
                value={active.language_preference.map(languageLabel).join(', ')}
              />
            )}
            {active.transportation_required && (
              <Detail label={t('transportation_required')} value={t('yes')} />
            )}
            {active.work_authorization_required && (
              <Detail label={t('work_authorization_required')} value={t('yes')} />
            )}
          </div>

          {active.required_docs.length > 0 && (
            <div className="mt-3">
              <p className="text-xs uppercase tracking-wide text-[var(--jale-ink-2)] mb-2">
                {t('required_docs')}
              </p>
              <ul className="space-y-1">
                {active.required_docs.map((d) => (
                  <li key={d} className="text-sm">
                    {docLabel(t, d)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <ApplyButton code={active.code} shareCode={shareCode} />
        <p className="text-center text-xs text-[var(--jale-ink-2)] mt-3">{t('apply_hint')}</p>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--jale-ink-2)] mb-1">{label}</p>
      <p>{value}</p>
    </div>
  );
}

function docLabel(t: Awaited<ReturnType<typeof getTranslations>>, doc: PublicJobDocType): string {
  if (doc === 'resume') return t('doc_resume');
  if (doc === 'driver_license') return t('doc_driver_license');
  return t('doc_ssn');
}
