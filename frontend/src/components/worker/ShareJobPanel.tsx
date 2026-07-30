'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
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
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
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
      setErrorMsg(apiErr.code === 'share_url_misconfigured' ? t('error_misconfigured') : t('error_generic'));
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
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">{t('title')}</p>
        <p className="text-xs text-[var(--jale-ink-2)]">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUTTON_CHANNELS.map((channel) => (
          <Button
            key={channel}
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            loading={loadingChannel === channel}
            loadingLabel={channelLabel[channel]}
            onClick={() => handleShare(channel)}
          >
            {channelLabel[channel]}
          </Button>
        ))}
      </div>

      {canNativeShare && (
        <button
          type="button"
          onClick={() => handleShare('device_share')}
          disabled={loadingChannel === 'device_share'}
          className="text-sm font-semibold text-[var(--jale-blue-700)] underline disabled:opacity-50"
        >
          {channelLabel.device_share}
        </button>
      )}

      {errorMsg && <p className="text-error text-sm">{errorMsg}</p>}
    </div>
  );
}
