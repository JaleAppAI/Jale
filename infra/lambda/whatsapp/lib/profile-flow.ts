import type { PoolClient } from 'pg';
import { type ProfileField } from './flows';
import { t, type Lang, type TemplateKey } from './templates';

export const FIELD_PROMPT_KEY: Record<ProfileField, TemplateKey> = {
  full_name: 'ask_name',
  city: 'ask_city',
  main_trade: 'ask_trade',
  main_trade_other: 'ask_trade_freetext',
  years_experience: 'ask_experience',
  has_transportation: 'ask_transportation',
  availability: 'ask_availability',
};

export function profileQuestionBody(field: ProfileField, lang: Lang): string {
  return t(FIELD_PROMPT_KEY[field], lang);
}

export async function loadProfileFromDb(
  client: PoolClient,
  userId: string,
): Promise<Partial<Record<ProfileField, string | boolean | null>>> {
  const r = await client.query(
    `SELECT full_name, city, main_trade, main_trade_other,
            years_experience, has_transportation, availability
       FROM users WHERE id = $1`,
    [userId],
  );
  return (r.rows[0] ?? {}) as Partial<Record<ProfileField, string | boolean | null>>;
}

export async function loadTradeFromDb(
  client: PoolClient,
  userId: string,
): Promise<string> {
  const r = await client.query<{ main_trade: string | null }>(
    `SELECT main_trade FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0]?.main_trade ?? 'other';
}

export async function upsertWorkerProfileFromUsers(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO worker_profiles
       (user_id, full_name, phone, availability, years_experience, location)
     SELECT
       id,
       full_name,
       COALESCE(whatsapp_number, phone),
       availability,
       CASE years_experience
         WHEN '0-1' THEN 1
         WHEN '2-4' THEN 3
         WHEN '5-9' THEN 7
         WHEN '10+' THEN 10
         ELSE NULL
       END,
       city
     FROM users
     WHERE id = $1 AND user_type = 'worker'
     ON CONFLICT (user_id) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           phone = EXCLUDED.phone,
           availability = EXCLUDED.availability,
           years_experience = EXCLUDED.years_experience,
           location = EXCLUDED.location`,
    [userId],
  );

  // Seed a trade-derived starter skill. worker_skills is the canonical
  // matching table (ADR-M03) and the web app's profile-completeness gate
  // requires at least one skill — without this, every WhatsApp-onboarded
  // worker is blocked from applying on the web. Uses main_trade_other free
  // text when the trade is "other"; the literal "other" is never a skill.
  // ON CONFLICT DO NOTHING keeps retries idempotent and never clobbers
  // skills the worker added on the web. Lowercased to match the 008
  // normalization convention; capped at the column's 100-char CHECK.
  await client.query(
    `INSERT INTO worker_skills (worker_id, skill)
     SELECT id,
            lower(left(btrim(COALESCE(NULLIF(btrim(main_trade_other), ''), main_trade)), 100))
     FROM users
     WHERE id = $1
       AND user_type = 'worker'
       AND COALESCE(NULLIF(btrim(main_trade_other), ''), main_trade) IS NOT NULL
       AND lower(btrim(COALESCE(NULLIF(btrim(main_trade_other), ''), main_trade))) <> 'other'
     ON CONFLICT DO NOTHING`,
    [userId],
  );
}

// Sprint 22 R1-A: `autoAdvanceProfileAfterAi` (and its `AutoAdvanceProfileArgs`)
// lived here. It was the LAST writer of the v1 `building_profile` ->
// `building_trust_signal` / `building_custom_trust` hand-off and the only
// caller of flows.ts's deleted `buildTrustQuestion`. Its two call sites in
// ai-profile-writer.ts sat on the v1 legacy branch, which has had no producer
// since processor.ts started tagging BOTH StartExecution payloads with the v2
// marker. Everything else in this module is live on v2.

export function normalizeProfession(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[-./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
