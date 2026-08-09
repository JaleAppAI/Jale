'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { ProgressRow } from '@/components/ui/progress-row';
import {
    ApiError,
    EMPLOYER_PRO_PLAN_CODE,
    clearIdempotencyKey,
    getBilling,
    getIdempotencyKey,
    isDefinitiveError,
    openBillingPortal,
    startCheckout,
} from '@/lib/api/employer';
import type { EmployerBilling } from '@/lib/api/employer';

export const dynamic = 'force-dynamic';

type BannerKind = 'success' | 'cancel' | null;

// Actions the checkout/portal error branch can resolve to. Kept separate from
// the raw error code so the UI copy stays stable even if the backend adds
// more specific provider codes later.
type ActionErrorKind = 'expired_session' | 'provider_unavailable' | 'provider_error' | 'generic';

// Subscription status enum from `subscriptions.status` (infra/db/migrations/034).
const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
    incomplete: 'status.incomplete',
    incomplete_expired: 'status.incomplete_expired',
    trialing: 'status.trialing',
    active: 'status.active',
    past_due: 'status.past_due',
    canceled: 'status.canceled',
    unpaid: 'status.unpaid',
    paused: 'status.paused',
};

/**
 * Dot colour per subscription status. The dot carries no information the
 * adjacent status text does not already carry (it is `aria-hidden`), so a
 * missing entry degrading to the muted ink tone is safe.
 */
const SUBSCRIPTION_STATUS_DOTS: Record<string, string> = {
    incomplete: 'bg-[var(--jale-warning)]',
    incomplete_expired: 'bg-[var(--jale-danger)]',
    trialing: 'bg-[var(--jale-blue-500)]',
    active: 'bg-[var(--jale-success)]',
    past_due: 'bg-[var(--jale-warning)]',
    canceled: 'bg-[var(--jale-danger)]',
    unpaid: 'bg-[var(--jale-danger)]',
    paused: 'bg-[var(--jale-ink-2)]',
};

function classifyActionError(err: unknown): ActionErrorKind {
    if (err instanceof ApiError) {
        if (err.status === 401) return 'expired_session';
        // 503 = provider_retryable (transient Stripe/5xx failure — safe to retry
        // with the same idempotency key). 502 = provider_error (terminal).
        if (err.status === 503) return 'provider_unavailable';
        if (err.status === 502) return 'provider_error';
    }
    return 'generic';
}

/** Medium-style date, locale-resolved by the runtime. */
function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

/**
 * One key/value field: label left (uppercase, tracked, muted), value right.
 * Rows stack with a dashed hairline between them; the last row drops its rule
 * so the stack never doubles up with the panel's own section divider.
 */
function KvRow({
    label,
    value,
    numeric = false,
}: {
    label: string;
    value: ReactNode;
    numeric?: boolean;
}) {
    return (
        <div className="flex items-baseline justify-between gap-4 border-b border-dashed border-[var(--jale-divider)] py-2.5 last:border-b-0">
            <span className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                {label}
            </span>
            <span
                className={`text-right text-sm font-medium text-[var(--jale-ink)] ${numeric ? 'tabular-nums' : ''}`}
            >
                {value}
            </span>
        </div>
    );
}

export default function EmployerBillingPage() {
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const searchParams = useSearchParams();
    const t = useTranslations('billing');

    const [checkoutBusy, setCheckoutBusy] = useState(false);
    const [portalBusy, setPortalBusy] = useState(false);
    const [actionError, setActionError] = useState<{ kind: ActionErrorKind; message: string } | null>(null);
    const [returnBannerDismissed, setReturnBannerDismissed] = useState(false);

    const {
        phase,
        data: billing,
        errorKind,
        retry,
    } = usePageData<EmployerBilling>({
        fetcher: ({ token, signal }) => getBilling(token, signal),
        legalReturnUrl: '/employer/billing',
        // Guards the (unlikely) `null` body: a rendered page with no billing
        // object is the empty state, never a crash on `billing.planCode`.
        isEmpty: (data) => !data,
    });

    const returnState: BannerKind = searchParams.get('billing') === 'success'
        ? 'success'
        : searchParams.get('billing') === 'cancel'
            ? 'cancel'
            : null;

    // Success/cancel return states are informational only — the webhook is the
    // source of truth for subscription state, so refetch rather than assume.
    useEffect(() => {
        if (returnState && idToken) retry();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [returnState, idToken]);

    async function handleUpgrade() {
        if (!idToken) return;
        setCheckoutBusy(true);
        setActionError(null);
        const origin = window.location.origin;
        const path = window.location.pathname;
        const body = {
            planCode: EMPLOYER_PRO_PLAN_CODE,
            successUrl: `${origin}${path}?billing=success`,
            cancelUrl: `${origin}${path}?billing=cancel`,
        };
        const idempotencyKey = getIdempotencyKey('billing-checkout', body);
        try {
            const session = await startCheckout(idToken, body, idempotencyKey);
            clearIdempotencyKey('billing-checkout');
            // Redirect only to the server-returned hosted URL — never construct one.
            window.location.href = session.url;
        } catch (err) {
            try {
                handleLegalWall(err, '/employer/billing');
            } catch {
                if (isDefinitiveError(err)) {
                    clearIdempotencyKey('billing-checkout');
                }
                const kind = classifyActionError(err);
                setActionError({ kind, message: t(`action_error.${kind}`) });
            }
            setCheckoutBusy(false);
        }
    }

    async function handleManage() {
        if (!idToken) return;
        setPortalBusy(true);
        setActionError(null);
        const origin = window.location.origin;
        const path = window.location.pathname;
        const returnUrl = `${origin}${path}`;
        const idempotencyKey = getIdempotencyKey('billing-portal', { returnUrl });
        try {
            const session = await openBillingPortal(idToken, returnUrl, idempotencyKey);
            clearIdempotencyKey('billing-portal');
            window.location.href = session.url;
        } catch (err) {
            try {
                handleLegalWall(err, '/employer/billing');
            } catch {
                if (isDefinitiveError(err)) {
                    clearIdempotencyKey('billing-portal');
                }
                const kind = classifyActionError(err);
                setActionError({ kind, message: t(`action_error.${kind}`) });
            }
            setPortalBusy(false);
        }
    }

    // "Manage" needs an existing Stripe customer (any subscription history, even
    // canceled) — the portal lets them resubscribe or review invoices. "Upgrade"
    // is offered whenever the employer isn't currently entitled to the paid
    // plan, independent of past subscription history.
    const canManage = !!billing?.subscription;
    const canUpgrade = billing ? billing.planCode !== EMPLOYER_PRO_PLAN_CODE : false;
    const usagePercent = billing && billing.activeJobLimit > 0
        ? Math.min(100, Math.round((billing.activeJobUsage / billing.activeJobLimit) * 100))
        : 0;

    const priceLabel = billing
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency: billing.currency.toUpperCase() })
            .format(billing.display_price_minor / 100)
        : null;

    // 'auth' means the token gate has not opened yet: nothing has been asked
    // for, so the page owes the reader a skeleton rather than an empty screen.
    const showSkeleton = phase === 'auth' || phase === 'loading';
    const showReturnBanner = returnState !== null && !returnBannerDismissed;
    const periodEnd = billing?.subscription?.current_period_end ?? null;
    const endsAtPeriodEnd = Boolean(billing?.subscription?.cancel_at_period_end);

    return (
        <AppShell role="employer" title={t('title')}>
            <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
                {showSkeleton ? (
                    /* Same archetype and geometry as `loading.tsx`, so the route-level
                       skeleton and this one are the same picture — the handover from
                       server render to client fetch costs no visible swap. */
                    <DetailPageSkeleton fields={4} />
                ) : (
                    <div className="anim-fade-in">
                        <div className="mb-5 lg:hidden">
                            <Link
                                href="/employer/dashboard"
                                className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] hover:underline"
                            >
                                {t('back_to_dashboard')}
                            </Link>
                        </div>

                        {showReturnBanner && (
                            <InlineFeedback
                                tone={returnState === 'success' ? 'success' : 'warning'}
                                onDismiss={() => setReturnBannerDismissed(true)}
                                className="mb-4"
                            >
                                {returnState === 'success'
                                    ? t('return_state.success')
                                    : t('return_state.cancel')}
                            </InlineFeedback>
                        )}

                        {phase === 'error' && errorKind ? (
                            <DashboardPanel>
                                <ErrorState
                                    kind={errorKind}
                                    onRetry={retry}
                                    // The 401 sentence this page has always shown; every
                                    // other kind keeps the app-wide copy.
                                    body={errorKind === 'unauthorized' ? t('expired_session') : undefined}
                                />
                            </DashboardPanel>
                        ) : !billing ? (
                            <DashboardPanel>
                                <EmptyState icon="chart" title={t('empty.title')} body={t('empty.body')} />
                            </DashboardPanel>
                        ) : (
                            <div className="space-y-5">
                                <DashboardPanel>
                                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                                                {t('current_plan.label')}
                                            </p>
                                            <h2 className="mt-1 text-xl font-extrabold text-[var(--jale-ink)]">
                                                {billing.planCode === EMPLOYER_PRO_PLAN_CODE
                                                    ? t('plan_name.employer_pro')
                                                    : t('plan_name.employer_free')}
                                            </h2>
                                        </div>
                                        {billing.subscription?.status && (
                                            <span className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--jale-ink-2)]">
                                                <span
                                                    aria-hidden
                                                    className={`h-2 w-2 shrink-0 rounded-full ${
                                                        SUBSCRIPTION_STATUS_DOTS[billing.subscription.status] ?? 'bg-[var(--jale-ink-2)]'
                                                    }`}
                                                />
                                                {t(SUBSCRIPTION_STATUS_KEYS[billing.subscription.status] ?? 'status.active')}
                                            </span>
                                        )}
                                    </div>

                                    <div className="border-b border-[var(--jale-divider)] px-5 py-4">
                                        <ProgressRow
                                            label={t('usage.label')}
                                            value={t('usage.value', {
                                                used: billing.activeJobUsage,
                                                limit: billing.activeJobLimit,
                                            })}
                                            percent={usagePercent}
                                        />
                                    </div>

                                    <div className="border-b border-[var(--jale-divider)] px-5 py-2">
                                        {priceLabel && (
                                            <KvRow
                                                label={t('current_plan.price_label')}
                                                value={t('current_plan.price', {
                                                    price: priceLabel,
                                                    interval: billing.billing_interval === 'year'
                                                        ? t('interval.year')
                                                        : t('interval.month'),
                                                })}
                                                numeric
                                            />
                                        )}
                                        {periodEnd && (
                                            <KvRow
                                                label={endsAtPeriodEnd
                                                    ? t('current_plan.ends_on')
                                                    : t('current_plan.renews_on')}
                                                value={formatDate(periodEnd)}
                                                numeric
                                            />
                                        )}
                                    </div>

                                    <div className="px-5 py-4">
                                        {billing.subscription?.status === 'past_due' && billing.subscription.grace_ends_at && (
                                            <InlineFeedback tone="warning" className="mb-4">
                                                {t('current_plan.grace_period', {
                                                    date: formatDate(billing.subscription.grace_ends_at),
                                                })}
                                            </InlineFeedback>
                                        )}

                                        <div className="flex flex-wrap gap-3">
                                            {canManage && (
                                                <Button
                                                    onClick={handleManage}
                                                    loading={portalBusy}
                                                    loadingLabel={t('actions.manage_loading')}
                                                >
                                                    {t('actions.manage')}
                                                </Button>
                                            )}
                                            {canUpgrade && (
                                                <Button
                                                    onClick={handleUpgrade}
                                                    loading={checkoutBusy}
                                                    loadingLabel={t('actions.upgrade_loading')}
                                                    variant="ghost"
                                                >
                                                    {t('actions.upgrade')}
                                                </Button>
                                            )}
                                        </div>

                                        {actionError && (
                                            <InlineFeedback tone="danger" className="mt-4">
                                                <span className="block">{actionError.message}</span>
                                                {actionError.kind === 'provider_unavailable' && (
                                                    <span className="mt-1 block text-xs font-semibold opacity-80">
                                                        {t('action_error.retry_safe')}
                                                    </span>
                                                )}
                                                {actionError.kind === 'expired_session' && (
                                                    <Link
                                                        href="/auth/employer"
                                                        className="mt-1 inline-block text-xs font-bold underline underline-offset-2"
                                                    >
                                                        {t('action_error.sign_in_again')}
                                                    </Link>
                                                )}
                                            </InlineFeedback>
                                        )}
                                    </div>
                                </DashboardPanel>

                                {canUpgrade && (
                                    <DashboardPanel>
                                        <div className="px-5 py-4">
                                            <h3 className="text-base font-bold text-[var(--jale-ink)]">
                                                {t('upgrade_panel.title')}
                                            </h3>
                                            <p className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
                                                {t('upgrade_panel.body')}
                                            </p>
                                            <Button
                                                onClick={handleUpgrade}
                                                loading={checkoutBusy}
                                                loadingLabel={t('actions.upgrade_loading')}
                                                className="mt-4"
                                            >
                                                {t('actions.upgrade')}
                                            </Button>
                                        </div>
                                    </DashboardPanel>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </AppShell>
    );
}
