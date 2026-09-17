'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { accountKeyFromIdToken } from '@/lib/account-key';
import { formatShortDate } from '@/lib/date';
import { readSignageDismissed, writeSignageDismissed } from '@/lib/signage-storage';
import type { SubscriptionSignage } from '@/lib/plan-limit';

/**
 * The employer's billing-state banner: "you're on Free", or "your subscription
 * needs attention". Every decision -- which banner wins, whether a past_due
 * employer is still inside grace, which key each string comes from -- is made
 * by `subscriptionSignage`; this component only looks keys up and renders.
 *
 * A dismissal is remembered against two things, and `lib/signage-storage` owns
 * both: the billing STATE (`dismissKey`, so a move from past_due to canceled
 * re-shows the banner) and the ACCOUNT that dismissed it. The second one was
 * missing. Browser storage is per browser, not per account, and this product is
 * routinely used with more than one employer login on one machine -- so the
 * first employer's "I have read this" was hiding the free-plan signage from
 * every employer who signed in after them.
 */

function readDismissed(signage: SubscriptionSignage, account: string | null): boolean {
  if (signage === null) return false;
  return readSignageDismissed(signage.dismissKey, signage.variant, account);
}

export function SubscriptionBanner({
  signage,
  locale,
}: {
  signage: SubscriptionSignage;
  locale: string;
}) {
  const tBilling = useTranslations('billing');
  const { idToken } = useAuth();
  // Known by the time this renders: the banner only exists inside the
  // dashboard's `ready` branch, which the page cannot reach without a token.
  const account = accountKeyFromIdToken(idToken);
  // Seeded synchronously on first render, then re-read whenever the billing
  // state (and so the key) or the account changes. Reading storage in the
  // initializer is hydration-safe HERE because this component only renders
  // inside the dashboard's client-only `ready` branch, which never exists in
  // server HTML; it is what stops a banner dismissed earlier in the session
  // from painting for a frame and then vanishing (a flash plus a layout shift
  // on every visit).
  const [dismissed, setDismissed] = useState(() => readDismissed(signage, account));

  useEffect(() => {
    setDismissed(readDismissed(signage, account));
  }, [account, signage]);

  if (signage === null || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    if (signage !== null) writeSignageDismissed(signage.dismissKey, signage.variant, account);
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
