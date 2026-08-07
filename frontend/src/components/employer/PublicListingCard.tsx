'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, shareEmployerJob, updateJobPublicListing } from '@/lib/api/employer';

interface PublicListingCardProps {
  jobId: string;
  /** The job's current opt-in state, from the detail fetch. */
  initialEnabled: boolean;
  jobTitle: string;
}

// The employer's opt-IN to a public job page (migration 057), merged with the
// trackable share link + QR code that becomes available once a job is public.
// Jobs start private; nothing becomes publicly readable until the employer
// flips the toggle. The toggle copy leads with the benefit (reach) but must
// also state plainly what is shared -- consent that does not say what is
// shared is not consent.
//
// The bare /j/{public_code} URL is intentionally never shown here: the
// tracked share link minted by POST /employer/jobs/{jobId}/share is the only
// link an employer ever sees, so every open/signup can be credited to their
// business. The share half only renders once the toggle is on, and turning
// the toggle off clears any fetched share link so stale link UI can't linger.
export function PublicListingCard({ jobId, initialEnabled, jobTitle }: PublicListingCardProps) {
  const t = useTranslations('employer_job_listing');
  const { idToken } = useAuth();

  // Toggle half.
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Share half.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loadingShare, setLoadingShare] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [generatingQr, setGeneratingQr] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  function clearShareState() {
    setShareUrl(null);
    setCopiedLink(false);
    setShareError(null);
  }

  async function handleToggle() {
    if (!idToken || saving) return;
    setToggleError(null);
    setSaving(true);
    const next = !enabled;
    try {
      const result = await updateJobPublicListing(idToken, jobId, next);
      // Trust the server's answer, not the optimistic value.
      setEnabled(result.public_listing_enabled);
      if (!result.public_listing_enabled) {
        // Turning the listing off invalidates any share link fetched while
        // it was on -- clear it so stale link UI doesn't linger.
        clearShareState();
      }
    } catch {
      setToggleError(t('toggle_error'));
    } finally {
      setSaving(false);
    }
  }

  async function handleGetLink() {
    if (!idToken || loadingShare) return;
    setShareError(null);
    setLoadingShare(true);
    try {
      const result = await shareEmployerJob(idToken, jobId);
      setShareUrl(result.share_url);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'share_url_misconfigured') {
        setShareError(t('error_misconfigured'));
      } else if (err instanceof ApiError && err.code === 'job_not_found') {
        // Public listing is opt-in (migration 057): the share endpoint 404s
        // for a job the employer has not published. Should be rare here
        // since this half only renders while enabled, but a concurrent
        // toggle-off elsewhere can still race it.
        setShareError(t('error_not_public'));
      } else {
        setShareError(t('error_generic'));
      }
    } finally {
      setLoadingShare(false);
    }
  }

  async function handleCopyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http); the URL is visible
      // as text either way, so failing quietly loses nothing.
    }
  }

  async function handleDownloadQr() {
    if (!shareUrl || generatingQr) return;
    setShareError(null);
    setGeneratingQr(true);
    try {
      // Named import, not a default import: qrcode is a CommonJS package and
      // its default-export shape under @types/qrcode isn't guaranteed --
      // the named form works either way.
      const { toDataURL } = await import('qrcode');
      const dataUrl = await toDataURL(shareUrl, { width: 512, margin: 2 });
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `jale-job-${jobId.slice(0, 8)}-qr.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      setShareError(t('error_qr'));
    } finally {
      setGeneratingQr(false);
    }
  }

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('benefit')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={saving}
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-green-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t('shares')}</p>
      <p className={`text-sm ${enabled ? 'text-green-700' : 'text-gray-600'}`}>
        {enabled ? t('enabled') : t('disabled')}
      </p>
      {toggleError && <p className="text-sm text-red-600">{toggleError}</p>}

      {enabled && (
        <div className="space-y-3 border-t pt-3 mt-1">
          <p className="text-sm text-muted-foreground">{t('subtitle', { jobTitle })}</p>

          {!shareUrl ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={loadingShare}
              loadingLabel={t('loading')}
              onClick={handleGetLink}
            >
              {t('get_link')}
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg bg-gray-50 border px-3 py-2">
                <Input
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs sm:text-sm"
                />
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="shrink-0 text-sm font-semibold text-blue-700 hover:text-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {copiedLink ? t('copied') : t('copy_link')}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('tracked_caption')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={generatingQr}
                loadingLabel={t('generating_qr')}
                onClick={handleDownloadQr}
              >
                {t('download_qr')}
              </Button>
            </div>
          )}

          {shareError && <p className="text-sm text-red-600">{shareError}</p>}
        </div>
      )}
    </div>
  );
}
