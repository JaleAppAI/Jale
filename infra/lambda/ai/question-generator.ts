import type { Handler } from 'aws-lambda';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { parseBedrockJson, stripCodeFences } from '../lib/bedrock-json';
import { getDbPool } from '../lib/db';
import { normalizeProfession } from '../whatsapp/handlers/custom-trust';

const bedrock = new BedrockRuntimeClient({});
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

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
  // Sprint 22 R1-A: every trade (the five standard ones included) is served
  // from this cache now, and the answers are graded by the AI trust scorer.
  // A menu label or a duration ("5 years", "lead") gives the scorer nothing to
  // grade, so the prompt demands three OPEN questions and explicitly forbids
  // years/seniority/"how long" and any multiple-choice or numbered form. The
  // retired prompt actively asked for a seniority question; that is gone.
  const systemPrompt =
    'You generate exactly 3 open-ended assessment questions for a blue-collar worker applying for jobs. ' +
    'Every question must invite the worker to answer in their own words, in a sentence or two. ' +
    'Questions must reveal real trade knowledge without requiring formal education. ' +
    'Never write a multiple-choice question, never offer numbered or lettered options, and never ' +
    'ask anything answerable with a single word, a number, or a level. ' +
    'Return only a JSON array of exactly 3 objects with keys "q_en" and "q_es". No markdown.';

  const userMessage =
    `Generate 3 open questions for a worker who says they are a "${profession}". ` +
    'Question 1: ask what they specialize in and what they actually built or did on their last job. ' +
    'Question 2: ask how they start a job they have never seen before. ' +
    'Question 3: ask about a job or a problem that went wrong and what they did about it. ' +
    'Do not ask how many years of experience they have, do not ask how long they have done the work, ' +
    'and do not ask about seniority or their level (helper, independent, lead) - the profile already ' +
    'collects experience, and a level is a label the scorer cannot grade. ' +
    'Do not offer multiple-choice answers and do not write numbered options. ' +
    'Keep language simple because workers may not be formally educated.';

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
    }),
  );

  const text = response.output?.message?.content?.[0]?.text ?? '';
  // `cleaned` exists only to quote the response in the errors below. The parse
  // itself goes through the shared lenient parser, which also tolerates the
  // prose a model wraps around the JSON when it ignores "no markdown".
  const cleaned = stripCodeFences(text);
  const parsed: unknown = parseBedrockJson(text);

  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error(`Expected 3 questions from Bedrock, got: ${cleaned.slice(0, 100)}`);
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
