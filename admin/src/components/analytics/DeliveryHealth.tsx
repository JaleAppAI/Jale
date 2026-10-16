import { formatCount, percentOf } from '@/lib/analytics-format';
import { AnalyticsPanel } from './AnalyticsPanel';

export type DeliveryChannel = { name: string; out: number; in: number; failed: number };

// The failure line carries an icon and words, never colour alone.
function FailIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={12} cy={12} r={9} />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function DeliveryHealth({ channels }: { channels: DeliveryChannel[] }) {
  return (
    <AnalyticsPanel title="Message delivery" subtitle="Sent this period, and how many failed or went unconfirmed">
      <div className="flex flex-col gap-4">
        {channels.map((channel) => {
          const total = channel.out + channel.in;
          // The bar is outbound-only: failures are outbound rows. delivered =
          // out − failed; with nothing sent the bar is one empty segment.
          const delivered = Math.max(0, channel.out - channel.failed);
          const rate = percentOf(channel.failed, channel.out, 1);
          return (
            <div key={channel.name} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold">{channel.name}</span>
                <span className="text-[var(--jale-ink-2)]">
                  <strong className="font-semibold text-[var(--jale-ink)]">{formatCount(total)}</strong>
                  {' messages · '}
                  {formatCount(channel.out)} out / {formatCount(channel.in)} in
                </span>
              </div>
              <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                <div style={{ flexGrow: delivered || 1, background: delivered ? 'var(--chart-1)' : 'transparent' }} />
                {channel.failed > 0 ? <div style={{ flexGrow: channel.failed, background: 'var(--jale-danger)' }} /> : null}
              </div>
              <div data-delivery-fail="" className="inline-flex items-center gap-1.5 text-xs text-[var(--jale-danger-text)]">
                <FailIcon />
                {channel.failed > 0
                  ? `${formatCount(channel.failed)} failed or unconfirmed${rate ? ` · ${rate} of outbound` : ''}`
                  : 'No failures'}
              </div>
            </div>
          );
        })}
      </div>
    </AnalyticsPanel>
  );
}
