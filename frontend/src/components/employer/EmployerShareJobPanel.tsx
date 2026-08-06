'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, shareEmployerJob } from '@/lib/api/employer';

interface EmployerShareJobPanelProps {
  jobId: string;
  publicListingEnabled: boolean;
  jobTitle: string;
}

// Mirrors the worker-side ShareJobPanel, but for employers: mints a
// trackable share_url via POST /employer/jobs/{jobId}/share -- distinct from
// the raw /j/{public_code} link PublicListingToggle already shows -- and
// offers a downloadable QR code for print use (job fairs, flyers). Requires
// the job's public-listing opt-in (migration 057); the share endpoint 404s
// (`job_not_found`) for a job that hasn't been published yet.
export function EmployerShareJobPanel({ jobId, publicListingEnabled, jobTitle }: EmployerShareJobPanelProps) {
  const t = useTranslations('employer_job_share');
  const { idToken } = useAuth();

  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generatingQr, setGeneratingQr] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!publicListingEnabled) {
    return <p className="text-xs text-muted-foreground">{t('disabled_hint')}</p>;
  }

  async function handleGetLink() {
    if (!idToken || loading) return;
    setErrorMsg(null);
    setLoading(true);
    try {
      const result = await shareEmployerJob(idToken, jobId);
      setShareUrl(result.share_url);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'share_url_misconfigured') {
        setErrorMsg(t('error_misconfigured'));
      } else if (err instanceof ApiError && err.code === 'job_not_found') {
        // Public listing is opt-in (migration 057): the share endpoint 404s
        // for a job the employer has not published. Should be rare here
        // since this panel is only rendered when publicListingEnabled is
        // true, but a concurrent toggle-off elsewhere can still race it.
        setErrorMsg(t('error_not_public'));
      } else {
        setErrorMsg(t('error_generic'));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http); the URL is visible
      // as text either way, so failing quietly loses nothing.
    }
  }

  async function handleDownloadQr() {
    if (!shareUrl || generatingQr) return;
    setErrorMsg(null);
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
      setErrorMsg(t('error_qr'));
    } finally {
      setGeneratingQr(false);
    }
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div>
        <h3 className="font-medium">{t('title')}</h3>
        <p className="text-sm text-muted-foreground">{t('subtitle', { jobTitle })}</p>
      </div>

      {!shareUrl ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={loading}
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
              onClick={handleCopy}
              className="shrink-0 text-sm font-semibold text-blue-700 hover:text-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {copied ? t('copied') : t('copy_link')}
            </button>
          </div>
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

      {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
    </div>
  );
}
