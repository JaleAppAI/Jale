'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { applyIntent } from '@/lib/api/publicJob';

interface ApplyButtonProps {
  code: string;
}

/**
 * Suspense fallback for the primary CTA.
 *
 * `useSearchParams()` below opts this island out of the static render, so this
 * block is what the ISR HTML actually ships and what the visitor sees until
 * hydration. It traces `Button`'s `lg` size exactly (h-12, full width, pill),
 * so the real button lands in the space already reserved for it instead of
 * popping in and pushing the apply hint and secondary CTA down the page.
 */
export function ApplyButtonSkeleton() {
  return <Skeleton className="h-12 w-full rounded-full" />;
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
        variant="primary"
        size="lg"
        // Was `deep` (brand navy), which measured ~1.1:1 fill-vs-ground on the
        // dark page: readable label, invisible button. `primary` measures
        // 4.5:1 against that same ground -- clear of the 3:1 that WCAG 1.4.11
        // asks of a non-text boundary -- and already carries `--shadow-btn`,
        // so the manual elevation that used to draw the edge back is gone.
        className="w-full"
      >
        {t('apply_button')}
      </Button>
      {failed && (
        <p className="text-error text-sm text-center mt-2">{t('apply_error')}</p>
      )}
    </div>
  );
}
