'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Input } from '@/components/ui/input';
import { ApiError, shareEmployerJob } from '@/lib/api/employer';

/**
 * A job's tracked share link, its copy control and its QR download: the logic
 * the job page's `PublicListingCard` and the "Job posted" screen share.
 *
 * The link is minted by `POST /employer/jobs/{jobId}/share`, which only
 * answers for a job whose public listing is on (migration 057). Turning the
 * listing on is the caller's step; this owns what comes after it.
 */

/** How long "Copied" stays on a copy control before reverting. */
export const COPIED_RESET_MS = 2000;

/**
 * "Copied" feedback for one copy control: `copy(text)` writes to the clipboard
 * and flips `copied` for `COPIED_RESET_MS`. The timer is cleared on unmount, so
 * a copy made just before navigating away sets no state on a dead component.
 * A clipboard that refuses (permissions, http) fails quietly: the text is on
 * screen either way.
 */
export function useCopyFeedback() {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const copy = useCallback(async (text: string | null) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        } catch {
            // Clipboard unavailable; the link stays visible as text.
        }
    }, []);

    const reset = useCallback(() => setCopied(false), []);

    return { copied, copy, reset };
}

export function useJobShareLink(jobId: string) {
    const t = useTranslations('employer_job_listing');
    const { idToken } = useAuth();
    const errorMessage = useErrorMessage();

    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [generatingQr, setGeneratingQr] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const linkCopy = useCopyFeedback();

    /** Fetches the tracked link. Resolves to it, or to `null` with `error` set. */
    const fetchLink = useCallback(async (): Promise<string | null> => {
        if (!idToken) return null;
        setError(null);
        setLoading(true);
        try {
            const result = await shareEmployerJob(idToken, jobId);
            setShareUrl(result.share_url);
            return result.share_url;
        } catch (err) {
            const code = err instanceof ApiError ? err.code : null;
            if (code === 'share_url_misconfigured') {
                setError(t('error_misconfigured'));
            } else if (code === 'job_not_found') {
                // Public listing is opt-in (migration 057): the share endpoint
                // 404s for a job that is not public -- a concurrent toggle-off
                // elsewhere can race the fetch.
                setError(t('error_not_public'));
            } else {
                setError(errorMessage(err, { unknown: t('error_generic') }));
            }
            return null;
        } finally {
            setLoading(false);
        }
    }, [errorMessage, idToken, jobId, t]);

    /** Downloads a 512px PNG QR code of the tracked link. */
    const downloadQr = useCallback(async () => {
        if (!shareUrl || generatingQr) return;
        setError(null);
        setGeneratingQr(true);
        try {
            // Named import: qrcode is CommonJS and its default-export shape
            // under @types/qrcode is not guaranteed.
            const { toDataURL } = await import('qrcode');
            const dataUrl = await toDataURL(shareUrl, { width: 512, margin: 2 });
            const link = document.createElement('a');
            link.href = dataUrl;
            link.download = `jale-job-${jobId.slice(0, 8)}-qr.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch {
            setError(t('error_qr'));
        } finally {
            setGeneratingQr(false);
        }
    }, [generatingQr, jobId, shareUrl, t]);

    /** Forgets the link -- turning the listing off invalidates it. */
    const clear = useCallback(() => {
        setShareUrl(null);
        linkCopy.reset();
        setError(null);
    }, [linkCopy]);

    return {
        shareUrl,
        loading,
        generatingQr,
        error,
        setError,
        fetchLink,
        downloadQr,
        clear,
        copied: linkCopy.copied,
        copyLink: () => linkCopy.copy(shareUrl),
    };
}

/** A read-only link with its copy control, as the job page has always drawn it. */
export function ShareLinkRow({
    url,
    label,
    copied,
    onCopy,
}: {
    url: string;
    /** The input's accessible name. */
    label: string;
    copied: boolean;
    onCopy: () => void;
}) {
    const t = useTranslations('employer_job_listing');
    return (
        <div className="flex items-center gap-2 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-3 py-2">
            <Input
                readOnly
                value={url}
                aria-label={label}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs sm:text-sm"
            />
            <button
                type="button"
                onClick={onCopy}
                className="shrink-0 cursor-pointer rounded px-1 text-sm font-semibold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
                {copied ? t('copied') : t('copy_link')}
            </button>
        </div>
    );
}
