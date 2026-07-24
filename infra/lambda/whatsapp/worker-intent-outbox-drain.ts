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
