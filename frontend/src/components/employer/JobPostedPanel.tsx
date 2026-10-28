'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { ShareLinkRow, useJobShareLink } from '@/components/employer/JobShareLink';
import { updateJobPublicListing } from '@/lib/api/employer';
import type { Job } from '@/lib/api/employer';
import { shiftPeriodLabels, type Translator } from '@/lib/job-detail-display';

/**
 * The wizard's last screen: the job is live, here is how to get it in front of
 * workers, and what happens after that.
 *
 * It renders inside `PostJobModal`'s own dialog, never a second one. A new job
 * is private (migration 057), so sharing starts with one tap that turns the
 * public listing on and then fetches the tracked link -- `createJob`'s answer
 * carries no public code to build a link from.
 */
/**
 * Why the ticked template was not saved while the job posted: the plan's
 * template cap (`limit`), a name the server found taken (a list gone stale
 * under a second tab), or any other failure of the template save.
 */
export type TemplateNotSaved =
    | { reason: 'limit'; limit: number }
    | { reason: 'name_taken' }
    | { reason: 'failed' };

export function JobPostedPanel({
    job,
    templateNotSaved,
    offerUpgrade = true,
    onNavigate,
}: {
    job: Job;
    /** The ticked template, when it was not saved; null when there is nothing to say. */
    templateNotSaved: TemplateNotSaved | null;
    /**
     * Whether the template-limit note links to Billing's upgrade (Phase 3:
     * `upgradeOffered` -- not for a foreman, nor for an owner already on Pro).
     * Defaults to Phase 2's always.
     */
    offerUpgrade?: boolean;
    /** Called before a link inside the panel navigates, so the dialog closes first. */
    onNavigate: () => void;
}) {
    const t = useTranslations('employer_dashboard');
    const tListing = useTranslations('employer_job_listing');
    const tCommon = useTranslations('common');
    const tBilling = useTranslations('billing');
    const { idToken } = useAuth();
    const errorMessage = useErrorMessage();
    const share = useJobShareLink(job.id);

    // A new job is always private (migration 057); this tracks the tap.
    const [listingOn, setListingOn] = useState(false);
    const [turningOn, setTurningOn] = useState(false);
    const [toggleError, setToggleError] = useState<string | null>(null);

    const shareHeadId = useId();
    const nextHeadId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    // The step form the focus was in is gone. Focus goes to the dialog itself,
    // which the Modal now names "Your job is posted", so that is what is read.
    useEffect(() => {
        rootRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    }, []);

    // The same widening adapter the job pages apply at this boundary.
    const tCommonDisplay: Translator = (key, values) =>
        (tCommon as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values);
    const summary = [job.title, job.location, shiftPeriodLabels(job, tCommonDisplay).join(', ')]
        .filter(Boolean)
        .join(' · ');

    /**
     * One tap: switch the listing on (unless an earlier tap already did), then
     * fetch the link. A failed switch leaves the job private and says so; a
     * failed fetch after a good switch only retries the fetch.
     */
    async function turnOn() {
        if (!idToken || turningOn) return;
        setToggleError(null);
        setTurningOn(true);
        try {
            if (!listingOn) {
                const result = await updateJobPublicListing(idToken, job.id, true);
                if (!result.public_listing_enabled) {
                    setToggleError(tListing('toggle_error'));
                    return;
                }
                setListingOn(true);
            }
            await share.fetchLink();
        } catch (err) {
            setToggleError(errorMessage(err, { unknown: tListing('toggle_error') }));
        } finally {
            setTurningOn(false);
        }
    }

    const failure = toggleError ?? share.error;

    return (
        <div ref={rootRef} className="space-y-5" data-guide="post.posted">
            <div className="flex flex-col items-center gap-2.5 text-center">
                <span
                    aria-hidden="true"
                    className="inline-flex size-14 items-center justify-center rounded-full bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]"
                >
                    <Icon name="check" />
                </span>
                <p className="text-base font-bold text-[var(--jale-ink)]">{summary}</p>
            </div>

            {templateNotSaved !== null ? (
                <InlineFeedback tone="warning" data-guide="post.template_not_saved">
                    <span className="block">
                        {templateNotSaved.reason === 'limit'
                            ? t('jobs.template_not_saved_after_post', { limit: templateNotSaved.limit })
                            : templateNotSaved.reason === 'name_taken'
                              ? t('jobs.template_not_saved_name_taken')
                              : t('jobs.template_not_saved_failed')}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Link
                            href="/employer/templates"
                            onClick={onNavigate}
                            className="inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                        >
                            {t('templates.manage_link')}
                        </Link>
                        {templateNotSaved.reason === 'limit' && offerUpgrade ? (
                            <Link
                                href="/employer/billing"
                                onClick={onNavigate}
                                className="inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                            >
                                <Icon name="spark" />
                                {tBilling('limit_reached.cta')}
                            </Link>
                        ) : null}
                    </span>
                </InlineFeedback>
            ) : null}

            <section aria-labelledby={shareHeadId} className="space-y-3 border-t border-[var(--jale-divider)] pt-4" data-guide="post.share">
                <h4 id={shareHeadId} className="text-base font-bold text-[var(--jale-ink)]">
                    {t('job_posted.share_head')}
                </h4>

                {share.shareUrl ? (
                    <>
                        <ShareLinkRow
                            url={share.shareUrl}
                            label={t('job_posted.link_label')}
                            copied={share.copied}
                            onCopy={() => void share.copyLink()}
                        />
                        <p className="text-sm text-[var(--jale-ink)]">{t('job_posted.crew')}</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            loading={share.generatingQr}
                            loadingLabel={tListing('generating_qr')}
                            onClick={() => void share.downloadQr()}
                        >
                            {tListing('download_qr')}
                        </Button>
                        <p className="text-xs text-[var(--jale-ink-2)]">{t('job_posted.off_note')}</p>
                    </>
                ) : (
                    <>
                        <p className="text-sm text-[var(--jale-ink-2)]">{t('job_posted.share_body')}</p>
                        <Button
                            type="button"
                            variant="primary"
                            loading={turningOn}
                            loadingLabel={tListing('loading')}
                            onClick={() => void turnOn()}
                            className="w-full"
                        >
                            {listingOn ? tListing('get_link') : t('job_posted.turn_on')}
                        </Button>
                    </>
                )}

                {failure ? (
                    <InlineFeedback
                        tone="danger"
                        onDismiss={() => {
                            setToggleError(null);
                            share.setError(null);
                        }}
                    >
                        {failure}
                    </InlineFeedback>
                ) : null}
            </section>

            <section aria-labelledby={nextHeadId} className="space-y-3 border-t border-[var(--jale-divider)] pt-4">
                <h4 id={nextHeadId} className="text-base font-bold text-[var(--jale-ink)]">
                    {t('job_posted.next_head')}
                </h4>
                <ol className="space-y-3">
                    {(['n1', 'n2', 'n3'] as const).map((key, index) => (
                        <li key={key} className="flex items-start gap-2.5">
                            <span
                                aria-hidden="true"
                                className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--jale-blue-50)] text-xs font-bold text-[var(--jale-blue-700)]"
                            >
                                {index + 1}
                            </span>
                            <span className="text-sm text-[var(--jale-ink)]">{t(`job_posted.${key}`)}</span>
                        </li>
                    ))}
                </ol>
            </section>
        </div>
    );
}

/**
 * The posted screen's footer: close the dialog, then go to the dashboard --
 * unless the dashboard is already the page behind it, which needs no second
 * history entry (its list already holds the new job).
 */
export function JobPostedFooter({ onClose }: { onClose: () => void }) {
    const t = useTranslations('employer_dashboard');
    const router = useRouter();
    const pathname = usePathname();
    return (
        <Button
            type="button"
            variant="outline"
            className="w-full"
            data-guide="post.back"
            onClick={() => {
                onClose();
                if (pathname !== '/employer/dashboard') router.push('/employer/dashboard');
            }}
        >
            {t('job_posted.back')}
        </Button>
    );
}
