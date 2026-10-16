import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { completenessTable, failureReasons, newestWeeksFirst, topCauseLabel, wholePercent, type VoiceSplit } from '@/lib/ops-health';
import { AnalyticsPanel } from './AnalyticsPanel';
import { BarChart } from './charts/BarChart';
import { ChartFrame } from './charts/ChartFrame';
import { SUB, TABLE, TD, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

const VOICE_COUNTED =
  'Voice figures count only voice notes that produced a row, as attempts: a note processed twice counts twice, and a pipeline crash or timeout leaves no row, so that note is not counted. Test profiles are left out of the voice figures.';

export function VoiceExtraction({ voice, now }: { voice: VoiceSplit; now: Date }) {
  const subtitle = 'Newest first · voice notes the AI turned into profile fields, by the week they were processed · counts attempts';
  if (voice.window.processed === 0) {
    return (
      <AnalyticsPanel title="AI voice extraction" subtitle={subtitle} howCounted={VOICE_COUNTED}>
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No voice notes in these weeks.</p>
      </AnalyticsPanel>
    );
  }

  const reasons = failureReasons(voice.window);
  const completeness = completenessTable(voice.window, voice.models);

  return (
    <>
      <AnalyticsPanel title="AI voice extraction" subtitle={subtitle} howCounted={VOICE_COUNTED}>
        <TableScroll label="AI voice extraction table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Week</th>
                <th className={TH_NUM}>Voice notes</th>
                <th className={TH_NUM}>Usable</th>
                <th className={TH_NUM}>Failed</th>
                <th className={TH}>Top cause</th>
              </tr>
            </thead>
            <tbody>
              {newestWeeksFirst(voice.weekly, now).map((row) => (
                <tr key={row.weekStart}>
                  <td className={TD}>
                    {row.label}
                    {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className={TD_NUM}>{formatCount(row.processed)}</td>
                  <td className={TD_NUM}>{formatCount(row.usable)}</td>
                  <td className={TD_NUM}>{formatCount(row.failed)}</td>
                  <td className={TD_WRAP}>{topCauseLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </AnalyticsPanel>

      <ChartFrame
        title="Why extractions failed"
        subtitle="Failed attempts in these weeks, by cause · share of all failures"
        howCounted="Failure causes are recorded only since migration 115 was applied; failed rows from before then show as Cause not recorded. Pipeline error also includes AI calls that timed out after 60 seconds and, occasionally, an extra row written after a successful save."
        table={{
          caption: 'Failed attempts by cause',
          columns: ['Cause', 'Failed', 'Share of failures'],
          rows: reasons.map((reason) => [reason.label, formatCount(reason.count), wholePercent(reason.count, voice.window.failed)]),
        }}
      >
        {reasons.length === 0 ? (
          <p className="m-0 text-sm text-[var(--jale-ink-2)]">No failed extractions in these weeks.</p>
        ) : (
          <BarChart
            title="Why extractions failed"
            orientation="horizontal"
            labels={reasons.map((reason) => reason.label)}
            series={[{ key: 'failed', label: 'Failed attempts', color: 'chart-1', values: reasons.map((reason) => reason.count) }]}
            xTitle="Failed attempts"
            yTitle="Cause"
            formatValue={(v) => `${formatCount(v)} · ${wholePercent(v, voice.window.failed)}`}
          />
        )}
      </ChartFrame>

      <AnalyticsPanel
        title="Field completeness"
        subtitle="Share of usable replies with the field found at confidence 0.75 or higher"
        howCounted="Field completeness counts a field as found when it has a value with confidence 0.75 or higher, the threshold onboarding uses."
      >
        <TableScroll label="Field completeness table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Field</th>
                {completeness.columns.map((column) => (
                  <th key={column.key} className={column.model ? `${TH_NUM} whitespace-normal [overflow-wrap:anywhere]` : TH_NUM}>
                    {column.label}
                    <span className={SUB}>{formatCount(column.usable)} usable</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {completeness.rows.map((row) => (
                <tr key={row.field}>
                  <td className={TD_WRAP}>{row.label}</td>
                  {row.cells.map((cell, i) => (
                    <td key={completeness.columns[i].key} className={TD_NUM}>
                      {cell.share}
                      <span className={SUB}>{formatCount(cell.found)} of {formatCount(cell.of)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </AnalyticsPanel>
    </>
  );
}
