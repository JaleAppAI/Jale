'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { getReferrerContext, sendOpenBeacon } from '@/lib/api/publicJob';
import type { PublicJobReferrerContext } from '@/lib/api/publicJob';

interface ReferralContextProps {
  code: string;
}

/**
 * Geometry shared by the real ribbon and its skeleton, so the two are the same
 * height by construction rather than by two independent guesses. `min-h` is
 * explicit because the skeleton has no text to establish a line box, and a
 * ribbon that grows when the copy arrives is exactly the shift the skeleton
 * exists to prevent.
 */
const RIBBON_SHELL =
  'flex min-h-[41px] items-center gap-2 border-b border-[var(--jale-divider)] px-5 py-2.5 text-[13px] font-medium';

/**
 * Suspense fallback for the ribbon slot, and the island's own pre-resolution
 * state.
 *
 * Both matter, because this island resolves in two steps. `useSearchParams()`
 * opts the component out of the static render, so the fallback is what gets
 * baked into the ISR HTML; then hydration runs, and only after a network round
 * trip does `getReferrerContext` say whether there is an attribution to show.
 * Rendering this same block in the fallback AND while the lookup is in flight
 * makes the referred path -- the one where a ribbon actually appears, and the
 * page's primary audience -- shift-free end to end.
 *
 * Deliberately NOT teal: teal is the mark of a confirmed referral, so an
 * unresolved slot stays neutral paper. The colour only arrives with the fact.
 */
export function ReferralRibbonSkeleton() {
  return (
    <div className={`${RIBBON_SHELL} bg-[var(--jale-paper-2)]`} aria-hidden>
      <Skeleton tone="divider" className="size-2 rounded-full" />
      <Skeleton tone="divider" className="h-3 w-44 max-w-[60%]" />
    </div>
  );
}

/**
 * Records the page-open beacon and, when the visit carries a `?r=` share
 * tag, resolves and renders who shared the link. Teal marks the referral
 * thread and is used nowhere else on the page.
 *
 * The `useRef` guard + local `ignore` flag mirror the fire-once effect idiom
 * in worker/home's job-list effect: the ref stops the beacon/fetch from
 * firing twice (e.g. React StrictMode's double-invoke in dev), and `ignore`
 * stops a state update from a stale/in-flight request racing a later one.
 *
 * Three render states, in the order a referred visitor meets them:
 *   `?r=` present, lookup unresolved -> the skeleton above (holds the space)
 *   `?r=` present, lookup resolved   -> the teal ribbon
 *   no `?r=`, or the lookup found nothing -> nothing at all
 * The last case is the one place a shift remains: the baked-in fallback
 * collapses at hydration for a visitor who arrived without a share tag. That
 * is the accepted trade for holding the space on the referred path, and it
 * resolves at hydration rather than after a network call.
 */
export function ReferralContext({ code }: ReferralContextProps) {
  const t = useTranslations('public_job');
  const searchParams = useSearchParams();
  const r = searchParams.get('r');
  const [ctx, setCtx] = useState<PublicJobReferrerContext | null>(null);
  const [resolved, setResolved] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    let ignore = false;

    sendOpenBeacon(code, r ?? null);

    if (r) {
      getReferrerContext(code, r).then((result) => {
        if (ignore) return;
        setCtx(result);
        setResolved(true);
      });
    }

    return () => {
      ignore = true;
    };
  }, [code, r]);

  if (!ctx) {
    // Only a visit that carries a share tag can ever produce a ribbon, so only
    // that visit is worth holding space for.
    return r && !resolved ? <ReferralRibbonSkeleton /> : null;
  }

  const message =
    ctx.kind === 'employer'
      ? t('referred_banner_employer')
      : ctx.first_name
        ? t('referred_banner_worker', { name: ctx.first_name })
        : t('referred_banner_worker_anonymous');

  return (
    <p className={`${RIBBON_SHELL} anim-fade-in bg-[var(--jale-teal-50)] text-[var(--jale-ink)]`}>
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full bg-[var(--jale-teal-500)] shrink-0"
      />
      {message}
    </p>
  );
}
