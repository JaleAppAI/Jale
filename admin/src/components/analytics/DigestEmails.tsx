import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { adoptionLine, digestEmpty, digestTableRows, type DigestSplit } from '@/lib/digest';
import type { DigestAdoption } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const DIGEST_NOTES = [
  'Applicant digest emails launched on Aug 23, 2026, so earlier weeks are empty.',
  'An employer with the digest on is emailed at most once a day, only on days with new applicants, and only when they have an email address.',
  'Digest emails count by the week they were queued.',
  'Employers reached counts employers with at least one digest sent.',
  'Who has the digest on, and their email address, is as of now; digest emails of deleted employers drop out.',
];

export function DigestEmails({ adoption, sends, now }: { adoption: DigestAdoption; sends: DigestSplit; now: Date }) {
  return (
    <AnalyticsPanel
      title="Applicant digest emails"
      subtitle="Newest first · digest emails by the week they were queued · who has the digest on is as of now"
      howCounted="Failed means the send gave up after 5 attempts; Unknown means the send timed out and may have arrived (it is never retried); Still sending means queued or waiting to retry. Bounces and spam complaints switch the digest off for that employer but do not show as failures."
      notes={DIGEST_NOTES}
    >
      <p data-digest-adoption="" className="m-0 text-sm font-semibold">{adoptionLine(adoption)}</p>
      {digestEmpty(sends) ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No digest emails in these weeks.</p>
      ) : (
        <TableScroll label="Applicant digest emails table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Week</th>
                <th className={TH_NUM}>Emailed</th>
                <th className={TH_NUM}>Sent</th>
                <th className={TH_NUM}>Failed</th>
                <th className={TH_NUM}>Unknown</th>
                <th className={TH_NUM}>Still sending</th>
                <th className={TH_NUM}>Employers reached</th>
              </tr>
            </thead>
            <tbody>
              {digestTableRows(sends, now).map((row) => (
                <tr key={row.weekStart}>
                  <td className={TD}>
                    {row.label}
                    {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className={TD_NUM}>{formatCount(row.emailed)}</td>
                  <td className={TD_NUM}>{formatCount(row.sent)}</td>
                  <td className={TD_NUM}>{formatCount(row.failed)}</td>
                  <td className={TD_NUM}>{formatCount(row.unknown)}</td>
                  <td className={TD_NUM}>{formatCount(row.inProgress)}</td>
                  <td className={TD_NUM}>{formatCount(row.employersReached)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={TH}>These weeks</th>
                <td className={TD_NUM}>{formatCount(sends.window.emailed)}</td>
                <td className={TD_NUM}>{formatCount(sends.window.sent)}</td>
                <td className={TD_NUM}>{formatCount(sends.window.failed)}</td>
                <td className={TD_NUM}>{formatCount(sends.window.unknown)}</td>
                <td className={TD_NUM}>{formatCount(sends.window.inProgress)}</td>
                <td className={TD_NUM}>{formatCount(sends.window.employersReached)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      )}
    </AnalyticsPanel>
  );
}
