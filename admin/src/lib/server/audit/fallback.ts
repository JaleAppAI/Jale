// The fallback channel for attempt and session events.
//
// When an attempt cannot be written to the database, the event goes to a
// dedicated CloudWatch Logs group as one JSON line: the record_event payload
// plus `origin` and `occurred_at`. Each container writes to its own stream,
// one PutLogEvents call per event, and every line it delivers emits the EMF
// metric AuditFallbackEvents. If the fallback fails too, the event is lost and
// AuditFallbackFailed goes to the function log with codes and ids only.
//
// A successful read never falls back: it fails the request instead.
import { randomUUID } from 'node:crypto';
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { SURFACE_PATTERN, type AuditEventPayload } from './codes';

export const AUDIT_FALLBACK_LOG_GROUP_ENV = 'AUDIT_FALLBACK_LOG_GROUP';
export const AUDIT_METRIC_NAMESPACE = 'Jale/Audit';

const ORIGIN = 'admin';

// One stream per container, created on first use.
const streamName = `${ORIGIN}/${randomUUID()}`;
const streamsReady = new Map<string, Promise<void>>();
let logsClient: CloudWatchLogsClient | undefined;

type AuditMetric = 'AuditFallbackEvents' | 'AuditFallbackFailed' | 'AuditWriteFailed';

// Embedded Metric Format: a single JSON line that CloudWatch Logs turns into a
// metric. It must be the only argument to console.log/console.error, or the
// line is no longer parseable and the metric never appears.
function emfLine(
  metric: AuditMetric,
  dimensions: Record<string, string>,
  fields: Record<string, unknown>,
): string {
  return JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: AUDIT_METRIC_NAMESPACE,
        Dimensions: [Object.keys(dimensions)],
        Metrics: [{ Name: metric, Unit: 'Count' }],
      }],
    },
    ...dimensions,
    ...fields,
    [metric]: 1,
  });
}

function surfaceCode(surface: unknown): string {
  return typeof surface === 'string' && surface.length <= 100 && SURFACE_PATTERN.test(surface)
    ? surface
    : 'invalid';
}

/** An access or action event could not be written in its transaction. */
export function emitAuditWriteFailed(surface: unknown): void {
  console.log(emfLine('AuditWriteFailed', { Surface: surfaceCode(surface) }, { origin: ORIGIN }));
}

/**
 * The event is lost. Only codes, ids and counts are printed: never the reveal
 * reason, and never an error's text, which can carry row values.
 */
export function emitAuditFallbackFailed(fields: Record<string, unknown>, occurredAt: Date = new Date()): void {
  console.error(emfLine('AuditFallbackFailed', {}, {
    origin: ORIGIN,
    occurred_at: occurredAt.toISOString(),
    ...fields,
  }));
}

function lostEventFields(payload: AuditEventPayload): Record<string, unknown> {
  const { reason: _reason, link_expires_at: _linkExpiresAt, ...codes } = payload;
  return codes;
}

function getLogsClient(): CloudWatchLogsClient {
  logsClient ??= new CloudWatchLogsClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 },
  });
  return logsClient;
}

function ensureStream(logs: CloudWatchLogsClient, logGroupName: string): Promise<void> {
  let ready = streamsReady.get(logGroupName);
  if (!ready) {
    ready = logs
      .send(new CreateLogStreamCommand({ logGroupName, logStreamName: streamName }))
      .then(
        () => undefined,
        (error: unknown) => {
          if ((error as { name?: unknown } | null)?.name === 'ResourceAlreadyExistsException') {
            return;
          }
          // Not ready: the next fallback tries to create the stream again.
          streamsReady.delete(logGroupName);
          throw error;
        },
      );
    streamsReady.set(logGroupName, ready);
  }
  return ready;
}

/** Writes one event to the fallback group. Never throws. */
export async function writeAuditFallback(payload: AuditEventPayload, occurredAt: Date = new Date()): Promise<void> {
  try {
    const logGroupName = process.env[AUDIT_FALLBACK_LOG_GROUP_ENV]?.trim();
    if (!logGroupName) {
      throw new Error('the audit fallback log group is not configured');
    }
    const logs = getLogsClient();
    await ensureStream(logs, logGroupName);
    await logs.send(new PutLogEventsCommand({
      logGroupName,
      logStreamName: streamName,
      logEvents: [{
        timestamp: occurredAt.getTime(),
        message: JSON.stringify({ origin: ORIGIN, occurred_at: occurredAt.toISOString(), ...payload }),
      }],
    }));
    console.log(emfLine('AuditFallbackEvents', {}, { origin: ORIGIN }));
  } catch {
    emitAuditFallbackFailed(lostEventFields(payload), occurredAt);
  }
}
