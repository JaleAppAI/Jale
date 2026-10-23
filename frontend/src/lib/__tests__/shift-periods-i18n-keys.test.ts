import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { SHIFT_PERIODS } from '@/lib/job-form';

/**
 * The shift-choice labels and their one-line help (contract K2.1), copied from
 * the approved job-form board. They live under `common` because that is the
 * namespace `scheduleSummary` already reads display labels from, so every page
 * that renders a schedule gets them with no keys of its own.
 */

type MessageNode = string | { [key: string]: MessageNode };

function resolve(tree: MessageNode, path: string): string | undefined {
  let node: MessageNode = tree;
  for (const segment of path.split('.')) {
    if (typeof node === 'string' || !(segment in node)) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

const EXPECTED = {
  en: {
    day: ['Day', 'Starts in the morning, ends by late afternoon'],
    evening: ['Evening', 'Starts in the afternoon, ends by late evening'],
    night: ['Night', 'Starts in the evening, ends after midnight'],
    overnight: ['Overnight', 'Runs through the night, ends in the morning'],
  },
  es: {
    day: ['Día', 'Empieza en la mañana y termina a media tarde'],
    evening: ['Tarde', 'Empieza en la tarde y termina en la noche'],
    night: ['Noche', 'Empieza en la noche y termina después de medianoche'],
    overnight: ['Madrugada', 'Toda la noche, termina en la mañana'],
  },
} as const;

describe('shift choice copy', () => {
  for (const [locale, tree] of [['en', en], ['es', es]] as const) {
    it(`has a label and a help line for every shift in ${locale}`, () => {
      for (const period of SHIFT_PERIODS) {
        const [label, help] = EXPECTED[locale][period];
        expect(resolve(tree as MessageNode, `common.shift_periods.${period}`)).toBe(label);
        expect(resolve(tree as MessageNode, `common.shift_period_help.${period}`)).toBe(help);
      }
    });
  }
});
