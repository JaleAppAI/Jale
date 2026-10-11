import Link from 'next/link';
import { REVEAL_TILE_DAYS } from '@/lib/server/admin-audit';
import { loadAdminDashboard } from '@/lib/server/admin-cases';
import {
  lockoutOutcomeBadge,
  lockoutOutcomeText,
  LOCKOUT_WINDOW_DAYS,
} from '@/lib/server/admin-lockouts';
import { requireAdminSession } from '@/lib/server/session';

export default async function AdminDashboardPage() {
  const session = await requireAdminSession();
  // One recorded read. Each tile keeps its own query (filtering a 200-row page
  // undercounted open cases and reveals once the tables outgrew it), and the
  // cases and lockouts shown are recorded before the page renders.
  const {
    openCaseCount,
    openCases,
    revealCount,
    lockedOutCount,
    stuckCount,
    recentLockouts,
  } = await loadAdminDashboard(session);

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
          <strong>{lockedOutCount}</strong>
          <span>{stuckCount} stuck at the code step</span>
        </article>
        <article className="card kpi">
          <span className="muted">Contact reveals ({REVEAL_TILE_DAYS} days)</span>
          <strong>{revealCount}</strong>
          <span>From the access records</span>
        </article>
      </section>

      <section className="grid two">
        <article className="card">
          <div className="section-title">
            <h2>Open queue</h2>
            <Link className="button" href="/cases" prefetch={false}>View all</Link>
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
                <Link className="button" href={`/cases/${item.id}`} prefetch={false}>Open</Link>
              </div>
            ))}
            {openCases.length === 0 ? <p className="muted">No open cases.</p> : null}
          </div>
        </article>

        <article className="card">
          <div className="section-title">
            <h2>Recent lockouts</h2>
            <Link className="button" href="/verifications" prefetch={false}>View all</Link>
          </div>
          <div className="list">
            {recentLockouts.map((item) => (
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
            {lockedOutCount === 0 ? <p className="muted">No lockouts in the last {LOCKOUT_WINDOW_DAYS} days.</p> : null}
          </div>
        </article>
      </section>
    </main>
  );
}
