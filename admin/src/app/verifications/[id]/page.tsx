import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminActionsPanel } from '@/components/AdminActionsPanel';
import { getVerificationActions } from '@/lib/action-policy';
import { getVerificationRecord } from '@/lib/server/admin-verifications';
import { requireAdminSession } from '@/lib/server/session';

export default async function VerificationDetailPage({ params }: { params: { id: string } }) {
  const session = await requireAdminSession();
  const item = await getVerificationRecord(params.id);
  const role = session.role;

  if (!item) {
    notFound();
  }

  const actions = getVerificationActions(item, role);

  return (
    <main className="grid two">
      <section className="card stack-gap">
        <div className="meta">
          <span className="badge open">{item.subjectType}</span>
          <span className={`badge ${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
        </div>
        <h1>{item.subjectName}</h1>
        <p className="muted">{item.subjectLabel}</p>
        <div className="stack">
          <span className="muted">Current step</span>
          <strong>{item.step}</strong>
        </div>
        <div className="stack">
          <span className="muted">Reason</span>
          <span>{item.reason}</span>
        </div>
        <div className="stack">
          <span className="muted">Assigned admin</span>
          <span>{item.assignedAdmin}</span>
        </div>
      </section>

      <aside className="card stack-gap">
        <h2>Actions</h2>
        <p className="muted">Current role: {role.replace(/_/g, ' ')}.</p>
        <AdminActionsPanel
          actions={actions}
          target={{
            targetType: 'verification',
            targetId: item.id,
            targetStatus: item.status,
            targetStep: item.step,
          }}
        />
        <div className="stack-gap">
          {actions.map((adminAction) => (
            <div className="action-note" id={`${adminAction.id}-description`} key={`${adminAction.id}-note`}>
              <strong>{adminAction.label}</strong>
              <span className="muted">{adminAction.description}</span>
              {adminAction.reason ? <span className="muted">Disabled: {adminAction.reason}</span> : null}
            </div>
          ))}
        </div>
        <div className="stack">
          <span className="muted">Contact</span>
          <span>{item.maskedPhone ?? item.maskedEmail ?? 'Masked until revealed'}</span>
        </div>
        <Link className="button" href="/verifications">Back to verifications</Link>
      </aside>
    </main>
  );
}
