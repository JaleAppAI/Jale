'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { visibleFieldKeys, isFieldComplete } from '@/lib/application-answers-form';
import { docTypeLabel } from '@/lib/doc-types';
import type { RequirementsFlowState, RequirementsTotals } from '@/lib/application-requirements-flow';

/**
 * "Check & finish" (prototype W4c), in both of its states.
 *
 * WHAT IT SHOWS is a summary, not a form: which questions are answered, how
 * many documents are attached, how many certifications are confirmed --
 * rendered through the shared `KVList` the job detail page already uses for
 * its facts, so the two read the same way.
 *
 * The per-answer VALUES are deliberately not rendered. Eleven field shapes
 * (addresses, repeating work history, military service) would each need their
 * own display formatter, none of which exists, and a half-rendered
 * "[object Object]" is worse than an honest answered/skipped marker. The
 * prototype shows literal values for four hand-picked fields; this shows the
 * state of every one. Flagged as a divergence.
 *
 * FINISH IS GATED ON THE SERVER'S `remaining`, never on the local draft: the
 * whole point of this step is to be right about what the employer will
 * actually see, and only the door knows whether the last upload landed. When
 * something is still outstanding the button is disabled and the missing items
 * are named with a link back to the step that fixes them (W4c, right phone).
 */
export function RequirementsReviewStep({
  state, totals, onFinish, onGotoDocuments, saving,
}: {
  state: RequirementsFlowState;
  totals: RequirementsTotals;
  onFinish: () => void;
  onGotoDocuments: () => void;
  saving: boolean;
}) {
  const t = useTranslations('worker_application_details.review');
  const tReq = useTranslations('job_requirements');
  const tDocTypes = useTranslations('doc_types');
  const tCommon = useTranslations('common');

  const { job, remaining } = state.server;
  const fieldsToShow = visibleFieldKeys(job.required_fields, job.optional_fields);

  const items: KVItem[] = fieldsToShow.map((key) => ({
    label: tReq(`fields.${key}`),
    value: state.skipped.has(key)
      ? t('skipped')
      : isFieldComplete(key, state.draft)
        ? t('answered')
        : t('not_answered'),
  }));

  items.push({
    label: t('docs'),
    value: t('of', { done: totals.docs.done, total: totals.docs.total }),
  });
  if (totals.certifications.total > 0) {
    items.push({
      label: t('certs'),
      value: t('of', { done: totals.certifications.done, total: totals.certifications.total }),
    });
  }

  // Named from the SERVER's remaining, in the job's own column order.
  const missingLabels = [
    ...remaining.fields.map((key) => tReq(`fields.${key}`)),
    ...remaining.docs.map((doc) => docTypeLabel(doc, tDocTypes) ?? doc),
    ...remaining.certifications.unclaimed,
    ...remaining.certifications.unproven,
  ];
  const blocked = missingLabels.length > 0;

  return (
    <div className="anim-fade-in grid gap-4">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--jale-ink-2)]">
          {t('summary_title')}
        </p>
        <KVList items={items} />
      </div>

      {blocked ? (
        <>
          <InlineFeedback tone="warning">
            {t('still_missing', { items: Array.from(new Set(missingLabels)).join(', ') })}
          </InlineFeedback>
          <button
            type="button"
            onClick={onGotoDocuments}
            className="self-start text-sm font-semibold text-[var(--jale-blue-700)] underline underline-offset-2"
          >
            {t('go_fix')}
          </button>
        </>
      ) : (
        <InlineFeedback tone="info">
          {t('will_see', { company: state.server.job.company_name ?? '' })
            .replace(/\s{2,}/g, ' ')
            .trim()}
        </InlineFeedback>
      )}

      <p className="text-xs text-[var(--jale-ink-2)]">{t('saved_note')}</p>

      <Button
        className="w-full"
        size="lg"
        disabled={blocked}
        loading={saving}
        loadingLabel={tCommon('loading')}
        onClick={onFinish}
      >
        {t('finish')}
      </Button>
    </div>
  );
}
