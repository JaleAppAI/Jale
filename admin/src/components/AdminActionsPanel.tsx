'use client';

import { useState, type FormEvent } from 'react';
import { submitAdminActionState, type AdminActionFormState } from '@/app/actions';
import type { AdminAction } from '@/lib/action-policy';

type CaseTarget = {
  targetType: 'admin_case';
  targetId: string;
  targetStatus: string;
  targetCaseType: string;
};

type VerificationTarget = {
  targetType: 'verification';
  targetId: string;
  targetStatus: string;
  targetStep: string;
};

export type AdminActionsTarget = CaseTarget | VerificationTarget;

type AdminActionsPanelProps = {
  actions: AdminAction[];
  target: AdminActionsTarget;
};

const INITIAL_STATE: AdminActionFormState = { status: 'idle' };

function TargetHiddenInputs({ target }: { target: AdminActionsTarget }) {
  if (target.targetType === 'admin_case') {
    return (
      <>
        <input name="targetType" type="hidden" value="admin_case" />
        <input name="targetId" type="hidden" value={target.targetId} />
        <input name="targetKind" type="hidden" value="case" />
        <input name="targetStatus" type="hidden" value={target.targetStatus} />
        <input name="targetCaseType" type="hidden" value={target.targetCaseType} />
      </>
    );
  }

  return (
    <>
      <input name="targetType" type="hidden" value="verification" />
      <input name="targetId" type="hidden" value={target.targetId} />
      <input name="targetKind" type="hidden" value="verification" />
      <input name="targetStatus" type="hidden" value={target.targetStatus} />
      <input name="targetStep" type="hidden" value={target.targetStep} />
    </>
  );
}

function RevealedContactCard({ state }: { state: AdminActionFormState }) {
  if (state.status !== 'ok' || !state.revealed) {
    return null;
  }

  const { name, phone, email } = state.revealed;

  return (
    <div className="card stack-gap" role="status" aria-live="polite">
      <div className="meta">
        <span className="pill danger">PII revealed</span>
        <span className="muted">Audited · re-masked on refresh</span>
      </div>
      <div className="stack">
        {name ? <span><strong>Name:</strong> {name}</span> : null}
        {phone ? <span><strong>Phone:</strong> {phone}</span> : null}
        {email ? <span><strong>Email:</strong> {email}</span> : null}
        {!name && !phone && !email ? <span className="muted">No contact on file for this subject.</span> : null}
      </div>
    </div>
  );
}

export function AdminActionsPanel({ actions, target }: AdminActionsPanelProps) {
  const [state, setState] = useState<AdminActionFormState>(INITIAL_STATE);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;

    const formData = new FormData(event.currentTarget);
    setIsPending(true);
    try {
      // Server action invoked as an RPC from a client event handler — works on
      // React 18.3 / Next 14 without the React 19-only useActionState hook.
      const next = await submitAdminActionState(state, formData);
      setState(next);
    } catch {
      setState({ status: 'error', message: 'The action could not be completed. Please retry.' });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <RevealedContactCard state={state} />
      {state.status === 'error' && state.message ? (
        <p className="form-error" role="alert">{state.message}</p>
      ) : null}
      {state.status === 'ok' && !state.revealed && state.message ? (
        <p className="muted" role="status">{state.message}</p>
      ) : null}

      <div className="action-form-grid">
        {actions.map((adminAction) => (
          <form className="action-form" key={adminAction.id} onSubmit={handleSubmit}>
            <input name="actionId" type="hidden" value={adminAction.id} />
            <TargetHiddenInputs target={target} />
            <button
              aria-describedby={`${adminAction.id}-description`}
              className={`button${adminAction.dangerous ? ' danger' : ''}`}
              disabled={adminAction.disabled || isPending}
              title={adminAction.reason}
              type="submit"
            >
              {adminAction.label}
            </button>
            {adminAction.piiReveal ? (
              <textarea
                aria-label={`${adminAction.label} justification`}
                disabled={adminAction.disabled || isPending}
                minLength={20}
                name="justification"
                placeholder="Required PII reveal justification"
                required
              />
            ) : (
              <input
                aria-label={`${adminAction.label} note`}
                disabled={adminAction.disabled || isPending}
                name="note"
                placeholder="Optional audit note"
                type="text"
              />
            )}
          </form>
        ))}
      </div>
    </>
  );
}
