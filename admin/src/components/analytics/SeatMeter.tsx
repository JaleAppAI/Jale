import { Badge } from '@/components/ui/badge';
import { seatMeterText, seatsOverLimit, type SeatFigures } from '@/lib/employer-health';

/**
 * A company's seats in words ("2 of 3 seats · 1 pending · 1 suspended"). The
 * count is the owner's billing meter; an "over limit" badge shows whenever the
 * seats held (active foremen plus live invites) pass the plan's limit, so the
 * state never rests on colour or on the numbers alone.
 */
export function SeatMeter({ seats }: { seats: SeatFigures }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span data-seat-meter="" className="tabular-nums">{seatMeterText(seats)}</span>
      {seatsOverLimit(seats) ? <Badge tone="warning">over limit</Badge> : null}
    </span>
  );
}
