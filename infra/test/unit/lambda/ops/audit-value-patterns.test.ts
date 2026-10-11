import {
  CLOUDWATCH_VALUE_PATTERNS,
  VALUE_KINDS,
  cloudWatchRegexToJs,
  scanForValues,
} from '../../../../lambda/ops/audit-value-patterns';
import { MUST_HIT, MUST_NOT_HIT } from './fixtures/audit-value-samples';

/**
 * One set of value patterns, used by the export job's `reason`
 * scan and, in CloudWatch's regex subset, by the metric filters on the audit
 * log groups. Both are checked against the one shared sample table.
 */
describe('audit value patterns', () => {
  it('has a pattern for each value kind', () => {
    expect([...VALUE_KINDS].sort()).toEqual(['email', 'phone', 'url']);
    expect(Object.keys(CLOUDWATCH_VALUE_PATTERNS).sort()).toEqual(['email', 'phone', 'url']);
  });

  describe('the CloudWatch form', () => {
    it.each(VALUE_KINDS.map((kind) => [kind]))('%s uses only the documented regex subset', (kind) => {
      const pattern = CLOUDWATCH_VALUE_PATTERNS[kind];
      // Delimited by %, one regex, no parentheses, no space, only the
      // documented symbols and operators.
      expect(pattern.startsWith('%') && pattern.endsWith('%')).toBe(true);
      const body = pattern.slice(1, -1);
      expect(body).not.toContain('%');
      expect(body).toMatch(/^[A-Za-z0-9:_#=@/;,\-^$?[\]{}|\\*+.]+$/);
      // CloudWatch rejects patterns longer than 1024 characters.
      expect(pattern.length).toBeLessThanOrEqual(1024);
    });

    it.each(MUST_NOT_HIT.map((sample) => [sample]))('does not hit %s', (sample) => {
      for (const kind of VALUE_KINDS) {
        expect(cloudWatchRegexToJs(CLOUDWATCH_VALUE_PATTERNS[kind]).test(sample)).toBe(false);
      }
    });

    it.each(MUST_HIT.map(({ sample, kind }) => [sample, kind]))('hits %s as %s', (sample, kind) => {
      expect(cloudWatchRegexToJs(CLOUDWATCH_VALUE_PATTERNS[kind as 'phone' | 'email' | 'url']).test(sample)).toBe(true);
    });

    it('refuses a pattern outside the subset', () => {
      expect(() => cloudWatchRegexToJs('%(a)%')).toThrow('CLOUDWATCH_REGEX_UNSUPPORTED');
      expect(() => cloudWatchRegexToJs('%a b%')).toThrow('CLOUDWATCH_REGEX_UNSUPPORTED');
      expect(() => cloudWatchRegexToJs('a')).toThrow('CLOUDWATCH_REGEX_UNSUPPORTED');
    });
  });

  describe('the export scanner', () => {
    it.each(MUST_NOT_HIT.map((sample) => [sample]))('finds nothing in %s', (sample) => {
      expect(scanForValues(sample)).toEqual([]);
    });

    it.each(MUST_HIT.map(({ sample, kind }) => [sample, kind]))('finds %s as %s', (sample, kind) => {
      expect(scanForValues(sample)).toContain(kind);
    });

    it('finds nothing in an absent reason', () => {
      expect(scanForValues(null)).toEqual([]);
      expect(scanForValues(undefined)).toEqual([]);
      expect(scanForValues('')).toEqual([]);
    });

    it('reports every kind present, once each', () => {
      expect(scanForValues('555-010-1234 or jane@example.com or https://example.com or 555-010-9999'))
        .toEqual(['phone', 'email', 'url']);
    });
  });
});
