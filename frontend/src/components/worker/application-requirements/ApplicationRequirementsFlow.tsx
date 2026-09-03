'use client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { classifyError, errorMessageKey } from '@/lib/api/errors';
import {
  getApplicationDefaults,
  getApplicationRequirements,
  getVaultDocuments,
  postApplicationAnswers,
  postApplicationCertifications,
  postApplicationPromptAnswers,
  type ApplicationRequirementsState,
  type ApplicationSaveResult,
  type WorkerVaultDoc,
} from '@/lib/api/worker';
import {
  answersBatch,
  initRequirementsFlowState,
  requirementsFlowReducer,
  requirementsTotals,
  terminalScreen,
  type RequirementsFlowState,
} from '@/lib/application-requirements-flow';
import { buildCertClaimsPayload } from '@/lib/certification-claims';
import { missingRequiredCertClaims, missingRequiredCertProofs } from '@/lib/certification-claims';
import { missingRequiredFields } from '@/lib/application-answers-form';
import { partitionRequiredDocs } from '@/lib/job-requirements';
import { QuestionsStep } from './QuestionsStep';
import { DocumentsCertificationsStep, proofFilesFromVault } from './DocumentsCertificationsStep';
import { PromptTopUpStep } from './PromptTopUpStep';
import { RequirementsCompleteStep } from './RequirementsCompleteStep';
import { RequirementsProgress } from './RequirementsProgress';
import { RequirementsReviewStep } from './RequirementsReviewStep';
import { RequirementsStepNav } from './RequirementsStepNav';
import { RequirementsTerminalPanel } from './RequirementsTerminalPanel';

/**
 * The one stateful component of the stage-2 door: it owns the reducer and
 * every network call, and everything below it is props.
 *
 * IT MIRRORS `OnboardingFlow`, deliberately, because it is the same kind of
 * thing -- a SECOND DOOR onto an engine the worker can also drive over
 * WhatsApp. The same worker can be answering the same question in chat while
 * this tab is open, so the server document is the source of truth for what is
 * still owed, every write returns the whole document, and the flow re-reads
 * rather than guessing.
 *
 * WHERE IT DIFFERS FROM `OnboardingFlow`, and why:
 *
 *  - NO LOCK VERSION, so no conflict-and-retry. B4.0 #4: the merges commute,
 *    prompt answers are write-once in SQL and `details_completed_at` is
 *    guarded by `IS NULL`. The only refusal is `blocked`, which already
 *    carries the fresh state -- there is nothing to retry and nothing to race.
 *  - THE STEP IS LOCAL, not server-driven. `next_step` exists and is read
 *    LOOSELY by design (see its type); the web door shows three panels in a
 *    fixed order because a form is easier to fill than a chat transcript, and
 *    it seeds the opening panel from `remaining` (`initialStepIndex`) so a
 *    worker who only owes a document is not walked back through answers.
 *  - THERE IS NO "POST COMPLETE". `details_completed_at` flips server-side the
 *    moment nothing remains, including on a GET after a vault upload. Finish
 *    is therefore a RE-READ: if the timestamp came back set, show the
 *    completion screen; if not, say what is still missing rather than claim
 *    success.
 *
 * SAVES ARE PARTIAL AND TOUCHED-ONLY (`answersBatch`), chunked at the door's
 * 20-key cap. Re-sending an untouched key would be this door overwriting what
 * the other one stored.
 */
export function ApplicationRequirementsFlow({
  token,
  initialState,
}: {
  token: string;
  initialState: ApplicationRequirementsState;
}) {
  const router = useRouter();
  const t = useTranslations('worker_application_details');
  const tCommon = useTranslations('common');

  const [flow, dispatch] = useReducer(requirementsFlowReducer, initialState, initRequirementsFlowState);
  const [vaultDocs, setVaultDocs] = useState<readonly WorkerVaultDoc[] | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const applicationId = flow.server.application.id;
  const { job } = flow.server;

  // ---------------------------------------------------------------------
  // Vault
  // ---------------------------------------------------------------------
  // The documents step needs real vault DOC IDS to attach certification proof
  // (`CertificationClaim.doc_ids`), which the state document's
  // `documents[].present` booleans cannot supply -- so this fetch runs
  // alongside the page's own, exactly as the job detail page does it.
  const fetchVaultDocs = useCallback(async () => {
    try {
      const { documents } = await getVaultDocuments(token);
      setVaultDocs(documents);
    } catch {
      setVaultDocs(null);
    }
  }, [token]);

  useEffect(() => { void fetchVaultDocs(); }, [fetchVaultDocs]);

  /**
   * A vault change can flip `details_completed_at` on its own (the GET
   * recomputes presence), so an upload is followed by BOTH a vault refetch and
   * a state re-read. `sync_server`, not `hydrate`: the worker may be mid-edit
   * on another field and rebuilding the draft would delete their typing.
   */
  async function handleVaultChanged() {
    await fetchVaultDocs();
    try {
      dispatch({ type: 'sync_server', server: await getApplicationRequirements(token, applicationId) });
    } catch {
      // The upload itself succeeded and the vault list is already refreshed;
      // a failed re-read is a stale counter, not a lost file.
    }
  }

  // ---------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------
  // Merged at most ONCE, and only when the server had no answers of its own.
  // The backend now seeds `worker_application_defaults` into the application
  // when the employer arms the stage (B4.0 #9), so on nearly every real load
  // `serverAnswered` is already true and this never fires -- it is the
  // fallback for an application armed before that seeding existed.
  const defaultsTriedRef = useRef(false);
  useEffect(() => {
    if (defaultsTriedRef.current) return;
    if (flow.serverAnswered) return;
    defaultsTriedRef.current = true;
    void getApplicationDefaults(token)
      .then((defaults) => dispatch({ type: 'apply_defaults', defaults: defaults.answers }))
      // A convenience prefill, never a blocker -- the same contract the job
      // page's old defaults fetch had.
      .catch(() => {});
  }, [token, flow.serverAnswered]);

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  /**
   * The one place a `ApplicationSaveResult` is turned into state. Returns the
   * saved state on success and `null` on every refusal, so a caller can simply
   * stop.
   */
  function consume(result: ApplicationSaveResult): ApplicationRequirementsState | null {
    switch (result.kind) {
      case 'saved':
        return result.state;
      case 'invalid':
        dispatch({ type: 'invalid', errors: result.errors });
        return null;
      case 'blocked':
        // The stage closed under them. The fresh state's own terminal panel is
        // the message -- no error line on top of it.
        dispatch({ type: 'blocked', server: result.state });
        return null;
      case 'too_large':
        setInlineError(t('errors.too_large'));
        dispatch({ type: 'save_failed', errorKind: 'server' });
        return null;
      case 'certification_document_limit':
        setInlineError(t('errors.certification_document_limit'));
        dispatch({ type: 'save_failed', errorKind: 'server' });
        return null;
      case 'not_found':
        setInlineError(t('errors.not_found'));
        dispatch({ type: 'save_failed', errorKind: 'not_found' });
        return null;
    }
  }

  async function saveFields(advance: boolean) {
    const batches = answersBatch(flow);
    if (batches.length === 0) {
      if (advance) dispatch({ type: 'next' });
      return;
    }

    setInlineError(null);
    dispatch({ type: 'saving' });
    try {
      let latest: ApplicationRequirementsState | null = null;
      // In ORDER, hydrating from the last: the door caps a batch at 20 keys
      // and rejects a bigger one outright, so `answersBatch` chunks.
      for (const batch of batches) {
        latest = consume(await postApplicationAnswers(token, applicationId, batch));
        if (latest === null) return;
      }
      if (latest === null) return;
      dispatch({ type: 'hydrate', server: latest });
      if (advance) dispatch({ type: 'next' });
    } catch (err) {
      dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
    }
  }

  async function saveCerts() {
    const certs = job.certification_requirements;
    if (certs.length === 0) {
      dispatch({ type: 'next' });
      return;
    }

    setInlineError(null);
    dispatch({ type: 'saving' });
    try {
      const claims = buildCertClaimsPayload(certs, flow.certClaims, proofFilesFromVault(certs, vaultDocs));
      const saved = consume(await postApplicationCertifications(token, applicationId, claims));
      if (saved === null) return;
      dispatch({ type: 'hydrate', server: saved });
      dispatch({ type: 'next' });
    } catch (err) {
      dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
    }
  }

  async function savePromptAnswers(answers: Record<string, string>) {
    setInlineError(null);
    dispatch({ type: 'saving' });
    try {
      const saved = consume(await postApplicationPromptAnswers(token, applicationId, answers));
      if (saved === null) return;
      dispatch({ type: 'hydrate', server: saved });
    } catch (err) {
      dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
    }
  }

  /**
   * FINISH IS A RE-READ, not a write. There is no "POST complete": the door
   * sets `details_completed_at` itself the moment nothing remains, so the only
   * honest way to report completion is to ask.
   */
  async function finish() {
    setInlineError(null);
    dispatch({ type: 'saving' });
    try {
      dispatch({ type: 'finished', server: await getApplicationRequirements(token, applicationId) });
    } catch (err) {
      dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
    }
  }

  // ---------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------
  const totals = requirementsTotals(flow.server);
  const terminal = terminalScreen(flow.server);
  const outstandingPrompts = job.pre_application_prompts.filter(
    (p) => flow.server.remaining.prompts.includes(p.id),
  );

  const certs = job.certification_requirements;
  const proofFiles = proofFilesFromVault(certs, vaultDocs);
  const { supported: supportedDocs } = partitionRequiredDocs(job.required_docs);
  const hasDoc = (docType: string) => vaultDocs?.some((d) => d.doc_type === docType) ?? false;
  const missingDocs = Array.from(new Set(supportedDocs)).filter(
    (doc) => (certs.length > 0 ? doc !== 'certification_doc' : true) && !hasDoc(doc),
  );

  const canLeaveDetails = missingRequiredFields(job.required_fields, flow.draft).length === 0;
  const canLeaveDocuments = (
    missingDocs.length === 0 &&
    missingRequiredCertClaims(certs, flow.certClaims).length === 0 &&
    missingRequiredCertProofs(certs, flow.certClaims, proofFiles).length === 0
  );

  const errorText = flow.errorKind ? tCommon(errorMessageKey(flow.errorKind)) : null;
  const companyName = job.company_name;

  const header = (
    <>
      <Link
        href="/worker/applications"
        className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
      >
        {t('back')}
      </Link>
      <div>
        <h1 className="text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
          {t('title')}
        </h1>
        <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
          {companyName
            ? t('subtitle', { company: companyName, job: job.title ?? '' })
            : t('subtitle_no_company', { job: job.title ?? '' })}
        </p>
      </div>
    </>
  );

  return (
    <DashboardPanel>
      <div className="space-y-5 p-5 md:p-6">
        {/* ORDER MATTERS, and it is not the obvious one. A worker who finishes
            HERE has, by definition, just set `details_completed_at` -- which
            makes `terminalScreen` return `already_complete`. Checking the
            terminal first would swap their completion screen for the flat
            "nothing left to do, you already sent everything" panel meant for
            someone ARRIVING at a finished application. So `finished` wins,
            with one exception ahead of it: a job that closed under them is
            worth saying whatever else happened. */}
        {terminal === 'closed' ? (
          <>
            <Link
              href="/worker/applications"
              className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
            >
              {t('back')}
            </Link>
            <RequirementsTerminalPanel screen="closed" companyName={companyName} jobId={job.id} />
          </>
        ) : flow.finished === 'complete' ? (
          <RequirementsCompleteStep companyName={companyName} jobId={job.id} />
        ) : terminal !== null ? (
          <>
            <Link
              href="/worker/applications"
              className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
            >
              {t('back')}
            </Link>
            <RequirementsTerminalPanel
              screen={terminal}
              companyName={companyName}
              jobId={job.id}
            />
          </>
        ) : outstandingPrompts.length > 0 ? (
          <>
            {header}
            <PromptTopUpStep
              prompts={outstandingPrompts}
              companyName={companyName}
              saving={flow.saving}
              error={inlineError ?? errorText}
              onSubmit={(answers) => void savePromptAnswers(answers)}
            />
          </>
        ) : (
          <>
            {header}

            {/* The other door moved while this tab was open (W4f). Info, not a
                warning: nothing went wrong, and the newer answers are already
                on screen. */}
            {flow.notice === 'other_door' ? (
              <InlineFeedback tone="info">{t('notice.other_door')}</InlineFeedback>
            ) : null}

            <RequirementsProgress totals={totals} />

            <RequirementsStepNav
              stepIndex={flow.stepIndex}
              onGoto={(index) => dispatch({ type: 'goto', index })}
              canLeaveDetails={canLeaveDetails}
              canLeaveDocuments={canLeaveDocuments}
            />

            {inlineError ? (
              <InlineFeedback tone="danger" onDismiss={() => setInlineError(null)}>
                {inlineError}
              </InlineFeedback>
            ) : null}
            {errorText && !inlineError ? (
              <InlineFeedback tone="danger">{errorText}</InlineFeedback>
            ) : null}

            {/* Two failed saves in a row and the flow stops insisting: every
                answered field is already stored, so offer the way out rather
                than leave a worker pressing a button that keeps failing. The
                same rule `OnboardingFlow` follows. */}
            {flow.failures >= 2 ? (
              <Button variant="ghost" onClick={() => router.replace('/worker/applications')}>
                {t('back')}
              </Button>
            ) : null}

            {flow.stepIndex === 0 ? (
              <QuestionsStep
                requiredFields={job.required_fields}
                optionalFields={job.optional_fields}
                state={flow}
                dispatch={dispatch}
                onContinue={() => void saveFields(true)}
                saving={flow.saving}
                invalidFields={flow.invalidFields}
              />
            ) : flow.stepIndex === 1 ? (
              <DocumentsCertificationsStep
                requirements={{
                  required_docs: job.required_docs,
                  optional_docs: job.optional_docs,
                  certification_requirements: certs,
                }}
                certClaims={flow.certClaims}
                dispatch={dispatch}
                token={token}
                vaultDocs={vaultDocs}
                onVaultChanged={handleVaultChanged}
                onContinue={() => void saveCerts()}
              />
            ) : (
              <RequirementsReviewStep
                state={flow}
                totals={totals}
                saving={flow.saving}
                onFinish={() => void finish()}
                onGotoDocuments={() => dispatch({ type: 'goto', index: 1 })}
              />
            )}
          </>
        )}
      </div>
    </DashboardPanel>
  );
}

export type { RequirementsFlowState };
