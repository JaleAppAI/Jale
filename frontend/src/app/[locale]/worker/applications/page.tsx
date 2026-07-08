'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { MetricCard } from '@/components/ui/metric-card';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { getApplications } from '@/lib/api/worker';
import type { Application } from '@/lib/api/worker';
import { normalizeApplicationStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

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

  if (error) {
    return (
      <AppShell role="worker" title={t('title')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
          <p className="text-sm text-error">{error}</p>
        </main>
      </AppShell>
    );
  }

  // Derived from the already-fetched list: terminal statuses are hired /
  // not_interested (legacy values normalize onto them); everything else is active.
  const normalizedStatuses = apps.map((a) => normalizeApplicationStatus(a.status));
  const totalCount = apps.length;
  const hiredCount = normalizedStatuses.filter((s) => s === 'hired').length;
  const activeCount = normalizedStatuses.filter((s) => s !== 'hired' && s !== 'not_interested').length;

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <MetricCard label={t('stats.total')} value={loading ? '-' : totalCount} />
          <MetricCard label={t('stats.active')} value={loading ? '-' : activeCount} tone="teal" />
          <MetricCard label={t('stats.hired')} value={loading ? '-' : hiredCount} tone="green" />
        </div>

        <DashboardPanel>
          <PanelHeader title={t('title')} />
          <div className="p-5">
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
          </div>
        </DashboardPanel>
      </main>
    </AppShell>
  );
}
