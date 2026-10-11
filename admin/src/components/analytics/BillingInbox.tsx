import { formatCount } from '@/lib/analytics-format';
import { billingLiveLine, newestWeeksFirst, skippedByType, type BillingSplit } from '@/lib/ops-health';
import type { BillingInboxNow } from '@/lib/types';

export function BillingInbox({ billing, inbox, now }: { billing: BillingSplit; inbox: BillingInboxNow; now: Date }) {
  const empty = billing.window.received === 0;
  const skipped = skippedByType(billing.eventTypes);
  const widest = Math.max(1, ...skipped.map((type) => type.skipped));
  return (
    <>
      <article className="card cohort-card">
        <div className="chart-head" style={{ marginBottom: 8 }}>
          <div>
            <h2>Billing inbox</h2>
            <p>Stripe webhook events · newest first, by the week they were received</p>
          </div>
        </div>
        <p className="ops-live">
          <strong>Right now:</strong> {billingLiveLine(inbox, now)}
        </p>
        {empty ? (
          <p className="muted">No billing events in these weeks.</p>
        ) : (
          <div className="table-scroll" role="region" aria-label="Billing inbox table" tabIndex={0}>
            <table className="data-table cohort-table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="num">Received</th>
                  <th className="num">Processed</th>
                  <th className="num">Skipped</th>
                  <th className="num">Failed</th>
                  <th className="num">Retried</th>
                  <th className="num">Payment-failed invoices</th>
                </tr>
              </thead>
              <tbody>
                {newestWeeksFirst(billing.weekly, now).map((row) => (
                  <tr key={row.weekStart}>
                    <td>
                      {row.label}
                      {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                    </td>
                    <td className="num">{formatCount(row.received)}</td>
                    <td className="num">{formatCount(row.processed)}</td>
                    <td className="num">{formatCount(row.skipped)}</td>
                    <td className="num">{formatCount(row.failed)}</td>
                    <td className="num">{formatCount(row.retried)}</td>
                    <td className="num">{formatCount(row.paymentFailedInvoices)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {empty ? null : (
        <article className="card">
          <div className="chart-head" style={{ marginBottom: 14 }}>
            <div>
              <h2>Skipped events by type</h2>
              <p>Events received in these weeks that billing skipped, by Stripe event type</p>
            </div>
          </div>
          {skipped.length === 0 ? (
            <p className="muted">No skipped events in these weeks.</p>
          ) : (
            <ol className="funnel-bars">
              {skipped.map((type) => (
                <li key={type.eventType} className="funnel-row">
                  <div className="funnel-meta">
                    <span className="funnel-label ops-code">{type.eventType}</span>
                    <span className="muted"><strong>{formatCount(type.skipped)}</strong></span>
                  </div>
                  <div className="funnel-track" aria-hidden="true">
                    <div className="funnel-fill stalled" style={{ width: `${(type.skipped / widest) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </article>
      )}
    </>
  );
}
