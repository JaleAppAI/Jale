'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { TemplateEditModal } from '@/components/employer/TemplateEditModal';
import { getBilling, listJobTemplates, deleteJobTemplate } from '@/lib/api/employer';
import type { JobTemplate } from '@/lib/api/employer';
import { templateRowSummary, TRADE_CATEGORIES } from '@/lib/job-form';
import { formatStartDate } from '@/lib/date';

export const dynamic = 'force-dynamic';

export default function TemplatesPage() {
  const { idToken } = useAuth();
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
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  function loadTemplates() {
    if (!idToken) return;
    setLoading(true);
    setLoadError(null);
    listJobTemplates(idToken)
      .then(setTemplates)
      .catch(() => setLoadError(tCommon('error')))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idToken]);

  useEffect(() => {
    if (!idToken) return;
    getBilling(idToken)
      .then((b) => setTemplateLimit(b.templateLimit))
      .catch(() => {});
  }, [idToken]);

  const atCap = templateLimit !== null && templates.length >= templateLimit;

  const meterText = templateLimit === null
    ? t('templates.meter_count', { count: templates.length })
    : t('templates.meter', { count: templates.length, limit: templateLimit });

  return (
    <>
      <AppShell role="employer" title={t('templates.title')}>
        <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--jale-ink-2)]">{meterText}</p>
            <Button onClick={() => setCreating(true)} disabled={atCap}>
              {t('templates.new')}
            </Button>
          </div>

          {atCap && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[var(--jale-warning-bg)] px-4 py-3">
              <p className="text-sm font-semibold text-[var(--jale-warning)]">{t('templates.limit_note')}</p>
              <Link
                href="/employer/billing"
                className="inline-flex h-10 items-center justify-center rounded-full bg-[var(--jale-blue-900)] px-5 text-sm font-bold text-white hover:bg-[var(--jale-blue-950,#0e0e3d)]"
              >
                {tBilling('limit_reached.cta')}
              </Link>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted">{tCommon('loading')}</p>
          ) : loadError ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-error">{loadError}</p>
              <Button variant="outline" size="sm" onClick={loadTemplates}>
                {tCommon('retry')}
              </Button>
            </div>
          ) : templates.length === 0 ? (
            <DashboardPanel className="p-8 text-center">
              <p className="mb-4 text-sm text-muted-foreground">{t('templates.empty')}</p>
              <Button onClick={() => setCreating(true)} disabled={atCap}>
                {t('templates.new')}
              </Button>
            </DashboardPanel>
          ) : (
            <DashboardPanel>
              <PanelHeader title={t('templates.title')} />
              <div className="hidden grid-cols-[2fr_3fr_auto_auto] gap-3 border-b border-[var(--jale-divider)] px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted sm:grid">
                <span>{t('templates.col_name')}</span>
                <span>{t('templates.col_details')}</span>
                <span>{t('templates.updated')}</span>
                <span />
              </div>
              <div className="divide-y divide-[var(--jale-divider)]">
                {templates.map((tpl) => {
                  const interval = tpl.payload.pay_interval
                    ? t(`modal.pay_interval_option.${tpl.payload.pay_interval}`)
                    : undefined;
                  const { city, trade, pay } = templateRowSummary(tpl.payload, interval);
                  // The helper returns the raw trade_category slug; localize it
                  // only when it's a known category (payloads are forward-
                  // compatible JSON, so an unknown value falls through as-is).
                  const tradeLabel = (TRADE_CATEGORIES as readonly string[]).includes(trade)
                    ? t(`modal.trade.${trade}`)
                    : trade;
                  const updated = formatStartDate(tpl.updated_at, locale) ?? '—';

                  return (
                    <div
                      key={tpl.id}
                      className="grid grid-cols-1 gap-2 px-5 py-4 sm:grid-cols-[2fr_3fr_auto_auto] sm:items-center sm:gap-3"
                    >
                      <p className="text-sm font-semibold text-[var(--jale-ink)]">{tpl.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {city} &middot; {tradeLabel} &middot; {pay}
                      </p>
                      <p className="text-xs text-muted-foreground">{updated}</p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setEditing(tpl)}>
                          {t('modal.edit_title')}
                        </Button>
                        <Button
                          variant="error"
                          size="sm"
                          onClick={() => { setDeleting(tpl); setDeleteError(null); }}
                        >
                          {t('templates.delete_confirm')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </DashboardPanel>
          )}
        </main>
      </AppShell>

      <TemplateEditModal
        key={editing?.id ?? (creating ? 'new' : 'closed')}
        open={creating || editing !== null}
        template={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSaved={(saved) => {
          setTemplates((current) => {
            const rest = current.filter((tpl) => tpl.id !== saved.id);
            return [saved, ...rest];
          });
        }}
      />

      <DeleteTemplateDialog
        open={deleting !== null}
        templateName={deleting?.name ?? ''}
        deleting={deleteBusy}
        error={deleteError}
        onCancel={() => {
          if (deleteBusy) return;
          setDeleting(null);
          setDeleteError(null);
        }}
        onConfirm={async () => {
          if (!idToken || !deleting || deleteBusy) return;
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
        }}
      />
    </>
  );
}

/**
 * Confirm dialog for permanently deleting a job template. Mirrors
 * DeleteJobDialog's overlay/panel structure (no dialog primitive exists in
 * this codebase); the parent owns the deleting/error state so one delete
 * attempt cannot leak loading state into the next selected template.
 */
function DeleteTemplateDialog({
  open,
  templateName,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  templateName: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations('employer_dashboard');

  if (!open) return null;

  async function handleConfirm() {
    if (deleting) return;
    await onConfirm();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => {
        if (!deleting) onCancel();
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
          {t('templates.delete_body', { name: templateName })}
        </p>
        {error && (
          <p className="mt-3 rounded-lg bg-[var(--jale-danger-bg)] px-3 py-2 text-sm text-[var(--jale-danger)]">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="error"
            onClick={handleConfirm}
            loading={deleting}
            loadingLabel={t('templates.delete_confirm')}
          >
            {t('templates.delete_confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
