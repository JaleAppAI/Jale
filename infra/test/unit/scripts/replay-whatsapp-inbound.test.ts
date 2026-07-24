import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  parseInboundReplayArgs,
  replayWhatsappInbound,
  type DbQueryable,
  type SqsCommandClient,
} from '../../../scripts/replay-whatsapp-inbound';

const MESSAGE_SID = `SM${'a'.repeat(32)}`;
const OTHER_SID = `MM${'b'.repeat(32)}`;
const PHONE = 'whatsapp:+19152272188';
const OTP = '482913';
const TEXT = 'Your private message';
const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123/inbound-dlq.fifo';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/inbound.fifo';
const DLQ_ARN = 'arn:aws:sqs:us-east-1:123:inbound-dlq.fifo';

function body(sid = MESSAGE_SID): string {
  return `MessageSid=${sid}&From=${encodeURIComponent(PHONE)}&Body=${encodeURIComponent(`${TEXT} ${OTP}`)}`;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    MessageId: 'sqs-target',
    ReceiptHandle: 'receipt-target',
    Body: body(),
    Attributes: {
      MessageGroupId: 'private-user-group',
      // SQS replaces a FIFO message's original dedupe id with the original
      // SQS MessageId when it moves the record to a FIFO DLQ.
      MessageDeduplicationId: 'sqs-target',
      ApproximateReceiveCount: '3',
      SentTimestamp: '1720000000000',
      ApproximateFirstReceiveTimestamp: '1720000001000',
    },
    ...overrides,
  };
}

type Handler = (command: unknown) => Promise<unknown>;

const AVAILABLE_DB: DbQueryable = {
  query: async () => ({
    rows: [{
      status: 'failed',
      first_seen_at: '2026-07-23T10:00:00.000Z',
      updated_at: '2026-07-23T10:05:00.000Z',
      completed_at: null,
      has_last_error: true,
      conversation_state: 'profile',
      workflow_status: 'active',
      current_step_key: 'profile.name',
    }],
    rowCount: 1,
  }),
};

function fakeClient(handler: Handler): { client: SqsCommandClient; commands: unknown[] } {
  const commands: unknown[] = [];
  return {
    client: {
      db: AVAILABLE_DB,
      send: async (command: unknown) => {
        commands.push(command);
        return handler(command);
      },
    },
    commands,
  };
}

function receiveSequence(
  batches: Message[][],
  options: {
    sendError?: Error;
    deleteError?: Error;
    visibilityFailures?: string[];
    destinationRedriveArn?: string;
    fifo?: boolean;
  } = {},
): ReturnType<typeof fakeClient> {
  let receiveIndex = 0;
  return fakeClient(async (command) => {
    if (command instanceof GetQueueAttributesCommand) {
      if (command.input.QueueUrl === DLQ_URL) {
        return { Attributes: { QueueArn: DLQ_ARN, FifoQueue: String(options.fifo ?? true) } };
      }
      return {
        Attributes: {
          QueueArn: 'arn:aws:sqs:us-east-1:123:inbound.fifo',
          FifoQueue: String(options.fifo ?? true),
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: options.destinationRedriveArn ?? DLQ_ARN }),
        },
      };
    }
    if (command instanceof ReceiveMessageCommand) {
      return { Messages: batches[receiveIndex++] ?? [] };
    }
    if (command instanceof ChangeMessageVisibilityBatchCommand) {
      return {
        Successful: command.input.Entries,
        Failed: (options.visibilityFailures ?? []).map((Id) => ({ Id, Code: 'InternalError' })),
      };
    }
    if (command instanceof SendMessageCommand) {
      if (options.sendError) throw options.sendError;
      return { MessageId: 'destination-id' };
    }
    if (command instanceof DeleteMessageCommand) {
      if (options.deleteError) throw options.deleteError;
      return {};
    }
    throw new Error(`unexpected command ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
}

describe('parseInboundReplayArgs', () => {
  const base = ['--dlq-url', DLQ_URL, '--queue-url', QUEUE_URL];

  it('accepts exactly one valid MessageSid target and defaults to dry-run', () => {
    expect(parseInboundReplayArgs(['--message-sid', MESSAGE_SID, ...base])).toEqual({
      ok: true,
      value: {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: false,
      },
    });
  });

  it('accepts an exact SQS message id and execute', () => {
    expect(parseInboundReplayArgs(['--sqs-message-id', 'exact id', ...base, '--execute'])).toEqual({
      ok: true,
      value: {
        target: { kind: 'sqs_message_id', value: 'exact id' },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
    });
  });

  const invalidArgv: string[][] = [
    [],
    ['--message-sid', MESSAGE_SID, ...base, '--sqs-message-id', 'x'],
    ['--message-sid', `SM${'z'.repeat(32)}`, ...base],
    ['--message-sid', MESSAGE_SID, '--dlq-url', DLQ_URL],
    ['--message-sid', MESSAGE_SID, ...base, '--execute', '--execute'],
    ['--message-sid', MESSAGE_SID, ...base, '--queue-url', QUEUE_URL],
    ['--message-sid', MESSAGE_SID, ...base, '--all'],
    ['--message-sid', `${MESSAGE_SID},${OTHER_SID}`, ...base],
    ['--sqs-message-id', '*', ...base],
    ['--sqs-message-id', 'a,b', ...base],
    ['--sqs-message-id', '', ...base],
    ['--message-sid', MESSAGE_SID, '--dlq-url', DLQ_URL, '--queue-url', DLQ_URL],
    ['--message-sid', '--execute', ...base],
  ];

  it.each(invalidArgv.map((argv) => [argv]))('rejects unsafe, incomplete, duplicate, or bulk argv: %j', (argv: string[]) => {
    expect(parseInboundReplayArgs(argv).ok).toBe(false);
  });
});

describe('replayWhatsappInbound', () => {
  it('matches MessageSid exactly, scans bounded batches of at most 10, and dry-run restores every receipt without send/delete', async () => {
    const first = Array.from({ length: 10 }, (_, i) =>
      message({
        MessageId: `other-${i}`,
        ReceiptHandle: `other-receipt-${i}`,
        Body: body(OTHER_SID),
        Attributes: {
          ...message().Attributes,
          MessageGroupId: `other-group-${i}`,
          MessageDeduplicationId: OTHER_SID,
        },
      }),
    );
    const target = message();
    const { client, commands } = receiveSequence([first, [target]]);
    const output: string[] = [];

    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: false,
      },
      { maxBatches: 2, log: (line: string) => output.push(line) },
    );

    expect(result.kind).toBe('dry_run');
    const receives = commands.filter((c): c is ReceiveMessageCommand => c instanceof ReceiveMessageCommand);
    expect(receives).toHaveLength(2);
    expect(receives.every((c) => c.input.QueueUrl === DLQ_URL && c.input.MaxNumberOfMessages === 10)).toBe(true);
    expect(receives.every((c) => c.input.MessageSystemAttributeNames?.includes('All'))).toBe(true);
    const visibility = commands.filter(
      (c): c is ChangeMessageVisibilityBatchCommand => c instanceof ChangeMessageVisibilityBatchCommand,
    );
    expect(visibility.flatMap((c) => c.input.Entries ?? [])).toHaveLength(11);
    expect(visibility.every((c) => (c.input.Entries?.length ?? 0) <= 10)).toBe(true);
    expect(commands.some((c) => c instanceof SendMessageCommand)).toBe(false);
    expect(commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
    const printed = output.join('\n');
    expect(printed).toContain(MESSAGE_SID);
    expect(printed).toContain('sqs-target');
    expect(printed).toContain('DB status: failed');
    expect(printed).toContain('workflow status: active');
    expect(printed).not.toContain(PHONE);
    expect(printed).not.toContain(OTP);
    expect(printed).not.toContain(TEXT);
    expect(printed).not.toContain(body());
    expect(printed).not.toContain('private-user-group');
  });

  it('matches an exact SQS id, sends byte-identical body with original FIFO attributes, then deletes only target', async () => {
    const rawBody = `${body()}&Extra=%2B%250A`;
    const target = message({ Body: rawBody });
    const nonTarget = message({
      MessageId: 'sqs-other',
      ReceiptHandle: 'receipt-other',
      Body: body(OTHER_SID),
      Attributes: { ...message().Attributes, MessageGroupId: 'other-group', MessageDeduplicationId: 'sqs-other' },
    });
    const { client, commands } = receiveSequence([[nonTarget, target]]);

    const result = await replayWhatsappInbound(client, {
      target: { kind: 'sqs_message_id', value: 'sqs-target' },
      dlqUrl: DLQ_URL,
      queueUrl: QUEUE_URL,
      execute: true,
    });

    expect(result.kind).toBe('executed');
    const sendIndex = commands.findIndex((c) => c instanceof SendMessageCommand);
    const deleteIndex = commands.findIndex((c) => c instanceof DeleteMessageCommand);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(sendIndex);
    const send = commands[sendIndex] as SendMessageCommand;
    expect(send.input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MessageBody: rawBody,
      MessageGroupId: 'private-user-group',
      MessageDeduplicationId: MESSAGE_SID,
    });
    const deletion = commands[deleteIndex] as DeleteMessageCommand;
    expect(deletion.input).toEqual({ QueueUrl: DLQ_URL, ReceiptHandle: 'receipt-target' });
    const visibilityHandles = commands
      .filter((c): c is ChangeMessageVisibilityBatchCommand => c instanceof ChangeMessageVisibilityBatchCommand)
      .flatMap((c) => c.input.Entries ?? [])
      .map((entry) => entry.ReceiptHandle);
    expect(visibilityHandles).toContain('receipt-other');
    expect(visibilityHandles).not.toContain('receipt-target');
  });

  it('accepts AWS FIFO DLQ rewritten dedupe id but rejects unrelated dedupe metadata', async () => {
    const rewritten = message({
      MessageId: 'original-sqs-id',
      Attributes: { ...message().Attributes, MessageDeduplicationId: 'original-sqs-id' },
    });
    const accepted = receiveSequence([[rewritten]]);
    const result = await replayWhatsappInbound(accepted.client, {
      target: { kind: 'sqs_message_id', value: 'original-sqs-id' },
      dlqUrl: DLQ_URL,
      queueUrl: QUEUE_URL,
      execute: true,
    });
    expect(result.kind).toBe('executed');
    const send = accepted.commands.find((c): c is SendMessageCommand => c instanceof SendMessageCommand);
    expect(send?.input.MessageDeduplicationId).toBe(MESSAGE_SID);

    const invalid = receiveSequence([[message({
      Attributes: { ...message().Attributes, MessageDeduplicationId: 'unrelated-id' },
    })]]);
    const rejected = await replayWhatsappInbound(invalid.client, {
      target: { kind: 'sqs_message_id', value: 'sqs-target' },
      dlqUrl: DLQ_URL,
      queueUrl: QUEUE_URL,
      execute: true,
    });
    expect(rejected.kind).toBe('validation_failed');
  });

  it('rejects a destination not authorized to redrive to the supplied FIFO DLQ before receiving', async () => {
    const { client, commands } = receiveSequence([[message()]], {
      destinationRedriveArn: 'arn:aws:sqs:us-east-1:123:different-dlq.fifo',
    });
    const result = await replayWhatsappInbound(client, {
      target: { kind: 'message_sid', value: MESSAGE_SID },
      dlqUrl: DLQ_URL,
      queueUrl: QUEUE_URL,
      execute: true,
    });
    expect(result.kind).toBe('queue_binding_failed');
    expect(commands.filter((c) => c instanceof GetQueueAttributesCommand)).toHaveLength(2);
    expect(commands.some((c) => c instanceof ReceiveMessageCommand)).toBe(false);
  });

  it('fails closed and restores the target when exact MessageSid DB state is unavailable on execute', async () => {
    const { client, commands } = receiveSequence([[message()]]);
    const unavailableDb: DbQueryable = { query: async () => { throw new Error(`db failed ${PHONE}`); } };
    const output: string[] = [];
    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { db: unavailableDb, log: (line) => output.push(line) },
    );
    expect(result.kind).toBe('db_state_unavailable');
    expect(commands.some((c) => c instanceof SendMessageCommand || c instanceof DeleteMessageCommand)).toBe(false);
    expect(commands.some((c) => c instanceof ChangeMessageVisibilityBatchCommand)).toBe(true);
    expect(output.join('\n')).not.toContain(PHONE);
  });

  it('never reorders a target behind more than ten same-group messages and instructs replaying the visible group head', async () => {
    const predecessors = Array.from({ length: 10 }, (_, index) => message({
      MessageId: `predecessor-${index}`,
      ReceiptHandle: `predecessor-receipt-${index}`,
      Body: body(OTHER_SID),
      Attributes: {
        ...message().Attributes,
        MessageGroupId: 'same-group',
        MessageDeduplicationId: `predecessor-${index}`,
      },
    }));
    // Once the first ten same-group records are held invisible, SQS cannot
    // expose the eleventh record from that group. It returns no target.
    const { client, commands } = receiveSequence([predecessors, []]);
    const output: string[] = [];
    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { maxBatches: 2, log: (line) => output.push(line) },
    );
    expect(result.kind).toBe('not_found');
    expect(commands.some((c) => c instanceof SendMessageCommand || c instanceof DeleteMessageCommand)).toBe(false);
    expect(output.join('\n')).toMatch(/group head.*first/i);
    const restored = commands
      .filter((c): c is ChangeMessageVisibilityBatchCommand => c instanceof ChangeMessageVisibilityBatchCommand)
      .flatMap((c) => c.input.Entries ?? []);
    expect(restored).toHaveLength(10);
  });

  it('restores held messages and returns nonzero result when target is absent at scan cap', async () => {
    const other = message({ MessageId: 'other', ReceiptHandle: 'other-receipt' });
    const { client, commands } = receiveSequence([[other], [other], [message({ MessageId: 'later' })]]);

    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'sqs_message_id', value: 'missing' },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { maxBatches: 2 },
    );

    expect(result.kind).toBe('not_found');
    expect(commands.filter((c) => c instanceof ReceiveMessageCommand)).toHaveLength(2);
    expect(commands.some((c) => c instanceof SendMessageCommand || c instanceof DeleteMessageCommand)).toBe(false);
    expect(commands.some((c) => c instanceof ChangeMessageVisibilityBatchCommand)).toBe(true);
  });

  it('restores target on invalid body or FIFO attributes and never exposes secrets', async () => {
    const invalid = message({
      Body: `MessageSid=${MESSAGE_SID}&From=${encodeURIComponent(PHONE)}&Body=${OTP}`,
      Attributes: { ...message().Attributes, MessageDeduplicationId: OTHER_SID },
    });
    const { client, commands } = receiveSequence([[invalid]]);
    const output: string[] = [];

    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'sqs_message_id', value: 'sqs-target' },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { log: (line: string) => output.push(line) },
    );

    expect(result.kind).toBe('validation_failed');
    expect(commands.some((c) => c instanceof SendMessageCommand || c instanceof DeleteMessageCommand)).toBe(false);
    expect(commands.some((c) => c instanceof ChangeMessageVisibilityBatchCommand)).toBe(true);
    expect(output.join('\n')).not.toMatch(new RegExp(`${PHONE}|${OTP}|${TEXT}`));
  });

  it.each(['', 'From=not-a-whatsapp-number&'])(
    'rejects a missing or malformed From field without send/delete',
    async (fromPrefix) => {
      const invalid = message({ Body: `${fromPrefix}MessageSid=${MESSAGE_SID}&Body=${OTP}` });
      const { client, commands } = receiveSequence([[invalid]]);
      const result = await replayWhatsappInbound(client, {
        target: { kind: 'sqs_message_id', value: 'sqs-target' },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      });
      expect(result.kind).toBe('validation_failed');
      expect(commands.some((c) => c instanceof SendMessageCommand || c instanceof DeleteMessageCommand)).toBe(false);
    },
  );

  it('restores target after send failure and leaves source intact', async () => {
    const { client, commands } = receiveSequence([[message()]], { sendError: new Error(`failed ${PHONE} ${OTP}`) });
    const output: string[] = [];
    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { log: (line: string) => output.push(line) },
    );

    expect(result.kind).toBe('send_failed');
    expect(commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
    const restored = commands
      .filter((c): c is ChangeMessageVisibilityBatchCommand => c instanceof ChangeMessageVisibilityBatchCommand)
      .flatMap((c) => c.input.Entries ?? []);
    expect(restored.some((entry) => entry.ReceiptHandle === 'receipt-target')).toBe(true);
    expect(output.join('\n')).not.toMatch(new RegExp(`${PHONE}|${OTP}`));
  });

  it('returns distinct partial failure when destination accepted but source delete failed', async () => {
    const { client, commands } = receiveSequence([[message()]], {
      deleteError: new Error(`delete failed ${PHONE}`),
    });
    const output: string[] = [];
    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'message_sid', value: MESSAGE_SID },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: true,
      },
      { log: (line: string) => output.push(line) },
    );

    expect(result.kind).toBe('destination_accepted_source_not_deleted');
    expect(commands.findIndex((c) => c instanceof SendMessageCommand)).toBeLessThan(
      commands.findIndex((c) => c instanceof DeleteMessageCommand),
    );
    expect(output.join('\n')).toMatch(/destination accepted.*source not deleted/i);
    expect(output.join('\n')).not.toContain(PHONE);
  });

  it('treats partial visibility restoration failures conservatively', async () => {
    const { client } = receiveSequence([[message({ MessageId: 'other' })]], {
      visibilityFailures: ['0'],
    });
    const result = await replayWhatsappInbound(
      client,
      {
        target: { kind: 'sqs_message_id', value: 'missing' },
        dlqUrl: DLQ_URL,
        queueUrl: QUEUE_URL,
        execute: false,
      },
      { maxBatches: 1 },
    );
    expect(result.kind).toBe('visibility_restore_failed');
  });
});
