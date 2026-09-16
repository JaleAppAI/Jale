'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { TerminalScreen } from '@/lib/application-requirements-flow';

/**
 * The dead ends of `/worker/applications/[id]` (prototype W4e, extended
 * 2026-09-08 with the two application-level outcomes).
 *
 * One component for all of them, because the shape is identical and only the
 * tone, the sentence and the way out differ -- near-copies would drift the
 * first time one of them was reworded.
 *
 * EVERY ONE OFFERS A WAY OUT. The same rule `OnboardingFlow`'s exit panel
 * follows: a worker who lands here did so from a WhatsApp link or a bookmark,
 * and a screen that only says "nothing to do" with no navigation is a trap.
 * A closed job or an employer who moved on sends them to other jobs; a hire
 * sends them to their applications, where the celebration banner and the
 * job's details live; the two "nothing outstanding" screens send them back to
 * the job they are still in the running for.
 *
 * TONES: `hired` and `already_complete` are the success screens. `closed` is a
 * warning (the job is gone). `not_interested` and `not_requested` are plain
 * information -- an employer moving on is not an error the worker made.
 *
 * `closed` is the only screen whose sentence never names the employer; every
 * other body has a `_no_company` twin, because an orphaned job resolves
 * `company_name` to null and interpolating an empty string there leaves a
 * sentence with no subject.
 *
 * `companyName` is expected to have been through `lib/employer-name.ts`'s
 * `realCompanyName` already (the flow does it once, where the value enters the
 * tree): the API's raw `company_name` is `employer_display_name()`, which falls
 * back to the "Empleador" PLACEHOLDER, and "Empleador has it all." names a
 * company that does not exist. The twin sentences cover that case too.
 */
export function RequirementsTerminalPanel({
  screen, companyName, jobId,
}: {
  screen: TerminalScreen;
  companyName?: string | null;
  jobId?: string | null;
}) {
  const t = useTranslations('worker_application_details.terminal');

  const tone = screen === 'hired' || screen === 'already_complete'
    ? 'success'
    : screen === 'closed'
      ? 'warning'
      : 'info';
  const body = screen === 'closed'
    ? t('closed_body')
    : companyName
      ? t(`${screen}_body`, { company: companyName })
      : t(`${screen}_body_no_company`);

  return (
    <div className="anim-fade-in grid gap-4">
      <InlineFeedback tone={tone}>{t(screen)}</InlineFeedback>
      <p className="text-sm text-[var(--jale-ink-2)]">{body}</p>

      {screen === 'hired' ? (
        <Link href="/worker/applications">
          <Button variant="secondary" className="w-full">{t('view_applications')}</Button>
        </Link>
      ) : screen === 'closed' || screen === 'not_interested' || !jobId ? (
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
