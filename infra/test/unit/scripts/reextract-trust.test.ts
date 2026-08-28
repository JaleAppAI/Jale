import {
  REEXTRACT_SELECT_SQL,
  parseArgs,
  resolveExitCode,
  run,
  type Queryable,
  type ReextractArgs,
  type SqsCommandClient,
} from '../../../scripts/reextract-trust';

const QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/trust-extraction-queue';

// A worker's own words are the exact thing this tool must never surface.
const SECRET_ANSWER = 'I ran the panel at 42 Willow St, call me on 555-123-9876';

const ROWS = [
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', user_id: 'u-1', profession_key: 'electrician' },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', user_id: 'u-2', profession_key: 'painter' },
];

function args(overrides: Partial<ReextractArgs> = {}): ReextractArgs {
  return { extractorVersion: 'v1', execute: false, limit: 200, ...overrides };
}

function fakeDb(rows: Array<Record<string, unknown>> = ROWS) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
  return { db, calls };
}

function fakeSqs(failOn?: string) {
  const bodies: string[] = [];
  const client: SqsCommandClient = {
    send: async (command: unknown) => {
      const body = (command as { MessageBody: string }).MessageBody;
      bodies.push(body);
      return {};
    },
  };
  // The `send` seam is injected instead of the SDK, so no command constructor
  // and no credentials are involved.
  const send = async (_client: SqsCommandClient, _url: string, body: string) => {
    if (failOn && body.includes(failOn)) {
      const error = new Error('queue gone: ' + QUEUE_URL);
      error.name = 'QueueDoesNotExist';
      throw error;
    }
    bodies.push(body);
    return {};
  };
  return { client, send, bodies };
}

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (line: string) => lines.push(line),
    logError: (line: string) => errors.push(line),
    all: () => [...lines, ...errors].join('\n'),
  };
}

describe('parseArgs', () => {
  it('requires --extractor-version', () => {
    expect(parseArgs([])).toEqual({ ok: false, error: '--extractor-version is required' });
  });

  it('defaults to a dry run with limit 200', () => {
    expect(parseArgs(['--extractor-version', 'v1'])).toEqual({
      ok: true,
      value: { extractorVersion: 'v1', execute: false, limit: 200 },
    });
  });

  it('accepts an explicit --dry-run', () => {
    const parsed = parseArgs(['--extractor-version', 'v2', '--dry-run']);
    expect(parsed).toMatchObject({ ok: true, value: { execute: false } });
  });

  it('accepts --execute and --limit', () => {
    expect(parseArgs(['--extractor-version', 'v1', '--limit', '50', '--execute'])).toEqual({
      ok: true,
      value: { extractorVersion: 'v1', execute: true, limit: 50 },
    });
  });

  it('rejects --dry-run together with --execute', () => {
    expect(parseArgs(['--extractor-version', 'v1', '--dry-run', '--execute']))
      .toEqual({ ok: false, error: '--dry-run and --execute are mutually exclusive' });
  });

  it('rejects the --flag=value form without echoing the value', () => {
    const parsed = parseArgs(['--extractor-version=v1']);
    expect(parsed.ok).toBe(false);
    expect((parsed as { error: string }).error).toContain('--extractor-version');
    expect((parsed as { error: string }).error).not.toContain('=v1');
  });

  it('rejects bulk/all flags and points at --limit', () => {
    for (const flag of ['--all', '--bulk', '-a', '--force-all', '--everything']) {
      const parsed = parseArgs(['--extractor-version', 'v1', flag]);
      expect(parsed.ok).toBe(false);
      expect((parsed as { error: string }).error).toContain('--limit');
    }
  });

  it('rejects unknown flags, duplicates, missing values and stray positionals', () => {
    expect(parseArgs(['--nope']).ok).toBe(false);
    expect(parseArgs(['--extractor-version', 'v1', '--extractor-version', 'v2']))
      .toEqual({ ok: false, error: 'Duplicate flag: --extractor-version' });
    expect(parseArgs(['--extractor-version', 'v1', '--execute', '--execute']))
      .toEqual({ ok: false, error: 'Duplicate flag: --execute' });
    expect(parseArgs(['--extractor-version'])).toEqual({
      ok: false,
      error: 'Missing value for --extractor-version',
    });
    expect(parseArgs(['--extractor-version', '--limit', '5'])).toEqual({
      ok: false,
      error: 'Missing value for --extractor-version',
    });
    const positional = parseArgs(['v1']);
    expect(positional).toEqual({ ok: false, error: 'Unexpected positional argument (value redacted)' });
  });

  it('rejects a non-integer, zero, negative or oversized --limit', () => {
    for (const raw of ['0', '-1', '1.5', ' 5', '5000000', 'abc', '007x']) {
      expect(parseArgs(['--extractor-version', 'v1', '--limit', raw]).ok).toBe(false);
    }
    expect(parseArgs(['--extractor-version', 'v1', '--limit', '5000']).ok).toBe(true);
  });

  it('rejects a version string that is not inert text (it gets echoed)', () => {
    const parsed = parseArgs(['--extractor-version', 'v1; DROP TABLE users']);
    expect(parsed.ok).toBe(false);
    expect((parsed as { error: string }).error).not.toContain('DROP TABLE');
  });
});

describe('selection SQL', () => {
  it('never PROJECTS the answers column — a worker`s words cannot leave the DB', () => {
    // `a.answers` is referenced (inside the EXISTS filter) but must never
    // appear in the outer projection: the returned columns are the whole
    // reason this tool physically cannot print an answer.
    const projection = REEXTRACT_SELECT_SQL.slice(
      REEXTRACT_SELECT_SQL.search(/SELECT/i),
      REEXTRACT_SELECT_SQL.search(/\n\s*FROM/i),
    );
    expect(projection).not.toMatch(/answer/i);
    expect(projection).toMatch(/SELECT\s+a\.id,\s*a\.user_id,\s*a\.profession_key/i);
    // The only place answers may appear at all is the non-blank EXISTS test.
    const answersRefs = REEXTRACT_SELECT_SQL.match(/a\.answers/g) ?? [];
    expect(answersRefs).toHaveLength(1);
  });

  it('left-joins worker_trust_extractions on the requested version and keeps only the misses', () => {
    expect(REEXTRACT_SELECT_SQL).toMatch(/LEFT JOIN worker_trust_extractions e/i);
    expect(REEXTRACT_SELECT_SQL).toMatch(/e\.extractor_version = \$1/);
    expect(REEXTRACT_SELECT_SQL).toMatch(/e\.id IS NULL/i);
  });

  it('requires at least one non-blank answer and excludes failed assessments', () => {
    expect(REEXTRACT_SELECT_SQL).toMatch(/jsonb_array_elements/i);
    expect(REEXTRACT_SELECT_SQL).toMatch(/answer_text/);
    expect(REEXTRACT_SELECT_SQL).toMatch(/a\.status IN \('pending','scoring','scored'\)/i);
    expect(REEXTRACT_SELECT_SQL).not.toMatch(/'failed'/);
  });

  it('parameterises the version and the limit rather than interpolating them', () => {
    expect(REEXTRACT_SELECT_SQL).toMatch(/LIMIT \$2/);
    const { db, calls } = fakeDb();
    return run({ db, args: args({ limit: 7 }), log: () => {}, logError: () => {} }).then(() => {
      expect(calls[0].values).toEqual(['v1', 7]);
    });
  });
});

describe('run — dry run (default)', () => {
  it('queries, prints counts and ids, and sends nothing', async () => {
    const { db, calls } = fakeDb();
    const out = capture();
    const { client, send, bodies } = fakeSqs();

    const result = await run({ db, args: args(), sqs: client, send, queueUrl: QUEUE_URL, log: out.log, logError: out.logError });

    expect(result).toEqual({ kind: 'dry_run', selected: 2, queued: 0 });
    expect(calls).toHaveLength(1);
    expect(bodies).toHaveLength(0);
    expect(out.all()).toContain('2 assessment(s)');
    expect(out.all()).toContain(ROWS[0].id);
    expect(out.all()).toContain('Re-run with --execute');
  });

  it('is a no-op at zero rows and exits 0', async () => {
    const { db } = fakeDb([]);
    const out = capture();

    const result = await run({ db, args: args(), log: out.log, logError: out.logError });

    expect(result).toEqual({ kind: 'nothing_to_do', selected: 0, queued: 0 });
    expect(resolveExitCode(result)).toBe(0);
    expect(out.all()).toContain('nothing to re-extract');
  });

  it('does not need a queue URL', async () => {
    const { db } = fakeDb();
    const out = capture();

    const result = await run({ db, args: args(), log: out.log, logError: out.logError });

    expect(result.kind).toBe('dry_run');
    expect(out.errors).toHaveLength(0);
  });

  it('never prints an answer even when the DB hands one back', async () => {
    const { db } = fakeDb([{ ...ROWS[0], answers: [{ answer_text: SECRET_ANSWER }] }]);
    const out = capture();

    await run({ db, args: args(), log: out.log, logError: out.logError });

    expect(out.all()).not.toContain('Willow St');
    expect(out.all()).not.toMatch(/\d{3}-\d{3}-\d{4}/);
  });
});

describe('run — --execute', () => {
  it('sends the drain`s payload shape, one message per assessment', async () => {
    const { db } = fakeDb();
    const out = capture();
    const { client, send, bodies } = fakeSqs();

    const result = await run({
      db, args: args({ execute: true }), sqs: client, send, queueUrl: QUEUE_URL,
      log: out.log, logError: out.logError,
    });

    expect(result).toEqual({ kind: 'executed', selected: 2, queued: 2 });
    expect(bodies.map((body) => JSON.parse(body))).toEqual([
      { assessmentId: ROWS[0].id, userId: 'u-1', professionKey: 'electrician' },
      { assessmentId: ROWS[1].id, userId: 'u-2', professionKey: 'painter' },
    ]);
    expect(out.all()).toContain('queued 2 of 2');
  });

  it('refuses without TRUST_EXTRACTION_QUEUE_URL, before touching the database', async () => {
    const { db, calls } = fakeDb();
    const out = capture();

    const result = await run({ db, args: args({ execute: true }), log: out.log, logError: out.logError });

    expect(result).toEqual({ kind: 'queue_not_configured', selected: 0, queued: 0 });
    expect(calls).toHaveLength(0);
    expect(resolveExitCode(result)).toBe(1);
    expect(out.errors.join('\n')).toContain('TRUST_EXTRACTION_QUEUE_URL');
  });

  it('continues past a failed send, reports the error NAME only, and exits non-zero', async () => {
    const { db } = fakeDb();
    const out = capture();
    const { client, send, bodies } = fakeSqs(ROWS[0].id);

    const result = await run({
      db, args: args({ execute: true }), sqs: client, send, queueUrl: QUEUE_URL,
      log: out.log, logError: out.logError,
    });

    expect(result).toEqual({ kind: 'aws_error', selected: 2, queued: 1 });
    expect(resolveExitCode(result)).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(out.all()).toContain('QueueDoesNotExist');
    // SDK errors quote the queue URL, which embeds the account id.
    expect(out.all()).not.toContain(QUEUE_URL);
    expect(out.all()).not.toContain('123456789012');
  });

  it('honours --limit by passing it to the query, not by slicing in code', async () => {
    const { db, calls } = fakeDb();
    const out = capture();
    const { client, send } = fakeSqs();

    await run({
      db, args: args({ execute: true, limit: 1 }), sqs: client, send, queueUrl: QUEUE_URL,
      log: out.log, logError: out.logError,
    });

    expect(calls[0].values).toEqual(['v1', 1]);
  });
});

describe('resolveExitCode', () => {
  it('maps a dry run and an empty backlog to 0, failures to 1', () => {
    expect(resolveExitCode({ kind: 'dry_run', selected: 3, queued: 0 })).toBe(0);
    expect(resolveExitCode({ kind: 'executed', selected: 3, queued: 3 })).toBe(0);
    expect(resolveExitCode({ kind: 'nothing_to_do', selected: 0, queued: 0 })).toBe(0);
    expect(resolveExitCode({ kind: 'aws_error', selected: 3, queued: 1 })).toBe(1);
    expect(resolveExitCode({ kind: 'queue_not_configured', selected: 0, queued: 0 })).toBe(1);
  });
});
