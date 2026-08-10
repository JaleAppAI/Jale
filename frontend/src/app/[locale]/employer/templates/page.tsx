'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { TemplateEditModal } from '@/components/employer/TemplateEditModal';
import { deleteJobTemplate, getBilling, listJobTemplates, type JobTemplate } from '@/lib/api/employer';
import { templateRowSummary } from '@/lib/job-form';
import { formatStartDate } from '@/lib/date';

export const dynamic = 'force-dynamic';

export default function EmployerTemplatesPage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  const locale = useLocale();

  const [templates, setTemplates] = useState<JobTemplate[]>([]);
  const [templateLimit, setTemplateLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<JobTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<JobTemplate | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!idToken) return;
    setLoading(true);
    setLoadError(null);
    listJobTemplates(idToken)
      .then(setTemplates)
      .catch((err) => {
        try {
          handleLegalWall(err, '/employer/templates');
        } catch {
          setLoadError(tCommon('error'));
        }
      })
      .finally(() => setLoading(false));
  }, [handleLegalWall, idToken, tCommon]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!idToken) return;
    // Billing failure just degrades the meter to a plain count.
    getBilling(idToken)
      .then((b) => setTemplateLimit(b.templateLimit))
      .catch(() => {});
  }, [idToken]);

  const atLimit = templateLimit !== null && templates.length >= templateLimit;
  const meter = templateLimit === null
    ? t('templates.meter_count', { count: templates.length })
    : t('templates.meter', { count: templates.length, limit: templateLimit });

  const mergeSaved = (saved: JobTemplate) => {
    setTemplates((current) => {
      const next = [saved, ...current.filter((tpl) => tpl.id !== saved.id)];
      return next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  };

  const handleDelete = async () => {
    if (!deleting || !idToken || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteJobTemplate(idToken, deleting.id);
      setTemplates((current) => current.filter((tpl) => tpl.id !== deleting.id));
      setDeleting(null);
    } catch {
      setDeleteError(t('templates.delete_error'));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <AppShell role="employer" title={t('templates.title')}>
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold text-[var(--jale-blue-900)]">{t('templates.title')}</h1>
            <p className="mt-1 text-sm font-semibold text-[var(--jale-ink-2)]">{meter}</p>
          </div>
          <Button onClick={() => setCreating(true)} disabled={atLimit}>{t('templates.new')}</Button>
        </div>

        {atLimit && (
          <div className="mb-4 rounded-2xl border border-[var(--jale-danger)]/30 bg-[var(--jale-danger-bg)] p-4">
            <p className="text-sm font-semibold text-[var(--jale-danger)]">{t('templates.limit_note')}</p>
            <Link
              href="/employer/billing"
              className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[var(--jale-blue-900)] px-4 text-xs font-bold text-white hover:bg-[var(--jale-blue-950,#0e0e3d)]"
            >
              {tBilling('limit_reached.cta')}
            </Link>
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm font-semibold text-[var(--jale-ink-2)]">{tCommon('loading')}</p>
          </div>
        ) : loadError ? (
          <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm font-semibold text-[var(--jale-danger)]">{loadError}</p>
            <Button onClick={refetch} className="mt-4">{tCommon('retry')}</Button>
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--jale-divider)] bg-white p-8 text-center shadow-[var(--shadow-card)]">
            <p className="text-sm text-[var(--jale-ink-2)]">{t('templates.empty')}</p>
            <Button onClick={() => setCreating(true)} className="mt-4" disabled={atLimit}>{t('templates.new')}</Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[var(--jale-divider)] bg-white shadow-[var(--shadow-card)]">
            <div className="hidden grid-cols-[1.4fr_2fr_1fr_auto] gap-3 border-b border-[var(--jale-divider)] px-5 py-3 md:grid">
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.col_name')}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.col_details')}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.updated')}</span>
              <span />
            </div>
            {templates.map((tpl) => {
              const summary = templateRowSummary(
                tpl.payload,
                tpl.payload.pay_interval ? t(`modal.pay_interval_option.${tpl.payload.pay_interval}`) : undefined,
              );
              return (
                <div key={tpl.id} className="grid gap-2 border-b border-[var(--jale-divider)] px-5 py-4 last:border-b-0 md:grid-cols-[1.4fr_2fr_1fr_auto] md:items-center md:gap-3">
                  <p className="text-sm font-semibold text-[var(--jale-ink)]">{tpl.name}</p>
                  <p className="text-sm text-[var(--jale-ink-2)]">{summary.city} · {summary.trade} · {summary.pay}</p>
                  <p className="text-sm text-[var(--jale-ink-2)]">{formatStartDate(tpl.updated_at, locale) ?? '—'}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(tpl)}>{t('templates.edit')}</Button>
                    <Button variant="outline" size="sm" onClick={() => { setDeleteError(null); setDeleting(tpl); }}>{t('templates.delete_confirm')}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TemplateEditModal
        key={editing?.id ?? (creating ? 'new' : 'closed')}
        open={creating || editing !== null}
        template={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={mergeSaved}
      />

      {deleting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!deleteBusy) setDeleting(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[var(--jale-paper)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-[var(--jale-ink)]">{t('templates.delete_title')}</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
              {t('templates.delete_body', { name: deleting.name })}
            </p>
            {deleteError && (
              <p className="mt-3 rounded-lg bg-[var(--jale-danger-bg)] px-3 py-2 text-sm text-[var(--jale-danger)]">
                {deleteError}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteBusy}>
                {t('modal.cancel')}
              </Button>
              <Button
                variant="error"
                onClick={handleDelete}
                loading={deleteBusy}
                loadingLabel={t('templates.delete_confirm')}
              >
                {t('templates.delete_confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
