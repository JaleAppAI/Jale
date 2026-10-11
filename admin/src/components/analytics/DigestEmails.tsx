import { formatCount } from '@/lib/analytics-format';
import { adoptionLine, digestEmpty, digestTableRows, type DigestSplit } from '@/lib/digest';
import type { DigestAdoption } from '@/lib/types';

export function DigestEmails({ adoption, sends, now }: { adoption: DigestAdoption; sends: DigestSplit; now: Date }) {
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Applicant digest emails</h2>
          <p>Newest first · digest emails by the week they were queued · who has the digest on is as of now</p>
        </div>
      </div>
      <p className="digest-adoption">{adoptionLine(adoption)}</p>
      {digestEmpty(sends) ? (
        <p className="muted">No digest emails in these weeks.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Applicant digest emails table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Week</th>
                <th className="num">Emailed</th>
                <th className="num">Sent</th>
                <th className="num">Failed</th>
                <th className="num">Unknown</th>
                <th className="num">Still sending</th>
                <th className="num">Employers reached</th>
              </tr>
            </thead>
            <tbody>
              {digestTableRows(sends, now).map((row) => (
                <tr key={row.weekStart}>
                  <td>
                    {row.label}
                    {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className="num">{formatCount(row.emailed)}</td>
                  <td className="num">{formatCount(row.sent)}</td>
                  <td className="num">{formatCount(row.failed)}</td>
                  <td className="num">{formatCount(row.unknown)}</td>
                  <td className="num">{formatCount(row.inProgress)}</td>
                  <td className="num">{formatCount(row.employersReached)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">These weeks</th>
                <td className="num">{formatCount(sends.window.emailed)}</td>
                <td className="num">{formatCount(sends.window.sent)}</td>
                <td className="num">{formatCount(sends.window.failed)}</td>
                <td className="num">{formatCount(sends.window.unknown)}</td>
                <td className="num">{formatCount(sends.window.inProgress)}</td>
                <td className="num">{formatCount(sends.window.employersReached)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </article>
  );
}
