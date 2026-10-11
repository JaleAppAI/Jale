import { listAuditEvents } from '@/lib/server/admin-audit';
import { requireAdminSession } from '@/lib/server/session';

export default async function AuditPage() {
  await requireAdminSession();
  const { rows: auditEvents, totalCount } = await listAuditEvents();

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge verification">Audit log</span>
        </div>
        <h1>Operational audit trail</h1>
      </section>

      <section className="card stack-gap">
        {auditEvents.map((event) => (
          <div className="audit-row" key={event.id}>
            <div className="stack">
              <strong>{event.summary}</strong>
              <span className="muted">{new Date(event.at).toLocaleString()}</span>
            </div>
            <div className="stack">
              <span className="muted">Actor</span>
              <span>{event.actor}</span>
              <span className={event.piiReveal ? 'pill danger' : 'pill'}>{event.piiReveal ? 'PII reveal' : 'Mutation'}</span>
            </div>
            <div className="stack">
              <span className="muted">Target</span>
              <span>{event.targetType}</span>
              <span>{event.targetId}</span>
            </div>
            <div className="stack">
              <span className="muted">Action</span>
              <span>{event.action}</span>
            </div>
          </div>
        ))}
        {auditEvents.length === 0 ? <p className="muted">No audit events found.</p> : null}
        {totalCount > auditEvents.length ? (
          <p className="muted">Showing {auditEvents.length} of {totalCount}</p>
        ) : null}
      </section>
    </main>
  );
}
