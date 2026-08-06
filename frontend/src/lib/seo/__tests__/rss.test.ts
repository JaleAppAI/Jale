import { describe, expect, it } from 'vitest';
import { escapeXml, toRfc822 } from '../rss';

describe('escapeXml', () => {
  it('escapes all five predefined XML entities', () => {
    expect(escapeXml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('escapes & first so its own output entities are not double-escaped', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralizes a CDATA/tag-injection attempt from untrusted employer text', () => {
    const untrusted = 'Roofer]]></description><script>alert(1)</script>';
    const escaped = escapeXml(untrusted);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('</description>');
    expect(escaped).toBe('Roofer]]&gt;&lt;/description&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeXml('Electrician - Austin, TX')).toBe('Electrician - Austin, TX');
  });
});

describe('toRfc822', () => {
  it('formats an ISO date as an RFC-1123/822 UTC string', () => {
    expect(toRfc822('2026-01-01T12:30:00.000Z')).toBe('Thu, 01 Jan 2026 12:30:00 GMT');
  });

  it('falls back to the Unix epoch on an unparseable date rather than emitting "Invalid Date"', () => {
    expect(toRfc822('not-a-date')).toBe(new Date(0).toUTCString());
  });
});
