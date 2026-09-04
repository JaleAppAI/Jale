import type { PayingEmployer } from '@/lib/types';
import { periodEndLabel } from '@/lib/analytics-format';

export function PayingEmployersList({ rows }: { rows: PayingEmployer[] }) {
  return (
    <article className="card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Paying employers</h2>
          <p>{rows.length} subscriptions · active, trialing, or past due</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No paying employers yet.</p>
      ) : (
        <div className="list-rows">
          {rows.map((row) => (
            <div key={`${row.employerId}-${row.planCode}`} className="list-row">
              <span className="name">{row.displayName}</span>
              <span className="muted plan" style={{ fontSize: '0.82rem' }}>{row.planCode}</span>
              <span className={`badge ${row.status}`}>{row.status.replace('_', ' ')}</span>
              <span className={row.cancelAtPeriodEnd ? 'period cancels' : 'period'}>{periodEndLabel(row)}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
