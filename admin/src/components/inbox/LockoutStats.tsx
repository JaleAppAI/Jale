import { StatTile } from '@/components/ui/stat-tile';
import type { LockoutDetail } from '@/lib/server/admin-lockouts';
import { durationText } from '@/lib/local-time';
import { attemptsText, typicalVerifyText } from './inbox-view';

/** The lockout's four numbers (FE-2 §4.4). "So far" is measured at the page's own now. */
export function LockoutStats({ detail, nowIso }: { detail: LockoutDetail; nowIso: string }) {
  const sinceStart = Date.parse(nowIso) - Date.parse(detail.startedAt);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-4">
      <StatTile label="Attempts used" value={attemptsText(detail.attemptsUsed, detail.attemptsAllowed)} />
      <StatTile label="In verification so far" value={durationText(Number.isFinite(sinceStart) ? sinceStart : 0)} />
      <StatTile label="Earlier resets" value={String(detail.earlierResets)} />
      <StatTile hint="Median over the last 30 days" label="Typical time to verify" value={typicalVerifyText(detail.typicalMinutesToVerify)} />
    </div>
  );
}
