import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { billingLiveLine, newestWeeksFirst, skippedByType, type BillingSplit } from '@/lib/ops-health';
import type { BillingInboxNow } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { BarChart } from './charts/BarChart';
import { ChartFrame } from './charts/ChartFrame';
import { TABLE, TD, TD_NUM, TH, TH_NUM } from './table-styles';

const BILLING_NOTES = ['Older ones have left the queue and must be resent from Stripe.'];

export function BillingInbox({ billing, inbox, now }: { billing: BillingSplit; inbox: BillingInboxNow; now: Date }) {
  const empty = billing.window.received === 0;
  const skipped = skippedByType(billing.eventTypes);
  return (
    <>
      <AnalyticsPanel
        title="Billing inbox"
        subtitle="Stripe webhook events · newest first, by the week they were received"
        howCounted="Billing stuck means received but never claimed, or the 5-minute processing claim expired. Billing events are retried for about 20 minutes; any still stuck or failed after an hour have been dead-lettered and can be redriven from the queue for 14 days."
        notes={BILLING_NOTES}
      >
        <p data-billing-live="" className="m-0 text-sm">
          <strong>Right now:</strong> {billingLiveLine(inbox, now)}
        </p>
        {empty ? (
          <p className="m-0 text-sm text-[var(--jale-ink-2)]">No billing events in these weeks.</p>
        ) : (
          <TableScroll label="Billing inbox table">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>Week</th>
                  <th className={TH_NUM}>Received</th>
                  <th className={TH_NUM}>Processed</th>
                  <th className={TH_NUM}>Skipped</th>
                  <th className={TH_NUM}>Failed</th>
                  <th className={TH_NUM}>Retried</th>
                  <th className={TH_NUM}>Payment-failed invoices</th>
                </tr>
              </thead>
              <tbody>
                {newestWeeksFirst(billing.weekly, now).map((row) => (
                  <tr key={row.weekStart}>
                    <td className={TD}>
                      {row.label}
                      {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                    </td>
                    <td className={TD_NUM}>{formatCount(row.received)}</td>
                    <td className={TD_NUM}>{formatCount(row.processed)}</td>
                    <td className={TD_NUM}>{formatCount(row.skipped)}</td>
                    <td className={TD_NUM}>{formatCount(row.failed)}</td>
                    <td className={TD_NUM}>{formatCount(row.retried)}</td>
                    <td className={TD_NUM}>{formatCount(row.paymentFailedInvoices)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </AnalyticsPanel>

      {empty ? null : (
        <ChartFrame
          title="Skipped events by type"
          subtitle="Events received in these weeks that billing skipped, by Stripe event type"
          table={{ caption: 'Skipped events by type', columns: ['Event type', 'Skipped'], rows: skipped.map((type) => [type.eventType, formatCount(type.skipped)]) }}
        >
          {skipped.length === 0 ? (
            <p className="m-0 text-sm text-[var(--jale-ink-2)]">No skipped events in these weeks.</p>
          ) : (
            <BarChart
              title="Skipped events by type"
              orientation="horizontal"
              labels={skipped.map((type) => type.eventType)}
              series={[{ key: 'skipped', label: 'Skipped', color: 'chart-1', values: skipped.map((type) => type.skipped) }]}
              xTitle="Skipped events"
              yTitle="Stripe event type"
            />
          )}
        </ChartFrame>
      )}
    </>
  );
}
