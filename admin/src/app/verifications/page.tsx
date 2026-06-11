import Link from 'next/link';
import { listVerificationRecords } from '@/lib/server/admin-verifications';
import { requireAdminSession } from '@/lib/server/session';

export default async function VerificationsPage() {
  await requireAdminSession();
  const verificationRecords = await listVerificationRecords();

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge verification">Verifications</span>
        </div>
        <h1>Verification queue</h1>
      </section>

      <section className="card stack-gap">
        {verificationRecords.map((item) => (
          <div className="verification-row" key={item.id}>
            <div className="stack">
              <strong>{item.subjectName}</strong>
              <span className="muted">{item.subjectLabel}</span>
              <span className="muted">{item.reason}</span>
            </div>
            <div className="stack">
              <span className="muted">Status</span>
              <span className={`badge ${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
              <span className="muted">Step {item.step}</span>
            </div>
            <div className="stack">
              <span className="muted">Contact</span>
              <span>{item.maskedPhone ?? item.maskedEmail ?? 'Masked'}</span>
              <span className="muted">Updated {new Date(item.updatedAt).toLocaleString()}</span>
            </div>
            <Link className="button" href={`/verifications/${item.id}`}>Review</Link>
          </div>
        ))}
        {verificationRecords.length === 0 ? <p className="muted">No verification records found.</p> : null}
      </section>
    </main>
  );
}
