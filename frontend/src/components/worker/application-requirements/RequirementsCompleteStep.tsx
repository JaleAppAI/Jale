'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';

/**
 * "Your details are with the employer" (prototype W4d).
 *
 * The chip-over-headline shape is `DoneStep`'s: a small success marker, then
 * the sentence that says what actually happened, then the state as a badge,
 * then the ways on. Reused rather than reinvented so the two "you're finished"
 * moments in the worker app read as the same moment.
 *
 * IT PROMISES NOTHING ABOUT BEING HIRED. The employer asked for details and
 * has them; that is the whole claim. "We'll let you know when they update your
 * application" is the only forward-looking line, and it is about a
 * notification, not an outcome.
 */
export function RequirementsCompleteStep({
  companyName, jobId,
}: {
  companyName?: string | null;
  jobId?: string | null;
}) {
  const t = useTranslations('worker_application_details.complete');

  return (
    <div className="anim-fade-in grid gap-4">
      <InlineFeedback tone="success">
        <span className="font-semibold text-[var(--jale-ink)]">{t('chip')}</span>
      </InlineFeedback>

      <div>
        <h2 className="text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
          {t('title')}
        </h2>
        <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
          {companyName ? t('body', { company: companyName }) : t('body_no_company')}
        </p>
      </div>

      <div>
        <Badge tone="success">{t('status_chip')}</Badge>
      </div>

      <div className="grid gap-2.5">
        <Link href="/worker/applications">
          <Button className="w-full">{t('back_to_applications')}</Button>
        </Link>
        {jobId ? (
          <Link href={`/worker/jobs/${jobId}`}>
            <Button variant="ghost" className="w-full">{t('view_job')}</Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
