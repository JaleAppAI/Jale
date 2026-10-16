// Times for the viewer's own time zone. Records store UTC instants. The
// server cannot know the viewer's zone, so it renders UTC text, and the
// browser switches to its own zone after hydration (components/LocalTime.tsx).

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

// What datetime-local inputs produce: a date and a time, no zone.
const LOCAL_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * "2026-10-02 14:30:05 UTC". The server and the browser's first render
 * produce exactly this text, so hydration never mismatches.
 */
export function utcText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * An instant as a datetime-local value ("YYYY-MM-DDTHH:mm") in the zone this
 * code runs in, the viewer's zone in a browser. Empty when there is no instant.
 */
export function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A datetime-local value, read in the zone this code runs in, as an ISO
 * instant in UTC. Undefined when the value is empty or not a local date-time.
 */
export function localInputToIso(value: string): string | undefined {
  if (!LOCAL_INPUT_PATTERN.test(value)) return undefined;
  // A date-time with no offset is local time (ECMAScript date time string format).
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2026-10-02 UTC": the server's and the first client render's date-only text. */
export function utcDateText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 10)} UTC`;
}

/** "14:30 UTC": the server's and the first client render's time-only text (FE-2 message times). */
export function utcTimeText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * A length of time: "45m", "3h 12m", "1d 4h". Negative or invalid input reads
 * "0m" (a clock a little ahead of the server must not print a negative wait).
 */
export function durationText(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalMinutes = Math.floor(safe / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * An instant relative to `nowMs`: "just now" (under a minute either way),
 * "5m ago", "3h ago", "2d ago", or "in 3h 12m" for a future instant.
 * Deterministic, so the server and the first client render agree.
 */
export function relativeText(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at) || !Number.isFinite(nowMs)) return iso;
  const diff = nowMs - at;
  if (Math.abs(diff) < MINUTE_MS) return 'just now';
  if (diff < 0) return `in ${durationText(-diff)}`;
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  return `${Math.floor(diff / DAY_MS)}d ago`;
}
