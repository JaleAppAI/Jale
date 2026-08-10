import { describe, expect, it } from 'vitest';
import { localeSwitchHref } from '../locale-switch';

/**
 * The referral tag is the thing under test here, not string concatenation.
 * A visitor who opens `/en/j/ABC123?r=demo` from WhatsApp and taps "Español"
 * must land on `/es/j/ABC123?r=demo` -- if the `?r=` is dropped, the ribbon
 * stops naming who shared the job and the apply intent posts with no share
 * code, so the referral is lost with no error anywhere to show for it.
 */
describe('localeSwitchHref', () => {
  it('carries the ?r= share tag across the switch', () => {
    expect(localeSwitchHref('/j/ABC123', 'r=demo')).toBe('/j/ABC123?r=demo');
  });

  it('accepts a leading "?" (location.search shape) without doubling it', () => {
    expect(localeSwitchHref('/j/ABC123', '?r=demo')).toBe('/j/ABC123?r=demo');
  });

  it('preserves every param, in order, not just r', () => {
    expect(localeSwitchHref('/j/ABC123', 'r=demo&utm_source=whatsapp')).toBe(
      '/j/ABC123?r=demo&utm_source=whatsapp',
    );
  });

  it('passes an encoded value through verbatim rather than re-serializing it', () => {
    expect(localeSwitchHref('/j/ABC123', 'r=a%2Bb%20c')).toBe('/j/ABC123?r=a%2Bb%20c');
  });

  it('returns the bare path when there is no query', () => {
    expect(localeSwitchHref('/j/ABC123', '')).toBe('/j/ABC123');
    expect(localeSwitchHref('/j/ABC123', null)).toBe('/j/ABC123');
    expect(localeSwitchHref('/j/ABC123', undefined)).toBe('/j/ABC123');
  });

  it('never emits a dangling "?" for an empty search string', () => {
    // Two URLs for one page splits the ISR cache and the canonical signal.
    expect(localeSwitchHref('/j/ABC123', '?')).toBe('/j/ABC123');
  });
});
