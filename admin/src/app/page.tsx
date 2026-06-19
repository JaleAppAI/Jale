import Link from 'next/link';
import { listAdminCases } from '@/lib/server/admin-cases';
import { listAuditEvents } from '@/lib/server/admin-audit';
import { listVerificationRecords } from '@/lib/server/admin-verifications';
import { requireAdminSession } from '@/lib/server/session';

export default async function AdminDashboardPage() {
  await requireAdminSession();
  const [{ rows: adminCases }, { rows: auditEvents }, { rows: verificationRecords }] = await Promise.all([
    listAdminCases(),
    listAuditEvents(),
    listVerificationRecords(),
  ]);

  const openCases = adminCases.filter((item) => item.status !== 'resolved' && item.status !== 'dismissed');
  const pendingVerifications = verificationRecords.filter((item) => item.status !== 'approved');
  const piiReveals = auditEvents.filter((event) => event.piiReveal);

  return (
    <main className="stack-gap">
      <section className="hero">
        <h1>Admin dashboard</h1>
        <p className="muted" style={{ marginTop: 6 }}>Queue health at a glance</p>
      </section>

      <section className="grid three">
        <article className="card kpi">
          <span className="muted">Open cases</span>
          <strong>{openCases.length}</strong>
          <span>Need review</span>
        </article>
        <article className="card kpi">
          <span className="muted">Pending verifications</span>
          <strong>{pendingVerifications.length}</strong>
          <span>Awaiting action</span>
        </article>
        <article className="card kpi">
          <span className="muted">Audit events</span>
          <strong>{piiReveals.length}</strong>
          <span>Reveal events</span>
        </article>
      </section>

      <section className="grid two">
        <article className="card">
          <div className="section-title">
            <h2>Open queue</h2>
            <Link className="button" href="/cases">View all</Link>
          </div>
          <div className="list">
            {openCases.slice(0, 3).map((item) => (
              <div className="case-row" key={item.id}>
                <div className="stack">
                  <strong>{item.summary}</strong>
                  <span className="muted">{item.workerName} · {item.maskedPhone}</span>
                  <span className={`badge ${item.status}`}>{item.status}</span>
                </div>
                <div className="stack">
                  <span className="muted">Case type</span>
                  <span>{item.type.replace(/_/g, ' ')}</span>
                </div>
                <div className="stack">
                  <span className="muted">Assigned admin</span>
                  <span>{item.assignedAdmin}</span>
                </div>
                <Link className="button" href={`/cases/${item.id}`}>Open</Link>
              </div>
            ))}
            {openCases.length === 0 ? <p className="muted">No open cases.</p> : null}
          </div>
        </article>

        <article className="card">
          <div className="section-title">
            <h2>Verification queue</h2>
            <Link className="button" href="/verifications">View all</Link>
          </div>
          <div className="list">
            {pendingVerifications.slice(0, 3).map((item) => (
              <div className="verification-row" key={item.id}>
                <div className="stack">
                  <strong>{item.subjectName}</strong>
                  <span className="muted">{item.reason}</span>
                  <span className={`badge ${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
                </div>
                <div className="stack">
                  <span className="muted">Step</span>
                  <span>{item.step}</span>
                </div>
                <div className="stack">
                  <span className="muted">Assigned admin</span>
                  <span>{item.assignedAdmin}</span>
                </div>
                <Link className="button" href={`/verifications/${item.id}`}>Review</Link>
              </div>
            ))}
            {pendingVerifications.length === 0 ? <p className="muted">No pending verifications.</p> : null}
          </div>
        </article>
      </section>
    </main>
  );
}
