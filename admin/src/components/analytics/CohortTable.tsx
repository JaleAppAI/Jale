import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount, percentOf } from '@/lib/analytics-format';
import { shareShade } from '@/lib/funnel';
import type { CohortCounts } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

export type CohortTableRow = CohortCounts & { label: string; settling: boolean };

const SHARE_COLUMNS: { key: keyof CohortCounts; header: string; whatsappOnly?: boolean }[] = [
  { key: 'codeRequested', header: 'Code', whatsappOnly: true },
  { key: 'verified', header: 'Verified' },
  { key: 'acceptedTerms', header: 'Terms' },
  { key: 'finishedProfile', header: 'Profile' },
  { key: 'ready', header: 'Ready' },
];

export function CohortTable({ rows, showCode, declined }: { rows: CohortTableRow[]; showCode: boolean; declined: number }) {
  const shares = SHARE_COLUMNS.filter((column) => showCode || !column.whatsappOnly);
  return (
    <AnalyticsPanel
      title="Weekly cohorts"
      subtitle="Grouped by the week of first contact, newest first"
      howCounted="Workers reset by an operator and accounts from the retired web bypass are left out, so Verified here differs from the verified sign-ups on the Growth tab. Weeks before the onboarding funnel launched show no starters."
      notes={[`${formatCount(declined)} declined the terms in these weeks.`]}
    >
      <TableScroll label="Weekly cohorts table">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Week</th>
              <th className={TH_NUM}>Started</th>
              {shares.map((column) => (
                <th key={column.key} className={TH_NUM}>{column.header}</th>
              ))}
              <th className={TH_NUM}>In progress</th>
              <th className={TH_NUM}>Abandoned</th>
              <th className={TH_NUM}>Declined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cohortWeek}>
                <td className={TD}>
                  {row.label}
                  {row.settling ? (
                    <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="Workers in this week can still move for 7 days after it ends">settling</span>
                  ) : null}
                </td>
                <td className={TD_NUM}>{formatCount(row.started)}</td>
                {shares.map((column) => {
                  const count = row[column.key] as number;
                  return (
                    <td key={column.key} className={TD_NUM} style={{ background: shareShade(count, row.started) }}>
                      {percentOf(count, row.started) ?? '—'}
                    </td>
                  );
                })}
                <td className={TD_NUM}>{formatCount(row.inProgress)}</td>
                <td className={TD_NUM}>{formatCount(row.abandoned)}</td>
                <td className={TD_NUM}>{formatCount(row.declined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </AnalyticsPanel>
  );
}
