'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

// Catches anything getPublicJob() throws that is NOT a
// PublicJobNotFoundError (that case calls notFound() and never reaches this
// boundary). A 5xx from the API, a network failure, etc. land here instead of
// a blank/dead page.
export default function PublicJobError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('common');

  return (
    <div className="min-h-screen bg-[var(--jale-paper)] px-4 flex items-center justify-center">
      <div className="max-w-sm w-full mx-auto text-center">
        <p className="text-2xl font-bold text-[var(--jale-blue-900)] mb-4">Jale</p>
        <p className="text-sm text-error mb-4">{t('error')}</p>
        <Button onClick={reset} variant="outline">
          {t('retry')}
        </Button>
      </div>
    </div>
  );
}
