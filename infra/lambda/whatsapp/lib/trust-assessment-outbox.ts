import type { PoolClient } from 'pg';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient({});

function trustAssessmentQueueUrl(): string {
  const url = process.env.TRUST_ASSESSMENT_QUEUE_URL;
  if (!url) throw new Error('TRUST_ASSESSMENT_QUEUE_URL not set');
  return url;
}

export async function queueTrustAssessmentEnqueue(
  client: PoolClient,
  assessmentId: string,
  workerId: string,
  professionKey: string,
): Promise<void> {
  await client.query(
    `INSERT INTO trust_assessment_enqueue_outbox
        (assessment_id, worker_id, profession_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (assessment_id) DO NOTHING`,
    [assessmentId, workerId, professionKey],
  );
}

export async function drainTrustAssessmentEnqueueOutbox(
  client: PoolClient,
  limit = 25,
): Promise<void> {
  const rows = await client.query<{
    id: string;
    assessment_id: string;
    worker_id: string;
    profession_key: string;
    attempts: number;
  }>(
    `SELECT id, assessment_id, worker_id, profession_key, attempts
       FROM trust_assessment_enqueue_outbox
      WHERE status IN ('pending','failed')
        AND next_attempt_at <= now()
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  for (const row of rows.rows) {
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: trustAssessmentQueueUrl(),
          MessageBody: JSON.stringify({
            assessmentId: row.assessment_id,
            userId: row.worker_id,
            professionKey: row.profession_key,
          }),
        }),
      );
      await client.query(
        `UPDATE trust_assessment_enqueue_outbox
            SET status = 'sent', sent_at = now(), last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      await client.query(
        `UPDATE trust_assessment_enqueue_outbox
            SET status = 'failed',
                attempts = attempts + 1,
                next_attempt_at = now() + make_interval(mins => LEAST(60, GREATEST(1, attempts + 1) * 5)),
                last_error = left($2, 500)
          WHERE id = $1`,
        [row.id, error instanceof Error ? error.message : String(error)],
      );
    }
  }
}
