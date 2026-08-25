'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { formatShortDate } from '@/lib/date';
import type { SubscriptionSignage } from '@/lib/plan-limit';

/**
 * The employer's billing-state banner: "you're on Free", or "your subscription
 * needs attention". Every decision -- which banner wins, whether a past_due
 * employer is still inside grace, which key each string comes from -- is made
 * by `subscriptionSignage`; this component only looks keys up and renders.
 *
 * Dismissal is SESSION storage, deliberately, not localStorage: a permanently
 * dismissed "your payment failed" warning is a support ticket. It comes back
 * next session, and `dismissKey` is keyed by the billing state, so a move from
 * past_due to canceled re-shows the banner within the same session too.
 */
function readDismissed(dismissKey: string | null): boolean {
  if (dismissKey === null || typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(dismissKey) === '1';
  } catch {
    // Private mode / storage disabled -- show the banner rather than crash.
    return false;
  }
}

export function SubscriptionBanner({
  signage,
  locale,
}: {
  signage: SubscriptionSignage;
  locale: string;
}) {
  const tBilling = useTranslations('billing');
  const dismissKey = signage?.dismissKey ?? null;
  // Seeded synchronously on first render, then re-read whenever the billing
  // state (and so the key) changes. Reading storage in the initializer is
  // hydration-safe HERE because this component only renders inside the
  // dashboard's client-only `ready` branch, which never exists in server HTML;
  // it is what stops a banner dismissed earlier in the session from painting
  // for a frame and then vanishing (a flash plus a layout shift on every visit).
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissKey));

  useEffect(() => {
    setDismissed(readDismissed(dismissKey));
  }, [dismissKey]);

  if (signage === null || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      if (dismissKey !== null) window.sessionStorage.setItem(dismissKey, '1');
    } catch {
      // Dismissal just does not survive the next page load. Not worth a crash.
    }
  }

  // `formatShortDate` returns null for an unparseable date, and next-intl
  // renders a null param as the literal "null" -- so both optional params
  // collapse to '' when they do not apply. The copy that interpolates them is
  // only ever selected when they do (`lapsed_body_grace` implies a grace date).
  const params = {
    ...signage.bodyParams,
    status: signage.statusKey ? tBilling(signage.statusKey) : '',
    date: signage.graceEndsAt ? formatShortDate(signage.graceEndsAt, locale) ?? '' : '',
  };

  return (
    <InlineFeedback tone={signage.tone} onDismiss={dismiss} className="mb-5">
      <span className="flex flex-col gap-1">
        <span className="font-bold">{tBilling(signage.titleKey)}</span>
        <span>{tBilling(signage.bodyKey, params)}</span>
        <Link
          href={signage.ctaHref}
          className="mt-1 inline-flex items-center gap-1.5 self-start text-xs font-bold underline underline-offset-2"
        >
          <Icon name="spark" />
          {tBilling(signage.ctaKey)}
        </Link>
      </span>
    </InlineFeedback>
  );
}
