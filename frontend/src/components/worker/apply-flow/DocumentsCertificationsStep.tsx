'use client';
import { useState, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Spinner } from '@/components/ui/spinner';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { REQUIREMENT_DOC_KEYS, partitionRequiredDocs, whatYouNeedHintKey, workerCertNoteKey } from '@/lib/job-requirements';
import type { ApplyFlowAction, ApplyFlowState } from '@/lib/apply-flow-view';
import type { CertClaim } from '@/lib/certification-claims';
import { missingRequiredCertClaims, missingRequiredCertProofs } from '@/lib/certification-claims';
import { matchCertProof, type CertRequirement } from '@/lib/certification-match';
import {
  confirmAuthUpload, getAuthUploadUrl, uploadFileToS3,
  type JobDetail, type JobDocType, type WorkerVaultDoc,
} from '@/lib/api/worker';
import { UploadButton, YesNo } from './FieldControls';

// Legacy single-slot cap (075_worker_documents_multi_certification.sql):
// still the effective ceiling for the UNNAMED certification_doc row rendered
// when a job has NO named `certification_requirements` -- untouched by 078.
const LEGACY_MAX_CERTIFICATION_FILES = 5;

// Per-NAME cap (078_worker_documents_cert_name.sql,
// `enforce_certification_document_limit`'s `existing_name_count >= 5` branch,
// constraint `certification_document_name_limit`): once a job has named certs,
// each cert name gets its own 5-file ceiling in the vault, independent of the
// (now 20) total-per-slot cap. This is purely a client-side pre-check mirror
// -- the DB trigger is the actual enforcement -- kept as its own constant
// (not reused from `LEGACY_MAX_CERTIFICATION_FILES`) because the two numbers
// happen to match today but come from different migrations and could diverge.
const MAX_CERT_FILES_PER_NAME = 5;

/** Trim + case-fold, same normalization `certification-match.ts`'s private `normalize` uses. Duplicated locally: that helper is not exported, and this is the one extra thing this step needs beyond `matchCertProof`'s single-match contract -- an exact per-name vault file COUNT (for the "X of 5 uploaded" cap copy), which requires scanning every match, not just the first. */
function normalizeCertName(name: string): string {
  return name.trim().toLowerCase();
}

function countVaultDocsForCert(certName: string, vaultDocs: readonly WorkerVaultDoc[] | null): number {
  if (!vaultDocs) return 0;
  const target = normalizeCertName(certName);
  return vaultDocs.filter(
    (d) => d.doc_type === 'certification_doc' && d.cert_name != null && normalizeCertName(d.cert_name) === target,
  ).length;
}

/**
 * Computes, for each named certification requirement, the vault document ids
 * that count as "attached proof" -- consumed by `missingRequiredCertProofs`/
 * `buildCertClaimsPayload` (both `certification-claims.ts`) and by
 * `ReviewStep`'s summary. Exported so `ApplyFlow.tsx` (forward-jump gating)
 * and `ReviewStep.tsx` (review summary) share one definition.
 *
 * NOT stored in `ApplyFlowState`: `apply-flow-view.ts` tracks only the
 * yes/no claim per cert name, never a proof-file selection, so "is this
 * cert's proof satisfied" is recomputed fresh from `vaultDocs` on every
 * render rather than carried as separate reducer state that could drift
 * from the vault's actual contents.
 *
 * Deliberately uses `matchCertProof`'s single-first-match contract rather
 * than enumerating every vault row under a given name: the only thing either
 * caller needs is "is there at least one attached" (`missingRequiredCertProofs`
 * only checks `files.length === 0`; `buildCertClaimsPayload` only checks
 * `files.length > 0`), and a one-element array already answers that without
 * re-deriving `certification-match.ts`'s un-exported `normalize` helper for a
 * full multi-match scan.
 */
export function proofFilesFromVault(
  certs: readonly CertRequirement[],
  vaultDocs: readonly WorkerVaultDoc[] | null,
): Record<string, string[]> {
  const proofFiles: Record<string, string[]> = {};
  if (!vaultDocs) return proofFiles;
  for (const cert of certs) {
    const match = matchCertProof(cert.name, vaultDocs);
    if (match) proofFiles[cert.name] = [match.id];
  }
  return proofFiles;
}

/**
 * Step 2 of the in-page apply flow: legacy per-doc-type upload rows (resume,
 * driver's license, work-auth doc, and -- only on a job with NO named
 * certifications -- the single undifferentiated certification_doc row,
 * exactly as `ApplicationAnswersForm` renders it today) PLUS, on a job WITH
 * named `certification_requirements`, one `CertClaimRow` per named cert.
 *
 * These two certification UIs are mutually exclusive by construction
 * (`hasCerts` below), matching the data model invariant `job-requirements.ts`
 * documents: a new-shape job (non-empty `certification_requirements`) must
 * never carry `'certification_doc'` in `required_docs`/`optional_docs`.
 *
 * Fully controlled for FLOW data (`state.certClaims` via `dispatch`); the
 * local `useState`s here (`uploadingKey`, `uploadError`, `retryingVault`) are
 * transient in-flight UI state for the upload/retry buttons, not flow data --
 * there is nowhere else for them to live, since a controlled component still
 * needs somewhere to track "which button just got clicked" independent of
 * the parent-owned reducer. `attempted` is the same "did the worker just try
 * to continue" pattern `QuestionsStep` uses, and (unlike that reset bug this
 * file never had) is only ever set true here, never reset on edit, so fixing
 * one missing item never hides another's still-visible marker.
 *
 * ADDITIONS BEYOND THE ORIGINAL WK-T3 PROP LIST (documented here and in
 * `ApplyFlow.tsx`'s doc comment, since Wave-3 wires this up): `token` and
 * `onVaultChanged`. Uploading requires an authenticated call
 * (`getAuthUploadUrl`/`confirmAuthUpload` both take `token`), and this
 * component cannot update `vaultDocs` itself -- it is a prop, owned by the
 * parent -- so a successful upload calls `onVaultChanged()` to ask the
 * parent to refetch and pass the updated array back down. There is a brief
 * window between a successful upload and the refetch landing where the vault
 * has not visibly updated yet; that is accepted latency, not a bug, the same
 * way the old modal's own `getVaultDocuments` refetch after upload was not
 * instantaneous either.
 *
 * `vaultDocs === null` fails every doc/cert check CLOSED (see
 * `missingLegacyDocs` below), which would otherwise stack a dead end on top
 * of a fetch failure -- `onVaultChanged` is normally only called after a
 * successful upload, so the "Try again" button next to the
 * `vault_check_failed` notice is this step's only path back to a working
 * state without leaving the flow.
 */
export function DocumentsCertificationsStep({
  job, state, dispatch, token, vaultDocs, onVaultChanged,
}: {
  job: JobDetail;
  state: ApplyFlowState;
  dispatch: Dispatch<ApplyFlowAction>;
  token: string;
  vaultDocs: readonly WorkerVaultDoc[] | null;
  onVaultChanged: () => void | Promise<void>;
}) {
  const t = useTranslations('job_requirements');
  // `worker_job_detail` (not the apply_flow sub-namespace) for the one thing
  // only it has: `doc_labels.ssn`, the human name of the legacy doc type the
  // notice below reports.
  const tDetail = useTranslations('worker_job_detail');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const tWhatYouNeed = useTranslations('worker_job_detail.what_you_need');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();

  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  // A failed vault fetch fails every doc/cert check CLOSED (see
  // `missingLegacyDocs` below), which would otherwise be a dead end with no
  // way forward -- `onVaultChanged` is normally only called after a
  // successful upload, so this retry affordance is the only path back.
  const [retryingVault, setRetryingVault] = useState(false);

  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  const certs = job.certification_requirements ?? [];
  const hasCerts = certs.length > 0;

  // certification_doc is excluded UNCONDITIONALLY, not just when hasCerts:
  // when a job requires the plain certification_doc (no named certs), that
  // requirement renders below via the dedicated CertificationDocRow (the
  // "X of 5 uploaded" multi-file row) -- letting it also pass this filter
  // would render the same requirement twice with two inconsistent controls,
  // exactly the double-render the pre-redesign form's single-loop ternary
  // never allowed.
  const docsToShow = REQUIREMENT_DOC_KEYS.filter((key) => {
    if (key === 'certification_doc') return false;
    return requiredDocs.includes(key) || optionalDocs.includes(key);
  }) as JobDocType[];

  // A `required_docs` key outside REQUIREMENT_DOC_KEYS (legacy 'ssn', still
  // valid in the jobs CHECK for old rows) has no upload control anywhere in
  // this app -- `docsToShow` above already filters it out. Gating on it was
  // therefore an invisible dead end: Continue blocked forever with nothing on
  // screen to fix. Those keys stop blocking here and are surfaced as a visible
  // notice below instead, so the requirement is neither silently dropped nor
  // silently unsatisfiable.
  const { supported: supportedDocs, unsupported: unsupportedDocs } = partitionRequiredDocs(requiredDocs);

  const hasDoc = (docType: JobDocType) => vaultDocs?.some((d) => d.doc_type === docType) ?? false;
  // Layered ON TOP of that partition, not folded into it: `certification_doc`
  // IS a supported key and this is a separate rule. Defensive
  // belt-and-suspenders: per `job-requirements.ts`, a new-shape job must never
  // carry 'certification_doc' in `required_docs` -- this filter guards against
  // a malformed/legacy payload violating that invariant, so a stray entry
  // cannot double-count as both the legacy gate and a named-cert gate.
  // `vaultDocs === null` (vault fetch failed) fails CLOSED: a required doc's
  // presence cannot be verified, so it counts as still missing rather than
  // silently letting the worker past a check that never actually ran.
  const missingLegacyDocs = supportedDocs.filter(
    (doc) => (hasCerts ? doc !== 'certification_doc' : true) && !hasDoc(doc as JobDocType),
  );

  const proofFiles = proofFilesFromVault(certs, vaultDocs);
  const missingClaims = missingRequiredCertClaims(certs, state.certClaims);
  const missingProofs = missingRequiredCertProofs(certs, state.certClaims, proofFiles);

  const canContinue = missingLegacyDocs.length === 0 && missingClaims.length === 0 && missingProofs.length === 0;

  function docLabel(docType: JobDocType): string {
    return t(`docs.${docType}`);
  }

  async function handleUpload(docType: JobDocType, file: File, certName?: string) {
    const key = certName ? `${docType}:${certName}` : docType;
    setUploadingKey(key);
    setUploadError(null);
    try {
      const { url, s3_key } = await getAuthUploadUrl(token, docType, file.type);
      await uploadFileToS3(url, file);
      await confirmAuthUpload(token, s3_key, docType, file, certName);
      await onVaultChanged();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploadingKey(null);
    }
  }

  function handleContinue() {
    if (!canContinue) {
      setAttempted(true);
      return;
    }
    dispatch({ type: 'next' });
  }

  async function handleRetryVault() {
    setRetryingVault(true);
    try {
      await onVaultChanged();
    } finally {
      setRetryingVault(false);
    }
  }

  const legacyCertDocsUploaded = vaultDocs?.filter((d) => d.doc_type === 'certification_doc') ?? [];
  const legacyCertRowVisible = !hasCerts && (requiredDocs.includes('certification_doc') || optionalDocs.includes('certification_doc'));

  return (
    <div className="grid gap-5">
      <p className="text-sm text-[var(--jale-ink-2)]">{tFlow('hints.documents')}</p>

      {vaultDocs === null ? (
        <InlineFeedback tone="warning">
          <span className="flex flex-wrap items-center gap-2">
            <span>{tWhatYouNeed('vault_check_failed')}</span>
            <Button variant="outline" size="sm" onClick={() => void handleRetryVault()} loading={retryingVault} loadingLabel={tCommon('loading')}>
              {tCommon('retry')}
            </Button>
          </span>
        </InlineFeedback>
      ) : null}

      {/* OUTSIDE the docs list below, deliberately: in the case this exists for
          (`required_docs: ['ssn']`) `docsToShow` is empty and that whole block
          renders nothing, so a notice nested inside it would be invisible
          exactly when it is the only explanation the worker gets. */}
      {unsupportedDocs.length > 0 ? (
        <InlineFeedback tone="warning">
          <span className="font-semibold">
            {unsupportedDocs.map((doc) => (doc === 'ssn' ? tDetail('doc_labels.ssn') : doc)).join(', ')}
          </span>
          {/* A colon, not another em dash: the sentence itself already carries
              one, and two in one line read as a broken clause. */}
          {': '}
          {tFlow('legacy_doc_notice')}
        </InlineFeedback>
      ) : null}

      {docsToShow.length > 0 ? (
        <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
          {docsToShow.map((docType) => (
            <li key={docType} className="p-4">
              <SingleDocRow
                docType={docType}
                docLabel={docLabel}
                existing={vaultDocs?.find((d) => d.doc_type === docType)}
                uploading={uploadingKey === docType}
                onUpload={(file) => void handleUpload(docType, file)}
                required={requiredDocs.includes(docType)}
                missing={attempted && missingLegacyDocs.includes(docType)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {legacyCertRowVisible ? (
        <div className="rounded-[var(--radius-input)] border border-[var(--jale-divider)] p-4">
          <CertificationDocRow
            docLabel={docLabel}
            count={legacyCertDocsUploaded.length}
            uploading={uploadingKey === 'certification_doc'}
            onUpload={(file) => void handleUpload('certification_doc', file)}
            required={requiredDocs.includes('certification_doc')}
            missing={attempted && missingLegacyDocs.includes('certification_doc')}
          />
        </div>
      ) : null}

      {hasCerts ? (
        <div className="grid gap-3">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('groups.certifications')}
          </p>
          {certs.map((cert) => (
            <CertClaimRow
              key={cert.name}
              cert={cert}
              claim={state.certClaims[cert.name] ?? { has: null }}
              onSetHas={(has) => dispatch({ type: 'set_cert_claim', name: cert.name, has })}
              vaultDocs={vaultDocs}
              uploading={uploadingKey === `certification_doc:${cert.name}`}
              onUpload={(file) => void handleUpload('certification_doc', file, cert.name)}
              missingClaim={attempted && missingClaims.includes(cert.name)}
              missingProof={attempted && missingProofs.includes(cert.name)}
            />
          ))}
        </div>
      ) : null}

      {uploadError ? (
        <InlineFeedback tone="danger" onDismiss={() => setUploadError(null)}>{uploadError}</InlineFeedback>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={handleContinue}>{tFlow('continue_button')}</Button>
      </div>
    </div>
  );
}

function SingleDocRow({
  docType, docLabel, existing, uploading, onUpload, required, missing,
}: {
  docType: JobDocType;
  docLabel: (docType: JobDocType) => string;
  existing?: WorkerVaultDoc;
  uploading: boolean;
  onUpload: (file: File) => void;
  required: boolean;
  missing: boolean;
}) {
  const t = useTranslations('job_requirements');
  const tDocs = useTranslations('worker_profile.documents');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  // Same worker-voiced hint the pre-apply "What you'll need" panel shows for
  // this document, so the promise made on the job page and the explanation
  // given inside the flow are one string, not two that can drift. Suppressed
  // once the vault already has the file or the blocking error is showing --
  // both of those lines are more specific than the generic explanation.
  const tWhatYouNeed = useTranslations('worker_job_detail.what_you_need');
  const hintKey = whatYouNeedHintKey({
    kind: 'doc',
    tier: required ? 'required' : 'optional',
    proofRequired: false,
    satisfied: Boolean(existing),
    blockingError: missing,
  });
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--jale-ink)]">
          {docLabel(docType)}
          {!required && (
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
              {t('states.optional')}
            </span>
          )}
        </p>
        <div className="mt-1 flex items-center gap-2">
          {existing ? <Badge tone="success">{tDocs('uploaded')}</Badge> : <Badge tone="neutral">{tDocs('not_uploaded')}</Badge>}
          {uploading && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--jale-ink-2)]">
              <Spinner size="sm" />{tDocs('uploading')}
            </span>
          )}
        </div>
        {missing ? (
          <p className="mt-1 text-xs font-semibold text-[var(--jale-danger)]">
            {tFlow('errors.required_doc', { label: docLabel(docType) })}
          </p>
        ) : null}
        {hintKey ? (
          <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{tWhatYouNeed(hintKey)}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {existing && (
          <a href={existing.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--jale-blue-700)] underline">
            {tDocs('view')}
          </a>
        )}
        <UploadButton disabled={uploading} label={existing ? tDocs('replace') : tDocs('upload')} onFile={onUpload} />
      </div>
    </div>
  );
}

function CertificationDocRow({
  docLabel, count, uploading, onUpload, required, missing,
}: {
  docLabel: (docType: JobDocType) => string;
  count: number;
  uploading: boolean;
  onUpload: (file: File) => void;
  required: boolean;
  missing: boolean;
}) {
  const t = useTranslations('job_requirements');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const atMax = count >= LEGACY_MAX_CERTIFICATION_FILES;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--jale-ink)]">
          {docLabel('certification_doc')}
          {!required && (
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
              {t('states.optional')}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-[var(--jale-ink-2)]">
          {t('apply.certification_count', { count, max: LEGACY_MAX_CERTIFICATION_FILES })}
        </p>
        {missing ? (
          <p className="mt-1 text-xs font-semibold text-[var(--jale-danger)]">
            {tFlow('errors.required_doc', { label: docLabel('certification_doc') })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {uploading && <Spinner size="sm" />}
        <UploadButton disabled={uploading || atMax} label={t('apply.add_certification')} onFile={onUpload} />
      </div>
    </div>
  );
}

/**
 * One named-certification claim row: "Do you have {name}?" yes/no, and (only
 * when claimed yes AND `cert.proof_required`) a proof area -- a vault match
 * (checkmark + reuse, via `matchCertProof`) or an upload affordance capped at
 * `MAX_CERT_FILES_PER_NAME` (migration 078's per-name cap, see this file's
 * header comment).
 *
 * An OPTIONAL cert never blocks (per `certification-claims.ts`'s locked
 * semantics): claimed yes with no proof renders `cert_unverified_note`
 * instead of an error, whether or not `proof_required` is set, because proof
 * is never demanded on an optional cert regardless of that flag. A REQUIRED
 * + proof_required cert claimed yes with no proof renders the blocking
 * `errors.cert_proof` message once the worker has attempted to continue.
 * A cert with `proof_required === false` shows no proof area at all -- the
 * claim itself is the whole requirement, and `cert_attest_note` now says so
 * out loud once the worker answers yes (see `workerCertNoteKey`), because
 * "no upload appeared" is not by itself a legible answer to "does this job
 * want a photo of my card?".
 */
export function CertClaimRow({
  cert, claim, onSetHas, vaultDocs, uploading, onUpload, missingClaim, missingProof,
}: {
  cert: CertRequirement;
  claim: CertClaim;
  onSetHas: (has: boolean) => void;
  vaultDocs: readonly WorkerVaultDoc[] | null;
  uploading: boolean;
  onUpload: (file: File) => void;
  missingClaim: boolean;
  missingProof: boolean;
}) {
  const t = useTranslations('job_requirements');
  const tFlow = useTranslations('worker_job_detail.apply_flow');

  const match = vaultDocs ? matchCertProof(cert.name, vaultDocs) : undefined;
  // `matchCertProof` returns the narrow `VaultDocLike` shape (id/doc_type/
  // cert_name only) -- re-look-up by id against the full `vaultDocs` array to
  // read `file_name` for the "Use {file} from your vault" sentence.
  const matchDoc = match ? vaultDocs?.find((d) => d.id === match.id) : undefined;
  const fileCount = countVaultDocsForCert(cert.name, vaultDocs);
  const atMax = fileCount >= MAX_CERT_FILES_PER_NAME;
  const showProofArea = claim.has === true && cert.proof_required;
  // What happens after "yes" -- the attestation-only case (proof_required
  // false) had NO render site at all before this: the entire explanation of
  // what the claim commits the worker to lived inside `showProofArea`, so a
  // cert the employer is happy to eyeball in person answered "yes" and then
  // said nothing. `workerCertNoteKey` also stays silent on the cases another
  // line already owns (proof attached, optional-tier `cert_unverified_note`,
  // and the blocking `errors.cert_proof`), so the row never stacks two
  // sentences that contradict or repeat each other.
  const certNoteKey = workerCertNoteKey({
    claimed: claim.has,
    tier: cert.tier,
    proofRequired: cert.proof_required,
    hasProof: Boolean(matchDoc),
    blockingError: missingProof,
  });

  return (
    <div className="rounded-[var(--radius-input)] border border-[var(--jale-divider)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">
          {tFlow('cert_question', { name: cert.name })}
        </p>
        <Badge tone={cert.tier === 'required' ? 'info' : 'neutral'}>
          {t(cert.tier === 'required' ? 'states.required' : 'states.optional')}
        </Badge>
      </div>

      <div className="mt-2">
        <YesNo value={claim.has} onChange={onSetHas} ariaLabel={tFlow('cert_question', { name: cert.name })} />
      </div>

      {missingClaim ? (
        <p className="mt-2 text-xs font-semibold text-[var(--jale-danger)]">
          {tFlow('errors.required_cert', { name: cert.name })}
        </p>
      ) : null}

      {certNoteKey ? (
        <p className="mt-2 text-xs text-[var(--jale-ink-2)]">{tFlow(certNoteKey)}</p>
      ) : null}

      {showProofArea ? (
        <div className="mt-3 grid gap-2">
          {matchDoc ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--jale-success)]">
                <Icon name="check" />
                {tFlow('cert_use_vault', { file: matchDoc.file_name })}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {uploading && <Spinner size="sm" />}
              <UploadButton disabled={uploading || atMax} label={tFlow('cert_upload_new')} onFile={onUpload} />
              <span className="text-xs text-[var(--jale-ink-2)]">
                {t('apply.certification_count', { count: fileCount, max: MAX_CERT_FILES_PER_NAME })}
              </span>
            </div>
          )}

          {!matchDoc && cert.tier === 'optional' ? (
            <p className="text-xs text-[var(--jale-ink-2)]">{tFlow('cert_unverified_note')}</p>
          ) : null}

          {!matchDoc && missingProof ? (
            <p className="text-xs font-semibold text-[var(--jale-danger)]">
              {tFlow('errors.cert_proof', { name: cert.name })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
