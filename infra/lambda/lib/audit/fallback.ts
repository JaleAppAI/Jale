import { randomUUID } from 'node:crypto';
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { emitAuditFallbackEvent, emitAuditFallbackFailed } from './metrics';
import type { AuditEventPayload } from './record';

/**
 * The fallback channel for attempt records: when an attempt
 * cannot be written to the database, it goes to a dedicated CloudWatch Logs
 * group as one JSON line, the record_event payload plus `occurred_at` and
 * `origin`. Each container writes to its own stream, `<origin>/<uuid>`,
 * created on first use. Every delivered line emits `AuditFallbackEvents`. If
 * the fallback fails too, the record is lost and `AuditFallbackFailed` goes to
 * the function log with codes and ids only.
 *
 * A successful read never comes here: its record is written in the read's
 * own transaction, or the request fails.
 */
export const AUDIT_FALLBACK_LOG_GROUP_ENV = 'AUDIT_FALLBACK_LOG_GROUP';

export type AuditOrigin = 'api' | 'whatsapp';

/** `whatsapp` for the Lambdas on the WhatsApp engine's login, `api` for the rest. */
export function auditOrigin(env: NodeJS.ProcessEnv = process.env): AuditOrigin {
  return env.DB_EXPECTED_LOGIN === 'jale_whatsapp' ? 'whatsapp' : 'api';
}

const containerId = randomUUID();
const streamsReady = new Map<string, Promise<void>>();
let logsClient: CloudWatchLogsClient | undefined;

function getLogsClient(): CloudWatchLogsClient {
  // Bounded, so a slow Logs endpoint delays a failed request's answer by
  // seconds at most.
  logsClient ??= new CloudWatchLogsClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 },
  });
  return logsClient;
}

function ensureStream(logs: CloudWatchLogsClient, logGroupName: string, logStreamName: string): Promise<void> {
  const key = `${logGroupName}\n${logStreamName}`;
  let ready = streamsReady.get(key);
  if (!ready) {
    ready = logs
      .send(new CreateLogStreamCommand({ logGroupName, logStreamName }))
      .then(
        () => undefined,
        (error: unknown) => {
          if ((error as { name?: unknown } | null)?.name === 'ResourceAlreadyExistsException') return;
          // Not ready: the next fallback tries to create the stream again.
          streamsReady.delete(key);
          throw error;
        },
      );
    streamsReady.set(key, ready);
  }
  return ready;
}

/** The lost record's codes and ids, for the AuditFallbackFailed line. */
function lostRecordFields(payload: AuditEventPayload): Record<string, unknown> {
  const { link_expires_at: _linkExpiresAt, ...codes } = payload;
  return codes;
}

/** Writes one attempt record to the fallback group. Never throws. */
export async function writeAuditFallback(
  payload: AuditEventPayload,
  occurredAt: Date = new Date(),
  origin: AuditOrigin = auditOrigin(),
): Promise<void> {
  try {
    const logGroupName = process.env[AUDIT_FALLBACK_LOG_GROUP_ENV]?.trim();
    if (!logGroupName) throw new Error('the audit fallback log group is not configured');
    const logStreamName = `${origin}/${containerId}`;
    const logs = getLogsClient();
    await ensureStream(logs, logGroupName, logStreamName);
    await logs.send(new PutLogEventsCommand({
      logGroupName,
      logStreamName,
      logEvents: [{
        timestamp: occurredAt.getTime(),
        message: JSON.stringify({ ...payload, occurred_at: occurredAt.toISOString(), origin }),
      }],
    }));
    emitAuditFallbackEvent(origin);
  } catch {
    // The error's text is never printed: a database or SDK message can echo
    // values. The record's codes and ids say what was lost.
    emitAuditFallbackFailed(origin, { ...lostRecordFields(payload), occurred_at: occurredAt.toISOString() });
  }
}
