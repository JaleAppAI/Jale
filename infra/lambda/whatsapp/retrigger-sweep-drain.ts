// infra/lambda/whatsapp/retrigger-sweep-drain.ts
//
// EventBridge-scheduled (every 5 minutes) release of stranded deferred
// intents: calls the SECURITY DEFINER sweep (migration 072), which re-emits
// one worker.ready event per ready worker still holding deferred business
// intents (e.g. workers made ready by the migration-053 web bypass, which
// emits no worker.ready event). The existing 1-minute DomainOutboxDrainLambda
// consumes the events and performs the actual release — this Lambda owns no
// business logic beyond the call and a structured metric log.
import type { ScheduledEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';

const SWEEP_LIMIT = 500;

export async function handler(event: ScheduledEvent): Promise<void> {
  const pool = await getDbPool();
  // The EventBridge event id scopes the sweep generation: retries of the
  // same invocation dedupe on event_key, while each 5-minute tick mints a
  // fresh generation for workers still stranded.
  const sweepRunId = event.id || `sweep-${new Date().toISOString().slice(0, 13)}`;
  const result = await pool.query<{ workers_swept: number; events_enqueued: number }>(
    'SELECT workers_swept, events_enqueued FROM retrigger_deferred_ready_workers($1, $2)',
    [sweepRunId, SWEEP_LIMIT],
  );
  const row = result.rows[0] ?? { workers_swept: 0, events_enqueued: 0 };
  console.log(JSON.stringify({
    metric: 'RetriggerSweepDrain',
    workersSwept: row.workers_swept,
    eventsEnqueued: row.events_enqueued,
  }));
}
