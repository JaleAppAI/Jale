import type { Handler } from 'aws-lambda';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDbPool } from '../lib/db';
import { normalizeProfession } from '../whatsapp/handlers/custom-trust';

const bedrock = new BedrockRuntimeClient({});
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-lite-v1:0';

export interface QuestionSet {
  q_en: string;
  q_es: string;
}

export interface QuestionGeneratorEvent {
  professionKey?: string;
  professionRaw: string;
}

export async function generateAndCacheQuestions(
  professionKey: string,
  professionRaw: string,
): Promise<QuestionSet[]> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    const cached = await client.query<{ questions: QuestionSet[] }>(
      'SELECT questions FROM trade_questions WHERE profession_key = $1',
      [professionKey],
    );
    if (cached.rows.length > 0) return cached.rows[0].questions;

    const questions = await callBedrock(professionRaw);

    await client.query(
      `INSERT INTO trade_questions (profession_key, profession_raw, questions, model_id)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (profession_key) DO NOTHING`,
      [professionKey, professionRaw, JSON.stringify(questions), BEDROCK_MODEL_ID],
    );

    return questions;
  } finally {
    client.release();
  }
}

async function callBedrock(profession: string): Promise<QuestionSet[]> {
  const systemPrompt =
    'You generate exactly 3 assessment questions for a blue-collar worker applying for jobs. ' +
    'Questions must reveal real trade knowledge without requiring formal education. ' +
    'Return only a JSON array of exactly 3 objects with keys "q_en" and "q_es". No markdown.';

  const userMessage =
    `Generate 3 assessment questions for a worker who says they are a "${profession}". ` +
    'Questions should cover: specialization, independence/responsibility level, and common tasks. ' +
    'Do not ask how many years of experience they have; that is already collected in the profile. ' +
    'For the second question, ask what level they can work at, such as helper, independently, or lead. ' +
    'Keep language simple because workers may not be formally educated.';

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

  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error(`Expected 3 questions from Bedrock, got: ${trimmed.slice(0, 100)}`);
  }

  return parsed.map((question, index) => {
    const q = question as Partial<QuestionSet>;
    if (!q.q_en || !q.q_es) {
      throw new Error(`Question ${index} missing q_en or q_es`);
    }
    return { q_en: String(q.q_en), q_es: String(q.q_es) };
  });
}

export const handler: Handler<QuestionGeneratorEvent> = async (event) => {
  const professionKey = event.professionKey ?? normalizeProfession(event.professionRaw);
  return generateAndCacheQuestions(professionKey, event.professionRaw);
};
