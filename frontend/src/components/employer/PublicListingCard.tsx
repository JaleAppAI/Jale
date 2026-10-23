'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { JobStatus } from '@/lib/status';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import { ShareLinkRow, useCopyFeedback, useJobShareLink } from '@/components/employer/JobShareLink';
import { updateJobPublicListing } from '@/lib/api/employer';

interface PublicListingCardProps {
    jobId: string;
    /** The job's current opt-in state, from the detail fetch. */
    initialEnabled: boolean;
    /**
     * The job's status from the detail fetch. When not 'active', the public
     * page serves a "no longer accepting applications" notice regardless of
     * the listing toggle (public-job.ts flattens every non-active status),
     * and this card must say so instead of implying the posting is live.
     */
    jobStatus: JobStatus;
    jobTitle: string;
    /**
     * The job's short public code (/j/{publicCode}). Optional so callers that
     * don't have it yet degrade gracefully, but in practice always passed --
     * it backs the untracked fallback link shown when the tracked share fetch
     * fails, so an employer is never left with literally no link to hand out.
     */
    publicCode?: string;
    /**
     * Reports the server's answer back to the page so the loaded job stays in
     * sync with what the toggle just did. Without it the page would keep
     * rendering the pre-toggle value and a reload would appear to undo the
     * employer's action.
     */
    onEnabledChange?: (enabled: boolean) => void;
}

// The employer's opt-IN to a public job page (migration 057), merged with the
// trackable share link + QR code that becomes available once a job is public.
// Jobs start private; nothing becomes publicly readable until the employer
// flips the toggle. The toggle copy leads with the benefit (reach) but must
// also state plainly what is shared -- consent that does not say what is
// shared is not consent.
//
// The bare /j/{public_code} URL is intentionally NOT shown as the primary
// link: the tracked share link minted by POST /employer/jobs/{jobId}/share is
// preferred whenever it's available, so opens/signups can be credited to the
// employer's business. But when that fetch FAILS (shareError set) and
// publicCode is known, the bare link is shown as a copyable fallback -- an
// employer must never be left with no link at all just because the tracking
// endpoint had a bad moment. The fallback is explicitly labeled untracked so
// it's never confused with the tracked link.
//
// PAINT NOTE: every colour here is a `--jale-*` token, so the card is correct
// in both themes without a single per-theme override. The switch in particular
// carries its state with a TOKEN pair (blue track + blue knob when on, paper /
// ink-2 when off) rather than the literal palette green/grey it used to: a
// hardcoded mid-green reads as a bright confetti chip against the dark theme's
// navy panels, and a light literal grey disappears into them entirely. Teal is
// reserved for referral attribution and is deliberately absent here.
//
// The share half (tracked link, copy, QR) lives in `JobShareLink`, shared with
// the "Job posted" screen; this card owns the switch.
export function PublicListingCard({
    jobId,
    initialEnabled,
    jobStatus,
    jobTitle,
    publicCode,
    onEnabledChange,
}: PublicListingCardProps) {
    const t = useTranslations('employer_job_listing');
    const { idToken } = useAuth();
    const errorMessage = useErrorMessage();

    // Toggle half.
    const [enabled, setEnabled] = useState(initialEnabled);
    const [saving, setSaving] = useState(false);
    const [toggleError, setToggleError] = useState<string | null>(null);

    // Share half.
    const share = useJobShareLink(jobId);
    const fallbackCopy = useCopyFeedback();

    // Same origin as the app -- the public page lives on this domain, so no
    // config is needed and the link is correct in every environment.
    const fallbackUrl = publicCode
        ? typeof window !== 'undefined'
            ? `${window.location.origin}/j/${publicCode}`
            : `/j/${publicCode}`
        : null;

    async function handleToggle() {
        if (!idToken || saving) return;
        setToggleError(null);
        setSaving(true);
        const next = !enabled;
        try {
            const result = await updateJobPublicListing(idToken, jobId, next);
            // Trust the server's answer, not the optimistic value.
            setEnabled(result.public_listing_enabled);
            onEnabledChange?.(result.public_listing_enabled);
            if (!result.public_listing_enabled) {
                // Turning the listing off invalidates any share link fetched while
                // it was on -- clear it so stale link UI doesn't linger.
                share.clear();
            }
        } catch (err) {
            // Never `err.message`. Classified copy for the failures that have a
            // better sentence than "could not update visibility" (offline,
            // timeout, server), and the domain line for anything unclassifiable.
            setToggleError(errorMessage(err, { unknown: t('toggle_error') }));
        } finally {
            setSaving(false);
        }
    }

    return (
        <DashboardPanel>
            <PanelHeader
                title={t('title')}
                action={
                    <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={t('title')}
                        disabled={saving}
                        onClick={handleToggle}
                        className={[
                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border',
                            'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            enabled
                                ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
                                : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
                        ].join(' ')}
                    >
                        <span
                            aria-hidden
                            className={[
                                'inline-block h-4 w-4 rounded-full transition-transform duration-150',
                                enabled
                                    ? 'translate-x-[1.4375rem] bg-[var(--jale-blue-500)]'
                                    : 'translate-x-[0.1875rem] bg-[var(--jale-ink-2)]',
                            ].join(' ')}
                        />
                    </button>
                }
            />

            <div className="space-y-3 px-5 py-4">
                <p className="text-sm text-[var(--jale-ink-2)]">{t('benefit')}</p>
                <p className="text-xs text-[var(--jale-ink-2)]">{t('shares')}</p>

                <Badge tone={enabled ? 'success' : 'neutral'}>
                    {enabled ? t('enabled') : t('disabled')}
                </Badge>

                {jobStatus !== 'active' ? (
                    <InlineFeedback tone="info">{t('closed_notice')}</InlineFeedback>
                ) : null}

                {toggleError ? (
                    <InlineFeedback tone="danger" onDismiss={() => setToggleError(null)}>
                        {toggleError}
                    </InlineFeedback>
                ) : null}

                {enabled ? (
                    <div className="space-y-3 border-t border-[var(--jale-divider)] pt-3">
                        <p className="text-sm text-[var(--jale-ink-2)]">
                            {t('subtitle', { jobTitle })}
                        </p>

                        {!share.shareUrl ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                loading={share.loading}
                                loadingLabel={t('loading')}
                                onClick={() => void share.fetchLink()}
                            >
                                {t('get_link')}
                            </Button>
                        ) : (
                            <div className="space-y-2">
                                <ShareLinkRow
                                    url={share.shareUrl}
                                    label={t('title')}
                                    copied={share.copied}
                                    onCopy={() => void share.copyLink()}
                                />
                                <p className="text-xs text-[var(--jale-ink-2)]">
                                    {t('tracked_caption')}
                                </p>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    loading={share.generatingQr}
                                    loadingLabel={t('generating_qr')}
                                    onClick={() => void share.downloadQr()}
                                >
                                    {t('download_qr')}
                                </Button>
                            </div>
                        )}

                        {share.error ? (
                            <InlineFeedback tone="danger" onDismiss={() => share.setError(null)}>
                                {share.error}
                            </InlineFeedback>
                        ) : null}

                        {/* No-link-on-share-failure fallback: the tracked-link fetch
                            above failed, but the employer still needs SOME link to
                            hand out. Only shown when the tracked link never came
                            through -- once shareUrl exists, the tracked link is the
                            only link shown. */}
                        {share.error && !share.shareUrl && fallbackUrl ? (
                            <div className="space-y-2">
                                <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                    {t('fallback_link_label')}
                                </p>
                                <ShareLinkRow
                                    url={fallbackUrl}
                                    label={t('fallback_link_label')}
                                    copied={fallbackCopy.copied}
                                    onCopy={() => void fallbackCopy.copy(fallbackUrl)}
                                />
                                <p className="text-xs text-[var(--jale-ink-2)]">
                                    {t('fallback_link_untracked')}
                                </p>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </DashboardPanel>
    );
}
