'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { JobStatus } from '@/lib/status';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { Input } from '@/components/ui/input';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import { ApiError, shareEmployerJob, updateJobPublicListing } from '@/lib/api/employer';

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

/** How long "Copied!" stays on a copy control before reverting. */
const COPIED_RESET_MS = 2000;

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
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [loadingShare, setLoadingShare] = useState(false);
    const [copiedLink, setCopiedLink] = useState(false);
    const [generatingQr, setGeneratingQr] = useState(false);
    const [shareError, setShareError] = useState<string | null>(null);
    const [copiedFallback, setCopiedFallback] = useState(false);

    // One timer per copy control, cleared on unmount: a 2s timeout that fires
    // after the page has navigated away sets state on a dead component.
    const copiedLinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copiedFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (copiedLinkTimer.current) clearTimeout(copiedLinkTimer.current);
            if (copiedFallbackTimer.current) clearTimeout(copiedFallbackTimer.current);
        },
        [],
    );

    // Same origin as the app -- the public page lives on this domain, so no
    // config is needed and the link is correct in every environment.
    const fallbackUrl = publicCode
        ? typeof window !== 'undefined'
            ? `${window.location.origin}/j/${publicCode}`
            : `/j/${publicCode}`
        : null;

    const clearShareState = useCallback(() => {
        setShareUrl(null);
        setCopiedLink(false);
        setShareError(null);
    }, []);

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
                clearShareState();
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

    async function handleGetLink() {
        if (!idToken || loadingShare) return;
        setShareError(null);
        setLoadingShare(true);
        try {
            const result = await shareEmployerJob(idToken, jobId);
            setShareUrl(result.share_url);
        } catch (err) {
            const code = err instanceof ApiError ? err.code : null;
            if (code === 'share_url_misconfigured') {
                setShareError(t('error_misconfigured'));
            } else if (code === 'job_not_found') {
                // Public listing is opt-in (migration 057): the share endpoint 404s
                // for a job the employer has not published. Should be rare here
                // since this half only renders while enabled, but a concurrent
                // toggle-off elsewhere can still race it.
                setShareError(t('error_not_public'));
            } else {
                setShareError(errorMessage(err, { unknown: t('error_generic') }));
            }
        } finally {
            setLoadingShare(false);
        }
    }

    async function handleCopyLink() {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopiedLink(true);
            if (copiedLinkTimer.current) clearTimeout(copiedLinkTimer.current);
            copiedLinkTimer.current = setTimeout(() => setCopiedLink(false), COPIED_RESET_MS);
        } catch {
            // Clipboard can be unavailable (permissions, http); the URL is visible
            // as text either way, so failing quietly loses nothing.
        }
    }

    async function handleCopyFallback() {
        if (!fallbackUrl) return;
        try {
            await navigator.clipboard.writeText(fallbackUrl);
            setCopiedFallback(true);
            if (copiedFallbackTimer.current) clearTimeout(copiedFallbackTimer.current);
            copiedFallbackTimer.current = setTimeout(
                () => setCopiedFallback(false),
                COPIED_RESET_MS,
            );
        } catch {
            // Clipboard can be unavailable (permissions, http); the URL is visible
            // as text either way, so failing quietly loses nothing.
        }
    }

    async function handleDownloadQr() {
        if (!shareUrl || generatingQr) return;
        setShareError(null);
        setGeneratingQr(true);
        try {
            // Named import, not a default import: qrcode is a CommonJS package and
            // its default-export shape under @types/qrcode isn't guaranteed --
            // the named form works either way.
            const { toDataURL } = await import('qrcode');
            const dataUrl = await toDataURL(shareUrl, { width: 512, margin: 2 });
            const link = document.createElement('a');
            link.href = dataUrl;
            link.download = `jale-job-${jobId.slice(0, 8)}-qr.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch {
            setShareError(t('error_qr'));
        } finally {
            setGeneratingQr(false);
        }
    }

    const copyButtonClass = [
        'shrink-0 cursor-pointer rounded px-1 text-sm font-semibold',
        'text-[var(--jale-blue-700)] hover:underline',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
    ].join(' ');

    const linkRowClass = [
        'flex items-center gap-2 rounded-[var(--radius-input)]',
        'border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-3 py-2',
    ].join(' ');

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

                        {!shareUrl ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                loading={loadingShare}
                                loadingLabel={t('loading')}
                                onClick={handleGetLink}
                            >
                                {t('get_link')}
                            </Button>
                        ) : (
                            <div className="space-y-2">
                                <div className={linkRowClass}>
                                    <Input
                                        readOnly
                                        value={shareUrl}
                                        aria-label={t('title')}
                                        onFocus={(e) => e.currentTarget.select()}
                                        className="font-mono text-xs sm:text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleCopyLink}
                                        className={copyButtonClass}
                                    >
                                        {copiedLink ? t('copied') : t('copy_link')}
                                    </button>
                                </div>
                                <p className="text-xs text-[var(--jale-ink-2)]">
                                    {t('tracked_caption')}
                                </p>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    loading={generatingQr}
                                    loadingLabel={t('generating_qr')}
                                    onClick={handleDownloadQr}
                                >
                                    {t('download_qr')}
                                </Button>
                            </div>
                        )}

                        {shareError ? (
                            <InlineFeedback tone="danger" onDismiss={() => setShareError(null)}>
                                {shareError}
                            </InlineFeedback>
                        ) : null}

                        {/* No-link-on-share-failure fallback: the tracked-link fetch
                            above failed, but the employer still needs SOME link to
                            hand out. Only shown when the tracked link never came
                            through -- once shareUrl exists, the tracked link is the
                            only link shown. */}
                        {shareError && !shareUrl && fallbackUrl ? (
                            <div className="space-y-2">
                                <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                    {t('fallback_link_label')}
                                </p>
                                <div className={linkRowClass}>
                                    <Input
                                        readOnly
                                        value={fallbackUrl}
                                        aria-label={t('fallback_link_label')}
                                        onFocus={(e) => e.currentTarget.select()}
                                        className="font-mono text-xs sm:text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleCopyFallback}
                                        className={copyButtonClass}
                                    >
                                        {copiedFallback ? t('copied') : t('copy_link')}
                                    </button>
                                </div>
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
