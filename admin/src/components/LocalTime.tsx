'use client';

import { useSyncExternalStore } from 'react';
import { utcText } from '@/lib/local-time';

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

function localText(iso: string): string {
  // The viewer's locale and zone; timeStyle 'long' names the zone.
  localFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : localFormat.format(date);
}

/** An instant in the viewer's time zone (UTC text until hydration). */
export function LocalTime({ iso }: { iso: string }) {
  const isClient = useIsClient();
  return <time dateTime={iso}>{isClient ? localText(iso) : utcText(iso)}</time>;
}
