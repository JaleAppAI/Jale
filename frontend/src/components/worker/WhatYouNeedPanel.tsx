'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import { visibleFieldKeys } from '@/lib/application-answers-form';
import { matchCertProof, estimateApplyMinutes } from '@/lib/certification-match';
import { REQUIREMENT_DOC_KEYS } from '@/lib/job-requirements';
import type { JobDetail, WorkerVaultDoc } from '@/lib/api/worker';

/**
 * LIB GAP, flagged prominently (same visibility class as an i18n addition):
 * the task spec names `whatYouNeedSummary` in `certification-match.ts` as an
 * already-merged Wave-1 helper this panel should reuse. It does not exist --
 * verified against the file directly and against
 * `git log --all -S 'whatYouNeedSummary'` (no hit on any branch). It was
 * never written, not merged-but-uncommitted. Per this task's file ownership
 * (`certification-match.ts` is a lib file, not in the WK-T3 file list), this
 * panel does NOT add it there; the aggregation below is implemented locally
 * from the two helpers that DO exist (`matchCertProof`, `estimateApplyMinutes`)
 * plus `visibleFieldKeys` (`application-answers-form.ts`, also already merged).
 * If a later task adds the real `whatYouNeedSummary`, this file's local
 * `WhatYouNeedRow`/computation block is the one to delete in its favor.
 *
 * Also note: the task brief says the `what_you_need` i18n group has 11 keys;
 * `en.json`/`es.json` both currently carry exactly 10 (verified by direct
 * enumeration). Every key this panel needs is present in both locales, so
 * nothing was added under the i18n exception -- the discrepancy is a brief
 * miscount, not a gap to fill.
 */

export type WhatYouNeedRowStatus = 'in_vault' | 'proof_in_vault' | 'proof_needed' | 'none';

/** One doc/cert row's display data, pre-computed so the render below stays a straight map. */
type Row = {
  key: string;
  label: string;
  tier: 'required' | 'optional';
  status: WhatYouNeedRowStatus;
};

/**
 * Pre-apply preview panel for the worker job detail page: how many questions
 * the job asks, which documents/certifications it wants (Required/Optional),
 * which of those the worker's vault already satisfies, and a rough time
 * estimate (`estimateApplyMinutes`).
 *
 * Degrades gracefully when `vaultDocs` is `null` (the vault fetch failed):
 * the full requirement list (question count, every doc/cert with its
 * Required/Optional tier) still renders -- only the vault-match checkmarks
 * disappear, replaced by the `vault_check_failed` notice. This is a PREVIEW,
 * not a gate, so there is nothing to fail closed on here (contrast
 * `DocumentsCertificationsStep`, which fails closed on `vaultDocs === null`
 * because it is deciding whether Submit is allowed).
 */
export function WhatYouNeedPanel({
  job, vaultDocs,
}: {
  job: JobDetail;
  vaultDocs: readonly WorkerVaultDoc[] | null;
}) {
  const t = useTranslations('worker_job_detail.what_you_need');
  const tReq = useTranslations('job_requirements');

  const requiredFields = job.required_fields ?? [];
  const optionalFields = job.optional_fields ?? [];
  const fieldsToShow = visibleFieldKeys(requiredFields, optionalFields);
  const questionCount = fieldsToShow.length;
  const requiredQuestionCount = requiredFields.length;

  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  const certs = job.certification_requirements ?? [];
  const hasCerts = certs.length > 0;

  const docKeys = REQUIREMENT_DOC_KEYS.filter((key) => {
    if (key === 'certification_doc' && hasCerts) return false;
    return requiredDocs.includes(key) || optionalDocs.includes(key);
  });

  const docRows: Row[] = docKeys.map((key) => ({
    key,
    label: tReq(`docs.${key}`),
    tier: requiredDocs.includes(key) ? 'required' : 'optional',
    status: vaultDocs && vaultDocs.some((d) => d.doc_type === key) ? 'in_vault' : 'none',
  }));

  const certRows: Row[] = certs.map((cert) => {
    let status: WhatYouNeedRowStatus = 'none';
    if (vaultDocs) {
      const matched = Boolean(matchCertProof(cert.name, vaultDocs));
      if (cert.proof_required) status = matched ? 'proof_in_vault' : 'proof_needed';
      else if (matched) status = 'in_vault';
    }
    return { key: cert.name, label: cert.name, tier: cert.tier, status };
  });

  const estimate = estimateApplyMinutes(questionCount, docKeys.length, certs.length);

  return (
    <DashboardPanel>
      <PanelHeader title={t('title')} />
      <div className="space-y-4 p-5 md:p-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold text-[var(--jale-ink)]">
            {t('questions_summary', { count: questionCount })}
          </span>
          {requiredQuestionCount > 0 ? (
            <span className="text-[var(--jale-ink-2)]">
              {t('questions_required', { count: requiredQuestionCount })}
            </span>
          ) : null}
        </div>

        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--jale-ink-2)]">
          {t('estimate', { minutes: estimate })}
        </p>

        {vaultDocs === null ? (
          <InlineFeedback tone="warning">{t('vault_check_failed')}</InlineFeedback>
        ) : null}

        {docRows.length > 0 || certRows.length > 0 ? (
          <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
            {[...docRows, ...certRows].map((row) => (
              <WhatYouNeedRowView key={row.key} row={row} />
            ))}
          </ul>
        ) : null}
      </div>
    </DashboardPanel>
  );
}

/**
 * `useTranslations`'s return type is narrower than a plain
 * `(key, values?) => string` (its `values` type is pinned to next-intl's own
 * ICU-argument shape) -- calling both translators INSIDE this component
 * (rather than threading them down as props typed to a hand-rolled function
 * signature) sidesteps that mismatch entirely and matches how every other
 * component in this tree gets its translators.
 */
function WhatYouNeedRowView({ row }: { row: Row }) {
  const t = useTranslations('worker_job_detail.what_you_need');
  const tReq = useTranslations('job_requirements');
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
      <span className="min-w-0 text-sm font-medium text-[var(--jale-ink)]">{row.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <Badge tone={row.tier === 'required' ? 'info' : 'neutral'}>
          {tReq(`states.${row.tier}`)}
        </Badge>
        {row.status === 'in_vault' ? <Badge tone="success">{t('in_vault')}</Badge> : null}
        {row.status === 'proof_in_vault' ? <Badge tone="success">{t('proof_in_vault')}</Badge> : null}
        {row.status === 'proof_needed' ? <Badge tone="warning">{t('proof_needed')}</Badge> : null}
      </span>
    </li>
  );
}
