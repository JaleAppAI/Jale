import * as fs from 'node:fs';
import * as path from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import * as tutorialProgress from '../../../../lambda/api/tutorial-progress';
import { handler } from '../../../../lambda/api/tutorial-progress';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { corsHeaders } from '../../../../lambda/lib/http';

// The tutorial progress handler (contract K1.2 and K1.3) against an in-memory
// stand-in for the database. The stand-in answers the handler's statements by
// their text and applies their WHERE clauses, so a statement that loses its
// caller or role filter returns the other rows. The DB suite
// (test/unit/db/user-tutorial-progress.integration.test.ts) runs the same
// statements on PostgreSQL as the request login.

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;

const EMPLOYER_SUB = 'test-employer-sub';
const WORKER_SUB = 'test-worker-sub';
const EMPLOYER_USER_ID = '00000000-0000-4000-8000-0000000000e1';
const WORKER_USER_ID = '00000000-0000-4000-8000-0000000000a1';

interface StoredRow {
  user_id: string;
  tutorial_id: string;
  outcome: string;
  recorded_at: Date;
}

let users: Map<string, string>;
let stored: StoredRow[];
let statements: string[];
let failOn: RegExp | null;
let clock: number;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
  const text = normalize(sql);
  statements.push(text);
  if (failOn && failOn.test(text)) throw new Error('connection lost');
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (text === 'SELECT id FROM users WHERE cognito_sub = $1') {
    const id = users.get(params[0] as string);
    return id ? { rows: [{ id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.startsWith('INSERT INTO user_tutorial_progress (user_id, tutorial_id, outcome) VALUES ($1, $2, $3)')) {
    expect(text).toContain('ON CONFLICT (user_id, tutorial_id) DO NOTHING');
    const [userId, tutorialId, outcome] = params as string[];
    if (stored.some((r) => r.user_id === userId && r.tutorial_id === tutorialId)) return { rows: [], rowCount: 0 };
    clock += 1000;
    stored.push({ user_id: userId, tutorial_id: tutorialId, outcome, recorded_at: new Date(clock) });
    return { rows: [], rowCount: 1 };
  }
  if (text.startsWith('SELECT tutorial_id, outcome, recorded_at FROM user_tutorial_progress WHERE user_id = $1')) {
    let rows = stored.filter((r) => r.user_id === params[0]);
    if (text.includes('AND tutorial_id = ANY($2::text[])')) {
      rows = rows.filter((r) => (params[1] as string[]).includes(r.tutorial_id));
    } else if (text.includes('AND tutorial_id = $2')) {
      rows = rows.filter((r) => r.tutorial_id === params[1]);
    }
    if (text.endsWith('ORDER BY tutorial_id')) rows = [...rows].sort((a, b) => a.tutorial_id.localeCompare(b.tutorial_id));
    return { rows: rows.map(({ user_id: _u, ...rest }) => rest), rowCount: rows.length };
  }
  throw new Error(`unexpected statement: ${text}`);
}

function makeEvent(opts: {
  method?: string;
  resource?: string;
  sub?: string | null;
  body?: unknown;
} = {}): APIGatewayProxyEvent {
  const sub = 'sub' in opts ? opts.sub : EMPLOYER_SUB;
  const resource = opts.resource ?? '/employer/tutorials';
  const body = opts.body === undefined ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return {
    httpMethod: opts.method ?? 'GET',
    resource,
    path: resource,
    body,
    requestContext: sub ? { authorizer: { claims: { sub } } } : { authorizer: {} },
  } as unknown as APIGatewayProxyEvent;
}

function workerEvent(opts: { method?: string; body?: unknown } = {}): APIGatewayProxyEvent {
  return makeEvent({ ...opts, resource: '/worker/tutorials', sub: WORKER_SUB });
}

function parsed(res: { statusCode: number; body: string }): { status: number; body: any } {
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function seed(userId: string, tutorialId: string, outcome: string, at: string): void {
  stored.push({ user_id: userId, tutorial_id: tutorialId, outcome, recorded_at: new Date(at) });
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

function loggedLines(): string[] {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls].map((args) => args.map(String).join(' '));
}

function progressLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'TutorialProgress');
}

beforeEach(() => {
  jest.resetAllMocks();
  users = new Map([[EMPLOYER_SUB, EMPLOYER_USER_ID], [WORKER_SUB, WORKER_USER_ID]]);
  stored = [];
  statements = [];
  failOn = null;
  clock = Date.parse('2026-10-22T15:00:00.000Z');
  mockQuery.mockImplementation(fakeQuery);
  mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
  mockSetRlsContext.mockImplementation(async () => { statements.push('SET CALLER'); });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('GET tutorial progress', () => {
  it('answers the employer records only, ordered by id, with ISO times, on the employer path', async () => {
    seed(EMPLOYER_USER_ID, 'employer_welcome', 'skipped', '2026-10-20T10:00:00.000Z');
    seed(EMPLOYER_USER_ID, 'employer_applicants', 'completed', '2026-10-21T11:30:00.000Z');
    // A stray row of the other role on the same account is never returned.
    seed(EMPLOYER_USER_ID, 'worker_apply', 'completed', '2026-10-21T12:00:00.000Z');
    seed(WORKER_USER_ID, 'worker_profile', 'completed', '2026-10-21T12:00:00.000Z');

    const res = await handler(makeEvent());

    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({
      status: 200,
      body: {
        tutorials: [
          { tutorial_id: 'employer_applicants', outcome: 'completed', recorded_at: '2026-10-21T11:30:00.000Z' },
          { tutorial_id: 'employer_welcome', outcome: 'skipped', recorded_at: '2026-10-20T10:00:00.000Z' },
        ],
      },
    });
  });

  it('answers the worker records only on the worker path', async () => {
    seed(WORKER_USER_ID, 'worker_onboarding', 'completed', '2026-10-21T09:00:00.000Z');
    seed(WORKER_USER_ID, 'employer_welcome', 'skipped', '2026-10-21T09:05:00.000Z');

    const res = await handler(workerEvent());

    expect(parsed(res)).toEqual({
      status: 200,
      body: { tutorials: [{ tutorial_id: 'worker_onboarding', outcome: 'completed', recorded_at: '2026-10-21T09:00:00.000Z' }] },
    });
  });

  it('answers an empty list when nothing is recorded', async () => {
    expect(parsed(await handler(makeEvent()))).toEqual({ status: 200, body: { tutorials: [] } });
  });

  it('sets the caller context inside the transaction before the first read, and commits', async () => {
    await handler(makeEvent());

    expect(mockSetRlsContext).toHaveBeenCalledTimes(1);
    expect(mockSetRlsContext.mock.calls[0][1]).toBe(EMPLOYER_SUB);
    expect(statements.slice(0, 3)).toEqual(['BEGIN', 'SET CALLER', 'SELECT id FROM users WHERE cognito_sub = $1']);
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('answers 404 not_found when the caller has no users row', async () => {
    users.delete(EMPLOYER_SUB);

    const res = await handler(makeEvent());

    expect(parsed(res)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(statements.some((s) => s.includes('user_tutorial_progress'))).toBe(false);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('POST tutorial progress', () => {
  it('records an outcome and answers the stored record', async () => {
    const res = await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_post_job', outcome: 'completed' } }));

    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({
      status: 200,
      body: { tutorial: { tutorial_id: 'employer_post_job', outcome: 'completed', recorded_at: '2026-10-22T15:00:01.000Z' } },
    });
    expect(stored).toEqual([
      { user_id: EMPLOYER_USER_ID, tutorial_id: 'employer_post_job', outcome: 'completed', recorded_at: new Date('2026-10-22T15:00:01.000Z') },
    ]);
    expect(statements[statements.length - 1]).toBe('COMMIT');
  });

  it('keeps the first outcome: a second record answers the stored one unchanged', async () => {
    const first = parsed(await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_messages', outcome: 'skipped' } })));
    const second = parsed(await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_messages', outcome: 'completed' } })));

    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(second.body.tutorial.outcome).toBe('skipped');
    expect(stored).toHaveLength(1);
  });

  it('records worker ids on the worker path', async () => {
    const res = await handler(workerEvent({ method: 'POST', body: { tutorial_id: 'worker_details', outcome: 'skipped' } }));

    expect(parsed(res)).toEqual({
      status: 200,
      body: { tutorial: { tutorial_id: 'worker_details', outcome: 'skipped', recorded_at: '2026-10-22T15:00:01.000Z' } },
    });
    expect(stored.map((r) => r.user_id)).toEqual([WORKER_USER_ID]);
  });

  it.each([
    ['a worker id on the employer path', makeEvent({ method: 'POST', body: { tutorial_id: 'worker_apply', outcome: 'completed' } })],
    ['an employer id on the worker path', workerEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } })],
    ['an unknown id', makeEvent({ method: 'POST', body: { tutorial_id: 'employer_billing', outcome: 'completed' } })],
    ['an id that is not a string', makeEvent({ method: 'POST', body: { tutorial_id: 7, outcome: 'completed' } })],
    ['a missing id', makeEvent({ method: 'POST', body: { outcome: 'completed' } })],
  ])('answers 400 invalid_tutorial for %s and writes nothing', async (_name, event) => {
    expect(parsed(await handler(event))).toEqual({ status: 400, body: { error: 'invalid_tutorial' } });
    expect(stored).toEqual([]);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown outcome', { tutorial_id: 'employer_welcome', outcome: 'dismissed' }],
    ['a missing outcome', { tutorial_id: 'employer_welcome' }],
    ['an outcome that is not a string', { tutorial_id: 'employer_welcome', outcome: true }],
  ])('answers 400 invalid_outcome for %s and writes nothing', async (_name, body) => {
    expect(parsed(await handler(makeEvent({ method: 'POST', body })))).toEqual({ status: 400, body: { error: 'invalid_outcome' } });
    expect(stored).toEqual([]);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'tutorial_id=employer_welcome'],
    ['an empty body', ''],
    ['a JSON array', JSON.stringify([{ tutorial_id: 'employer_welcome', outcome: 'completed' }])],
    ['a JSON string', JSON.stringify('employer_welcome')],
    ['JSON null', 'null'],
  ])('answers 400 invalid_tutorial for %s', async (_name, body) => {
    expect(parsed(await handler(makeEvent({ method: 'POST', body })))).toEqual({ status: 400, body: { error: 'invalid_tutorial' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('answers 400 invalid_tutorial for no body at all', async () => {
    const event = makeEvent({ method: 'POST' });
    expect(event.body).toBeNull();
    expect(parsed(await handler(event))).toEqual({ status: 400, body: { error: 'invalid_tutorial' } });
  });

  /** A valid record padded with an ignored field to exactly `bytes` bytes of UTF-8. */
  function paddedBody(bytes: number): string {
    const base = { tutorial_id: 'employer_welcome', outcome: 'completed', note: '' };
    const filler = bytes - Buffer.byteLength(JSON.stringify(base), 'utf8');
    const body = JSON.stringify({ ...base, note: 'x'.repeat(filler) });
    expect(Buffer.byteLength(body, 'utf8')).toBe(bytes);
    return body;
  }

  it('accepts a body of exactly 1 KiB and ignores unknown fields', async () => {
    const res = await handler(makeEvent({ method: 'POST', body: paddedBody(1024) }));
    expect(parsed(res).status).toBe(200);
    expect(parsed(res).body.tutorial).toEqual(expect.objectContaining({ tutorial_id: 'employer_welcome', outcome: 'completed' }));
    expect(Object.keys(parsed(res).body.tutorial).sort()).toEqual(['outcome', 'recorded_at', 'tutorial_id']);
  });

  it('answers 400 invalid_tutorial for a body over 1 KiB, counted in bytes', async () => {
    expect(parsed(await handler(makeEvent({ method: 'POST', body: paddedBody(1025) })))).toEqual({
      status: 400, body: { error: 'invalid_tutorial' },
    });
    // 342 three-byte characters: 1026 bytes in 342 characters.
    const wide = JSON.stringify({ tutorial_id: 'employer_welcome', outcome: 'completed', note: '€'.repeat(342) });
    expect(wide.length).toBeLessThan(1024);
    expect(parsed(await handler(makeEvent({ method: 'POST', body: wide })))).toEqual({
      status: 400, body: { error: 'invalid_tutorial' },
    });
    expect(stored).toEqual([]);
  });

  it('answers 404 not_found when the caller has no users row, and writes nothing', async () => {
    users.delete(WORKER_SUB);

    const res = await handler(workerEvent({ method: 'POST', body: { tutorial_id: 'worker_apply', outcome: 'completed' } }));

    expect(parsed(res)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(stored).toEqual([]);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
  });
});

describe('requests the handler refuses before the database', () => {
  it.each([
    ['GET', makeEvent({ sub: null })],
    ['POST', makeEvent({ sub: null, method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } })],
    ['GET with an empty sub', makeEvent({ sub: '' })],
  ])('answers 401 unauthorized when the caller has no sub (%s)', async (_name, event) => {
    expect(parsed(await handler(event))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each(['/tutorials', '/employer/tutorials/extra', '/admin/tutorials'])('answers 404 not_found on %s', async (resource) => {
    expect(parsed(await handler(makeEvent({ resource })))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('answers 405 method_not_allowed for any other method', async () => {
    const res = await handler(makeEvent({ method: 'DELETE' }));
    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({ status: 405, body: { error: 'method_not_allowed' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});

describe('failures and logging', () => {
  it('answers 500 internal_error, rolls back and releases when a statement fails', async () => {
    failOn = /^INSERT INTO user_tutorial_progress/;

    const res = await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } }));

    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('writes one TutorialProgress line per request with role, method and outcome code, and never the sub', async () => {
    await handler(makeEvent());
    await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } }));
    await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'skipped' } }));
    await handler(workerEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'skipped' } }));
    await handler(makeEvent({ sub: null }));
    users.delete(WORKER_SUB);
    await handler(workerEvent());
    failOn = /^SELECT id FROM users/;
    await handler(makeEvent());

    expect(progressLines()).toEqual([
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'read' },
      { event: 'TutorialProgress', role: 'employer', method: 'POST', outcome: 'recorded' },
      { event: 'TutorialProgress', role: 'employer', method: 'POST', outcome: 'already_recorded' },
      { event: 'TutorialProgress', role: 'worker', method: 'POST', outcome: 'invalid_tutorial' },
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'unauthorized' },
      { event: 'TutorialProgress', role: 'worker', method: 'GET', outcome: 'not_found' },
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'internal_error', error: 'connection lost' },
    ]);
    const all = loggedLines().join('\n');
    expect(all).not.toContain(EMPLOYER_SUB);
    expect(all).not.toContain(WORKER_SUB);
  });
});

// K1.1: the backend keeps the same two id lists as the frontend client. The
// client module cannot be imported across the package boundary, so its text
// is read and the two array literals compared.
describe('the id lists match the frontend client (contract K1.1)', () => {
  const clientPath = path.resolve(__dirname, '../../../../../frontend/src/lib/api/tutorials.ts');

  function listIn(source: string, name: string): string[] {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
    expect(match).not.toBeNull();
    return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  it('lists the same employer and worker ids, in the same order', () => {
    const source = fs.readFileSync(clientPath, 'utf8');
    const backend = tutorialProgress as unknown as Record<string, unknown>;
    const employer = listIn(source, 'EMPLOYER_TUTORIAL_IDS');
    const worker = listIn(source, 'WORKER_TUTORIAL_IDS');

    expect(employer).toEqual(['employer_welcome', 'employer_post_job', 'employer_applicants', 'employer_messages']);
    expect(worker).toEqual(['worker_onboarding', 'worker_apply', 'worker_details', 'worker_profile']);
    expect(backend.EMPLOYER_TUTORIAL_IDS).toEqual(employer);
    expect(backend.WORKER_TUTORIAL_IDS).toEqual(worker);
  });
});
