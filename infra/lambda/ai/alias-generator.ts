import type { Handler } from 'aws-lambda';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDbPool } from '../lib/db';
import { normalizeProfession } from '../lib/profession';
import { TRADE_CATEGORIES } from '../lib/job-fields';

const bedrock = new BedrockRuntimeClient({});
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-lite-v1:0';

const MAX_ALIASES = 15;
const MIN_ALIASES = 1;

export interface TradeAliasRecord {
  trade_key: string;
  trade_raw: string;
  canonical_en: string;
  canonical_es: string;
  aliases: string[];
  trade_category: string | null;
}

export interface AliasGeneratorEvent {
  tradeKey?: string;
  tradeRaw: string;
}

interface RawAliasResponse {
  canonical_en?: unknown;
  canonical_es?: unknown;
  aliases?: unknown;
  trade_category?: unknown;
}

export async function generateAndCacheAliases(
  tradeKey: string,
  tradeRaw: string,
): Promise<TradeAliasRecord | null> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    // CRITICAL: the incoming key may be a Spanish (or otherwise) alias of an
    // already-cached trade (e.g. 'soldador' must hit the seeded welder row),
    // so we check membership in `aliases` in addition to an exact trade_key
    // match before ever calling Bedrock.
    const cached = await client.query<{
      trade_key: string;
      canonical_en: string;
      canonical_es: string;
      aliases: string[];
      trade_category: string | null;
    }>(
      `SELECT trade_key, canonical_en, canonical_es, aliases, trade_category
         FROM trade_aliases
        WHERE trade_key = $1 OR $1 = ANY(aliases)`,
      [tradeKey],
    );
    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      return {
        trade_key: row.trade_key,
        trade_raw: tradeRaw,
        canonical_en: row.canonical_en,
        canonical_es: row.canonical_es,
        aliases: row.aliases,
        trade_category: row.trade_category,
      };
    }

    const generated = await callBedrock(tradeRaw);

    const normalizedAliases = new Set<string>();
    for (const alias of generated.aliases) {
      normalizedAliases.add(normalizeProfession(alias));
    }
    normalizedAliases.add(normalizeProfession(tradeRaw));
    normalizedAliases.add(normalizeProfession(generated.canonical_en));
    normalizedAliases.add(normalizeProfession(generated.canonical_es));

    // An alias like "-" or "./" normalizes to '' -- drop those before persisting.
    const aliases = Array.from(normalizedAliases).filter(Boolean);
    if (aliases.length === 0) {
      throw new Error('No non-empty aliases remained after normalization');
    }

    const finalTradeKey = normalizeProfession(generated.canonical_en);
    const record: TradeAliasRecord = {
      trade_key: finalTradeKey,
      trade_raw: tradeRaw,
      canonical_en: generated.canonical_en,
      canonical_es: generated.canonical_es,
      aliases,
      trade_category: generated.trade_category,
    };

    await client.query(
      `INSERT INTO trade_aliases (trade_key, trade_raw, canonical_en, canonical_es, aliases, trade_category, model_id)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
       ON CONFLICT (trade_key) DO NOTHING`,
      [
        record.trade_key,
        record.trade_raw,
        record.canonical_en,
        record.canonical_es,
        record.aliases,
        record.trade_category,
        BEDROCK_MODEL_ID,
      ],
    );

    return record;
  } finally {
    client.release();
  }
}

interface ValidatedAliasResponse {
  canonical_en: string;
  canonical_es: string;
  aliases: string[];
  trade_category: string | null;
}

async function callBedrock(tradeRaw: string): Promise<ValidatedAliasResponse> {
  const categoryList = TRADE_CATEGORIES.join(', ');
  const systemPrompt =
    'You map a construction-trade name (in any language) to a strict JSON object with keys ' +
    '"canonical_en" (string), "canonical_es" (string), "aliases" (array of strings), and ' +
    '"trade_category" (string or null). ' +
    'Aliases are the trade\'s common English and Spanish names, nicknames, and spelling variants ' +
    'used by construction workers -- 5 to 15 entries, single words or short phrases. ' +
    'Do NOT include related-but-different trades. ' +
    `trade_category must be exactly one of: ${categoryList}, or null if none fit. ` +
    'Return only the JSON object. No markdown.';

  const userMessage = `A worker says their trade is "${tradeRaw}". Map it to the JSON object described.`;

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
    }),
  );

  const text = response.output?.message?.content?.[0]?.text ?? '';
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(trimmed);

  return validateAliasResponse(parsed, trimmed);
}

function validateAliasResponse(parsed: unknown, rawText: string): ValidatedAliasResponse {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected a JSON object from Bedrock, got: ${rawText.slice(0, 100)}`);
  }

  const response = parsed as RawAliasResponse;

  if (typeof response.canonical_en !== 'string' || response.canonical_en.trim().length === 0) {
    throw new Error(`Missing or invalid canonical_en: ${rawText.slice(0, 100)}`);
  }
  if (typeof response.canonical_es !== 'string' || response.canonical_es.trim().length === 0) {
    throw new Error(`Missing or invalid canonical_es: ${rawText.slice(0, 100)}`);
  }
  if (
    !Array.isArray(response.aliases)
    || response.aliases.length < MIN_ALIASES
    || response.aliases.length > MAX_ALIASES
    || response.aliases.some((alias) => typeof alias !== 'string' || alias.trim().length === 0)
  ) {
    throw new Error(`Expected 1-15 non-empty alias strings from Bedrock, got: ${rawText.slice(0, 100)}`);
  }
  if (
    response.trade_category !== null
    && response.trade_category !== undefined
    && (typeof response.trade_category !== 'string' || !TRADE_CATEGORIES.includes(response.trade_category as any))
  ) {
    throw new Error(`Invalid trade_category from Bedrock: ${rawText.slice(0, 100)}`);
  }

  return {
    canonical_en: response.canonical_en,
    canonical_es: response.canonical_es,
    aliases: response.aliases as string[],
    trade_category: (response.trade_category as string | null | undefined) ?? null,
  };
}

export const handler: Handler<AliasGeneratorEvent> = async (event) => {
  const tradeKey = event.tradeKey ?? normalizeProfession(event.tradeRaw);
  return generateAndCacheAliases(tradeKey, event.tradeRaw);
};
