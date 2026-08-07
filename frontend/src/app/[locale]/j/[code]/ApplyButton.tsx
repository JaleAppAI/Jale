'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { applyIntent } from '@/lib/api/publicJob';

interface ApplyButtonProps {
  code: string;
}

export function ApplyButton({ code }: ApplyButtonProps) {
  const t = useTranslations('public_job');
  const searchParams = useSearchParams();
  const shareCode = searchParams.get('r') ?? undefined;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleApply() {
    setFailed(false);
    setLoading(true);
    try {
      const { whatsappUrl } = await applyIntent(code, shareCode);
      window.location.href = whatsappUrl;
    } catch {
      setFailed(true);
      setLoading(false);
    }
    // Deliberately no `finally { setLoading(false) }`: on success the page is
    // navigating away to WhatsApp, and leaving the button in its loading
    // state during that handoff is preferable to a flash back to idle.
  }

  return (
    <div>
      <Button
        onClick={handleApply}
        loading={loading}
        loadingLabel={t('apply_loading')}
        variant="deep"
        size="lg"
        className="w-full rounded-xl"
      >
        {t('apply_button')}
      </Button>
      {failed && (
        <p className="text-error text-sm text-center mt-2">{t('apply_error')}</p>
      )}
    </div>
  );
}
