import {
  listIdentityLockouts,
  lockoutOutcomeBadge,
  lockoutOutcomeText,
  LOCKOUT_WINDOW_DAYS,
} from '@/lib/server/admin-lockouts';
import { requireAdminSession } from '@/lib/server/session';

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

export default async function VerificationsPage() {
  await requireAdminSession();
  const lockouts = await listIdentityLockouts();
  const lockedOut = lockouts.filter((item) => item.kind === 'lockout');
  const stuck = lockouts.filter((item) => item.kind === 'stuck');

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge verification">Lockouts</span>
        </div>
        <h1>Phone verification lockouts</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          WhatsApp sign-up phone codes, last {LOCKOUT_WINDOW_DAYS} days. Web sign-up lockouts happen
          inside Cognito and are not recorded here.
        </p>
      </section>

      <section className="card stack-gap">
        <h2>Locked out</h2>
        {lockedOut.map((item) => (
          <div className="verification-row" key={item.challengeId}>
            <div className="stack">
              <strong>{item.maskedPhone ?? 'Unknown number'}</strong>
              <span className="muted">Started {formatTime(item.startedAt)}</span>
            </div>
            <div className="stack">
              <span className="muted">Outcome</span>
              <span className={`badge ${lockoutOutcomeBadge(item.outcome)}`}>{lockoutOutcomeText(item)}</span>
            </div>
            <div className="stack">
              <span className="muted">Lockouts</span>
              <span>{item.lockoutCount}</span>
            </div>
            <div className="stack">
              <span className="muted">Last lockout</span>
              <span>{formatTime(item.lastEventAt)}</span>
            </div>
          </div>
        ))}
        {lockedOut.length === 0 ? <p className="muted">No lockouts in the last {LOCKOUT_WINDOW_DAYS} days.</p> : null}
      </section>

      <section className="card stack-gap">
        <h2>Stuck at the code step</h2>
        {stuck.map((item) => (
          <div className="verification-row" key={item.challengeId}>
            <div className="stack">
              <strong>{item.maskedPhone ?? 'Unknown number'}</strong>
              <span className="muted">Started {formatTime(item.startedAt)}</span>
            </div>
            <div className="stack">
              <span className="muted">Outcome</span>
              <span className={`badge ${lockoutOutcomeBadge(item.outcome)}`}>{lockoutOutcomeText(item)}</span>
            </div>
            <div className="stack">
              <span className="muted">Last activity</span>
              <span>{formatTime(item.lastEventAt)}</span>
            </div>
          </div>
        ))}
        {stuck.length === 0 ? <p className="muted">No one is stuck at the code step.</p> : null}
      </section>
    </main>
  );
}
