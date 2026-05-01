'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { getApplications } from '@/lib/api/worker';
import type { Application } from '@/lib/api/worker';

export default function WorkerApplicationsPage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_applications');
  const tCommon = useTranslations('common');

  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!idToken) return;
    getApplications(idToken)
      .then((res) => setApps(res.applications))
      .catch((err) => {
        try { handleLegalWall(err, '/worker/applications'); }
        catch { setError(tCommon('error')); }
      })
      .finally(() => setLoading(false));
  }, [idToken]);

  if (error) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error}</p></main>;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-[1.4rem] md:text-[1.7rem] font-bold tracking-[-0.03em] leading-[1.2] mb-6">{t('title')}</h1>
      {loading ? (
        <p className="text-sm text-muted">{tCommon('loading')}</p>
      ) : apps.length === 0 ? (
        <div className="text-sm text-muted">
          <p className="mb-2">{t('empty')}</p>
          <Link href="/worker/home" className="text-blue-700 underline">{t('empty_cta')}</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {apps.map((a) => (
            <Link key={a.application_id} href={`/worker/jobs/${a.job_id}`} className="block">
              <Card className="p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-semibold">{a.job_title}</p>
                    <p className="text-xs text-muted-foreground">{a.company_name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('applied')}: {new Date(a.applied_at).toLocaleDateString()}</p>
                  </div>
                  <ApplicationStatusChip status={a.status} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
