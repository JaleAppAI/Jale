import { inboxBadgeSrText, inboxBadgeText } from './badge-text';

/** The waiting-on-us count. Hidden when unknown (null) or zero; "99+" above 99. */
export function InboxBadge({ count }: { count: number | null | undefined }) {
  if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) return null;
  return (
    <span
      data-inbox-badge=""
      className="inline-flex min-w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-500)] px-[7px] text-[11px] font-bold leading-[22px] text-white tabular-nums"
    >
      <span aria-hidden="true">{inboxBadgeText(count)}</span>
      <span className="sr-only">{` ${inboxBadgeSrText(count)}`}</span>
    </span>
  );
}
