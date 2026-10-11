import { formatCount } from '@/lib/analytics-format';
import {
  completenessTable,
  failureReasons,
  newestWeeksFirst,
  topCauseLabel,
  wholePercent,
  type VoiceSplit,
} from '@/lib/ops-health';

export function VoiceExtraction({ voice, now }: { voice: VoiceSplit; now: Date }) {
  const heading = (
    <div className="chart-head" style={{ marginBottom: 8 }}>
      <div>
        <h2>AI voice extraction</h2>
        <p>Newest first · voice notes the AI turned into profile fields, by the week they were processed · counts attempts</p>
      </div>
    </div>
  );
  if (voice.window.processed === 0) {
    return (
      <article className="card">
        {heading}
        <p className="muted">No voice notes in these weeks.</p>
      </article>
    );
  }

  const reasons = failureReasons(voice.window);
  const widest = Math.max(1, ...reasons.map((reason) => reason.count));
  const completeness = completenessTable(voice.window, voice.models);

  return (
    <>
      <article className="card cohort-card">
        {heading}
        <div className="table-scroll" role="region" aria-label="AI voice extraction table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Week</th>
                <th className="num">Voice notes</th>
                <th className="num">Usable</th>
                <th className="num">Failed</th>
                <th>Top cause</th>
              </tr>
            </thead>
            <tbody>
              {newestWeeksFirst(voice.weekly, now).map((row) => (
                <tr key={row.weekStart}>
                  <td>
                    {row.label}
                    {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className="num">{formatCount(row.processed)}</td>
                  <td className="num">{formatCount(row.usable)}</td>
                  <td className="num">{formatCount(row.failed)}</td>
                  <td className="wrap ops-cause">{topCauseLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <section className="grid analytics-bottom">
        <article className="card">
          <div className="chart-head" style={{ marginBottom: 14 }}>
            <div>
              <h2>Why extractions failed</h2>
              <p>Failed attempts in these weeks, by cause · share of all failures</p>
            </div>
          </div>
          {reasons.length === 0 ? (
            <p className="muted">No failed extractions in these weeks.</p>
          ) : (
            <ol className="funnel-bars">
              {reasons.map((reason) => (
                <li key={reason.cause} className="funnel-row">
                  <div className="funnel-meta">
                    <span className="funnel-label">{reason.label}</span>
                    <span className="muted">
                      <strong>{formatCount(reason.count)}</strong> · {wholePercent(reason.count, voice.window.failed)}
                    </span>
                  </div>
                  <div className="funnel-track" aria-hidden="true">
                    <div className="funnel-fill stalled" style={{ width: `${(reason.count / widest) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="card cohort-card">
          <div className="chart-head" style={{ marginBottom: 8 }}>
            <div>
              <h2>Field completeness</h2>
              <p>Share of usable replies with the field found at confidence 0.75 or higher</p>
            </div>
          </div>
          <div className="table-scroll" role="region" aria-label="Field completeness table" tabIndex={0}>
            <table className="data-table cohort-table">
              <thead>
                <tr>
                  <th>Field</th>
                  {completeness.columns.map((column) => (
                    <th key={column.key} className={column.model ? 'num ops-model' : 'num'}>
                      {column.label}
                      <span className="ops-sub">{formatCount(column.usable)} usable</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {completeness.rows.map((row) => (
                  <tr key={row.field}>
                    <td className="wrap">{row.label}</td>
                    {row.cells.map((cell, i) => (
                      <td key={completeness.columns[i].key} className="num">
                        {cell.share}
                        <span className="ops-sub">{formatCount(cell.found)} of {formatCount(cell.of)}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </>
  );
}
