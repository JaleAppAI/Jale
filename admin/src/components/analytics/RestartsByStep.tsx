import { bucketLabel, formatCount } from '@/lib/analytics-format';
import { hasStartOver, restartStepRows, restartTotals, restartWeeks, restartsEmpty } from '@/lib/restarts';
import type { FunnelDoor, FunnelWeeks, OnboardingRestart } from '@/lib/types';
import { TrendChart, type TrendSeries } from '@/components/analytics/TrendChart';

// The validated pair of the Employers response-time chart.
const STARTED_OVER_BLUE = '#0179ff';
const WENT_BACK_ORANGE = '#eb6834';

export function RestartsByStep({
  rows,
  door,
  weeks,
  now,
}: {
  rows: OnboardingRestart[];
  door: FunnelDoor;
  weeks: FunnelWeeks;
  now: Date;
}) {
  const heading = (
    <div className="chart-head" style={{ marginBottom: 8 }}>
      <div>
        <h2>Start over and back</h2>
        <p>By the step workers left, in onboarding order · workers, and their share of the workers who were at the step in these weeks</p>
      </div>
    </div>
  );
  if (restartsEmpty(rows, door)) {
    return (
      <article className="card">
        {heading}
        <p className="muted">No one started over or went back in these weeks.</p>
      </article>
    );
  }

  const steps = restartStepRows(rows, door);
  const totals = restartTotals(rows, door);
  const byWeek = restartWeeks(rows, door, weeks, now);
  const startOver = hasStartOver(door);
  // Workers distinct across steps (the SQL's all-steps rows); a week with no
  // row had nobody: 0, not a gap.
  const startedOver: TrendSeries = {
    key: 'startedOver',
    label: 'Started over',
    color: STARTED_OVER_BLUE,
    values: byWeek.map((week) => week.restartWorkers),
  };
  const wentBack: TrendSeries = {
    key: 'wentBack',
    label: 'Went back',
    color: WENT_BACK_ORANGE,
    values: byWeek.map((week) => week.backWorkers),
  };

  return (
    <>
      <article className="card cohort-card">
        {heading}
        <div className="table-scroll" role="region" aria-label="Start over and back table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Step</th>
                <th className="num">Reached</th>
                <th className="num">Started over</th>
                <th className="num">Went back</th>
                <th className="num">Presses</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((row) => (
                <tr key={row.stepKey}>
                  <td>{row.label}</td>
                  <td className="num">{formatCount(row.reached)}</td>
                  <td className="num">{row.startedOver}</td>
                  <td className="num">{row.wentBack}</td>
                  <td className="num">{formatCount(row.presses)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All steps</th>
                <td className="num">{formatCount(totals.reached)}</td>
                <td className="num">{totals.startedOver}</td>
                <td className="num">{totals.wentBack}</td>
                <td className="num">{formatCount(totals.presses)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {startOver ? null : <p className="muted restarts-note">No start over on the web</p>}
      </article>

      <TrendChart
        title="Start over and back by week"
        subtitle={
          startOver
            ? 'Workers who started over or went back each week, at any step · each worker counted once'
            : 'Workers who went back each week, at any step · each worker counted once'
        }
        labels={byWeek.map((week) => bucketLabel(week.weekStart, '90d'))}
        tableCaption="Workers by week"
        partialLast
        series={startOver ? [startedOver, wentBack] : [wentBack]}
      />
    </>
  );
}
