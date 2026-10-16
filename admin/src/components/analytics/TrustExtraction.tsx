import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { formatAvgSections, newestWeeksFirst, type TrustSplit } from '@/lib/ops-health';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

export function TrustExtraction({ trust, now }: { trust: TrustSplit; now: Date }) {
  return (
    <AnalyticsPanel
      title="Trust extraction"
      subtitle="Newest first · per extractor version, by the week the extraction was created · in-flight extractions left out"
      howCounted="Not enough detail means the answers had too little in them to send to the AI; average sections counts how many of the five (skills, tools, experience, safety, notable) came back non-empty."
    >
      {trust.window.extractions === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No trust extractions in these weeks.</p>
      ) : (
        <TableScroll label="Trust extraction table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Week</th>
                <th className={TH}>Version</th>
                <th className={TH_NUM}>Extractions</th>
                <th className={TH_NUM}>Failed</th>
                <th className={TH_NUM}>Not enough detail</th>
                <th className={TH_NUM}>Avg sections of 5</th>
              </tr>
            </thead>
            <tbody>
              {newestWeeksFirst(trust.weekly, now).map((row) => (
                <tr key={`${row.weekStart}:${row.version ?? 'all'}`}>
                  <td className={TD}>
                    {row.label}
                    {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className={TD}>{row.version ?? '—'}</td>
                  <td className={TD_NUM}>{formatCount(row.extractions)}</td>
                  <td className={TD_NUM}>{formatCount(row.failed)}</td>
                  <td className={TD_NUM}>{formatCount(row.notEnoughDetail)}</td>
                  <td className={TD_NUM}>{formatAvgSections(row.avgSections)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </AnalyticsPanel>
  );
}
