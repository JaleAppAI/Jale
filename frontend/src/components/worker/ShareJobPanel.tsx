'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { shareJob } from '@/lib/api/worker';
import type { ShareChannel, WorkerApiError } from '@/lib/api/worker';

interface ShareJobPanelProps {
  jobId: string;
}

// A phone never tells us which app a link was shared to -- iOS and Android
// both keep that private. So we ask: each button below mints its OWN
// share_url for its own channel first, then hands off to that channel. Never
// mint one link and reuse it across buttons -- the per-channel call is the
// only thing that makes the resulting attribution data meaningful.
const BUTTON_CHANNELS: ShareChannel[] = ['whatsapp', 'sms', 'facebook', 'copy_link'];

/**
 * How long "Copied!" stays on the button. Long enough to be read on a phone
 * mid-scroll, short enough that the button does not look stuck in a state.
 */
const COPIED_RESET_MS = 3000;

/**
 * Deliberately NOT teal. Teal is the mark of a CONFIRMED referral (the ribbon
 * on /j/[code]); this panel only mints the link, so painting it teal would
 * promise attribution that has not happened yet.
 */
export function ShareJobPanel({ jobId }: ShareJobPanelProps) {
  const t = useTranslations('job_share');
  const { idToken } = useAuth();

  const [loadingChannel, setLoadingChannel] = useState<ShareChannel | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  // navigator.share is browser/OS-dependent; check after mount so we never
  // render a "More..." button that would do nothing (desktop browsers,
  // older mobile browsers).
  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  // Held in a ref so a second copy restarts the countdown instead of stacking
  // timers, and so an unmount mid-countdown cannot setState on a dead component.
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  function flashCopied() {
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, COPIED_RESET_MS);
  }

  async function handleShare(channel: ShareChannel) {
    if (!idToken || loadingChannel) return;
    setErrorMsg(null);
    setLoadingChannel(channel);
    try {
      const { share_url } = await shareJob(idToken, jobId, channel);

      switch (channel) {
        case 'whatsapp':
          window.location.href = `https://wa.me/?text=${encodeURIComponent(share_url)}`;
          break;
        case 'sms': {
          const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
          window.location.href = `sms:${isIOS ? '&' : '?'}body=${encodeURIComponent(share_url)}`;
          break;
        }
        case 'facebook':
          // Not window.open(): by the time this async handler resumes after
          // the await above, we're outside the original click's user-gesture
          // context, so mobile Safari/Android popup blockers can silently
          // swallow window.open here. A location handoff isn't subject to
          // that, matching the whatsapp/sms cases above.
          window.location.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(share_url)}`;
          break;
        case 'copy_link':
          await navigator.clipboard.writeText(share_url);
          flashCopied();
          break;
        case 'device_share':
          if (navigator.share) {
            try {
              await navigator.share({ url: share_url });
            } catch {
              // User dismissed the native share sheet -- not an error.
            }
          }
          break;
      }
    } catch (err) {
      const apiErr = err as WorkerApiError;
      if (apiErr.code === 'share_url_misconfigured') {
        setErrorMsg(t('error_misconfigured'));
      } else if (apiErr.code === 'job_not_found') {
        // Public listing is opt-in (migration 057): the share endpoint 404s
        // for a job the employer has not published. To the worker that is
        // "not shareable yet", not a malfunction.
        setErrorMsg(t('error_not_public'));
      } else {
        setErrorMsg(t('error_generic'));
      }
    } finally {
      setLoadingChannel(null);
    }
  }

  const channelLabel: Record<ShareChannel, string> = {
    whatsapp: t('whatsapp'),
    sms: t('sms'),
    facebook: t('facebook'),
    copy_link: copied ? t('copied') : t('copy_link'),
    device_share: t('more'),
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-bold text-[var(--jale-ink)]">{t('title')}</p>
        <p className="mt-0.5 text-xs text-[var(--jale-ink-2)]">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUTTON_CHANNELS.map((channel) => {
          const confirmed = channel === 'copy_link' && copied;
          return (
            <Button
              key={channel}
              type="button"
              // The confirmed copy tints itself rather than swapping in a
              // separate banner: the state belongs to the button that caused it.
              variant={confirmed ? 'secondary' : 'outline'}
              size="sm"
              loading={loadingChannel === channel}
              loadingLabel={channelLabel[channel]}
              onClick={() => handleShare(channel)}
            >
              {channelLabel[channel]}
            </Button>
          );
        })}
      </div>

      {/* The copy confirmation is a label swap, which assistive tech would not
          otherwise announce. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('copied') : ''}
      </span>

      {canNativeShare && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={loadingChannel === 'device_share'}
          loadingLabel={channelLabel.device_share}
          onClick={() => handleShare('device_share')}
        >
          {channelLabel.device_share}
        </Button>
      )}

      {errorMsg && <InlineFeedback tone="danger">{errorMsg}</InlineFeedback>}
    </div>
  );
}
