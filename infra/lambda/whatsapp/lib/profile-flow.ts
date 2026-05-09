import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  buildTrustQuestion,
  computeNextField,
  type ProfileField,
} from './flows';
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

async function tableColumnExists(
  client: PoolClient,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = $1
          AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return r.rows[0]?.exists === true;
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

export async function trustSignalColumnsAvailable(client: PoolClient): Promise<boolean> {
  const hasSignals = await tableColumnExists(client, 'users', 'trust_signals');
  if (!hasSignals) return false;
  return tableColumnExists(client, 'users', 'trust_signals_completed_at');
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
}

export interface AutoAdvanceProfileArgs {
  userId: string;
  conversationId: string;
  inboundMessageSid: string;
  language: Lang;
  queueBody: (body: string) => Promise<void>;
  loadCustomTrustQuestions?: (
    client: PoolClient,
    professionKey: string,
    professionRaw: string,
  ) => Promise<Array<{ q_en: string; q_es: string }>>;
  assessmentIdFactory?: () => string;
}

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

export async function autoAdvanceProfileAfterAi(
  client: PoolClient,
  args: AutoAdvanceProfileArgs,
): Promise<void> {
  const dbFilled = await loadProfileFromDb(client, args.userId);
  const next = computeNextField({}, dbFilled);

  if (next !== null) {
    await client.query(
      `UPDATE whatsapp_conversations
          SET conversation_state = 'building_profile',
              state_context = $2::jsonb,
              last_processed_message_sid = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [
        args.conversationId,
        JSON.stringify({ pending_field: next, collected: {}, field_sids: {} }),
        args.inboundMessageSid,
      ],
    );
    await args.queueBody(profileQuestionBody(next, args.language));
    return;
  }

  await upsertWorkerProfileFromUsers(client, args.userId);

  if (dbFilled.main_trade === 'other' && typeof dbFilled.main_trade_other === 'string') {
    const professionRaw = dbFilled.main_trade_other.trim();
    if (professionRaw) {
      const professionKey = normalizeProfession(professionRaw);
      const existing = await client.query(
        `SELECT id FROM worker_trust_assessments
         WHERE user_id = $1 AND profession_key = $2
           AND status IN ('pending','scoring','scored','failed')`,
        [args.userId, professionKey],
      );
      if (existing.rows.length === 0) {
        if (!args.loadCustomTrustQuestions) {
          throw new Error('loadCustomTrustQuestions required for custom AI profile trust flow');
        }
        const questions = await args.loadCustomTrustQuestions(client, professionKey, professionRaw);
        const assessmentId = args.assessmentIdFactory?.() ?? randomUUID();
        await client.query(
          `UPDATE whatsapp_conversations
              SET conversation_state = 'building_custom_trust',
                  state_context = $2::jsonb,
                  last_processed_message_sid = $3,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            args.conversationId,
            JSON.stringify({
              custom_trust_step: 0,
              custom_trust_answers: [],
              custom_trust_profession: professionRaw,
              custom_trust_questions: questions,
              custom_trust_assessment_id: assessmentId,
            }),
            args.inboundMessageSid,
          ],
        );
        await args.queueBody(args.language === 'es' ? questions[0].q_es : questions[0].q_en);
        return;
      }
    }
  }

  if (!await trustSignalColumnsAvailable(client)) {
    await client.query(
      `UPDATE whatsapp_conversations
          SET conversation_state = 'idle',
              state_context = '{}'::jsonb,
              last_processed_message_sid = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [args.conversationId, args.inboundMessageSid],
    );
    await args.queueBody(t('profile_complete', args.language));
    return;
  }

  const trust = await client.query<{ trust_signals_completed_at: string | null }>(
    `SELECT trust_signals_completed_at FROM users WHERE id = $1`,
    [args.userId],
  );
  const trustDone = !!trust.rows[0]?.trust_signals_completed_at;

  if (!trustDone) {
    const trade = await loadTradeFromDb(client, args.userId);
    await client.query(
      `UPDATE whatsapp_conversations
          SET conversation_state = 'building_trust_signal',
              state_context = $2::jsonb,
              last_processed_message_sid = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [
        args.conversationId,
        JSON.stringify({ trust_step: 0, trust_answers: [] }),
        args.inboundMessageSid,
      ],
    );
    await args.queueBody(buildTrustQuestion(0, trade, args.language));
    return;
  }

  await client.query(
    `UPDATE whatsapp_conversations
        SET conversation_state = 'idle',
            state_context = '{}'::jsonb,
            last_processed_message_sid = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [args.conversationId, args.inboundMessageSid],
  );
  await args.queueBody(t('profile_complete', args.language));
}
