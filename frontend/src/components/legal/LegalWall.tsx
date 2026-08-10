'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch } from '@/lib/api';
import { parseApiError } from '@/lib/api/errors';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

interface TosData {
    version: string;
    tosUrl: string;
    privacyUrl: string;
}

/**
 * Centering frame, shared verbatim with `app/[locale]/legal/accept/loading.tsx`
 * so the route skeleton, the in-page skeleton and the real card all land in the
 * same place. It subtracts the 3.5rem global `Header`, which this route keeps.
 */
const FRAME = 'flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6';

/**
 * `CenteredCardSkeleton` draws a `max-w-md` card, so the real card matches it.
 * (It was `max-w-lg`, which made the card jump wider the moment the terms
 * arrived — exactly the shift the archetype skeletons exist to prevent.)
 */
const CARD_WIDTH = 'w-full max-w-md';

export default function LegalWall() {
    const t = useTranslations('legal');
    const tCommon = useTranslations('common');
    const errorMessage = useErrorMessage();
    const router = useRouter();
    const { idToken } = useAuth();

    const [checked, setChecked] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    /*
     * The return-URL handoff is the one piece of state this screen holds on
     * another page's behalf, and `usePageData` writes to the same key when it
     * meets a legal wall (`handleLegalWall` stores the return URL and bounces
     * to /legal/accept — here, the page we are already on).
     *
     * `/legal/tos` is public and un-gated, so that branch is unreachable today.
     * Feeding the STORED value back in as `legalReturnUrl` makes it harmless if
     * that ever changes: the handler would rewrite the key with the value it
     * already had instead of overwriting the user's real destination with
     * `/legal/accept` and stranding them here after accepting.
     *
     * Read once, lazily, and never during SSR (`sessionStorage` does not exist
     * on the server, and can throw outright in some privacy modes).
     */
    const [storedReturnUrl] = useState<string | undefined>(() => {
        if (typeof window === 'undefined') return undefined;
        try {
            return sessionStorage.getItem('legalReturnUrl') ?? undefined;
        } catch {
            return undefined;
        }
    });

    const {
        phase,
        data: tosData,
        errorKind,
        retry,
    } = usePageData<TosData>({
        fetcher: async ({ token, signal }) => {
            const res = await apiFetch('/legal/tos', { signal }, token);
            // Typed so the kind survives to the UI. The old
            // `throw new Error('Failed to fetch')` collapsed every failure into
            // one sentence, so a phone with no signal and a broken backend were
            // indistinguishable — and only one of them is worth retrying.
            if (!res.ok) throw await parseApiError(res, 'fetch_failed');
            return res.json();
        },
        requireAuth: true,
        legalReturnUrl: storedReturnUrl,
    });

    /*
     * ACCEPT PATH — behaviourally frozen.
     *
     * The POST, its `tosVersion` payload, the `legalReturnUrl` read/remove and
     * the `router.replace(returnUrl)` below are byte-for-byte what they were.
     * This gates the whole authenticated app; only the two ERROR surfaces
     * changed (a typed throw, and a translated message instead of a boolean).
     */
    const handleAccept = async () => {
        if (!tosData || !checked) return;
        setSubmitError('');
        setIsSubmitting(true);
        try {
            const res = await apiFetch(
                '/legal/accept',
                { method: 'POST', body: JSON.stringify({ tosVersion: tosData.version }) },
                idToken ?? undefined
            );
            if (!res.ok) throw await parseApiError(res, 'accept_failed');
            const returnUrl = sessionStorage.getItem('legalReturnUrl') ?? '/';
            sessionStorage.removeItem('legalReturnUrl');
            router.replace(returnUrl);
        } catch (err) {
            // `error_submit` stays the wording for anything unclassifiable, so
            // the copy this screen has always shown is still what most failures
            // read as; a recognised kind now says something more useful.
            setSubmitError(errorMessage(err, { unknown: t('error_submit') }));
        } finally {
            setIsSubmitting(false);
        }
    };

    /* ===== S1 — auth gate + first load ==================================== */

    // 'auth' means the token gate has not opened yet: nothing has been asked
    // for, so this owes the reader a skeleton rather than a blank screen.
    if (phase === 'auth' || phase === 'loading') {
        return (
            <main className={FRAME}>
                <CenteredCardSkeleton title />
            </main>
        );
    }

    /* ===== S5 — the terms could not be loaded ============================= */

    if (phase === 'error' && errorKind) {
        return (
            <main className={FRAME}>
                <Card className={`${CARD_WIDTH} anim-fade-in p-2`}>
                    <ErrorState kind={errorKind} onRetry={retry} />
                </Card>
            </main>
        );
    }

    // `usePageData` cannot report 'ready' without data, but the render path is
    // typed on `tosData` being present, so this stays as the explicit guard.
    if (!tosData) {
        return (
            <main className={FRAME}>
                <CenteredCardSkeleton title />
            </main>
        );
    }

    /* ===== S2 — the wall itself =========================================== */

    return (
        <main className={FRAME}>
            <Card className={`${CARD_WIDTH} anim-fade-in space-y-6 p-8 md:p-10`}>
                <div>
                    <h1 className="mb-2 text-xl font-extrabold leading-[1.3] tracking-[-0.02em] text-[var(--jale-ink)]">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-[var(--jale-ink-2)]">{t('body')}</p>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                    <a href={tosData.tosUrl} target="_blank" rel="noopener noreferrer"
                        className="font-semibold text-[var(--jale-blue-700)] underline underline-offset-4 transition-colors duration-200 hover:text-[var(--jale-blue-500)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
                        {t('tos_link')}
                    </a>
                    <a href={tosData.privacyUrl} target="_blank" rel="noopener noreferrer"
                        className="font-semibold text-[var(--jale-blue-700)] underline underline-offset-4 transition-colors duration-200 hover:text-[var(--jale-blue-500)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
                        {t('privacy_link')}
                    </a>
                </div>

                <label className="flex cursor-pointer items-start gap-3">
                    <input
                        type="checkbox"
                        id="legal-checkbox"
                        checked={checked}
                        onChange={(e) => setChecked(e.target.checked)}
                        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[var(--jale-blue-500)]"
                    />
                    <span className="text-sm text-[var(--jale-ink)]">{t('checkbox')}</span>
                </label>

                {submitError ? (
                    <InlineFeedback tone="danger" onDismiss={() => setSubmitError('')}>
                        {submitError}
                    </InlineFeedback>
                ) : null}

                <Button className="w-full" onClick={handleAccept} disabled={!checked} loading={isSubmitting} loadingLabel={tCommon('loading')}>
                    {t('accept_cta')}
                </Button>
            </Card>
        </main>
    );
}
