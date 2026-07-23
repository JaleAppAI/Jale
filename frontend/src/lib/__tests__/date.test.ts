import { describe, expect, it } from 'vitest';
import { formatStartDate } from '@/lib/date';

describe('formatStartDate', () => {
  it('formats an ISO timestamp without day-shift (en)', () => {
    expect(formatStartDate('2026-06-15T00:00:00.000Z', 'en')).toBe('June 15, 2026');
  });

  it('localizes to Spanish', () => {
    expect(formatStartDate('2026-06-15', 'es')).toMatch(/junio/);
  });

  it('returns null for empty', () => {
    expect(formatStartDate(null, 'en')).toBeNull();
  });
});
