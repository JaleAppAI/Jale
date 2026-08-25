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
export function SubscriptionBanner({
  signage,
  locale,
}: {
  signage: SubscriptionSignage;
  locale: string;
}) {
  const tBilling = useTranslations('billing');
  const dismissKey = signage?.dismissKey ?? null;
  const [dismissed, setDismissed] = useState(false);

  // Read AFTER mount, never during render: `sessionStorage` does not exist on
  // the server, and a render that read it would hydrate differently than the
  // HTML. Re-runs on `dismissKey`, so a new billing state starts undismissed.
  useEffect(() => {
    if (dismissKey === null) {
      setDismissed(false);
      return;
    }
    let stored = false;
    try {
      stored = window.sessionStorage.getItem(dismissKey) === '1';
    } catch {
      // Private mode / storage disabled -- show the banner rather than crash.
    }
    setDismissed(stored);
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
