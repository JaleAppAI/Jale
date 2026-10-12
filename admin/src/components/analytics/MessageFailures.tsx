import { bucketLabel } from '@/lib/analytics-format';
import {
  failedOfCreated,
  failureChartEmpty,
  failureRate,
  failureTableRows,
  latestRateLabel,
  type MessageFailuresSplit,
} from '@/lib/ops-health';
import type { MessageLane } from '@/lib/types';
import { TrendChart } from '@/components/analytics/TrendChart';

// One fixed hue per lane: a lane keeps its color when job alerts come and go.
// Checked as a categorical set (adjacent CVD ΔE ≥ 9). The three light hues sit
// below 3:1 on white, so the values are carried by the Table twin (a column
// per lane) and the failed / created table, not by the lines.
const LANE_COLORS: Record<MessageLane, string> = {
  reply: '#0179ff',
  admin: '#eb6834',
  worker_notification: '#1baf7a',
  employer_invite: '#eda100',
  employer_freeform: '#e87ba4',
  job_alert: '#008300',
};

export function MessageFailures({ failures, now }: { failures: MessageFailuresSplit; now: Date }) {
  if (failureChartEmpty(failures)) {
    return (
      <article className="card">
        <div className="chart-head" style={{ marginBottom: 8 }}>
          <div>
            <h2>Message failures by week</h2>
            <p>Gave up + delivery failures, % of the messages each lane created that week</p>
          </div>
        </div>
        <p className="muted">No messages created in these weeks.</p>
      </article>
    );
  }

  return (
    <>
      <TrendChart
        title="Message failures by week"
        subtitle="Gave up + delivery failures, % of the messages each lane created that week · blank where a lane created nothing"
        labels={failures.weeks.map((week) => bucketLabel(week, '90d'))}
        tableCaption="Failure rate (%) by week"
        partialLast
        series={failures.lanes.map((lane) => {
          // A week where the lane created nothing has no rate (null): a gap, never 0.
          const values = lane.weekly.map(failureRate);
          return {
            key: lane.lane,
            label: lane.label,
            color: LANE_COLORS[lane.lane],
            values,
            endLabel: latestRateLabel(lane),
          };
        })}
      />

      <article className="card cohort-card">
        <div className="chart-head" style={{ marginBottom: 8 }}>
          <div>
            <h2>Failed / created by week</h2>
            <p>Newest first · gave up + delivery failures over messages created, by the week a message was created</p>
          </div>
        </div>
        <div className="table-scroll" role="region" aria-label="Message failures table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Week</th>
                {failures.lanes.map((lane) => (
                  <th key={lane.lane} className="num">{lane.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {failureTableRows(failures, now).map((row) => (
                <tr key={row.weekStart}>
                  <td>
                    {row.label}
                    {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                  </td>
                  {row.cells.map((cell, i) => (
                    <td key={failures.lanes[i].lane} className="num">{failedOfCreated(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">These weeks</th>
                {failures.lanes.map((lane) => (
                  <td key={lane.lane} className="num">{failedOfCreated(lane.window)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </article>
    </>
  );
}
