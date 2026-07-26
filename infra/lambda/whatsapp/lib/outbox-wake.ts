import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface PostCommitWakeSignals {
  workerIntent: boolean;
  domain: boolean;
}

export interface OutboxWakeDeps {
  workerIntentQueueUrl?: string;
  domainQueueUrl?: string;
  sendMessage: (queueUrl: string, body: string) => Promise<void>;
}

type WakeKind = 'worker_intent' | 'domain';

let sqsClient: SQSClient | undefined;

async function defaultSendMessage(queueUrl: string, body: string): Promise<void> {
  sqsClient ??= new SQSClient({});
  await sqsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}

function defaultDeps(): OutboxWakeDeps {
  return {
    workerIntentQueueUrl: process.env.WORKER_INTENT_WAKE_QUEUE_URL,
    domainQueueUrl: process.env.DOMAIN_OUTBOX_WAKE_QUEUE_URL,
    sendMessage: defaultSendMessage,
  };
}

function emitFailure(kind: WakeKind): void {
  console.log(JSON.stringify({ metric: 'WhatsAppOutboxWakeFailure', kind, count: 1 }));
}

export async function publishOutboxWakes(
  signals: PostCommitWakeSignals,
  deps: OutboxWakeDeps = defaultDeps(),
): Promise<{ sent: number; failed: number }> {
  const wakes: Array<{ kind: WakeKind; queueUrl?: string }> = [];
  if (signals.workerIntent) {
    wakes.push({ kind: 'worker_intent', queueUrl: deps.workerIntentQueueUrl });
  }
  if (signals.domain) {
    wakes.push({ kind: 'domain', queueUrl: deps.domainQueueUrl });
  }

  let sent = 0;
  let failed = 0;
  for (const wake of wakes) {
    if (!wake.queueUrl) {
      failed += 1;
      emitFailure(wake.kind);
      continue;
    }
    try {
      await deps.sendMessage(wake.queueUrl, JSON.stringify({ kind: wake.kind }));
      sent += 1;
    } catch {
      failed += 1;
      emitFailure(wake.kind);
    }
  }
  return { sent, failed };
}

export async function publishWorkerIntentWake(
  deps: OutboxWakeDeps = defaultDeps(),
): Promise<{ sent: number; failed: number }> {
  return publishOutboxWakes({ workerIntent: true, domain: false }, deps);
}
