import Link from 'next/link';
import { countPiiRevealEvents } from '@/lib/server/admin-audit';
import { countOpenAdminCases, listOpenAdminCases } from '@/lib/server/admin-cases';
import {
  listIdentityLockouts,
  lockoutOutcomeBadge,
  lockoutOutcomeText,
  LOCKOUT_WINDOW_DAYS,
} from '@/lib/server/admin-lockouts';
import { requireAdminSession } from '@/lib/server/session';

export default async function AdminDashboardPage() {
  await requireAdminSession();
  // Each tile has its own query: filtering a 200-row page undercounted open
  // cases and reveals once the tables outgrew it (roadmap audit finding 7).
  const [openCaseCount, openCases, piiRevealCount, lockouts] = await Promise.all([
    countOpenAdminCases(),
    listOpenAdminCases(3),
    countPiiRevealEvents(),
    listIdentityLockouts(),
  ]);

  const lockedOut = lockouts.filter((item) => item.kind === 'lockout');
  const stuckCount = lockouts.length - lockedOut.length;

  return (
    <main className="stack-gap">
      <section className="hero">
        <h1>Admin dashboard</h1>
        <p className="muted" style={{ marginTop: 6 }}>Queue health at a glance</p>
      </section>

      <section className="grid three">
        <article className="card kpi">
          <span className="muted">Open cases</span>
          <strong>{openCaseCount}</strong>
          <span>Need review</span>
        </article>
        <article className="card kpi">
          <span className="muted">Locked out ({LOCKOUT_WINDOW_DAYS} days)</span>
          <strong>{lockedOut.length}</strong>
          <span>{stuckCount} stuck at the code step</span>
        </article>
        <article className="card kpi">
          <span className="muted">Audit events</span>
          <strong>{piiRevealCount}</strong>
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
            {openCases.map((item) => (
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
            <h2>Recent lockouts</h2>
            <Link className="button" href="/verifications">View all</Link>
          </div>
          <div className="list">
            {lockedOut.slice(0, 3).map((item) => (
              <div className="verification-row" key={item.challengeId}>
                <div className="stack">
                  <strong>{item.maskedPhone ?? 'Unknown number'}</strong>
                  <span className={`badge ${lockoutOutcomeBadge(item.outcome)}`}>{lockoutOutcomeText(item)}</span>
                </div>
                <div className="stack">
                  <span className="muted">Lockouts</span>
                  <span>{item.lockoutCount}</span>
                </div>
                <div className="stack">
                  <span className="muted">Last lockout</span>
                  <span>{new Date(item.lastEventAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
            {lockedOut.length === 0 ? <p className="muted">No lockouts in the last {LOCKOUT_WINDOW_DAYS} days.</p> : null}
          </div>
        </article>
      </section>
    </main>
  );
}
