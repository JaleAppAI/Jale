'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import { visibleFieldKeys } from '@/lib/application-answers-form';
import { matchCertProof, estimateApplyMinutes } from '@/lib/certification-match';
import { REQUIREMENT_DOC_KEYS, whatYouNeedHintKey, type WhatYouNeedHintKey } from '@/lib/job-requirements';
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

/**
 * One doc/cert row's display data, pre-computed so the render below stays a
 * straight map.
 *
 * `hintKey` is the row's second line -- what the job will actually ask of the
 * worker for this item (upload / attest / never blocks), chosen by
 * `whatYouNeedHintKey`. `undefined` means the row's own status line already
 * says something more specific, so no hint renders at all. Only the key is
 * carried, not the inputs it was derived from (`proof_required` &c.): the
 * decision belongs to the helper, which is testable, and duplicating its
 * inputs here would invite a second, drifting copy of the same rule in the
 * view.
 *
 * Private on purpose: the exported `WhatYouNeedRowStatus` above is a public
 * type other files consume, and is deliberately NOT widened for this.
 */
type Row = {
  key: string;
  label: string;
  tier: 'required' | 'optional';
  status: WhatYouNeedRowStatus;
  hintKey: WhatYouNeedHintKey | undefined;
};

/**
 * Pre-apply preview panel for the worker job detail page, REFRAMED for the two
 * stages (sprint 23).
 *
 * The old panel said "here is everything you must produce to apply", which is
 * now simply false: applying costs the employer's questions or one tap, and
 * everything else is only ever asked for if they want to hire you. So the
 * panel splits in two, exactly as the prototype's W1 does -- a lead line for
 * what it takes TODAY, then an eyebrow ("If the employer wants to hire you,
 * they'll ask for:") over the doc/cert rows, which keep their vault badges
 * because a document already in the vault genuinely is one less thing later.
 *
 * The field questions move UNDER that eyebrow as a single counted row rather
 * than a headline number: they are no longer part of applying.
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
  const fieldCount = fieldsToShow.length;
  const requiredFieldCount = requiredFields.length;

  const prompts = job.pre_application_prompts ?? [];

  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  const certs = job.certification_requirements ?? [];
  const hasCerts = certs.length > 0;

  const docKeys = REQUIREMENT_DOC_KEYS.filter((key) => {
    if (key === 'certification_doc' && hasCerts) return false;
    return requiredDocs.includes(key) || optionalDocs.includes(key);
  });

  const docRows: Row[] = docKeys.map((key) => {
    const tier = requiredDocs.includes(key) ? 'required' : 'optional';
    const status: WhatYouNeedRowStatus =
      vaultDocs && vaultDocs.some((d) => d.doc_type === key) ? 'in_vault' : 'none';
    return {
      key,
      label: tReq(`docs.${key}`),
      tier,
      status,
      // `blockingError: false` -- this panel is a preview, never a gate (see
      // this component's doc comment), so no row here can be in an error
      // state to defer to.
      hintKey: whatYouNeedHintKey({
        kind: 'doc',
        tier,
        proofRequired: false,
        satisfied: status === 'in_vault',
        blockingError: false,
      }),
    };
  });

  const certRows: Row[] = certs.map((cert) => {
    let status: WhatYouNeedRowStatus = 'none';
    if (vaultDocs) {
      const matched = Boolean(matchCertProof(cert.name, vaultDocs));
      if (cert.proof_required) status = matched ? 'proof_in_vault' : 'proof_needed';
      else if (matched) status = 'in_vault';
    }
    return {
      key: cert.name,
      label: cert.name,
      tier: cert.tier,
      status,
      hintKey: whatYouNeedHintKey({
        kind: 'cert',
        tier: cert.tier,
        proofRequired: cert.proof_required,
        satisfied: status === 'in_vault' || status === 'proof_in_vault',
        blockingError: false,
      }),
    };
  });

  // The estimate is now about STAGE ONE only, so it is fed the prompt count
  // and nothing else: the docs and certs it used to include are no longer part
  // of applying, and counting them would price a task the worker is not being
  // asked to do.
  const estimate = estimateApplyMinutes(prompts.length, 0, 0);

  return (
    <DashboardPanel>
      <PanelHeader title={t('title')} />
      <div className="space-y-4 p-5 md:p-6">
        {/* What it takes TODAY. */}
        <InlineFeedback tone="info">
          <span className="font-semibold text-[var(--jale-ink)]">
            {prompts.length > 0
              ? t('to_apply_prompts', { count: prompts.length, minutes: estimate })
              : t('to_apply_one_tap')}
          </span>
        </InlineFeedback>

        {fieldCount > 0 || docRows.length > 0 || certRows.length > 0 ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--jale-ink-2)]">
              {t('later_eyebrow')}
            </p>

            {vaultDocs === null ? (
              <InlineFeedback tone="warning">{t('vault_check_failed')}</InlineFeedback>
            ) : null}

            <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
              {/* The field questions as ONE counted row, so they read as part
                  of the later ask rather than as the headline they used to be. */}
              {fieldCount > 0 ? (
                <li className="px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-sm font-medium text-[var(--jale-ink)]">
                      {t('fields_row', { count: fieldCount, required: requiredFieldCount })}
                    </span>
                    <Badge tone="neutral">{t('after_they_ask')}</Badge>
                  </div>
                </li>
              ) : null}
              {[...docRows, ...certRows].map((row) => (
                <WhatYouNeedRowView key={row.key} row={row} />
              ))}
            </ul>

            {docRows.length > 0 || certRows.length > 0 ? (
              <p className="text-xs text-[var(--jale-ink-2)]">{t('vault_note')}</p>
            ) : null}
          </>
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
    <li className="px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm font-medium text-[var(--jale-ink)]">{row.label}</span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge tone={row.tier === 'required' ? 'info' : 'neutral'}>
            {tReq(`states.${row.tier}`)}
          </Badge>
          {row.status === 'in_vault' ? <Badge tone="success">{t('in_vault')}</Badge> : null}
          {row.status === 'proof_in_vault' ? <Badge tone="success">{t('proof_in_vault')}</Badge> : null}
          {row.status === 'proof_needed' ? <Badge tone="warning">{t('proof_needed')}</Badge> : null}
          {row.status === 'none' ? <Badge tone="neutral">{t('not_yet')}</Badge> : null}
        </span>
      </div>
      {/*
        Second line: the Required/Optional badge above states the TIER, which
        says nothing about the mechanism -- a "Required" certification may
        want a file, or only the worker's word for it. This says which.
      */}
      {row.hintKey ? (
        <p className="mt-0.5 text-xs text-[var(--jale-ink-2)]">{t(row.hintKey)}</p>
      ) : null}
    </li>
  );
}
