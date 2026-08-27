/**
 * Operator CLI: redrive the billing webhook DLQ back onto its source queue.
 *
 * `billing-webhook-queue` dead-letters to `billing-webhook-dlq` after
 * `maxReceiveCount: 3` (infra/lib/stacks/billing-stack.ts). When the
 * processor was the thing at fault — a bad deploy, an expired Stripe
 * secret, a DB failover — the dead-lettered webhooks are still valid and
 * simply need reprocessing. Until now there was no tooling for that.
 *
 * This tool delegates the whole move to SQS's own managed redrive
 * (`StartMessageMoveTask`) rather than receiving and re-sending messages
 * itself. That choice IS the safety property: the operator process never
 * holds a Stripe webhook payload, so there is no code path on which a body
 * could be logged, truncated, reordered, or dropped. `ReceiveMessage` is
 * never called, and nothing but queue names, message counts, and the
 * returned `TaskHandle` is ever printed.
 *
 * Safety (mirrors scripts/replay-domain-event.ts):
 *   - Dry run is the default. `--execute` is required to start a move task;
 *     without it the tool only reads and prints the DLQ's depth.
 *   - Strict flag validation happens before any AWS call: unknown flags,
 *     duplicated flags, missing values, extra positionals, and any bulk/all
 *     flag are all rejected up front.
 *   - Queue URLs embed the AWS account id, so no error message and no log
 *     line ever echoes one — only the queue name (the URL's last path
 *     segment) is printed. ARNs are likewise never printed.
 *   - AWS failures print the error's `name` and nothing else; SDK error
 *     messages routinely quote the offending queue URL or ARN.
 *   - `--execute` is refused when the DLQ reports 0 available messages.
 *   - `--execute` is refused unless the destination queue genuinely
 *     dead-letters INTO this DLQ (its `RedrivePolicy.deadLetterTargetArn`
 *     must equal the DLQ's ARN). SQS validates that `SourceArn` is a DLQ but
 *     not that `DestinationArn` is that DLQ's real source, so without this
 *     guard a mistyped `--source-url` naming some other live queue would be
 *     accepted and Stripe webhooks would be delivered to the wrong consumer.
 *     The dry run reports the binding but never fails on it.
 *
 * Usage:
 *   cd infra
 *   AWS_REGION=us-east-2 npm run redrive:billing-dlq -- \
 *     --dlq-url <dlq-url> --source-url <queue-url>              # dry run
 *   AWS_REGION=us-east-2 npm run redrive:billing-dlq -- \
 *     --dlq-url <dlq-url> --source-url <queue-url> --execute     # redrive
 *
 * Progress of a started task is checked with the AWS CLI
 * (`aws sqs list-message-move-tasks --source-arn <dlq-arn>`); this tool
 * starts a task and exits.
 */

import {
  GetQueueAttributesCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
  type QueueAttributeName,
  type StartMessageMoveTaskCommandInput,
} from '@aws-sdk/client-sqs';

/**
 * The only SQS surface this tool needs. Narrowing the client to `send` is
 * what lets the tests drive every branch with a fake keyed on the command
 * constructor name, with no AWS credentials and no network.
 */
export interface SqsCommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface RedriveArgs {
  dlqUrl: string;
  sourceUrl: string;
  execute: boolean;
  /** Absent (not `undefined`) when unset, so it never reaches the SQS input. */
  maxPerSecond?: number;
}

export type ParseRedriveArgsResult =
  | { ok: true; value: RedriveArgs }
  | { ok: false; error: string };

export type RedriveResultKind =
  | 'dry_run'
  | 'executed'
  | 'nothing_to_redrive'
  | 'binding_mismatch'
  | 'aws_error';

export interface RedriveResult {
  kind: RedriveResultKind;
}

export interface RedriveDeps {
  client: SqsCommandClient;
  args: RedriveArgs;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const VALUE_FLAGS = new Set(['--dlq-url', '--source-url', '--max-per-second']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, '--execute']);
// Anything resembling "do this to everything" is rejected outright, matching
// replay-domain-event.ts. This tool's blast radius is already one whole queue;
// a flag implying more is a sign the operator means a different tool.
const BULK_FLAGS = new Set(['--all', '--bulk', '-a', '--force-all', '--everything']);

// SQS caps StartMessageMoveTask's rate at 500 messages/second.
const MAX_PER_SECOND_MIN = 1;
const MAX_PER_SECOND_MAX = 500;

const DLQ_ATTRIBUTE_NAMES: QueueAttributeName[] = [
  'QueueArn',
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
];
const SOURCE_ATTRIBUTE_NAMES: QueueAttributeName[] = ['QueueArn', 'RedrivePolicy'];

const UNKNOWN_QUEUE_NAME = '(unnamed queue)';
const UNAVAILABLE = 'unavailable';

/**
 * Derives the printable queue name from a queue URL's last path segment, and
 * doubles as the URL validator: `null` means the URL is unusable, either
 * because it does not parse or because it has no name to show. Returning the
 * name (rather than a boolean) keeps validation and display on one definition,
 * so the tool can never validate one thing and print another.
 */
export function queueNameFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1];
  if (name === undefined) return null;
  // SQS queue names are alphanumerics, hyphens, underscores, and (FIFO) `.fifo`.
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : null;
}

/** Strict base-10 integer in [1, 500]; rejects signs, decimals, and padding. */
function parseMaxPerSecond(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value >= MAX_PER_SECOND_MIN && value <= MAX_PER_SECOND_MAX ? value : null;
}

/**
 * Parses and strictly validates argv. Pure: performs no AWS call and reads no
 * environment. No error message ever contains a supplied value — queue URLs
 * carry the AWS account id, and a stray positional could be anything — so
 * errors name the offending *flag* and describe the problem instead.
 */
export function parseArgs(argv: string[]): ParseRedriveArgsResult {
  const values = new Map<string, string>();
  let execute = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (BULK_FLAGS.has(arg)) {
      return { ok: false, error: `Bulk/all operations are not supported: ${arg}` };
    }
    if (!ALL_FLAGS.has(arg)) {
      return arg.startsWith('--')
        ? { ok: false, error: `Unknown flag: ${arg}` }
        : { ok: false, error: 'Unexpected positional argument (value redacted)' };
    }
    if (arg === '--execute') {
      if (execute) return { ok: false, error: 'Duplicate flag: --execute' };
      execute = true;
      continue;
    }
    if (values.has(arg)) return { ok: false, error: `Duplicate flag: ${arg}` };

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `Missing value for ${arg}` };
    }
    values.set(arg, value);
    index += 1;
  }

  const dlqUrl = values.get('--dlq-url');
  const sourceUrl = values.get('--source-url');
  if (dlqUrl === undefined || sourceUrl === undefined) {
    return { ok: false, error: 'Both --dlq-url and --source-url are required' };
  }
  if (dlqUrl === sourceUrl) {
    return { ok: false, error: '--dlq-url and --source-url must be different queues' };
  }
  if (queueNameFromUrl(dlqUrl) === null) {
    return { ok: false, error: '--dlq-url is not a usable SQS queue URL (value redacted)' };
  }
  if (queueNameFromUrl(sourceUrl) === null) {
    return { ok: false, error: '--source-url is not a usable SQS queue URL (value redacted)' };
  }

  const value: RedriveArgs = { dlqUrl, sourceUrl, execute };

  const rawMaxPerSecond = values.get('--max-per-second');
  if (rawMaxPerSecond !== undefined) {
    const maxPerSecond = parseMaxPerSecond(rawMaxPerSecond);
    if (maxPerSecond === null) {
      return {
        ok: false,
        error: `--max-per-second must be an integer between ${MAX_PER_SECOND_MIN} and ${MAX_PER_SECOND_MAX}`,
      };
    }
    value.maxPerSecond = maxPerSecond;
  }

  return { ok: true, value };
}

/** Parses an SQS `Approximate*` count; `null` when absent or malformed. */
function parseCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Never yields `NaN`: a missing attribute prints as `unavailable`. */
function formatCount(raw: string | undefined): string {
  const value = parseCount(raw);
  return value === null ? UNAVAILABLE : String(value);
}

/**
 * SDK error messages routinely quote the queue URL or ARN that failed, so only
 * the error's `name` (e.g. `QueueDoesNotExist`) is ever surfaced.
 */
function errorName(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.length > 0) {
    return error.name;
  }
  return 'UnknownError';
}

async function getQueueAttributes(
  client: SqsCommandClient,
  queueUrl: string,
  attributeNames: QueueAttributeName[],
): Promise<Record<string, string>> {
  const response = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: attributeNames }),
  );
  return (response as { Attributes?: Record<string, string> }).Attributes ?? {};
}

/**
 * True only when this queue's redrive policy names `dlqArn` as its
 * dead-letter target. Absent, malformed, or differently-targeted policies all
 * return false: the binding must be positively proven, never assumed.
 */
function redriveTargetsDlq(rawPolicy: string | undefined, dlqArn: string): boolean {
  if (rawPolicy === undefined) return false;
  let policy: unknown;
  try {
    policy = JSON.parse(rawPolicy);
  } catch {
    return false;
  }
  if (policy === null || typeof policy !== 'object') return false;
  return (policy as { deadLetterTargetArn?: unknown }).deadLetterTargetArn === dlqArn;
}

type SourceQueueProbe =
  | { ok: true; sourceArn: string | undefined; bound: boolean }
  | { ok: false; errorName: string };

/**
 * Reads the destination queue's ARN and redrive policy in one call, mirroring
 * `validateQueueBinding` in scripts/replay-whatsapp-inbound.ts. Never throws:
 * the caller decides whether a failed probe is fatal (`--execute`) or merely
 * reported as unverified (dry run).
 */
async function probeSourceQueue(
  client: SqsCommandClient,
  sourceUrl: string,
  dlqArn: string | undefined,
): Promise<SourceQueueProbe> {
  try {
    const attributes = await getQueueAttributes(client, sourceUrl, SOURCE_ATTRIBUTE_NAMES);
    return {
      ok: true,
      sourceArn: attributes.QueueArn,
      bound: dlqArn !== undefined && redriveTargetsDlq(attributes.RedrivePolicy, dlqArn),
    };
  } catch (error) {
    return { ok: false, errorName: errorName(error) };
  }
}

/**
 * Reads the DLQ's depth, prints it, and — only under `--execute` — starts an
 * SQS message move task from the DLQ to the source queue.
 *
 * Both ARNs are resolved from the supplied URLs via `GetQueueAttributes`
 * rather than being constructed from region/account guesses, so a typo'd URL
 * fails as `QueueDoesNotExist` instead of silently targeting a real queue that
 * the operator did not name. A typo that happens to name a *real* queue is
 * caught by the redrive-policy binding check, which `--execute` requires and
 * the dry run merely reports.
 */
export async function run(deps: RedriveDeps): Promise<RedriveResult> {
  const { client, args } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));

  const dlqName = queueNameFromUrl(args.dlqUrl) ?? UNKNOWN_QUEUE_NAME;
  const sourceName = queueNameFromUrl(args.sourceUrl) ?? UNKNOWN_QUEUE_NAME;

  try {
    const dlqAttributes = await getQueueAttributes(client, args.dlqUrl, DLQ_ATTRIBUTE_NAMES);
    const visibleRaw = dlqAttributes.ApproximateNumberOfMessages;
    const notVisibleRaw = dlqAttributes.ApproximateNumberOfMessagesNotVisible;
    const dlqArn = dlqAttributes.QueueArn;

    // Probed on both paths so the dry run can tell the operator up front
    // whether `--execute` would be refused, instead of letting them discover
    // it only after deciding to mutate.
    const source = await probeSourceQueue(client, args.sourceUrl, dlqArn);

    // State is always printed before anything is mutated, so an aborted or
    // failed run still leaves the operator with the depth they asked about.
    log('--- billing webhook DLQ redrive ---');
    log(`DLQ: ${dlqName}`);
    log(`destination queue: ${sourceName}`);
    log(`ApproximateNumberOfMessages: ${formatCount(visibleRaw)}`);
    log(`ApproximateNumberOfMessagesNotVisible: ${formatCount(notVisibleRaw)}`);
    log(
      `MaxNumberOfMessagesPerSecond: ${
        args.maxPerSecond === undefined ? 'unset (SQS default rate)' : String(args.maxPerSecond)
      }`,
    );
    // Names only — a RedrivePolicy quotes an ARN, which carries the account id.
    log(`binding: ${source.ok && source.bound ? 'verified' : 'unverified'}`);
    log('-----------------------------------');

    if (!args.execute) {
      log(
        `DRY RUN: would move ${formatCount(visibleRaw)} message(s) from ${dlqName} to ${sourceName} `
          + 'via StartMessageMoveTask. Pass --execute to apply.',
      );
      return { kind: 'dry_run' };
    }

    const depth = parseCount(visibleRaw);
    // An unreadable depth is refused like an empty one — starting a move task
    // is only ever justified by a depth we actually observed — but the two are
    // reported distinctly: "SQS told us zero" and "SQS told us nothing" are
    // different situations for whoever is reading this at 2am.
    if (depth === null) {
      log(
        `nothing to redrive: ${dlqName} did not report a depth `
          + '(ApproximateNumberOfMessages unavailable). No move task started.',
      );
      return { kind: 'nothing_to_redrive' };
    }
    if (depth === 0) {
      log(`nothing to redrive: ${dlqName} reports 0 available messages. No move task started.`);
      return { kind: 'nothing_to_redrive' };
    }

    // A dry run tolerates an unreadable destination queue; `--execute` does not.
    if (!source.ok) {
      logError(source.errorName);
      return { kind: 'aws_error' };
    }
    if (!dlqArn || !source.sourceArn) {
      logError('QueueArnUnavailable');
      return { kind: 'aws_error' };
    }
    if (!source.bound) {
      logError(
        `QueueBindingMismatch: ${sourceName} does not dead-letter into ${dlqName}; `
          + 'refusing to start a move task',
      );
      return { kind: 'binding_mismatch' };
    }

    const input: StartMessageMoveTaskCommandInput = {
      SourceArn: dlqArn,
      DestinationArn: source.sourceArn,
    };
    // Set only when requested: an explicit `undefined` would still serialize
    // the field, and SQS rejects a null rate.
    if (args.maxPerSecond !== undefined) {
      input.MaxNumberOfMessagesPerSecond = args.maxPerSecond;
    }

    const response = (await client.send(new StartMessageMoveTaskCommand(input))) as {
      TaskHandle?: string;
    };

    log(`redrive started: moving up to ${depth} message(s) from ${dlqName} to ${sourceName}.`);
    log(`TaskHandle: ${response.TaskHandle ?? UNAVAILABLE}`);
    return { kind: 'executed' };
  } catch (error) {
    logError(errorName(error));
    return { kind: 'aws_error' };
  }
}

// A refused redrive is a failure the operator must see: `binding_mismatch`
// means they named the wrong destination queue.
const FAILURE_KINDS = new Set<RedriveResultKind>(['aws_error', 'binding_mismatch']);

/**
 * An empty DLQ exits 0: the desired end state already holds and nothing is
 * wrong, the same reason replay-domain-event.ts maps `already_completed` to 0.
 * An AWS failure or a rejected queue binding is a non-zero exit.
 */
export function resolveExitCode(result: RedriveResult): number {
  return FAILURE_KINDS.has(result.kind) ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const client = new SQSClient({}) as unknown as SqsCommandClient;
  const result = await run({ client, args: parsed.value });
  process.exitCode = resolveExitCode(result);
}

if (require.main === module) {
  void main().catch(() => {
    console.error('unexpected redrive failure (details redacted)');
    process.exitCode = 1;
  });
}
