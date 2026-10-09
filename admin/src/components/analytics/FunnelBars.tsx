import { formatCount } from '@/lib/analytics-format';
import type { FunnelStage } from '@/lib/types';

export function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <article className="card">
      <div className="chart-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>Onboarding funnel</h2>
          <p>How far the starters in these weeks got</p>
        </div>
      </div>
      <ol className="funnel-bars">
        {stages.map((stage) => (
          <li key={stage.key} className="funnel-row">
            <div className="funnel-meta">
              <span className="funnel-label">{stage.label}</span>
              <span className="muted">
                <strong>{formatCount(stage.count)}</strong>
                {stage.ofStarted ? ` · ${stage.ofStarted} of started` : ''}
                {stage.ofPrevious ? ` · ${stage.ofPrevious} of previous` : ''}
              </span>
            </div>
            <div className="funnel-track" aria-hidden="true">
              <div className="funnel-fill" style={{ width: `${(stage.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}
