import { formatCount } from '@/lib/analytics-format';
import { formatAvgSections, newestWeeksFirst, type TrustSplit } from '@/lib/ops-health';

export function TrustExtraction({ trust, now }: { trust: TrustSplit; now: Date }) {
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Trust extraction</h2>
          <p>Newest first · per extractor version, by the week the extraction was created · in-flight extractions left out</p>
        </div>
      </div>
      {trust.window.extractions === 0 ? (
        <p className="muted">No trust extractions in these weeks.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Trust extraction table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Version</th>
                <th className="num">Extractions</th>
                <th className="num">Failed</th>
                <th className="num">Not enough detail</th>
                <th className="num">Avg sections of 5</th>
              </tr>
            </thead>
            <tbody>
              {newestWeeksFirst(trust.weekly, now).map((row) => (
                <tr key={`${row.weekStart}:${row.version ?? 'all'}`}>
                  <td>
                    {row.label}
                    {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td>{row.version ?? '—'}</td>
                  <td className="num">{formatCount(row.extractions)}</td>
                  <td className="num">{formatCount(row.failed)}</td>
                  <td className="num">{formatCount(row.notEnoughDetail)}</td>
                  <td className="num">{formatAvgSections(row.avgSections)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
