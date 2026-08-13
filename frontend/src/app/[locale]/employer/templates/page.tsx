'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';
import { PanelHeader } from '@/components/ui/panel-header';
import { TemplateEditModal } from '@/components/employer/TemplateEditModal';
import { deleteJobTemplate, getBilling, listJobTemplates, type JobTemplate } from '@/lib/api/employer';
import { templateRowSummary, TRADE_CATEGORIES } from '@/lib/job-form';
import { formatLongDate } from '@/lib/date';

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
  // A destructive dialog opens on its SAFE action (see DeleteJobDialog).
  const cancelRef = useRef<HTMLButtonElement>(null);
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
      <main className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-[var(--jale-ink-2)]">{meter}</p>
          <Button onClick={() => setCreating(true)} disabled={atLimit}>{t('templates.new')}</Button>
        </div>

        {atLimit && (
          <InlineFeedback tone="warning" className="mb-5">
            <span className="block">{t('templates.limit_note')}</span>
            <Link
              href="/employer/billing"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
            >
              {tBilling('limit_reached.cta')}
            </Link>
          </InlineFeedback>
        )}

        {loading ? (
          <p className="text-sm text-muted">{tCommon('loading')}</p>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-3">
            <InlineFeedback tone="danger">{loadError}</InlineFeedback>
            <Button variant="outline" size="sm" onClick={refetch}>{tCommon('retry')}</Button>
          </div>
        ) : templates.length === 0 ? (
          <DashboardPanel className="p-8 text-center">
            <p className="mb-4 text-sm text-[var(--jale-ink-2)]">{t('templates.empty')}</p>
            <Button onClick={() => setCreating(true)} disabled={atLimit}>{t('templates.new')}</Button>
          </DashboardPanel>
        ) : (
          <DashboardPanel>
            <PanelHeader title={t('templates.title')} />
            <div className="hidden grid-cols-[1.4fr_2fr_1fr_auto] gap-3 border-b border-[var(--jale-divider)] px-5 py-3 md:grid">
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.col_name')}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.col_details')}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.updated')}</span>
              <span />
            </div>
            <div className="divide-y divide-[var(--jale-divider)]">
              {templates.map((tpl) => {
                const summary = templateRowSummary(
                  tpl.payload,
                  tpl.payload.pay_interval ? t(`modal.pay_interval_option.${tpl.payload.pay_interval}`) : undefined,
                );
                // The helper returns the stored enum; localize it here like the
                // interval label, passing unknown/legacy values through as-is.
                const tradeLabel = (TRADE_CATEGORIES as readonly string[]).includes(summary.trade)
                  ? t(`modal.trade.${summary.trade}`)
                  : summary.trade;
                return (
                  <div key={tpl.id} className="grid gap-2 px-5 py-4 md:grid-cols-[1.4fr_2fr_1fr_auto] md:items-center md:gap-3">
                    <p className="text-sm font-semibold text-[var(--jale-ink)]">{tpl.name}</p>
                    <p className="text-sm text-[var(--jale-ink-2)]">{summary.city} · {tradeLabel} · {summary.pay}</p>
                    {/* updated_at is a full timestamp -- formatLongDate renders it in the
                        reader's timezone (formatStartDate is date-only and pinned to UTC). */}
                    <p className="text-sm text-[var(--jale-ink-2)]">{formatLongDate(tpl.updated_at, locale) ?? '—'}</p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(tpl)}>{t('templates.edit')}</Button>
                      <Button variant="outline" size="sm" onClick={() => { setDeleteError(null); setDeleting(tpl); }}>{t('templates.delete_confirm')}</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </DashboardPanel>
        )}
      </main>

      <TemplateEditModal
        key={editing?.id ?? (creating ? 'new' : 'closed')}
        open={creating || editing !== null}
        template={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={mergeSaved}
      />

      <Modal
        open={deleting !== null}
        onClose={() => {
          if (!deleteBusy) setDeleting(null);
        }}
        title={t('templates.delete_title')}
        size="sm"
        closeOnOverlay={!deleteBusy}
        closeOnEscape={!deleteBusy}
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => setDeleting(null)} disabled={deleteBusy}>
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
          </>
        }
      >
        <p className="text-sm leading-6 text-[var(--jale-ink-2)]">
          {deleting ? t('templates.delete_body', { name: deleting.name }) : null}
        </p>
        {deleteError ? (
          <InlineFeedback tone="danger" className="mt-4">
            {deleteError}
          </InlineFeedback>
        ) : null}
      </Modal>
    </AppShell>
  );
}
