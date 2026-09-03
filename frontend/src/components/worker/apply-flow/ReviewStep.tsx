'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { ApplyFlowState } from '@/lib/apply-flow-view';
import { buildAnswersPayload, isFieldComplete, visibleFieldKeys } from '@/lib/application-answers-form';
import { buildCertClaimsPayload, type CertificationClaim } from '@/lib/certification-claims';
import { REQUIREMENT_DOC_KEYS } from '@/lib/job-requirements';
import type { JobDetail, JobDocType, WorkerVaultDoc } from '@/lib/api/worker';
import { proofFilesFromVault } from '../application-requirements/DocumentsCertificationsStep';

/**
 * Wire payload `ApplyFlow.onSubmit` hands to its caller.
 *
 * STALE AS OF SPRINT 23 WAVE 1: it used to map 1:1 onto `applyToJob`'s two
 * trailing params, but apply now takes `prompt_answers` alone -- field
 * answers and certification claims belong to the stage-2 door
 * (`postApplicationAnswers` / `postApplicationCertifications` in
 * `lib/api/worker.ts`). The page therefore builds this payload and does not
 * send it. Kept structurally intact on purpose: wave 2 re-points this flow
 * at the new doors, and reshaping it here would be a UI change this wave is
 * explicitly not making.
 */
export type ApplyFlowSubmitPayload = {
  answers: Record<string, unknown>;
  certification_claims: CertificationClaim[];
};

/**
 * The shape `ApplyFlow`'s `submitError` prop takes.
 *
 * This is a WK-T3-DEFINED contract -- the task spec names the `submitError`
 * prop but not its shape. Wave-3's page integration must classify the apply
 * call's failure into one of these two arms before passing it down:
 *
 *   - `missing_certification_proof`: the backend's `missing_certification_proof`
 *     400 -- a stale-gate backstop, mirroring the existing `missing_answers`
 *     backstop the worker job detail page already has for
 *     `ApplicationAnswersForm` -- naming the still-unproven certs. `certs` are
 *     RAW cert names; THIS component does the joining and `{certs}`
 *     interpolation into `worker_job_detail.apply_flow.errors.missing_certification_proof`,
 *     per the task spec's wording ("renders ... with the certs list joined").
 *   - `generic`: any other apply failure, as an ALREADY-TRANSLATED sentence.
 *     The page owns the full apply-error taxonomy (`handleApplyError` in
 *     `worker/jobs/[id]/page.tsx` today) via `useErrorMessage`, whose own doc
 *     comment makes rendering `err.message` directly a hard no -- so this
 *     component only ever displays a string the caller already translated,
 *     never a raw error/code.
 *
 * The `certs` list survives the wire because `lib/api/errors.ts`'s
 * `ALLOWED_PAYLOAD_KEYS` includes 'certs' -- `parseApiError` preserves it
 * from the backend's `missing_certification_proof` 400 body, and the page
 * hands it to this component via `submitError`.
 */
export type ApplyFlowSubmitError =
  | { kind: 'missing_certification_proof'; certs: string[] }
  | { kind: 'generic'; message: string };

/**
 * Step 3 of the in-page apply flow: a compact status summary (never a
 * full field-by-field value dump -- the `apply_flow.review_*` vocabulary is
 * counts and status lines, e.g. "3 of 5 questions answered", not a
 * transcript) plus the Submit button.
 *
 * Builds the actual wire payload itself (`buildAnswersPayload` +
 * `buildCertClaimsPayload`) from `state` on submit, so `ApplyFlow`/Wave-3
 * never has to re-derive it -- `onSubmit` receives a ready `ApplyFlowSubmitPayload`.
 */
export function ReviewStep({
  job, state, vaultDocs, onSubmit, submitting, submitError,
}: {
  job: JobDetail;
  state: ApplyFlowState;
  vaultDocs: readonly WorkerVaultDoc[] | null;
  onSubmit: (payload: ApplyFlowSubmitPayload) => void;
  submitting: boolean;
  submitError: ApplyFlowSubmitError | null;
}) {
  const t = useTranslations('job_requirements');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const tDetail = useTranslations('worker_job_detail');

  const requiredFields = job.required_fields ?? [];
  const optionalFields = job.optional_fields ?? [];
  const fieldsToShow = visibleFieldKeys(requiredFields, optionalFields);
  const answeredCount = fieldsToShow.filter(
    (key) => !state.skipped.has(key) && isFieldComplete(key, state.draft),
  ).length;
  const skippedOptional = fieldsToShow.filter(
    (key) => !requiredFields.includes(key) && state.skipped.has(key),
  );

  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  const certs = job.certification_requirements ?? [];
  const hasCerts = certs.length > 0;
  const docsToShow = REQUIREMENT_DOC_KEYS.filter((key) => {
    if (key === 'certification_doc' && hasCerts) return false;
    return requiredDocs.includes(key) || optionalDocs.includes(key);
  }) as JobDocType[];
  const hasDoc = (docType: JobDocType) => vaultDocs?.some((d) => d.doc_type === docType) ?? false;

  const proofFiles = proofFilesFromVault(certs, vaultDocs);

  function handleSubmit() {
    const answers = buildAnswersPayload(requiredFields, optionalFields, state.draft, state.skipped);
    const certification_claims = buildCertClaimsPayload(certs, state.certClaims, proofFiles);
    onSubmit({ answers, certification_claims });
  }

  return (
    <div className="grid gap-5">
      <p className="text-sm text-[var(--jale-ink-2)]">{tFlow('hints.review')}</p>

      {fieldsToShow.length > 0 ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('groups.questions')}
          </p>
          <p className="text-sm text-[var(--jale-ink)]">
            {tFlow('review_answers', { answered: answeredCount, total: fieldsToShow.length })}
          </p>
          {skippedOptional.map((key) => (
            <p key={key} className="text-xs text-[var(--jale-ink-2)]">
              {tFlow('review_skipped', { label: t(`fields.${key}`) })}
            </p>
          ))}
        </div>
      ) : null}

      {docsToShow.length > 0 ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('groups.documents')}
          </p>
          {docsToShow.map((docType) => {
            const uploaded = hasDoc(docType);
            const required = requiredDocs.includes(docType);
            const label = t(`docs.${docType}`);
            if (uploaded) {
              return (
                <div key={docType} className="flex items-center gap-2 text-sm text-[var(--jale-ink)]">
                  <span>{label}</span>
                  <Badge tone="success">{tDetail('doc_ok')}</Badge>
                </div>
              );
            }
            return (
              <p key={docType} className="text-xs text-[var(--jale-ink-2)]">
                {required ? tFlow('errors.required_doc', { label }) : tFlow('review_not_attached', { label })}
              </p>
            );
          })}
        </div>
      ) : null}

      {hasCerts ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('groups.certifications')}
          </p>
          {certs.map((cert) => {
            const claim = state.certClaims[cert.name];
            const hasProof = (proofFiles[cert.name]?.length ?? 0) > 0;
            if (claim?.has === true && hasProof) {
              return (
                <p key={cert.name} className="text-sm text-[var(--jale-ink)]">
                  {tFlow('review_claimed_proof', { name: cert.name })}
                </p>
              );
            }
            if (claim?.has === true) {
              return (
                <p key={cert.name} className="text-sm text-[var(--jale-ink)]">
                  {tFlow('review_claimed_no_proof', { name: cert.name })}
                </p>
              );
            }
            return (
              <p key={cert.name} className="text-xs text-[var(--jale-ink-2)]">
                {tFlow('review_not_claimed', { name: cert.name, tier: t(`states.${cert.tier}`) })}
              </p>
            );
          })}
        </div>
      ) : null}

      <p className="text-xs text-[var(--jale-ink-2)]">{tFlow('review_note')}</p>

      {submitError ? (
        <InlineFeedback tone="danger">
          {submitError.kind === 'missing_certification_proof'
            ? tFlow('errors.missing_certification_proof', { certs: submitError.certs.join(', ') })
            : submitError.message}
        </InlineFeedback>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={handleSubmit} loading={submitting}>
          {tFlow('submit')}
        </Button>
      </div>
    </div>
  );
}
