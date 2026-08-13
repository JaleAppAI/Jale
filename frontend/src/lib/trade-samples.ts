import samples from '@/data/trade-samples.json';

/**
 * Pure wrapper around `data/trade-samples.json` (ready-to-use, O*NET-grounded
 * job description samples, one per trade). Kept dependency-free -- no React,
 * no next-intl -- so it's importable from a plain node-environment vitest
 * test without dragging in `JobFormFields.tsx`'s component tree (LocationPicker,
 * AuthContext, etc).
 *
 * Deliberately excludes `other`: there is no single O*NET SOC code to ground a
 * sample against for a catch-all trade, and the backend rejects `other`
 * outright for AI generation too (`unsupported_trade_category`).
 */
type SampleTrade =
  | 'electrician' | 'plumber' | 'carpenter' | 'concrete'
  | 'painting' | 'drywall' | 'general_labor';

type TradeSampleEntry = { sample_en: string; sample_es: string };

type TradeSamplesFile = Record<SampleTrade, TradeSampleEntry> & {
  _meta: { source: string; soc_codes: Record<string, string>; retrieved: string };
};

const data = samples as unknown as TradeSamplesFile;

const SAMPLE_TRADES: readonly SampleTrade[] = [
  'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor',
];

/** Whether `trade` (a `JobForm['trade_category']` value, including `''`/`'other'`) has a ready-to-use sample. */
export function hasTradeSample(trade: string): trade is SampleTrade {
  return (SAMPLE_TRADES as readonly string[]).includes(trade);
}

/**
 * The sample description text for `trade` in `locale`, or `null` when the
 * trade has no sample (`other`, unset, or an unrecognized value). Only
 * `'es'` resolves to the Spanish text -- any other locale code (including an
 * unrecognized one) falls back to English rather than throwing.
 */
export function getTradeSample(trade: string, locale: string): string | null {
  if (!hasTradeSample(trade)) return null;
  const entry = data[trade];
  return locale === 'es' ? entry.sample_es : entry.sample_en;
}
