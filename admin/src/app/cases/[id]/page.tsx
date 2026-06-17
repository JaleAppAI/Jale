import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminActionsPanel } from '@/components/AdminActionsPanel';
import { getCaseActions } from '@/lib/action-policy';
import { getAdminCase } from '@/lib/server/admin-cases';
import { requireAdminSession } from '@/lib/server/session';

export default async function CaseDetailPage({ params }: { params: { id: string } }) {
  const session = await requireAdminSession();
  const item = await getAdminCase(params.id);
  const role = session.role;

  if (!item) {
    notFound();
  }

  const actions = getCaseActions(item, role);

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge open">{item.type.replace(/_/g, ' ')}</span>
          <span className={`badge ${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
        </div>
        <h1>{item.summary}</h1>
        <p className="muted">
          Worker: {item.workerName} · {item.maskedPhone}{item.maskedEmail ? ` · ${item.maskedEmail}` : ''}
        </p>
        <div className="meta">
          <span>Case {item.caseNumber ?? item.id}</span>
          <span>Conversation {item.conversationId}</span>
          <span>Assigned to {item.assignedAdmin}</span>
          <span>Updated {new Date(item.updatedAt).toLocaleString()}</span>
        </div>
      </section>

      <section className="grid two">
        <article className="card stack-gap">
          <h2>Timeline</h2>
          <div className="timeline">
            {item.timeline.map((event) => (
              <div className="row" key={event.id}>
                <div className="stack">
                  <strong>{event.title}</strong>
                  <span className="muted">{new Date(event.at).toLocaleString()}</span>
                </div>
                <div className="stack">
                  <span className="muted">Actor</span>
                  <span>{event.actor}</span>
                </div>
                <div className="stack">
                  <span className="muted">Details</span>
                  <span>{event.detail}</span>
                </div>
                {event.piiReveal ? <span className="pill danger">PII reveal</span> : null}
              </div>
            ))}
          </div>
        </article>

        <aside className="card stack-gap">
          <h2>Actions</h2>
          <p className="muted">
            Current role: {role.replace(/_/g, ' ')}.
          </p>
          <AdminActionsPanel
            actions={actions}
            target={{
              targetType: 'admin_case',
              targetId: item.id,
              targetStatus: item.status,
              targetCaseType: item.type,
            }}
          />
          <div className="stack-gap">
            {actions.map((adminAction) => (
              <div className="action-note" id={`${adminAction.id}-description`} key={`${adminAction.id}-note`}>
                <strong>{adminAction.label}</strong>
                <span className="muted">{adminAction.description}</span>
                {adminAction.piiReveal ? <span className="pill danger">Justification required</span> : null}
                {adminAction.reason ? <span className="muted">Disabled: {adminAction.reason}</span> : null}
              </div>
            ))}
          </div>
          <div className="stack">
            <span className="muted">Internal notes</span>
            <ul className="list" style={{ paddingLeft: 20, margin: 0 }}>
              {item.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
          <Link className="button" href="/cases">Back to queue</Link>
        </aside>
      </section>
    </main>
  );
}
