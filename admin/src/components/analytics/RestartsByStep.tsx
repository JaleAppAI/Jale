import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount, weekLabel } from '@/lib/analytics-format';
import { isCurrentWeek } from '@/lib/ops-health';
import { hasStartOver, restartStepRows, restartTotals, restartWeeks, restartsEmpty } from '@/lib/restarts';
import type { FunnelDoor, FunnelWeeks, OnboardingRestart } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { ChartFrame } from './charts/ChartFrame';
import { LineChart } from './charts/LineChart';
import { seriesTable } from './charts/text';
import type { ChartSeries } from './charts/types';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const RESTARTS_COUNTED =
  'Reached counts the workers who were at a step in these weeks: they arrived there, or started over or went back from it. All steps and the weekly chart count each worker once, so the steps can add up to more; Presses count every press, so a worker who pressed twice counts twice.';

const RESTARTS_NOTES = [
  'Start over and back counts workers by the step they left with the start over command (WhatsApp only) or back; voice-note retry loops and system moves do not count as going back.',
  'Workers reset by an operator lose their onboarding history, so their earlier restarts are not counted.',
  'Start over and back counts moves made since the last operator reset of each worker.',
  'On All, the start-over share is of every worker who was at the step, web included.',
];

export function RestartsByStep({ rows, door, weeks, now }: { rows: OnboardingRestart[]; door: FunnelDoor; weeks: FunnelWeeks; now: Date }) {
  const subtitle = 'By the step workers left, in onboarding order · workers, and their share of the workers who were at the step in these weeks';
  if (restartsEmpty(rows, door)) {
    return (
      <AnalyticsPanel title="Start over and back" subtitle={subtitle} howCounted={RESTARTS_COUNTED} notes={RESTARTS_NOTES}>
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No one started over or went back in these weeks.</p>
      </AnalyticsPanel>
    );
  }

  const steps = restartStepRows(rows, door);
  const totals = restartTotals(rows, door);
  const byWeek = restartWeeks(rows, door, weeks, now);
  const startOver = hasStartOver(door);
  // Workers distinct across steps (the SQL's all-steps rows); a week with no
  // row had nobody: 0, not a gap.
  const startedOver: ChartSeries = { key: 'startedOver', label: 'Started over', color: 'chart-1', values: byWeek.map((week) => week.restartWorkers) };
  const wentBack: ChartSeries = { key: 'wentBack', label: 'Went back', color: 'chart-2', values: byWeek.map((week) => week.backWorkers) };
  const series = startOver ? [startedOver, wentBack] : [wentBack];
  const labels = byWeek.map((week) => weekLabel(week.weekStart));
  const partialLast = byWeek.length > 0 && isCurrentWeek(byWeek[byWeek.length - 1].weekStart, now);

  return (
    <>
      <AnalyticsPanel title="Start over and back" subtitle={subtitle} howCounted={RESTARTS_COUNTED} notes={RESTARTS_NOTES}>
        <TableScroll label="Start over and back table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Step</th>
                <th className={TH_NUM}>Reached</th>
                <th className={TH_NUM}>Started over</th>
                <th className={TH_NUM}>Went back</th>
                <th className={TH_NUM}>Presses</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((row) => (
                <tr key={row.stepKey}>
                  <td className={TD}>{row.label}</td>
                  <td className={TD_NUM}>{formatCount(row.reached)}</td>
                  <td className={TD_NUM}>{row.startedOver}</td>
                  <td className={TD_NUM}>{row.wentBack}</td>
                  <td className={TD_NUM}>{formatCount(row.presses)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={TH}>All steps</th>
                <td className={TD_NUM}>{formatCount(totals.reached)}</td>
                <td className={TD_NUM}>{totals.startedOver}</td>
                <td className={TD_NUM}>{totals.wentBack}</td>
                <td className={TD_NUM}>{formatCount(totals.presses)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
        {startOver ? null : <p className="m-0 text-sm text-[var(--jale-ink-2)]">No start over on the web</p>}
      </AnalyticsPanel>

      <ChartFrame
        title="Start over and back by week"
        subtitle={
          startOver
            ? 'Workers who started over or went back each week, at any step · each worker counted once'
            : 'Workers who went back each week, at any step · each worker counted once'
        }
        table={seriesTable('Workers by week', labels, series, { format: formatCount, partialLast })}
      >
        <LineChart title="Start over and back by week" labels={labels} series={series} xTitle="Week starting" yTitle="Workers" partialLast={partialLast} />
      </ChartFrame>
    </>
  );
}
