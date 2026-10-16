import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { answeredLabel, formatDays, formatDurationPair } from '@/lib/employer-health';
import type { EmployerWeekTableRow } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const approxTitle = (approximate: number): string =>
  `${formatCount(approximate)} of this week's hires happened before hire times were recorded`;

const WEEKLY_NOTES = [
  'Hires from before hire times were recorded are marked approx.: they count as answered but not timed, and their time to hire is approximate.',
  'The unanswered shares count only applications and worker messages at least 7 days old.',
  'Weeks marked settling are less than 14 days old, so their unanswered counts are not final; a late answer can still change an older week too.',
  'Deleted jobs drop out of every figure.',
  'Test employer accounts are left out.',
];

export function EmployerWeeklyTable({ rows }: { rows: EmployerWeekTableRow[] }) {
  return (
    <AnalyticsPanel
      title="Week by week"
      subtitle="Newest first · applications and worker message runs by the week they started, hires by the week of the hire"
      howCounted="Time to hire includes the worker completing their details. Worker messages: a run of consecutive messages from a worker counts once, and conversations closed without a reply are left out."
      notes={WEEKLY_NOTES}
    >
      <TableScroll label="Week by week table">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Week</th>
              <th className={TH_NUM}>Applications</th>
              <th className={TH_NUM}>Answered</th>
              <th className={TH_NUM}>Unanswered 7d</th>
              <th className={TH_NUM}>First response (p50 / p75)</th>
              <th className={TH_NUM}>Worker messages</th>
              <th className={TH_NUM}>Reply (p50 / p75)</th>
              <th className={TH_NUM}>Hires</th>
              <th className={TH_NUM}>Time to hire</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.weekStart}>
                <td className={TD}>
                  {row.label}
                  {row.settling ? (
                    <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="Under 14 days old: unanswered counts are not final yet">settling</span>
                  ) : null}
                </td>
                <td className={TD_NUM}>{formatCount(row.applications)}</td>
                <td className={TD_NUM}>{answeredLabel(row)}</td>
                <td className={TD_NUM}>{formatCount(row.unanswered7d)}</td>
                <td className={TD_NUM}>{formatDurationPair(row.firstResponseP50Hours, row.firstResponseP75Hours)}</td>
                <td className={TD_NUM}>{formatCount(row.workerTurns)}</td>
                <td className={TD_NUM}>{formatDurationPair(row.replyP50Hours, row.replyP75Hours)}</td>
                <td className={TD_NUM}>{formatCount(row.hires)}</td>
                <td className={TD_NUM}>
                  {formatDays(row.timeToHireP50Days)}
                  {row.approximate ? (
                    <span className="ml-1 text-xs text-[var(--jale-ink-2)]" title={approxTitle(row.hiresApproximate)}>approx.</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </AnalyticsPanel>
  );
}
