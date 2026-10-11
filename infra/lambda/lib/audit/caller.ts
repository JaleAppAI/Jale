import { randomUUID } from 'node:crypto';
import {
  REQUEST_CHANNELS,
  REQUEST_ID_PATTERN,
  type RequestChannel,
} from './registry';

/**
 * Who is acting, as the audit records name them.
 *
 * - `worker` and `employer` carry the caller's `users.id`, resolved from the
 *   verified sign-in and never from the request body or query.
 * - `token_holder` is whoever holds a document upload link.
 * - `anonymous` is a person whose identity is not verified.
 * - `platform` is a system or provider callback.
 *
 * The last three never carry an id: not a phone number, not an unverified
 * sign-in subject, not any other raw identifier.
 */
export type AuditActor =
  | { kind: 'worker' | 'employer'; id: string }
  | { kind: 'token_holder' | 'anonymous' | 'platform' };

export interface AuditCaller {
  readonly actorKind: AuditActor['kind'];
  readonly actorId: string | null;
  readonly channel: RequestChannel;
  /**
   * The request's correlation id: API Gateway's request id, or the Lambda
   * invocation id for other entry points. A generated UUID when neither is
   * usable, so the parts of a split event still share one id.
   */
  readonly requestId: string;
}

/** The smallest shape of an API Gateway event this module reads. */
export interface RequestIdSource {
  requestContext?: { requestId?: unknown } | null;
}

const ID_ACTORS = new Set<string>(['worker', 'employer']);
const NO_ID_ACTORS = new Set<string>(['token_holder', 'anonymous', 'platform']);

function usableRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/**
 * Builds a caller from an actor and a correlation id. Throws on an actor the
 * records cannot hold: a worker or employer without a users.id, or an id on
 * an actor that must not carry one. Both are programming errors, so failing
 * the request is the safe answer. The id's UUID form is checked where a
 * record is built (record.ts, context.ts), next to the database that needs it.
 */
export function auditCallerFor(
  requestId: unknown,
  actor: AuditActor,
  channel: RequestChannel,
): AuditCaller {
  const kind = (actor as { kind?: unknown } | null)?.kind;
  const id = (actor as { id?: unknown } | null)?.id;
  if (typeof kind !== 'string' || (!ID_ACTORS.has(kind) && !NO_ID_ACTORS.has(kind))) {
    throw new Error('audit caller: unknown actor kind');
  }
  if (ID_ACTORS.has(kind) && (typeof id !== 'string' || id.length === 0)) {
    throw new Error(`audit caller: the ${kind} actor needs its users.id`);
  }
  if (NO_ID_ACTORS.has(kind) && id !== undefined && id !== null) {
    throw new Error(`audit caller: the ${kind} actor carries no id`);
  }
  if (!(REQUEST_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error('audit caller: unknown channel');
  }
  return Object.freeze({
    actorKind: kind as AuditActor['kind'],
    actorId: ID_ACTORS.has(kind) ? (id as string).toLowerCase() : null,
    channel,
    requestId: usableRequestId(requestId),
  });
}

/**
 * The caller of an API Gateway request. The request id is read with optional
 * chaining: hand-built test events often carry no requestContext beyond the
 * authorizer claims.
 */
export function auditCaller(
  event: RequestIdSource | null | undefined,
  actor: AuditActor,
  channel: RequestChannel,
): AuditCaller {
  return auditCallerFor(event?.requestContext?.requestId, actor, channel);
}
