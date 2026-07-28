import type { PoolClient } from 'pg';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});

export interface TrustQuestion {
  q_en: string;
  q_es: string;
}

function questionGeneratorArn(): string {
  const arn = process.env.QUESTION_GENERATOR_ARN;
  if (!arn) throw new Error('QUESTION_GENERATOR_ARN not set');
  return arn;
}

// Contract: lowercase, trim, collapse whitespace, hyphens/punctuation to spaces,
// strip accents. Must match normalizeProfession() in lambda/ai/question-generator.ts.
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

export async function loadOrGenerateQuestions(
  client: PoolClient,
  professionKey: string,
  professionRaw: string,
): Promise<TrustQuestion[]> {
  const cached = await client.query<{ questions: TrustQuestion[] }>(
    'SELECT questions FROM trade_questions WHERE profession_key = $1',
    [professionKey],
  );
  if (cached.rows.length > 0) return cached.rows[0].questions;

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: questionGeneratorArn(),
      Payload: Buffer.from(JSON.stringify({ professionKey, professionRaw })),
    }),
  );
  return JSON.parse(Buffer.from(response.Payload ?? new Uint8Array()).toString()) as TrustQuestion[];
}
