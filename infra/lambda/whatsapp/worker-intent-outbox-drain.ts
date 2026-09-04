import type { ScheduledEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { countAgedWorkerIntentOutbox, drainWorkerIntentOutbox } from './lib/outbox';

export async function handler(_event: ScheduledEvent): Promise<void> {
  const pool = await getDbPool();
  let result: Awaited<ReturnType<typeof drainWorkerIntentOutbox>>;
  try {
    result = await drainWorkerIntentOutbox(pool);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('worker_intent_lease_lost:')) {
      console.log(JSON.stringify({ metric: 'WorkerIntentOutboxLeaseLost', count: 1 }));
    }
    throw error;
  }
  const agedBacklog = await countAgedWorkerIntentOutbox(pool);
  // `...result` carries migration 093's `deferred` count onto this line as
  // well as sent/ambiguous/failed/leaseLost. It is load-bearing: a deferred
  // row is neither sent nor failed, so without it a lane whose WhatsApp
  // template is stuck pending Meta approval reads as a drain that quietly did
  // nothing. `sent: 0, failed: 0, deferred: 4` says what is actually wrong.
  console.log(JSON.stringify({ metric: 'WorkerIntentOutboxDrain', ...result }));
  if (result.ambiguous > 0) {
    console.log(JSON.stringify({ metric: 'WorkerIntentOutboxSendUnknown', count: result.ambiguous }));
  }
  if (result.failed > 0) {
    console.log(JSON.stringify({ metric: 'WorkerIntentOutboxFailure', count: result.failed }));
  }
  if (result.leaseLost > 0) {
    console.log(JSON.stringify({ metric: 'WorkerIntentOutboxLeaseLost', count: result.leaseLost }));
  }
  if (agedBacklog > 0) {
    console.log(JSON.stringify({ metric: 'WorkerIntentOutboxBacklogAged', count: agedBacklog }));
  }
}
