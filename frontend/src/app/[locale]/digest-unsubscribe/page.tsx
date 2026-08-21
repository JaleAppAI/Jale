'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineFeedback } from '@/components/ui/inline-feedback';

export const dynamic = 'force-dynamic';

/**
 * One-click unsubscribe for the employer daily-digest email.
 *
 * FULLY PUBLIC. It is reached from a link in an email, by someone who may not
 * be signed in (or may not be the account holder at all), so there is no
 * `useAuth`, no `useRequireAuth`, no `usePageData`, and no `Authorization`
 * header anywhere on this route. The bearer of the link is the `?token=` value
 * and nothing else; the backend is what decides whether it is still good.
 *
 * THE GET IS INERT. Loading this page unsubscribes nobody -- the POST happens
 * only on the button. Mail clients, link scanners, corporate security proxies
 * and preview fetchers all follow links in email without being asked, and a
 * page that acted on load would silently turn a scanner's crawl into an
 * employer's cancelled notifications. RFC 8058 one-click unsubscribe is a POST
 * for exactly this reason. `force-dynamic` for the same family of reasons the
 * other token routes use it: there is nothing here worth prerendering, and the
 * page reads a query parameter.
 *
 * The copy leaks nothing. A token that the backend rejects and a token that
 * never existed produce the same sentence, so this page cannot be used to
 * probe which tokens are real.
 *
 * Frame/column/card geometry is the `upload/[token]` route's, the other
 * anonymous token-link page in this app.
 */

const FRAME = 'min-h-[calc(100vh-3.5rem)] bg-[var(--jale-paper)] px-4 py-8';
const COLUMN = 'mx-auto w-full max-w-md anim-fade-in';

/**
 * `dead` is terminal: the server answered, and its answer was no. `retryable`
 * is not -- nobody's preferences changed, so the button stays.
 *
 * Keeping these apart matters for honesty in both directions. Calling a 503 or
 * a dropped connection "this link is no longer valid" tells an employer their
 * link is spent when it is not; calling a 400 `invalid_token` a temporary
 * glitch invites them to keep pressing a button that can never work.
 */
type Phase = 'idle' | 'submitting' | 'done' | 'dead';

export default function DigestUnsubscribePage() {
    const t = useTranslations('digest_unsubscribe');
    const tCommon = useTranslations('common');
    const searchParams = useSearchParams();
    const token = searchParams.get('token')?.trim() ?? '';

    // A missing or blank `?token=` starts dead: there is no request to make,
    // and offering a button that could only fail would be theatre.
    const [phase, setPhase] = useState<Phase>(token === '' ? 'dead' : 'idle');
    const [retryable, setRetryable] = useState<string | null>(null);

    async function handleUnsubscribe() {
        if (phase !== 'idle') return;
        setRetryable(null);
        setPhase('submitting');
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_BASE_URL}/public/employer-digest/unsubscribe`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                },
            );
            if (res.ok) {
                setPhase('done');
                return;
            }
            // These three, and only these three, mean the LINK is the problem:
            // unknown token, already spent, expired. Deliberately not the whole
            // 4xx range -- a 408 or 429 says nothing about the token, and
            // reporting it as "no longer valid" would be the same misreport
            // this branch exists to avoid for 5xx.
            //
            // The body is deliberately not read: the page has nothing to say
            // about `invalid_token` that it does not already say generically,
            // and echoing a server field is how detail leaks out.
            if (res.status === 400 || res.status === 401 || res.status === 410) {
                setPhase('dead');
                return;
            }
            setRetryable(tCommon('errors.server'));
            setPhase('idle');
        } catch {
            // `fetch` rejects when the request never reached the server. The
            // link is untouched, so this must not read as "no longer valid".
            setRetryable(tCommon('errors.offline'));
            setPhase('idle');
        }
    }

    return (
        <main className={FRAME}>
            <div className={COLUMN}>
                <Card className="space-y-4 p-6">
                    {phase === 'done' ? (
                        <>
                            <h1 className="text-lg font-extrabold text-[var(--jale-ink)]">
                                {t('success_title')}
                            </h1>
                            <p className="text-sm text-[var(--jale-ink-2)]">{t('success_body')}</p>
                            <p className="text-sm text-[var(--jale-ink-2)]">
                                {t('success_settings_hint')}
                            </p>
                        </>
                    ) : phase === 'dead' ? (
                        <>
                            <h1 className="text-lg font-extrabold text-[var(--jale-ink)]">
                                {t('error_title')}
                            </h1>
                            <p className="text-sm text-[var(--jale-ink-2)]">{t('error_body')}</p>
                        </>
                    ) : (
                        <>
                            <h1 className="text-lg font-extrabold text-[var(--jale-ink)]">
                                {t('title')}
                            </h1>
                            <p className="text-sm text-[var(--jale-ink-2)]">{t('body')}</p>

                            {retryable && (
                                <InlineFeedback tone="danger" onDismiss={() => setRetryable(null)}>
                                    {retryable}
                                </InlineFeedback>
                            )}

                            <Button
                                onClick={handleUnsubscribe}
                                loading={phase === 'submitting'}
                                loadingLabel={tCommon('loading')}
                            >
                                {t('button')}
                            </Button>
                        </>
                    )}
                </Card>
            </div>
        </main>
    );
}
