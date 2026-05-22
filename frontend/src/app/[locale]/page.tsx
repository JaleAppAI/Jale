import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export default function Home() {
  const t = useTranslations();

  return (
    <div className="min-h-screen">
      <main className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-6">
        <div className="text-center max-w-2xl">
          {/* Eyebrow */}
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-widest bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)] mb-6">
            Blue-collar hiring, built for today
          </span>

          <h1
            className="font-bold tracking-tight leading-[1.15] mb-5"
            style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', color: 'var(--jale-ink)', letterSpacing: '-0.03em' }}
          >
            {t('landing.headline')}
          </h1>

          <p className="text-base md:text-lg leading-[1.65] mb-10" style={{ color: 'var(--jale-ink-2)' }}>
            {t('landing.subheadline')}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/auth/worker">
              <Button size="lg" className="w-full sm:w-auto px-8">
                {t('landing.worker_cta')}
              </Button>
            </Link>
            <Link href="/auth/employer">
              <Button size="lg" variant="outline" className="w-full sm:w-auto px-8">
                {t('landing.employer_cta')}
              </Button>
            </Link>
          </div>

          {/* Trust strip */}
          <div
            className="mt-14 grid grid-cols-3 gap-6 max-w-lg mx-auto"
            style={{ borderTop: '1px solid var(--jale-divider)', paddingTop: '2rem' }}
          >
            {[
              { value: '36h', label: 'Average time-to-hire' },
              { value: '2.4×', label: 'Faster than job boards' },
              { value: '98%', label: 'Doc verification rate' },
            ].map(({ value, label }) => (
              <div key={value} className="text-center">
                <div
                  className="font-bold leading-none mb-1"
                  style={{ fontSize: '1.6rem', letterSpacing: '-0.03em', color: 'var(--jale-blue-500)' }}
                >
                  {value}
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
