'use client';
import { useEffect, useRef, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import type { ApplyFlowAction, ApplyFlowState } from '@/lib/apply-flow-view';
import { missingRequiredFields } from '@/lib/application-answers-form';
import { missingRequiredCertClaims, missingRequiredCertProofs } from '@/lib/certification-claims';
import { partitionRequiredDocs } from '@/lib/job-requirements';
import type { ApplicationDefaults, JobDetail, WorkerVaultDoc } from '@/lib/api/worker';
import { ApplyStepNav } from './ApplyStepNav';
import { QuestionsStep } from './QuestionsStep';
import { DocumentsCertificationsStep, proofFilesFromVault } from './DocumentsCertificationsStep';
import { ReviewStep, type ApplyFlowSubmitError, type ApplyFlowSubmitPayload } from './ReviewStep';

export type { ApplyFlowSubmitError, ApplyFlowSubmitPayload };

/**
 * PROPS CONTRACT -- read this before wiring the Wave-3 page integration.
 *
 * `ApplyFlow` is a CONTROLLED component tree: every piece of flow data
 * (`state`) and vault content (`vaultDocs`) is a prop, mutated only by
 * dispatching to the parent-owned `ApplyFlowState` reducer
 * (`lib/apply-flow-view.ts`) or by calling `onVaultChanged`. It holds NO
 * `useState` for flow data and runs no reset-on-open effect -- the named
 * anti-pattern in the old `ApplicationAnswersForm` modal, whose
 * `useEffect(() => { setDraft(emptyAnswerDraft()); ... }, [open, ...])`
 * clobbers state every time the gate opens. Resetting on a job-id change is
 * the PARENT's job: dispatch `{ type: 'reset', certNames }` (or remount this
 * tree keyed on `job.id`) when `job.id` changes, the same place `usePageData`
 * already keys its own refetch off `deps: [id]` in the worker job detail
 * page today.
 *
 * ONE exception below, NOT a violation of the above: a `useEffect` applies
 * `defaults` into the draft exactly once PER `job.id` via
 * `dispatch({ type: 'apply_defaults', ... })`, guarded by a `useRef` (not
 * dep-array identity -- `defaults` is fetched by the parent and there is no
 * contract forcing it to be a stable reference; guarding on identity alone
 * would re-fire, and re-dispatch, on every render where the caller builds
 * that object inline). This SYNCHRONIZES external prop data (an async fetch
 * the parent owns) into the reducer -- it holds no local flow state of its
 * own and never clears anything -- a different shape from the anti-pattern
 * (wiping existing state on a UI-open event).
 *
 * Local `useState` DOES appear one level down, in `QuestionsStep` and
 * `DocumentsCertificationsStep` (an `attempted`/`uploadingKey`/`uploadError`
 * flag apiece). That is NOT flow data either -- it is transient "did the
 * worker just try to continue" / "which upload is in flight" UI state with
 * nowhere else to live in a controlled tree, and none of it needs to survive
 * a remount.
 *
 * PROP LIST, WITH TWO ADDITIONS BEYOND THE ORIGINAL TASK SPEC (both required
 * for requirement 4's upload plumbing to actually work -- call these out to
 * Wave-3 prominently, they are not optional extras):
 *
 *   - `job`, `state`, `dispatch`, `vaultDocs`, `defaults`, `onSubmit`,
 *     `submitting`, `submitError`, `onBackToDetails` -- as specified.
 *   - `token: string` -- ADDED. `getAuthUploadUrl`/`confirmAuthUpload`
 *     (`lib/api/worker.ts`) both require an auth token as their first
 *     argument, and `DocumentsCertificationsStep` cannot reach `useAuth()`
 *     itself without breaking the controlled-props contract for a value the
 *     page already holds (`idToken`, per `worker/jobs/[id]/page.tsx`).
 *   - `onVaultChanged: () => void | Promise<void>` -- ADDED. Because
 *     `vaultDocs` is a PROP (not local state), this tree cannot update it
 *     after a successful upload the way the old modal's own
 *     `setVaultDocs(documents)` did. `DocumentsCertificationsStep` calls this
 *     after every successful `confirmAuthUpload` so the parent can refetch
 *     `getVaultDocuments` and pass the refreshed array back down as
 *     `vaultDocs` on the next render. There is necessarily a brief window
 *     between a successful upload and the refetch landing where the vault
 *     has not visibly updated yet -- accepted latency, not a bug.
 *
 * `vaultDocs === null` means the vault fetch failed or has not completed;
 * every consumer here treats that as "cannot verify" and fails CLOSED for
 * gating purposes (a required doc/cert proof that cannot be checked counts
 * as still missing), and `DocumentsCertificationsStep` renders a "Try again"
 * button next to its `vault_check_failed` notice that calls `onVaultChanged`
 * again -- so a fetch failure degrades to a recoverable state, not a dead
 * end with no way to reach Submit.
 *
 * `defaults` is `getApplicationDefaults()`'s return shape
 * (`{ answers, updated_at? }`) or `null` while it is loading / failed to load
 * (that call's own doc comment says failures are swallowed by the caller,
 * never a blocker to applying) -- only `.answers` is read here.
 *
 * `onSubmit` receives a fully-built `ApplyFlowSubmitPayload` (see
 * `ReviewStep.tsx`) -- a 1:1 map onto `applyToJob`'s `answers`/
 * `certification_claims` params, so the integration is a straight
 * pass-through: `applyToJob(token, id, payload.answers, payload.certification_claims)`.
 *
 * `submitError`'s shape (`ApplyFlowSubmitError`, defined in `ReviewStep.tsx`
 * and re-exported here) is ALSO a WK-T3-defined contract, not specified by
 * the task brief -- see that file's doc comment for the full rationale and
 * the one unwired backend/lib prerequisite (`lib/api/errors.ts`'s payload
 * allowlist has no `certs` key yet, so a real `missing_certification_proof`
 * response cannot reach this shape until that lib file is updated).
 */
export type ApplyFlowProps = {
  job: JobDetail;
  /** ADDED beyond the task spec's prop list -- see doc comment above. */
  token: string;
  state: ApplyFlowState;
  dispatch: Dispatch<ApplyFlowAction>;
  /** `null` = vault fetch failed or not yet loaded; every check here fails CLOSED on `null`. */
  vaultDocs: readonly WorkerVaultDoc[] | null;
  /** ADDED beyond the task spec's prop list -- see doc comment above. */
  onVaultChanged: () => void | Promise<void>;
  defaults: ApplicationDefaults | null;
  onSubmit: (payload: ApplyFlowSubmitPayload) => void;
  submitting: boolean;
  submitError: ApplyFlowSubmitError | null;
  onBackToDetails: () => void;
};

export function ApplyFlow({
  job, token, state, dispatch, vaultDocs, onVaultChanged, defaults,
  onSubmit, submitting, submitError, onBackToDetails,
}: ApplyFlowProps) {
  const t = useTranslations('worker_job_detail.apply_flow');

  // Sync `defaults` into the draft exactly once per `job.id` -- see this
  // file's prop-contract doc comment for why this is not the reset-on-open
  // anti-pattern `ApplicationAnswersForm` had. Guarded on `job.id` via a ref
  // (not `defaults` identity) so a caller that builds `defaults` inline
  // every render (e.g. `defaults={data ?? { answers: {} }}`) cannot turn this
  // into a dispatch-render-dispatch loop -- `apply_defaults` always returns a
  // new state object, so an identity-only guard would refire every render.
  const appliedDefaultsForJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!defaults) return;
    if (appliedDefaultsForJobRef.current === job.id) return;
    appliedDefaultsForJobRef.current = job.id;
    dispatch({ type: 'apply_defaults', defaults: defaults.answers });
  }, [defaults, job.id, dispatch]);

  const requiredFields = job.required_fields ?? [];
  const requiredDocs = job.required_docs ?? [];
  const certs = job.certification_requirements ?? [];
  const hasCerts = certs.length > 0;

  const canAdvanceFromQuestions = missingRequiredFields(requiredFields, state.draft).length === 0;

  const proofFiles = proofFilesFromVault(certs, vaultDocs);
  const hasDoc = (docType: string) => vaultDocs?.some((d) => d.doc_type === docType) ?? false;
  // Only keys the flow can actually offer an upload for may gate it: a legacy
  // 'ssn' entry (still valid in the jobs CHECK for old rows) is filtered out
  // of `DocumentsCertificationsStep`'s render list, so gating on it blocked
  // the step forever with nothing on screen to fix. The step surfaces the
  // unsupported keys as a visible notice instead.
  const { supported: supportedDocs } = partitionRequiredDocs(requiredDocs);
  // Layered ON TOP of that partition, not folded into it: `certification_doc`
  // is a supported key, and this is the separate defensive exclusion -- a
  // new-shape job must never carry it in `required_docs` once it has named
  // certs (job-requirements.ts's own invariant).
  // Deduped, matching `DocumentsCertificationsStep`'s own gate: `required_docs`
  // is raw wire data whose CHECK does not forbid a repeat, and the two lists
  // must agree exactly or the step nav would offer a Continue the step itself
  // refuses (or the reverse).
  const missingLegacyDocs = Array.from(new Set(supportedDocs)).filter(
    (doc) => (hasCerts ? doc !== 'certification_doc' : true) && !hasDoc(doc),
  );
  const canAdvanceFromDocuments = (
    missingLegacyDocs.length === 0 &&
    missingRequiredCertClaims(certs, state.certClaims).length === 0 &&
    missingRequiredCertProofs(certs, state.certClaims, proofFiles).length === 0
  );

  return (
    <DashboardPanel>
      <div className="space-y-5 p-5 md:p-6">
        <button
          type="button"
          onClick={onBackToDetails}
          className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
        >
          {t('back_to_details')}
        </button>

        <ApplyStepNav
          state={state}
          dispatch={dispatch}
          canAdvanceFromQuestions={canAdvanceFromQuestions}
          canAdvanceFromDocuments={canAdvanceFromDocuments}
        />

        {state.stepIndex === 0 ? (
          <QuestionsStep job={job} state={state} dispatch={dispatch} />
        ) : state.stepIndex === 1 ? (
          <DocumentsCertificationsStep
            job={job}
            state={state}
            dispatch={dispatch}
            token={token}
            vaultDocs={vaultDocs}
            onVaultChanged={onVaultChanged}
          />
        ) : (
          <ReviewStep
            job={job}
            state={state}
            vaultDocs={vaultDocs}
            onSubmit={onSubmit}
            submitting={submitting}
            submitError={submitError}
          />
        )}
      </div>
    </DashboardPanel>
  );
}
