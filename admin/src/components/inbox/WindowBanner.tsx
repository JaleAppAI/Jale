import type { ReactNode } from 'react';
import { CircleAlert, Clock } from 'lucide-react';
import { TEMPLATE_REPLY_MAX_CHARS } from '@/lib/support-reply';
import { windowClosedRest } from './inbox-view';

const BANNER = 'flex items-start gap-2.5 rounded-[var(--radius-input)] px-3.5 py-3 text-sm leading-relaxed';

/**
 * The WhatsApp 24-hour window (FE-2 §4.2). `timing` is the live countdown
 * while open, or how long ago it closed. The icon and the words carry the
 * state, not the colour alone. `capSoon` is the last 30 minutes of an open
 * window, when the server caps replies at TEMPLATE_REPLY_MAX_CHARS: the copy
 * says so up front instead of the composer learning it from a refusal.
 */
export function WindowBanner({ open, languageLabel, timing, capSoon = false }: { open: boolean; languageLabel: string; timing: ReactNode | null; capSoon?: boolean }) {
  if (open) {
    return (
      <p className={`${BANNER} bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]`}>
        <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span><strong>{timing === null ? 'Chat window open.' : <>Chat window open · closes in {timing}.</>}</strong> {capSoon
          ? `Keep it under ${TEMPLATE_REPLY_MAX_CHARS} characters: if it doesn't reach them before the window closes, it goes inside the Jale Support template.`
          : 'Your reply is sent exactly as written.'}</span>
      </p>
    );
  }
  return (
    <p className={`${BANNER} bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)]`}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span><strong>{timing === null ? 'The 24-hour chat window is closed.' : <>The 24-hour chat window closed {timing}.</>}</strong> {windowClosedRest(languageLabel)}</span>
    </p>
  );
}
