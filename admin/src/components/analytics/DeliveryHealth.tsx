import { formatCount, percentOf } from '@/lib/analytics-format';

export type DeliveryChannel = { name: string; out: number; in: number; failed: number };

function FailIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#d4313c" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={12} cy={12} r={9} />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function DeliveryHealth({ channels }: { channels: DeliveryChannel[] }) {
  return (
    <article className="card">
      <div className="chart-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>Message delivery</h2>
          <p>Sent this period, and how many failed or went unconfirmed</p>
        </div>
      </div>
      <div className="delivery-rows">
        {channels.map((channel) => {
          const total = channel.out + channel.in;
          // The bar is outbound-only: failures are outbound rows, so weighing
          // the delivered segment against total (out + in) understates the
          // failed share. delivered = out − failed; the `|| 1` guard below
          // still renders a full, non-failed bar when both are zero.
          const delivered = Math.max(0, channel.out - channel.failed);
          // Failures are outbound rows, so the rate is over outbound, not all traffic.
          const rate = percentOf(channel.failed, channel.out, 1);
          return (
            <div key={channel.name} className="delivery-row">
              <div className="delivery-meta">
                <span style={{ fontWeight: 650 }}>{channel.name}</span>
                <span className="muted">
                  <strong style={{ color: 'var(--jale-ink)', fontWeight: 650 }}>{formatCount(total)}</strong>
                  {' messages · '}{formatCount(channel.out)} out / {formatCount(channel.in)} in
                </span>
              </div>
              <div className="delivery-bar" aria-hidden="true">
                <div className="delivered" style={{ flexGrow: delivered || 1 }} />
                {channel.failed > 0 ? <div className="failed" style={{ flexGrow: channel.failed }} /> : null}
              </div>
              <div className="delivery-fail">
                <FailIcon />
                {channel.failed > 0
                  ? `${formatCount(channel.failed)} failed or unconfirmed${rate ? ` · ${rate} of outbound` : ''}`
                  : 'No failures'}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
