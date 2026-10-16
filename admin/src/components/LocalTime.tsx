'use client';

import { useSyncExternalStore } from 'react';
import { relativeText, utcDateText, utcText, utcTimeText } from '@/lib/local-time';

const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * False on the server and during hydration, true after it. For values that
 * depend on the viewer, like the time zone: the first client render matches
 * the server's HTML, then React renders again with the viewer's value.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer);
}

let localFormat: Intl.DateTimeFormat | undefined;
let localDateFormat: Intl.DateTimeFormat | undefined;
let localClockFormat: Intl.DateTimeFormat | undefined;

function localText(iso: string): string {
  // The viewer's locale and zone; timeStyle 'long' names the zone.
  localFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : localFormat.format(date);
}

function localDateText(iso: string): string {
  localDateFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : localDateFormat.format(date);
}

function localClockText(iso: string): string {
  localClockFormat ??= new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : localClockFormat.format(date);
}

type LocalTimeFormat = 'datetime' | 'date' | 'time' | 'relative';

function serverText(iso: string, format: LocalTimeFormat, nowIso: string | undefined): string {
  if (format === 'date') return utcDateText(iso);
  if (format === 'time') return utcTimeText(iso);
  // Relative text needs the server's request time to be deterministic.
  if (format === 'relative' && nowIso) return relativeText(iso, Date.parse(nowIso));
  return utcText(iso);
}

function clientText(iso: string, format: LocalTimeFormat): string {
  if (format === 'date') return localDateText(iso);
  if (format === 'time') return localClockText(iso);
  if (format === 'relative') return relativeText(iso, Date.now());
  return localText(iso);
}

/**
 * An instant for the viewer. `datetime` (default) is the full local date and
 * time; `date` the local date; `time` the local time of day (message times);
 * `relative` "5m ago" against the server's `nowIso`, then against the
 * viewer's clock after hydration. The server and the first client render show
 * UTC-based text, so hydration never mismatches; `date`, `time` and
 * `relative` carry the full local date-time as a title once hydrated.
 */
export function LocalTime({ iso, format = 'datetime', nowIso }: { iso: string; format?: LocalTimeFormat; nowIso?: string }) {
  const isClient = useIsClient();
  if (!isClient) {
    return <time dateTime={iso}>{serverText(iso, format, nowIso)}</time>;
  }
  return (
    <time dateTime={iso} title={format === 'datetime' ? undefined : localText(iso)}>
      {clientText(iso, format)}
    </time>
  );
}
