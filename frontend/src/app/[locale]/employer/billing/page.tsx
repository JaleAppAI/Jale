'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
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

export default function EmployerBillingPage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const searchParams = useSearchParams();
  const t = useTranslations('billing');
  const tCommon = useTranslations('common');

  const [billing, setBilling] = useState<EmployerBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [actionError, setActionError] = useState<{ kind: ActionErrorKind; message: string } | null>(null);

  const returnState: BannerKind = searchParams.get('billing') === 'success'
    ? 'success'
    : searchParams.get('billing') === 'cancel'
      ? 'cancel'
      : null;

  const refetch = useCallback(() => {
    if (!idToken) return;
    setLoading(true);
    setLoadError(null);
    getBilling(idToken)
      .then(setBilling)
      .catch((err) => {
        try {
          handleLegalWall(err, '/employer/billing');
        } catch {
          setLoadError(err instanceof ApiError && err.status === 401 ? t('expired_session') : tCommon('error'));
        }
      })
      .finally(() => setLoading(false));
  }, [handleLegalWall, idToken, t, tCommon]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Success/cancel return states are informational only — the webhook is the
  // source of truth for subscription state, so refetch rather than assume.
  useEffect(() => {
    if (returnState && idToken) refetch();
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

  return (
    <main className="min-h-screen bg-[#eef2f7] px-4 py-8 text-[var(--jale-ink)] md:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <Link href="/employer/dashboard" className="text-xs font-bold uppercase text-[var(--jale-ink-2)] hover:underline">
              {t('back_to_dashboard')}
            </Link>
            <h1 className="mt-2 text-2xl font-extrabold md:text-3xl">{t('title')}</h1>
          </div>
        </div>

        {returnState === 'success' && (
          <div className="mb-4 rounded-2xl border border-[var(--jale-success)]/30 bg-[var(--jale-success-bg)] p-4">
            <p className="text-sm font-semibold text-[#1f7a44]">{t('return_state.success')}</p>
          </div>
        )}
        {returnState === 'cancel' && (
          <div className="mb-4 rounded-2xl border border-[var(--jale-divider)] bg-white p-4">
            <p className="text-sm font-semibold text-[var(--jale-ink-2)]">{t('return_state.cancel')}</p>
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm font-semibold text-[var(--jale-ink-2)]">{tCommon('loading')}</p>
          </div>
        ) : loadError ? (
          <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm font-semibold text-[var(--jale-danger)]">{loadError}</p>
            <Button onClick={refetch} className="mt-4">{tCommon('retry')}</Button>
          </div>
        ) : billing ? (
          <div className="space-y-5">
            <section className="rounded-2xl border border-[var(--jale-divider)] bg-white p-5 shadow-[var(--shadow-card)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase text-[var(--jale-ink-2)]">{t('current_plan.label')}</p>
                  <h2 className="mt-1 text-xl font-extrabold">
                    {billing.planCode === 'employer_pro' ? t('plan_name.employer_pro') : t('plan_name.employer_free')}
                  </h2>
                  {priceLabel && (
                    <p className="mt-1 text-sm font-semibold text-[var(--jale-ink-2)]">
                      {t('current_plan.price', {
                        price: priceLabel,
                        interval: billing.billing_interval === 'year' ? t('interval.year') : t('interval.month'),
                      })}
                    </p>
                  )}
                </div>
                {billing.subscription?.status && (
                  <span className="rounded-full bg-[var(--jale-blue-50)] px-3 py-1 text-xs font-bold uppercase text-[var(--jale-blue-700)]">
                    {t(SUBSCRIPTION_STATUS_KEYS[billing.subscription.status] ?? 'status.active')}
                  </span>
                )}
              </div>

              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold">
                  <span>{t('usage.label')}</span>
                  <span className="opacity-70">
                    {t('usage.value', { used: billing.activeJobUsage, limit: billing.activeJobLimit })}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--jale-paper-2)]">
                  <div className="h-full rounded-full bg-[var(--jale-blue-500)]" style={{ width: `${usagePercent}%` }} />
                </div>
              </div>

              {billing.subscription?.cancel_at_period_end && billing.subscription.current_period_end && (
                <p className="mt-4 text-xs font-semibold text-[var(--jale-ink-2)]">
                  {t('current_plan.cancels_at', {
                    date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(billing.subscription.current_period_end)),
                  })}
                </p>
              )}
              {billing.subscription?.status === 'past_due' && billing.subscription.grace_ends_at && (
                <p className="mt-4 rounded-xl bg-[var(--jale-warning-bg)] p-3 text-xs font-semibold text-[#8a4400]">
                  {t('current_plan.grace_period', {
                    date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(billing.subscription.grace_ends_at)),
                  })}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                {canUpgrade && (
                  <Button onClick={handleUpgrade} loading={checkoutBusy} loadingLabel={t('actions.upgrade_loading')} className="h-12 px-6">
                    {t('actions.upgrade')}
                  </Button>
                )}
                {canManage && (
                  <Button onClick={handleManage} loading={portalBusy} loadingLabel={t('actions.manage_loading')} className="h-12 px-6" variant="outline">
                    {t('actions.manage')}
                  </Button>
                )}
              </div>

              {actionError && (
                <div className="mt-4 rounded-2xl border border-[var(--jale-danger)]/30 bg-[var(--jale-danger-bg)] p-4">
                  <p className="text-sm font-semibold text-[var(--jale-danger)]">{actionError.message}</p>
                  {(actionError.kind === 'provider_unavailable') && (
                    <p className="mt-1 text-xs font-semibold text-[var(--jale-ink-2)]">{t('action_error.retry_safe')}</p>
                  )}
                  {actionError.kind === 'expired_session' && (
                    <Link href="/auth/employer" className="mt-2 inline-block text-xs font-bold text-[var(--jale-blue-700)] hover:underline">
                      {t('action_error.sign_in_again')}
                    </Link>
                  )}
                </div>
              )}
            </section>

            {canUpgrade && (
              <section className="rounded-2xl border border-[var(--jale-divider)] bg-white p-5 shadow-[var(--shadow-card)]">
                <h3 className="text-base font-bold">{t('upgrade_panel.title')}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">{t('upgrade_panel.body')}</p>
                <Button onClick={handleUpgrade} loading={checkoutBusy} loadingLabel={t('actions.upgrade_loading')} className="mt-4">
                  {t('actions.upgrade')}
                </Button>
              </section>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--jale-divider)] bg-white p-8 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm font-bold">{t('empty.title')}</p>
            <p className="mt-2 text-sm text-[var(--jale-ink-2)]">{t('empty.body')}</p>
          </div>
        )}
      </div>
    </main>
  );
}
