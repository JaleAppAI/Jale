import Link from 'next/link';
import { listAdminCases } from '@/lib/server/admin-cases';
import { requireAdminSession } from '@/lib/server/session';

const statusTone: Record<string, string> = {
  open: 'open',
  pending_admin: 'pending_admin',
  pending_worker: 'pending_worker',
  resolved: 'resolved',
  dismissed: 'dismissed',
};

export default async function CasesPage() {
  await requireAdminSession();
  const adminCases = await listAdminCases();

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge verification">Cases</span>
        </div>
        <h1>Cases</h1>
      </section>

      <section className="card stack-gap">
        {adminCases.map((item) => (
          <div className="case-row" key={item.id}>
            <div className="stack">
              <strong>{item.summary}</strong>
              <span className="muted">{item.workerName} · {item.workerLabel}</span>
              <span className="meta">
                <span>Case {item.caseNumber ?? item.id}</span>
                <span>Conversation {item.conversationId}</span>
              </span>
            </div>
            <div className="stack">
              <span className="muted">Status</span>
              <span className={`badge ${statusTone[item.status] ?? item.status}`}>{item.status.replace(/_/g, ' ')}</span>
              <span className="muted">Priority {item.priority}</span>
            </div>
            <div className="stack">
              <span className="muted">Last message</span>
              <span>{item.lastMessage}</span>
              <span className="muted">{item.maskedPhone}</span>
            </div>
            <Link className="button" href={`/cases/${item.id}`}>Open case</Link>
          </div>
        ))}
        {adminCases.length === 0 ? <p className="muted">No admin cases found.</p> : null}
      </section>
    </main>
  );
}
