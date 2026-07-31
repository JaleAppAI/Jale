import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { normalizeProfession } from './profession';

const lambdaClient = new LambdaClient({});

/**
 * Fire-and-forget trigger for the bilingual trade-alias generator. Never
 * throws and never blocks the caller: a missing ALIAS_GENERATOR_ARN or a
 * failed invoke is swallowed and logged with only the failure reason, never
 * the raw trade text.
 */
export async function requestTradeAliasGeneration(tradeRaw: string): Promise<void> {
  const arn = process.env.ALIAS_GENERATOR_ARN;
  if (!arn) {
    console.warn('[trade-alias-request] alias generation skipped', {
      event: 'trade_alias_generator_arn_missing',
    });
    return;
  }

  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: arn,
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({ tradeKey: normalizeProfession(tradeRaw), tradeRaw }),
        ),
      }),
    );
  } catch (err) {
    console.warn('[trade-alias-request] alias generation invoke failed', {
      event: 'trade_alias_generation_invoke_failed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    });
  }
}
