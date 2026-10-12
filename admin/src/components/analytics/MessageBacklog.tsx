import { formatCount } from '@/lib/analytics-format';
import { backlogRows, openMessages } from '@/lib/ops-health';
import type { MessageBacklogLane } from '@/lib/types';

export function MessageBacklog({ lanes }: { lanes: MessageBacklogLane[] }) {
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Right now: message backlog</h2>
          <p>Messages from the last 48 hours not sent yet (waiting, retrying or in flight), by how long ago they were created</p>
        </div>
      </div>
      {openMessages(lanes) === 0 ? (
        <p className="muted">No messages waiting.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Message backlog table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Lane</th>
                <th className="num">Under 1 h</th>
                <th className="num">1–24 h</th>
                <th className="num">24–48 h</th>
                <th className="num">Stuck</th>
              </tr>
            </thead>
            <tbody>
              {backlogRows(lanes).map((row) => (
                <tr key={row.lane}>
                  <td>
                    {row.label}
                    <span className="ops-sub">{row.stuckAfter}</span>
                  </td>
                  <td className="num">{formatCount(row.openUnder1h)}</td>
                  <td className="num">{formatCount(row.open1To24h)}</td>
                  <td className="num">{formatCount(row.open24To48h)}</td>
                  <td className={row.stuck > 0 ? 'num ops-stuck' : 'num'}>{formatCount(row.stuck)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
