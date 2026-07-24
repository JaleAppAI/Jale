import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';

const MESSAGE_SID_PATTERN = /^(?:SM|MM)[0-9a-fA-F]{32}$/;
const FROM_PATTERN = /^whatsapp:\+[1-9]\d{7,14}$/;
const UNSAFE_EXACT_TARGET = /[,?*%[\]]|\.\./;
const VALUE_FLAGS = new Set(['--message-sid', '--sqs-message-id', '--dlq-url', '--queue-url']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, '--execute']);
const DEFAULT_MAX_BATCHES = 10;

export type InboundReplayTarget =
  | { kind: 'message_sid'; value: string }
  | { kind: 'sqs_message_id'; value: string };

export interface InboundReplayArgs {
  target: InboundReplayTarget;
  dlqUrl: string;
  queueUrl: string;
  execute: boolean;
}

export type ParseInboundReplayArgsResult =
  | { ok: true; value: InboundReplayArgs }
  | { ok: false; error: string };

export type InboundReplayResultKind =
  | 'dry_run'
  | 'executed'
  | 'not_found'
  | 'validation_failed'
  | 'scan_failed'
  | 'visibility_restore_failed'
  | 'send_failed'
  | 'destination_accepted_source_not_deleted';

export interface InboundReplayResult { kind: InboundReplayResultKind }
export interface SqsCommandClient { send(command: unknown): Promise<unknown> }
export interface ReplayWhatsappInboundOptions { maxBatches?: number; log?: (line: string) => void }

export function parseInboundReplayArgs(argv: string[]): ParseInboundReplayArgsResult {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!ALL_FLAGS.has(arg)) return { ok: false, error: arg.startsWith('--') ? `Unknown flag: ${arg}` : 'Unexpected positional value' };
    if (arg === '--execute') {
      if (execute) return { ok: false, error: 'Duplicate flag: --execute' };
      execute = true;
      continue;
    }
    if (values.has(arg)) return { ok: false, error: `Duplicate flag: ${arg}` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `Missing value for ${arg}` };
    values.set(arg, value);
    index += 1;
  }
  const messageSid = values.get('--message-sid');
  const sqsMessageId = values.get('--sqs-message-id');
  if (Boolean(messageSid) === Boolean(sqsMessageId)) return { ok: false, error: 'Exactly one target is required' };
  const dlqUrl = values.get('--dlq-url');
  const queueUrl = values.get('--queue-url');
  if (!dlqUrl || !queueUrl) return { ok: false, error: '--dlq-url and --queue-url are required' };
  if (dlqUrl === queueUrl) return { ok: false, error: 'Source and destination queue URLs must differ' };
  let target: InboundReplayTarget;
  if (messageSid !== undefined) {
    if (!MESSAGE_SID_PATTERN.test(messageSid)) return { ok: false, error: 'Invalid MessageSid' };
    target = { kind: 'message_sid', value: messageSid };
  } else {
    if (!sqsMessageId || sqsMessageId.trim().length === 0 || UNSAFE_EXACT_TARGET.test(sqsMessageId)) return { ok: false, error: 'Invalid exact SQS MessageId' };
    target = { kind: 'sqs_message_id', value: sqsMessageId };
  }
  return { ok: true, value: { target, dlqUrl, queueUrl, execute } };
}

interface ParsedInboundBody { messageSid: string; from: string }
function parseBody(rawBody: string | undefined): ParsedInboundBody | null {
  if (rawBody === undefined) return null;
  const params = new URLSearchParams(rawBody);
  const messageSids = params.getAll('MessageSid');
  const fromValues = params.getAll('From');
  if (messageSids.length !== 1 || fromValues.length !== 1 || !MESSAGE_SID_PATTERN.test(messageSids[0]) || !FROM_PATTERN.test(fromValues[0])) return null;
  return { messageSid: messageSids[0], from: fromValues[0] };
}

function matchesTarget(message: Message, target: InboundReplayTarget): boolean {
  return target.kind === 'sqs_message_id' ? message.MessageId === target.value : parseBody(message.Body)?.messageSid === target.value;
}

interface ValidatedTarget { body: string; messageSid: string; groupId: string; deduplicationId: string; receiptHandle: string }
function validateTarget(message: Message): ValidatedTarget | null {
  const parsedBody = parseBody(message.Body);
  const groupId = message.Attributes?.MessageGroupId;
  const deduplicationId = message.Attributes?.MessageDeduplicationId;
  if (!parsedBody || message.Body === undefined || !message.ReceiptHandle || !groupId || !deduplicationId || deduplicationId !== parsedBody.messageSid) return null;
  return { body: message.Body, messageSid: parsedBody.messageSid, groupId, deduplicationId, receiptHandle: message.ReceiptHandle };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function restoreVisibility(client: SqsCommandClient, queueUrl: string, messages: Message[]): Promise<boolean> {
  const handles = messages.map((message) => message.ReceiptHandle).filter((value): value is string => Boolean(value));
  if (handles.length !== messages.length) return false;
  for (const batch of chunks(handles, 10)) {
    try {
      const response = await client.send(new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((ReceiptHandle, index) => ({ Id: String(index), ReceiptHandle, VisibilityTimeout: 0 })),
      })) as { Failed?: Array<{ Id?: string }> };
      if ((response.Failed?.length ?? 0) > 0) return false;
    } catch { return false; }
  }
  return true;
}

function safeTimestamp(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) return 'unavailable';
  const timestamp = new Date(Number(value));
  return Number.isNaN(timestamp.getTime()) ? 'unavailable' : timestamp.toISOString();
}

function printTargetState(message: Message, validated: ValidatedTarget, log: (line: string) => void): void {
  log('--- inbound WhatsApp DLQ target ---');
  log(`SQS MessageId: ${message.MessageId ?? 'unavailable'}`);
  log(`MessageSid: ${validated.messageSid}`);
  log(`receive count: ${message.Attributes?.ApproximateReceiveCount ?? 'unavailable'}`);
  log(`sent timestamp: ${safeTimestamp(message.Attributes?.SentTimestamp)}`);
  log(`first receive timestamp: ${safeTimestamp(message.Attributes?.ApproximateFirstReceiveTimestamp)}`);
  log(`MessageGroupId sha256: ${createHash('sha256').update(validated.groupId).digest('hex')}`);
  log('DB-state unavailable');
}

export async function replayWhatsappInbound(client: SqsCommandClient, args: InboundReplayArgs, options: ReplayWhatsappInboundOptions = {}): Promise<InboundReplayResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const held: Message[] = [];
  let targetMessage: Message | undefined;
  if (!Number.isInteger(maxBatches) || maxBatches < 1) return { kind: 'scan_failed' };
  for (let batchIndex = 0; batchIndex < maxBatches && !targetMessage; batchIndex += 1) {
    let response: { Messages?: Message[] };
    try {
      response = await client.send(new ReceiveMessageCommand({
        QueueUrl: args.dlqUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 300,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      })) as { Messages?: Message[] };
    } catch {
      const restored = await restoreVisibility(client, args.dlqUrl, held);
      log(restored ? 'scan failed; held messages restored' : 'visibility restoration failed after scan error');
      return { kind: restored ? 'scan_failed' : 'visibility_restore_failed' };
    }
    const messages = response.Messages ?? [];
    held.push(...messages);
    if (messages.some((message) => !message.ReceiptHandle)) {
      const restored = await restoreVisibility(client, args.dlqUrl, held);
      return { kind: restored ? 'scan_failed' : 'visibility_restore_failed' };
    }
    targetMessage = messages.find((message) => matchesTarget(message, args.target));
    if (messages.length === 0) break;
  }
  if (!targetMessage) {
    const restored = await restoreVisibility(client, args.dlqUrl, held);
    log(restored ? 'target not found within bounded scan; held messages restored' : 'visibility restoration failed');
    return { kind: restored ? 'not_found' : 'visibility_restore_failed' };
  }
  const validated = validateTarget(targetMessage);
  if (!validated) {
    const restored = await restoreVisibility(client, args.dlqUrl, held);
    log(restored ? 'target validation failed; source message left intact' : 'visibility restoration failed');
    return { kind: restored ? 'validation_failed' : 'visibility_restore_failed' };
  }
  printTargetState(targetMessage, validated, log);
  if (!args.execute) {
    const restored = await restoreVisibility(client, args.dlqUrl, held);
    log(restored ? 'DRY RUN: no message sent or deleted' : 'visibility restoration failed');
    return { kind: restored ? 'dry_run' : 'visibility_restore_failed' };
  }
  const nonTargets = held.filter((message) => message !== targetMessage);
  if (!(await restoreVisibility(client, args.dlqUrl, nonTargets))) {
    await restoreVisibility(client, args.dlqUrl, [targetMessage]);
    log('visibility restoration failed before replay; no message sent or deleted');
    return { kind: 'visibility_restore_failed' };
  }
  try {
    await client.send(new SendMessageCommand({
      QueueUrl: args.queueUrl,
      MessageBody: validated.body,
      MessageGroupId: validated.groupId,
      MessageDeduplicationId: validated.deduplicationId,
    }));
  } catch {
    const restored = await restoreVisibility(client, args.dlqUrl, [targetMessage]);
    log(restored ? 'destination send failed; source message restored and left intact' : 'visibility restoration failed after send failure');
    return { kind: restored ? 'send_failed' : 'visibility_restore_failed' };
  }
  try {
    await client.send(new DeleteMessageCommand({ QueueUrl: args.dlqUrl, ReceiptHandle: validated.receiptHandle }));
  } catch {
    log('partial failure: destination accepted message; source not deleted');
    return { kind: 'destination_accepted_source_not_deleted' };
  }
  log('replay executed: destination accepted message and exact DLQ record deleted');
  return { kind: 'executed' };
}

function exitCode(result: InboundReplayResult): number {
  return result.kind === 'dry_run' || result.kind === 'executed' ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseInboundReplayArgs(argv);
  if (!parsed.ok) { console.error(parsed.error); process.exitCode = 1; return; }
  const result = await replayWhatsappInbound(new SQSClient({}) as SqsCommandClient, parsed.value);
  process.exitCode = exitCode(result);
}

if (require.main === module) {
  void main().catch(() => { console.error('unexpected replay failure (details redacted)'); process.exitCode = 1; });
}
