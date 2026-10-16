import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { DlqDepth } from './admin-analytics';

// Live reads of the AWS side of system health (contract K3.3 #11, K3.4).
// Every read is bounded (AWS_READ_TIMEOUT_MS) and fails soft: a source that
// cannot be read is "unavailable" / null, never a thrown page. A failure is
// logged by its error name only; AWS error messages can carry resource names.

export const AWS_READ_TIMEOUT_MS = 1500;

// AdminStack sets ADMIN_DLQ_QUEUES to a JSON list of { label, url }: the
// dead-letter queues that have a producer, labelled in plain words. Unset
// (a local preview) or malformed, there is nothing to read.
export type DlqQueue = { label: string; url: string };

export function parseDlqQueues(raw: string | undefined): DlqQueue[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const queues: DlqQueue[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return [];
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== 'string' || !label || typeof url !== 'string' || !url) return [];
    queues.push({ label, url });
  }
  return queues;
}

function logUnavailable(source: 'sqs' | 'cloudwatch', error: unknown, detail: Record<string, string>): void {
  const name = error instanceof Error ? error.name : 'UnknownError';
  console.error(JSON.stringify({ metric: 'AdminHealthSourceUnavailable', source, error: name, ...detail }));
}

let sqsClient: SQSClient | undefined;
function sqs(): SQSClient {
  return (sqsClient ??= new SQSClient({}));
}

// A queue attribute is a decimal string; anything else is not a depth.
function attributeCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

type QueueDepth = DlqDepth['queues'][number];

async function readQueue(queue: DlqQueue): Promise<QueueDepth> {
  try {
    const result = await sqs().send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      { abortSignal: AbortSignal.timeout(AWS_READ_TIMEOUT_MS) },
    );
    const visible = attributeCount(result.Attributes?.ApproximateNumberOfMessages);
    const inFlight = attributeCount(result.Attributes?.ApproximateNumberOfMessagesNotVisible);
    if (visible === null || inFlight === null) {
      logUnavailable('sqs', new Error('missing attributes'), { label: queue.label });
      return { label: queue.label, visible: null, inFlight: null, unavailable: true };
    }
    return { label: queue.label, visible, inFlight, unavailable: false };
  } catch (error) {
    logUnavailable('sqs', error, { label: queue.label });
    return { label: queue.label, visible: null, inFlight: null, unavailable: true };
  }
}

// Every listed queue in parallel. The total is known only when every queue
// answered (and there is at least one); a partial sum would read as "fine".
export async function readDlqDepth(queues: DlqQueue[] = parseDlqQueues(process.env.ADMIN_DLQ_QUEUES)): Promise<DlqDepth> {
  const read = await Promise.all(queues.map(readQueue));
  const known = read.length > 0 && read.every((queue) => !queue.unavailable);
  return {
    queues: read,
    totalVisible: known ? read.reduce((total, queue) => total + (queue.visible ?? 0), 0) : null,
  };
}

// SES sends from two regions: us-east-1 (the admin and worker pools' email)
// and the main region (the email outbox). Each region's account-level Bounce
// metric is summed over the last 24 hours.
export function sesRegions(mainRegion: string | undefined = process.env.AWS_REGION): string[] {
  return [...new Set(['us-east-1', ...(mainRegion ? [mainRegion] : [])])];
}

const cloudwatchClients = new Map<string, CloudWatchClient>();
function cloudwatch(region: string): CloudWatchClient {
  let client = cloudwatchClients.get(region);
  if (!client) {
    client = new CloudWatchClient({ region });
    cloudwatchClients.set(region, client);
  }
  return client;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function readRegionBounces(region: string, now: Date): Promise<number> {
  const result = await cloudwatch(region).send(
    new GetMetricDataCommand({
      StartTime: new Date(now.getTime() - DAY_MS),
      EndTime: now,
      MetricDataQueries: [{
        Id: 'bounces',
        MetricStat: { Metric: { Namespace: 'AWS/SES', MetricName: 'Bounce' }, Period: 3600, Stat: 'Sum' },
        ReturnData: true,
      }],
    }),
    { abortSignal: AbortSignal.timeout(AWS_READ_TIMEOUT_MS) },
  );
  // An idle account emits no datapoint: missing values count as 0.
  const values = result.MetricDataResults?.find((series) => series.Id === 'bounces')?.Values ?? [];
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

// Bounces in the last 24 hours across both regions; null when any region
// could not be read.
export async function readSesBounces24h(now: Date = new Date(), regions: string[] = sesRegions()): Promise<number | null> {
  const counts = await Promise.all(regions.map(async (region) => {
    try {
      return await readRegionBounces(region, now);
    } catch (error) {
      logUnavailable('cloudwatch', error, { region });
      return null;
    }
  }));
  if (counts.some((count) => count === null)) return null;
  return Math.round(counts.reduce<number>((total, count) => total + (count ?? 0), 0));
}
