// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import {
  AVAILABILITY_KEYS,
  EXPERIENCE_KEYS,
  STANDARD_TRADE_KEYS,
  TRADE_KEYS,
  TRANSPORT_KEYS,
  WORKER_VOCAB_VERSION,
  availabilityLabelKey,
  experienceLabelKey,
  tradeLabel,
  tradeLabelKey,
  transportLabelKey,
} from '@/lib/worker-vocab';

/**
 * Two different guarantees are pinned here.
 *
 * 1. The SETS themselves. A backend parity test reads `worker-vocab.ts` as
 *    text; this side checks the values the app actually imports, so a rename
 *    that keeps the file's shape still fails.
 * 2. That every key RESOLVES through next-intl in both locales. `10+` is the
 *    reason this is a rendering test rather than a JSON walk: `+` in a message
 *    key is not something to take on faith, and a missing key surfaces as the
 *    raw path rather than an exception.
 */

describe('worker vocabulary sets', () => {
  it('holds exactly the six trades, standard five first', () => {
    expect(TRADE_KEYS).toEqual(['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other']);
    expect(STANDARD_TRADE_KEYS).toEqual(['electrician', 'plumber', 'carpenter', 'concrete', 'painting']);
    expect(TRADE_KEYS.slice(0, 5)).toEqual([...STANDARD_TRADE_KEYS]);
  });

  it('holds the engine experience, availability and transport sets', () => {
    expect(EXPERIENCE_KEYS).toEqual(['0-1', '2-4', '5-9', '10+']);
    expect(AVAILABILITY_KEYS).toEqual(['full_time', 'part_time', 'weekends', 'flexible']);
    expect(TRANSPORT_KEYS).toEqual(['yes', 'no']);
  });

  it('is version 1', () => {
    expect(WORKER_VOCAB_VERSION).toBe(1);
  });
});

function VocabDump() {
  const t = useTranslations('worker_vocab');
  return (
    <ul>
      {TRADE_KEYS.map((k) => <li key={k} data-testid={`trade-${k}`}>{t(tradeLabelKey(k))}</li>)}
      {EXPERIENCE_KEYS.map((k) => <li key={k} data-testid={`experience-${k}`}>{t(experienceLabelKey(k))}</li>)}
      {AVAILABILITY_KEYS.map((k) => <li key={k} data-testid={`availability-${k}`}>{t(availabilityLabelKey(k))}</li>)}
      {TRANSPORT_KEYS.map((k) => <li key={k} data-testid={`transport-${k}`}>{t(transportLabelKey(k))}</li>)}
    </ul>
  );
}

describe('every vocabulary label resolves', () => {
  for (const [locale, messages] of [['en', en], ['es', es]] as const) {
    it(`renders a real sentence for every key in ${locale}`, () => {
      render(
        <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
          <VocabDump />
        </NextIntlClientProvider>,
      );
      const groups = [
        ['trade', TRADE_KEYS],
        ['experience', EXPERIENCE_KEYS],
        ['availability', AVAILABILITY_KEYS],
        ['transport', TRANSPORT_KEYS],
      ] as const;
      for (const [group, keys] of groups) {
        for (const key of keys) {
          const text = screen.getByTestId(`${group}-${key}`).textContent ?? '';
          expect(text.length, `${locale} ${group}.${key} is empty`).toBeGreaterThan(0);
          // A missing key renders as the dotted path itself.
          expect(text, `${locale} ${group}.${key} did not resolve`).not.toContain(`${group}.${key}`);
        }
      }
    });
  }

  it('shows the 10+ bucket, the one key with a + in its path', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
        <VocabDump />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('experience-10+')).toHaveTextContent('10+ years');
  });
});

describe('tradeLabel', () => {
  const t = (key: string) => (key === 'trade.other' ? 'Other' : `[${key}]`);

  it('prefers the worker\'s own words for "other"', () => {
    expect(tradeLabel(t, 'other', ' welder ')).toBe('welder');
    expect(tradeLabel(t, 'other', null)).toBe('Other');
    expect(tradeLabel(t, 'other', '   ')).toBe('Other');
  });

  it('translates a standard trade and passes null through', () => {
    expect(tradeLabel(t, 'plumber')).toBe('[trade.plumber]');
    expect(tradeLabel(t, null)).toBeNull();
  });
});
