'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { durationText } from '@/lib/local-time';
import { TEMPLATE_CAP_LEAD_MS } from './inbox-view';

/**
 * Time left in the 24-hour window. The first render uses the page's own
 * "now", so it matches the server's HTML. After hydration it ticks every 30
 * seconds. The page refreshes once when it first crosses into the last 30
 * minutes (only if it was seen above that line on this page), so the banner and
 * composer pick up the 250-character cap, and once more at zero so the
 * composer switches to template mode.
 */
export function WindowCountdown({ closesAt, nowIso }: { closesAt: string; nowIso: string }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.parse(nowIso));
  const refreshed = useRef(false);
  const sawAboveBand = useRef(false);
  const crossedBand = useRef(false);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const left = Date.parse(closesAt) - now;
  const remaining = Number.isFinite(left) ? Math.max(0, left) : 0;

  useEffect(() => {
    if (remaining === 0 && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [remaining, router]);

  useEffect(() => {
    if (remaining > TEMPLATE_CAP_LEAD_MS) {
      sawAboveBand.current = true;
    } else if (sawAboveBand.current && !crossedBand.current) {
      crossedBand.current = true;
      router.refresh();
    }
  }, [remaining, router]);

  return <time dateTime={closesAt}>{durationText(remaining)}</time>;
}
