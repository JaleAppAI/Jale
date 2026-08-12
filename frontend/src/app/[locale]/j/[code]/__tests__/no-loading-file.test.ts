import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHY THIS FILE EXISTS
 *
 * `src/app/[locale]/j/[code]/` must NOT contain a `loading.tsx`, and this test
 * is here because nothing else in the toolchain will stop someone from adding
 * one back. It looks like an obvious improvement -- every other route in the
 * app has a skeleton -- and the damage it does is invisible in a browser.
 *
 * A `loading.tsx` is sugar for a Suspense boundary wrapped around the segment.
 * With one present, Next streams: it flushes the response head, status 200 and
 * the skeleton, and only then runs `page.tsx`. By the time `getPublicJob`
 * comes back 404 and the page calls `notFound()`, the status line is already
 * on the wire, so Next can only swap the body. A dead or expired job link then
 * answers `200 OK` with not-found content -- a soft 404. Google Jobs treats
 * that as a live posting and keeps indexing (and sending workers to) jobs that
 * no longer exist, and the page LOOKS correct to anyone who checks by eye.
 * Only the status code is wrong.
 *
 * Without the boundary the segment renders to completion before anything is
 * sent, so `notFound()` still owns the status line and the response is a real
 * `404`. That is verified end-to-end by hand (`curl -o /dev/null -w "%{http_code}"`
 * against a bogus code on a production build); this test is the cheap guard
 * that keeps the file from reappearing between those checks.
 *
 * THE PROPER FIX, when someone wants the skeleton back: resolve the job ABOVE
 * the Suspense boundary -- do the lookup in the segment's `layout.tsx` (or a
 * parent server component) so the 404 decision is made before any streaming
 * starts, and let `loading.tsx` cover only the parts that render after the job
 * is known to exist. Delete this test in the same change, and say why.
 */

const ROUTE_DIR = resolve(__dirname, '..');

describe('public job route segment', () => {
  it('has no loading.tsx (its Suspense boundary would turn dead links into soft-404s)', () => {
    const loadingFiles = readdirSync(ROUTE_DIR).filter((name) => /^loading\.(tsx|ts|jsx|js)$/.test(name));
    expect(loadingFiles).toEqual([]);
  });

  it('is looking at the right directory', () => {
    // Guards the test itself: a moved/renamed route would otherwise make the
    // assertion above pass by reading an empty or unrelated folder.
    expect(existsSync(resolve(ROUTE_DIR, 'page.tsx'))).toBe(true);
  });
});
