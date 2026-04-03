import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export default function Home() {
  const t = useTranslations();

  return (
    <div className="min-h-screen bg-background">
      <main className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] px-4">
        <div className="text-center max-w-2xl">
          <h1 className="text-4xl md:text-6xl font-bold mb-6">
            {t('landing.headline')}
          </h1>
          <p className="text-xl text-muted-foreground mb-10">
            {t('landing.subheadline')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/worker">
              <Button size="lg" className="w-full sm:w-auto">
                {t('landing.worker_cta')}
              </Button>
            </Link>
            <Link href="/auth/employer">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                {t('landing.employer_cta')}
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
