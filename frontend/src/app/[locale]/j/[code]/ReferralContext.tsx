'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getReferrerContext, sendOpenBeacon } from '@/lib/api/publicJob';
import type { PublicJobReferrerContext } from '@/lib/api/publicJob';

interface ReferralContextProps {
  code: string;
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
 */
export function ReferralContext({ code }: ReferralContextProps) {
  const t = useTranslations('public_job');
  const searchParams = useSearchParams();
  const r = searchParams.get('r');
  const [ctx, setCtx] = useState<PublicJobReferrerContext | null>(null);
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
      });
    }

    return () => {
      ignore = true;
    };
  }, [code, r]);

  if (!ctx) return null;

  const message =
    ctx.kind === 'employer'
      ? t('referred_banner_employer')
      : ctx.first_name
        ? t('referred_banner_worker', { name: ctx.first_name })
        : t('referred_banner_worker_anonymous');

  return (
    <p className="flex items-center gap-2 bg-[var(--jale-teal-50)] text-[var(--jale-ink)] text-[13px] font-medium px-5 py-2.5 border-b border-[var(--jale-divider)]">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full bg-[var(--jale-teal-500)] shrink-0"
      />
      {message}
    </p>
  );
}
