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
