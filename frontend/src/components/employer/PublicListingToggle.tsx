'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { updateJobPublicListing } from '@/lib/api/employer';

interface PublicListingToggleProps {
  jobId: string;
  /** The job's current opt-in state, from the detail fetch. */
  initialEnabled: boolean;
  /** The job's short public code -- what /j/{code} resolves. */
  publicCode: string;
}

// The employer's opt-IN to a public job page (migration 057). Jobs start
// private; nothing becomes publicly readable until the employer flips this.
// The copy leads with the benefit (reach) but must also state plainly what is
// shared -- consent that does not say what is shared is not consent.
export function PublicListingToggle({ jobId, initialEnabled, publicCode }: PublicListingToggleProps) {
  const t = useTranslations('employer_job_visibility');
  const { idToken } = useAuth();

  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Same origin as the app -- the public page lives on this domain, so no
  // config is needed and the link is correct in every environment.
  const publicUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/j/${publicCode}`
    : `/j/${publicCode}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http); the URL is visible
      // as text either way, so failing quietly loses nothing.
    }
  }

  async function handleToggle() {
    if (!idToken || saving) return;
    setErrorMsg(null);
    setSaving(true);
    const next = !enabled;
    try {
      const result = await updateJobPublicListing(idToken, jobId, next);
      // Trust the server's answer, not the optimistic value.
      setEnabled(result.public_listing_enabled);
    } catch {
      setErrorMsg(t('error'));
    } finally {
      setSaving(false);
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
      {enabled && (
        <div className="flex items-center gap-2 rounded-lg bg-gray-50 border px-3 py-2">
          <p className="text-xs text-muted-foreground shrink-0">{t('link_label')}</p>
          <p className="text-sm font-mono truncate flex-1" title={publicUrl}>{publicUrl}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-sm font-semibold text-blue-700 hover:text-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
      )}
      {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
    </div>
  );
}
