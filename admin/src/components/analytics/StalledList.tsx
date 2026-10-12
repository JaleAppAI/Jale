import { formatCount } from '@/lib/analytics-format';
import type { StalledStep } from '@/lib/types';

export function StalledList({ steps, days }: { steps: StalledStep[]; days: number }) {
  const max = Math.max(1, ...steps.map((step) => step.workers));
  return (
    <article className="card">
      <div className="chart-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>Stuck now</h2>
          <p>Active workers with no progress for {days}+ days, by step and the door their run started in</p>
        </div>
      </div>
      {steps.length === 0 ? (
        <p className="muted">No one is stuck right now.</p>
      ) : (
        <ol className="funnel-bars">
          {steps.map((step) => (
            <li key={step.stepKey} className="funnel-row">
              <div className="funnel-meta">
                <span className="funnel-label">{step.label}</span>
                <span className="muted"><strong>{formatCount(step.workers)}</strong></span>
              </div>
              <div className="funnel-track" aria-hidden="true">
                <div className="funnel-fill stalled" style={{ width: `${(step.workers / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
