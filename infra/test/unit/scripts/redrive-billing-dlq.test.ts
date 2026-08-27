import {
  parseArgs,
  resolveExitCode,
  run,
  type RedriveArgs,
  type SqsCommandClient,
} from '../../../scripts/redrive-billing-dlq';

// Real (non-secret) shapes: account id is fake, but the URL/ARN layout matches
// what SQS actually returns for `billing-webhook-dlq` / `billing-webhook-queue`
// (infra/lib/stacks/billing-stack.ts).
const DLQ_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/billing-webhook-dlq';
const SOURCE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/billing-webhook-queue';
const DLQ_ARN = 'arn:aws:sqs:us-east-2:123456789012:billing-webhook-dlq';
const SOURCE_ARN = 'arn:aws:sqs:us-east-2:123456789012:billing-webhook-queue';
// Realistic StartMessageMoveTask handle: base64 JSON that EMBEDS the source
// ARN (and so the account id). The tool must never print it raw.
const TASK_ID = 'fake-task-id-1234';
const TASK_HANDLE = Buffer.from(
  JSON.stringify({ taskId: TASK_ID, sourceArn: 'arn:aws:sqs:us-east-2:123456789012:billing-webhook-dlq' }),
).toString('base64');
// A real, live queue that is NOT this DLQ's source — what a mistyped
// --source-url would plausibly hit.
const UNRELATED_DLQ_ARN = 'arn:aws:sqs:us-east-2:123456789012:whatsapp-inbound-dlq.fifo';

// A Stripe webhook body is the exact thing this tool must never surface.
const SECRET_BODY = '{"id":"evt_1PfakeSecret","type":"invoice.paid","customer":"cus_SsEcReT"}';

interface CapturedCommand {
  name: string;
  input: Record<string, unknown>;
}

interface FakeClientOptions {
  /** DLQ `ApproximateNumberOfMessages`; `undefined` omits the attribute entirely. */
  visible?: string;
  /** DLQ `ApproximateNumberOfMessagesNotVisible`. */
  notVisible?: string;
  /** Thrown by every `send` — used to exercise the AWS-failure path. */
  failWith?: Error;
  /** Thrown only by `StartMessageMoveTaskCommand`. */
  failStartWith?: Error;
  /** Drop `QueueArn` from one queue's attribute response. */
  omitQueueArn?: 'dlq' | 'source';
  /**
   * Destination queue's `RedrivePolicy`: `bound` (default) dead-letters into
   * this DLQ; `mismatch` targets a different DLQ; `omit` has no policy at all
   * (a queue with no DLQ configured); `invalid` returns unparsable JSON.
   */
  redrivePolicy?: 'bound' | 'mismatch' | 'omit' | 'invalid';
  taskHandle?: string;
}

function fakeClient(options: FakeClientOptions = {}): {
  client: SqsCommandClient;
  commands: CapturedCommand[];
} {
  const visible = 'visible' in options ? options.visible : '7';
  const notVisible = options.notVisible ?? '2';
  const commands: CapturedCommand[] = [];

  const client: SqsCommandClient = {
    send: async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = ((command as { input?: Record<string, unknown> }).input ?? {});
      commands.push({ name, input });

      if (options.failWith) throw options.failWith;

      if (name === 'GetQueueAttributesCommand') {
        const isDlq = input.QueueUrl === DLQ_URL;
        const attributes: Record<string, string> = {};
        if (options.omitQueueArn !== (isDlq ? 'dlq' : 'source')) {
          attributes.QueueArn = isDlq ? DLQ_ARN : SOURCE_ARN;
        }
        if (isDlq) {
          if (visible !== undefined) attributes.ApproximateNumberOfMessages = visible;
          attributes.ApproximateNumberOfMessagesNotVisible = notVisible;
        } else {
          const policy = options.redrivePolicy ?? 'bound';
          if (policy === 'bound') {
            attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 3 });
          } else if (policy === 'mismatch') {
            attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: UNRELATED_DLQ_ARN, maxReceiveCount: 3 });
          } else if (policy === 'invalid') {
            attributes.RedrivePolicy = '{"deadLetterTargetArn": truncated';
          }
        }
        return { Attributes: attributes };
      }

      if (name === 'StartMessageMoveTaskCommand') {
        if (options.failStartWith) throw options.failStartWith;
        return { TaskHandle: options.taskHandle ?? TASK_HANDLE };
      }

      // A body/attribute-bearing response must never be reachable: this tool
      // has no code path that receives messages.
      return { Messages: [{ Body: SECRET_BODY }] };
    },
  };

  return { client, commands };
}

function makeArgs(overrides: Partial<RedriveArgs> = {}): RedriveArgs {
  return { dlqUrl: DLQ_URL, sourceUrl: SOURCE_URL, execute: false, ...overrides };
}

interface RunCapture {
  kind: string;
  out: string;
  commands: CapturedCommand[];
}

async function invoke(
  args: RedriveArgs,
  options: FakeClientOptions = {},
): Promise<RunCapture> {
  const { client, commands } = fakeClient(options);
  const lines: string[] = [];
  const result = await run({
    client,
    args,
    log: (line) => lines.push(line),
    logError: (line) => lines.push(line),
  });
  return { kind: result.kind, out: lines.join('\n'), commands };
}

function names(commands: CapturedCommand[]): string[] {
  return commands.map((c) => c.name);
}

describe('parseArgs', () => {
  it('accepts the two required URLs and defaults to a dry run', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL]);
    expect(result).toEqual({
      ok: true,
      value: { dlqUrl: DLQ_URL, sourceUrl: SOURCE_URL, execute: false },
    });
  });

  it('accepts --execute', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--execute']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.execute).toBe(true);
  });

  it('accepts --max-per-second and parses it as an integer', () => {
    const result = parseArgs([
      '--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--execute', '--max-per-second', '25',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxPerSecond).toBe(25);
  });

  it('accepts the boundary values 1 and 500 for --max-per-second', () => {
    for (const value of ['1', '500']) {
      const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--max-per-second', value]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.maxPerSecond).toBe(Number(value));
    }
  });

  it('omits maxPerSecond entirely when the flag is not given', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(true);
    if (result.ok) expect('maxPerSecond' in result.value).toBe(false);
  });

  it('rejects a missing --dlq-url', () => {
    const result = parseArgs(['--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing --source-url', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL]);
    expect(result.ok).toBe(false);
  });

  it('rejects no arguments at all', () => {
    expect(parseArgs([]).ok).toBe(false);
  });

  it('rejects an unknown flag', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--yolo']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--yolo/);
  });

  it('rejects an extra positional without echoing its value', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, SECRET_BODY]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(SECRET_BODY);
  });

  it('rejects a flag whose value is missing', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--source-url/);
  });

  it('rejects a flag whose value is another flag', () => {
    const result = parseArgs(['--dlq-url', '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicated value flag', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--dlq-url', DLQ_URL, '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicated --execute', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--execute', '--execute']);
    expect(result.ok).toBe(false);
  });

  it.each(['--all', '--bulk', '-a', '--force-all', '--everything'])('rejects the bulk flag %s', (flag) => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, flag]);
    expect(result.ok).toBe(false);
  });

  it('rejects identical DLQ and source URLs', () => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', DLQ_URL]);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['zero', '0'],
    ['above the 500 cap', '501'],
    ['negative', '-5'],
    ['fractional', '2.5'],
    ['non-numeric', 'fast'],
    ['empty', ''],
    ['sign-prefixed', '+5'],
    ['whitespace-padded', ' 5 '],
  ])('rejects a %s --max-per-second', (_label, value) => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--max-per-second', value]);
    expect(result.ok).toBe(false);
  });

  it('rejects a URL with no final path segment (no queue name to derive)', () => {
    const result = parseArgs(['--dlq-url', 'https://sqs.us-east-2.amazonaws.com/', '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['account id only (would otherwise print the account id as the queue name)', 'https://sqs.us-east-2.amazonaws.com/123456789012'],
    ['non-numeric account segment', 'https://sqs.us-east-2.amazonaws.com/notanaccount/billing-webhook-queue'],
    ['three path segments', 'https://sqs.us-east-2.amazonaws.com/123456789012/extra/billing-webhook-queue'],
  ])('rejects a --source-url with %s, without echoing it', (_label, url) => {
    const result = parseArgs(['--dlq-url', DLQ_URL, '--source-url', url]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('123456789012');
      expect(result.error).not.toContain(url);
    }
  });

  it('rejects the --flag=value form without echoing the value', () => {
    const result = parseArgs([`--dlq-url=${DLQ_URL}`, '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--dlq-url');
      expect(result.error).not.toContain('123456789012');
      expect(result.error).not.toContain(DLQ_URL);
      expect(result.error).not.toContain('amazonaws');
    }
  });

  it('rejects an unparseable URL without echoing it', () => {
    const result = parseArgs(['--dlq-url', 'not a url', '--source-url', SOURCE_URL]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('not a url');
  });

  it('never echoes a queue URL (they embed the AWS account id) in any error', () => {
    const results = [
      parseArgs(['--dlq-url', DLQ_URL, '--source-url', DLQ_URL]),
      parseArgs(['--dlq-url', DLQ_URL]),
      parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, SECRET_BODY]),
      parseArgs(['--dlq-url', DLQ_URL, '--source-url', SOURCE_URL, '--max-per-second', '9999']),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain('123456789012');
        expect(result.error).not.toContain(DLQ_URL);
        expect(result.error).not.toContain(SOURCE_URL);
      }
    }
  });
});

describe('run — dry run (default)', () => {
  it('prints both DLQ depth attributes and the intended move, and mutates nothing', async () => {
    const { kind, out, commands } = await invoke(makeArgs(), { visible: '7', notVisible: '2' });

    expect(kind).toBe('dry_run');
    expect(out).toMatch(/ApproximateNumberOfMessages.*7/);
    expect(out).toMatch(/ApproximateNumberOfMessagesNotVisible.*2/);
    expect(out).toContain('billing-webhook-dlq');
    expect(out).toContain('billing-webhook-queue');
    expect(out).toMatch(/DRY RUN/);
    expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
  });

  it('issues only reads — two GetQueueAttributes calls and nothing else', async () => {
    const { commands } = await invoke(makeArgs());

    expect(names(commands)).toEqual(['GetQueueAttributesCommand', 'GetQueueAttributesCommand']);
    expect(commands.map((c) => c.input.QueueUrl)).toEqual([DLQ_URL, SOURCE_URL]);
  });

  it('reports the binding as verified without failing, and never prints the policy ARN', async () => {
    const { kind, out } = await invoke(makeArgs(), { redrivePolicy: 'bound' });

    expect(kind).toBe('dry_run');
    expect(out).toMatch(/binding: verified/);
    expect(out).not.toContain(DLQ_ARN);
  });

  it.each<['mismatch' | 'omit' | 'invalid']>([['mismatch'], ['omit'], ['invalid']])(
    'reports a %s binding as unverified but still succeeds (dry run stays tolerant)',
    async (policy) => {
      const { kind, out } = await invoke(makeArgs(), { redrivePolicy: policy });

      expect(kind).toBe('dry_run');
      expect(resolveExitCode({ kind: 'dry_run' })).toBe(0);
      expect(out).toMatch(/binding: unverified/);
      expect(out).not.toContain(UNRELATED_DLQ_ARN);
    },
  );

  it('reports the binding as unverified rather than failing when the destination read errors', async () => {
    const { client, commands } = fakeClient();
    const guarded: SqsCommandClient = {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const url = (command as { input?: Record<string, unknown> }).input?.QueueUrl;
        if (name === 'GetQueueAttributesCommand' && url === SOURCE_URL) {
          throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
        }
        return client.send(command);
      },
    };
    const lines: string[] = [];
    const result = await run({ client: guarded, args: makeArgs(), log: (l) => lines.push(l), logError: (l) => lines.push(l) });

    expect(result.kind).toBe('dry_run');
    expect(lines.join('\n')).toMatch(/binding: unverified/);
    expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
  });

  it('prints queue names only — never a full queue URL or the account id', async () => {
    const { out } = await invoke(makeArgs());

    expect(out).not.toContain(DLQ_URL);
    expect(out).not.toContain(SOURCE_URL);
    expect(out).not.toContain('123456789012');
  });

  it('is still a dry run at depth 0 and reports zero', async () => {
    const { kind, out, commands } = await invoke(makeArgs(), { visible: '0', notVisible: '0' });

    expect(kind).toBe('dry_run');
    expect(out).toMatch(/ApproximateNumberOfMessages.*0/);
    expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
  });

  it('prints `unavailable` rather than NaN when SQS omits the depth attribute', async () => {
    const { kind, out } = await invoke(makeArgs(), { visible: undefined });

    expect(kind).toBe('dry_run');
    expect(out).toContain('unavailable');
    expect(out).not.toContain('NaN');
  });

  it('reports the requested rate limit on its own line when --max-per-second is supplied', async () => {
    const { out } = await invoke(makeArgs({ maxPerSecond: 25 }));

    expect(out).toMatch(/MaxNumberOfMessagesPerSecond: 25/);
  });

  it('reports the rate as unset when --max-per-second is omitted', async () => {
    const { out } = await invoke(makeArgs());

    expect(out).toMatch(/MaxNumberOfMessagesPerSecond: unset/);
  });
});

describe('run — --execute', () => {
  it('starts the move task with the DLQ ARN as source and the queue ARN as destination, and prints only the task id', async () => {
    const { kind, out, commands } = await invoke(makeArgs({ execute: true }), { visible: '7' });

    expect(kind).toBe('executed');

    const start = commands.find((c) => c.name === 'StartMessageMoveTaskCommand');
    expect(start).toBeDefined();
    expect(start!.input).toEqual({ SourceArn: DLQ_ARN, DestinationArn: SOURCE_ARN });
    expect(out).toContain(`taskId: ${TASK_ID}`);
    // The raw handle base64-decodes to the source ARN + account id: never printed.
    expect(out).not.toContain(TASK_HANDLE);
    expect(out).not.toContain('123456789012');
    expect(out).not.toContain(DLQ_ARN);
    expect(out).not.toContain(SOURCE_ARN);
  });

  it('prints "unavailable" instead of a malformed or missing TaskHandle', async () => {
    const malformed = await invoke(makeArgs({ execute: true }), { visible: '7', taskHandle: 'not-base64-json' });
    expect(malformed.kind).toBe('executed');
    expect(malformed.out).toContain('taskId: unavailable');
    expect(malformed.out).not.toContain('not-base64-json');
  });

  it('resolves both ARNs via GetQueueAttributes (never hardcodes or derives them)', async () => {
    const { commands } = await invoke(makeArgs({ execute: true }));

    const attributeCalls = commands.filter((c) => c.name === 'GetQueueAttributesCommand');
    expect(attributeCalls.map((c) => c.input.QueueUrl)).toEqual([DLQ_URL, SOURCE_URL]);
    for (const call of attributeCalls) {
      expect(call.input.AttributeNames).toContain('QueueArn');
    }
  });

  it('omits MaxNumberOfMessagesPerSecond entirely when no rate is requested', async () => {
    const { commands } = await invoke(makeArgs({ execute: true }));

    const start = commands.find((c) => c.name === 'StartMessageMoveTaskCommand');
    expect(start).toBeDefined();
    expect('MaxNumberOfMessagesPerSecond' in start!.input).toBe(false);
  });

  it('passes MaxNumberOfMessagesPerSecond through when a rate is requested', async () => {
    const { commands } = await invoke(makeArgs({ execute: true, maxPerSecond: 25 }));

    const start = commands.find((c) => c.name === 'StartMessageMoveTaskCommand');
    expect(start!.input).toEqual({
      SourceArn: DLQ_ARN,
      DestinationArn: SOURCE_ARN,
      MaxNumberOfMessagesPerSecond: 25,
    });
  });

  it('refuses at depth 0 with "nothing to redrive" and starts no task', async () => {
    const { kind, out, commands } = await invoke(makeArgs({ execute: true }), { visible: '0', notVisible: '0' });

    expect(kind).toBe('nothing_to_redrive');
    expect(out).toMatch(/nothing to redrive/i);
    expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
  });

  it('a depth-0 refusal is a benign no-op (exit 0), matching replay-domain-event`s already_completed', () => {
    expect(resolveExitCode({ kind: 'nothing_to_redrive' })).toBe(0);
  });

  it('refuses when SQS omits the depth attribute rather than guessing', async () => {
    const { kind, out, commands } = await invoke(makeArgs({ execute: true }), { visible: undefined });

    expect(kind).toBe('nothing_to_redrive');
    expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
    // "SQS said nothing" must not be reported as "SQS said zero".
    expect(out).toMatch(/nothing to redrive.*unavailable/s);
    expect(out).not.toMatch(/reports 0 available/);
  });

  it.each<['dlq' | 'source']>([['dlq'], ['source']])(
    'aborts with exit 1 when the %s queue response carries no QueueArn',
    async (which) => {
      const { kind, commands } = await invoke(makeArgs({ execute: true }), {
        visible: '7',
        omitQueueArn: which,
      });

      expect(kind).toBe('aws_error');
      expect(resolveExitCode({ kind: 'aws_error' })).toBe(1);
      expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
    },
  );

  it('starts the move task when the destination genuinely dead-letters into the DLQ', async () => {
    const { kind, commands } = await invoke(makeArgs({ execute: true }), {
      visible: '7',
      redrivePolicy: 'bound',
    });

    expect(kind).toBe('executed');
    expect(names(commands)).toContain('StartMessageMoveTaskCommand');
  });

  it.each<['mismatch' | 'omit' | 'invalid']>([['mismatch'], ['omit'], ['invalid']])(
    'refuses with QueueBindingMismatch when the destination RedrivePolicy is %s',
    async (policy) => {
      const { kind, out, commands } = await invoke(makeArgs({ execute: true }), {
        visible: '7',
        redrivePolicy: policy,
      });

      expect(kind).toBe('binding_mismatch');
      expect(resolveExitCode({ kind: 'binding_mismatch' })).toBe(1);
      expect(out).toContain('QueueBindingMismatch');
      expect(out).toContain('billing-webhook-queue');
      expect(out).toContain('billing-webhook-dlq');
      expect(names(commands)).not.toContain('StartMessageMoveTaskCommand');
    },
  );

  it('names queues only in the mismatch refusal — never the policy ARN or account id', async () => {
    const { out } = await invoke(makeArgs({ execute: true }), { visible: '7', redrivePolicy: 'mismatch' });

    expect(out).not.toContain(UNRELATED_DLQ_ARN);
    expect(out).not.toContain(DLQ_ARN);
    expect(out).not.toContain(SOURCE_ARN);
    expect(out).not.toContain('123456789012');
  });

  it('still prints the depth before mutating', async () => {
    const { out } = await invoke(makeArgs({ execute: true }), { visible: '7', notVisible: '2' });

    expect(out).toMatch(/ApproximateNumberOfMessages.*7/);
    expect(out).toMatch(/ApproximateNumberOfMessagesNotVisible.*2/);
  });
});

describe('run — AWS failure', () => {
  it('prints only the error name (never the message) and exits 1 when GetQueueAttributes fails', async () => {
    const error = new Error(`QueueUrl ${DLQ_URL} is not valid; token AKIAIOSFODNN7EXAMPLE`);
    error.name = 'QueueDoesNotExist';

    const { kind, out } = await invoke(makeArgs(), { failWith: error });

    expect(kind).toBe('aws_error');
    expect(resolveExitCode({ kind: 'aws_error' })).toBe(1);
    expect(out).toContain('QueueDoesNotExist');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain(DLQ_URL);
    expect(out).not.toContain(error.message);
  });

  it('prints only the error name and exits 1 when StartMessageMoveTask fails', async () => {
    const error = new Error('There is already a task running for arn:aws:sqs:...:billing-webhook-dlq');
    error.name = 'ResourceNotFoundException';

    const { kind, out } = await invoke(makeArgs({ execute: true }), { failStartWith: error });

    expect(kind).toBe('aws_error');
    expect(out).toContain('ResourceNotFoundException');
    expect(out).not.toContain(error.message);
  });

  it('reports a fixed name when a non-Error value is thrown', async () => {
    const rejecting: SqsCommandClient = { send: async () => { throw SECRET_BODY; } };
    const lines: string[] = [];

    const result = await run({
      client: rejecting,
      args: makeArgs(),
      log: (line) => lines.push(line),
      logError: (line) => lines.push(line),
    });

    expect(result.kind).toBe('aws_error');
    expect(lines.join('\n')).not.toContain(SECRET_BODY);
    expect(lines.join('\n').trim().length).toBeGreaterThan(0);
  });
});

describe('run — message bodies are unreachable', () => {
  it.each<[string, RedriveArgs, FakeClientOptions]>([
    ['dry run', makeArgs(), {}],
    ['execute at depth 0', makeArgs({ execute: true }), { visible: '0' }],
    ['successful execute', makeArgs({ execute: true }), { visible: '7' }],
    ['AWS error', makeArgs(), { failWith: Object.assign(new Error(SECRET_BODY), { name: 'AccessDenied' }) }],
  ])('never issues ReceiveMessage on the %s path', async (_label, args, options) => {
    const { out, commands } = await invoke(args, options);

    expect(names(commands)).not.toContain('ReceiveMessageCommand');
    expect(out).not.toContain(SECRET_BODY);
  });

  it('only ever issues GetQueueAttributes and StartMessageMoveTask', async () => {
    const { commands } = await invoke(makeArgs({ execute: true, maxPerSecond: 5 }));

    for (const command of commands) {
      expect(['GetQueueAttributesCommand', 'StartMessageMoveTaskCommand']).toContain(command.name);
    }
  });

  it('requests only depth and ARN attributes — never anything message-shaped', async () => {
    const { commands } = await invoke(makeArgs({ execute: true }));

    const allowed = new Set([
      'QueueArn',
      'RedrivePolicy',
      'ApproximateNumberOfMessages',
      'ApproximateNumberOfMessagesNotVisible',
    ]);
    for (const call of commands.filter((c) => c.name === 'GetQueueAttributesCommand')) {
      for (const attribute of call.input.AttributeNames as string[]) {
        expect(allowed.has(attribute)).toBe(true);
      }
    }
  });
});

describe('resolveExitCode', () => {
  it('maps dry_run, executed and nothing_to_redrive to 0; aws_error and binding_mismatch to 1', () => {
    expect(resolveExitCode({ kind: 'dry_run' })).toBe(0);
    expect(resolveExitCode({ kind: 'executed' })).toBe(0);
    expect(resolveExitCode({ kind: 'nothing_to_redrive' })).toBe(0);
    expect(resolveExitCode({ kind: 'aws_error' })).toBe(1);
    expect(resolveExitCode({ kind: 'binding_mismatch' })).toBe(1);
  });
});
