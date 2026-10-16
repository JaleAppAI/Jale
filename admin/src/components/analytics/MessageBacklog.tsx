import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { backlogRows, openMessages } from '@/lib/ops-health';
import type { MessageBacklogLane } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { SUB, TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const BACKLOG_NOTES = [
  'WhatsApp replies are retried only while their incoming message is redelivered (about 30 minutes); after that they are stranded.',
  'Worker notifications can legitimately wait up to 48 hours for a message template to be approved; the 24-hour mark matches the existing backlog alarm.',
];

export function MessageBacklog({ lanes }: { lanes: MessageBacklogLane[] }) {
  return (
    <AnalyticsPanel
      title="Right now: message backlog"
      subtitle="Messages from the last 48 hours not sent yet (waiting, retrying or in flight), by how long ago they were created"
      howCounted="Retry windows (a message is stuck when it is still open this long after it was created): WhatsApp replies 30 min, Admin replies 10 min, Worker notifications 24 h, Employer invites and Employer free-text messages 30 min, Job alerts (old lane) 30 min. Open means created in the last 48 hours and not sent yet: waiting, retrying, or in flight."
      notes={BACKLOG_NOTES}
    >
      {openMessages(lanes) === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No messages waiting.</p>
      ) : (
        <TableScroll label="Message backlog table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Lane</th>
                <th className={TH_NUM}>Under 1 h</th>
                <th className={TH_NUM}>1–24 h</th>
                <th className={TH_NUM}>24–48 h</th>
                <th className={TH_NUM}>Stuck</th>
              </tr>
            </thead>
            <tbody>
              {backlogRows(lanes).map((row) => (
                <tr key={row.lane}>
                  <td className={TD}>
                    {row.label}
                    <span className={SUB}>{row.stuckAfter}</span>
                  </td>
                  <td className={TD_NUM}>{formatCount(row.openUnder1h)}</td>
                  <td className={TD_NUM}>{formatCount(row.open1To24h)}</td>
                  <td className={TD_NUM}>{formatCount(row.open24To48h)}</td>
                  <td className={row.stuck > 0 ? `${TD_NUM} font-bold text-[var(--jale-danger-text)]` : TD_NUM}>{formatCount(row.stuck)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </AnalyticsPanel>
  );
}
