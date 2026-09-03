'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { TerminalScreen } from '@/lib/application-requirements-flow';

/**
 * The three dead ends of `/worker/applications/[id]` (prototype W4e).
 *
 * One component for all three, because the shape is identical and only the
 * tone, the sentence and the way out differ -- three near-copies would drift
 * the first time one of them was reworded.
 *
 * EVERY ONE OFFERS A WAY OUT. The same rule `OnboardingFlow`'s exit panel
 * follows: a worker who lands here did so from a WhatsApp link or a bookmark,
 * and a screen that only says "nothing to do" with no navigation is a trap.
 * A closed job sends them to other jobs; the other two back to the job they
 * are still in the running for.
 *
 * `already_complete` is the only one in a success tone -- the worker finished,
 * they just finished somewhere else.
 */
export function RequirementsTerminalPanel({
  screen, companyName, jobId,
}: {
  screen: TerminalScreen;
  companyName?: string | null;
  jobId?: string | null;
}) {
  const t = useTranslations('worker_application_details.terminal');

  const tone = screen === 'already_complete' ? 'success' : screen === 'closed' ? 'warning' : 'info';
  // Only two of the three name the employer, and both have a fallback: an
  // orphaned job resolves `company_name` to null.
  const body = screen === 'closed'
    ? t('closed_body')
    : t(`${screen}_body`, { company: companyName ?? '' }).replace(/\s{2,}/g, ' ').trim();

  return (
    <div className="anim-fade-in grid gap-4">
      <InlineFeedback tone={tone}>{t(screen)}</InlineFeedback>
      <p className="text-sm text-[var(--jale-ink-2)]">{body}</p>

      {screen === 'closed' || !jobId ? (
        <Link href="/worker/home">
          <Button variant="secondary" className="w-full">{t('find_jobs')}</Button>
        </Link>
      ) : (
        <Link href={`/worker/jobs/${jobId}`}>
          <Button variant="secondary" className="w-full">{t('view_job')}</Button>
        </Link>
      )}
    </div>
  );
}
