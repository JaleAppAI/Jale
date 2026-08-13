'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { getPayReference, type PayReferenceResponse } from '@/lib/api/payReference';
import { TRADE_CATEGORIES } from '@/lib/job-form';
import { formatPayReference, type PayReferenceVariant } from '@/lib/pay-reference-format';

interface PayReferenceHintProps {
  trade: string;
  cityKey: string | null | undefined;
  /** Which surface is mounting this -- only tweaks the lead-in copy.
   *  Defaults to the employer "starting point" framing. */
  variant?: PayReferenceVariant;
}

/** Every value the `trade` prop can validly ask `/pay-reference` about.
 *  `'other'` is excluded separately below -- it is a valid trade_category,
 *  but the backend has no reference row for it (404 `no_reference`), so
 *  there is no point round-tripping a request that can only ever fail. */
const VALID_TRADES = new Set<string>(TRADE_CATEGORIES);

/**
 * A small, quiet "typically earn $X–$Y/hr" reference, sourced from BLS OEWS
 * data via `GET /pay-reference`. Mounted on every surface that has both a
 * trade and a city to ask about: the employer job-creation forms
 * (`JobFormFields`, `PostJobModal`), the worker profile page (near preferred
 * cities), and the worker job detail page (under the pay headline).
 *
 * Host-agnostic like `DescriptionHelper`: it takes the trade/city it needs
 * and renders itself, nothing more. UX RULE, non-negotiable: a missing
 * reference (404) or ANY other failure means this renders NOTHING -- never
 * an error state, never a loading spinner that blocks the surrounding form.
 * Idle/absent inputs (no trade, no city, an invalid or `'other'` trade) are
 * the same as "no data yet": render null and do not fetch.
 */
export function PayReferenceHint({ trade, cityKey, variant = 'employer' }: PayReferenceHintProps) {
  const { idToken } = useAuth();
  const t = useTranslations('pay');
  const tTrade = useTranslations('employer_dashboard');

  const [reference, setReference] = useState<PayReferenceResponse | null>(null);

  const canFetch = Boolean(idToken) && Boolean(cityKey) && trade !== '' && VALID_TRADES.has(trade);

  useEffect(() => {
    // A prop change while a previous answer is showing (e.g. the employer
    // switches trade) must drop the stale reference immediately -- it no
    // longer describes what's on screen.
    setReference(null);
    if (!canFetch || !idToken || !cityKey) return;

    const controller = new AbortController();
    getPayReference(idToken, trade, cityKey, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setReference(res);
      })
      .catch(() => {
        // 404 no_reference, 400, 401, network -- all of it means "don't
        // render", never an error banner blocking the form around this.
      });
    return () => controller.abort();
  }, [idToken, trade, cityKey, canFetch]);

  if (!reference) return null;

  // `employer_dashboard.modal.trade.*` is the one catalogue covering the
  // full trade_category set (including `drywall`/`general_labor`, which
  // `common.trades.*` / `lib/trades.ts` do not) -- see pay-reference-format.ts.
  const tradeLabel = tTrade(`modal.trade.${reference.trade_category}`);
  const { headline, source } = formatPayReference(reference, t, tradeLabel, variant);

  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-[var(--jale-ink-2)]">{headline}</p>
      <p className="text-xs text-[var(--jale-ink-2)]">{source}</p>
    </div>
  );
}
