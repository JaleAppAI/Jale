import { TableScroll } from '@/components/ui/table-scroll';
import { formatRate } from '@/lib/analytics-format';
import { failedOfCreated, failureChart, failureChartEmpty, failureTableRows, type MessageFailuresSplit } from '@/lib/ops-health';
import { AnalyticsPanel } from './AnalyticsPanel';
import { ChartFrame } from './charts/ChartFrame';
import { StackedLines } from './charts/StackedLines';
import { seriesTable } from './charts/text';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const FAILURES_COUNTED =
  'After 48 hours nothing retries a message, so anything still unsent counts as gave up. Failure rate = (gave up + delivery failures) ÷ messages created, by the week a message was created.';

const FAILURES_NOTES = [
  'Gave up also covers the last of 5 attempts failing, a send that ended with an unknown result, and any failed worker notification (an expired template wait fails it after fewer attempts).',
  'A delivery failure was sent, but Twilio reported it failed or undelivered.',
  'Free-text employer messages record delivery failures on the conversation, not in this lane; the message delivery panel on the Growth tab counts them.',
  'Deleting a job deletes its employer-message history.',
  'Job alerts now go out as worker notifications; only the old job-alert lane is dormant, and it shows only when it has messages.',
  'Weeks marked so far are still in progress, and messages that are still open can still add failures to their week.',
];

// One small-multiple row per lane (each lane keeps its chart token), then the
// failed / created table.
export function MessageFailures({ failures, now }: { failures: MessageFailuresSplit; now: Date }) {
  if (failureChartEmpty(failures)) {
    return (
      <AnalyticsPanel title="Message failures by week" subtitle="Gave up + delivery failures, % of the messages each lane created that week" howCounted={FAILURES_COUNTED} notes={FAILURES_NOTES}>
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No messages created in these weeks.</p>
      </AnalyticsPanel>
    );
  }
  const chart = failureChart(failures, now);
  return (
    <>
      <ChartFrame
        title="Message failures by week"
        subtitle="Gave up + delivery failures, % of the messages each lane created that week · blank where a lane created nothing"
        howCounted={FAILURES_COUNTED}
        table={seriesTable('Failure rate (%) by week', chart.labels, chart.series, { format: formatRate, unit: '%', partialLast: chart.partialLast })}
      >
        <StackedLines
          title="Message failures by week"
          labels={chart.labels}
          series={chart.series}
          xTitle="Week created"
          yTitle="Failure rate (%)"
          unit="%"
          formatValue={formatRate}
          partialLast={chart.partialLast}
        />
      </ChartFrame>

      <AnalyticsPanel
        title="Failed / created by week"
        subtitle="Newest first · gave up + delivery failures over messages created, by the week a message was created"
        notes={FAILURES_NOTES}
      >
        <TableScroll label="Message failures table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Week</th>
                {failures.lanes.map((lane) => (
                  <th key={lane.lane} className={TH_NUM}>{lane.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {failureTableRows(failures, now).map((row) => (
                <tr key={row.weekStart}>
                  <td className={TD}>
                    {row.label}
                    {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                  </td>
                  {row.cells.map((cell, i) => (
                    <td key={failures.lanes[i].lane} className={TD_NUM}>{failedOfCreated(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={TH}>These weeks</th>
                {failures.lanes.map((lane) => (
                  <td key={lane.lane} className={TD_NUM}>{failedOfCreated(lane.window)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      </AnalyticsPanel>
    </>
  );
}
