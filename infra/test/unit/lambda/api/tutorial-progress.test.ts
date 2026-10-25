import * as fs from 'node:fs';
import * as path from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import * as tutorialProgress from '../../../../lambda/api/tutorial-progress';
import { handler } from '../../../../lambda/api/tutorial-progress';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { corsHeaders } from '../../../../lambda/lib/http';

// The tutorial progress handler (contracts K1.2, K1.3 and K1-v2) against an
// in-memory stand-in for the database. The stand-in answers the handler's statements by
// their text and applies their WHERE clauses, so a statement that loses its
// caller or role filter returns the other rows. The DB suite
// suites (test/unit/db/user-tutorial-progress.integration.test.ts and
// user-tutorial-settings.integration.test.ts) run the same statements on
// PostgreSQL as the request login.

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

interface StoredSettings {
  always_show: boolean;
  muted: string[];
}

let users: Map<string, string>;
let stored: StoredRow[];
let settings: Map<string, StoredSettings>;
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
  if (text === 'SELECT always_show, muted FROM user_tutorial_settings WHERE user_id = $1') {
    const row = settings.get(params[0] as string);
    return row ? { rows: [{ always_show: row.always_show, muted: [...row.muted] }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.startsWith('INSERT INTO user_tutorial_settings (user_id, always_show, muted, updated_at)')) {
    // The upsert: a field sent as NULL keeps the stored value (or the default
    // on the first write); a field sent replaces it.
    expect(text).toBe(
      'INSERT INTO user_tutorial_settings (user_id, always_show, muted, updated_at) '
      + "VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text[], '{}'), now()) "
      + 'ON CONFLICT (user_id) DO UPDATE SET always_show = COALESCE($2::boolean, user_tutorial_settings.always_show), '
      + 'muted = COALESCE($3::text[], user_tutorial_settings.muted), updated_at = now() '
      + 'RETURNING always_show, muted',
    );
    const [userId, alwaysShow, muted] = params as [string, boolean | null, string[] | null];
    const current = settings.get(userId) ?? { always_show: false, muted: [] };
    const next = { always_show: alwaysShow ?? current.always_show, muted: muted ? [...muted] : current.muted };
    settings.set(userId, next);
    return { rows: [{ always_show: next.always_show, muted: [...next.muted] }], rowCount: 1 };
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
  settings = new Map();
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

const DEFAULT_SETTINGS = { always_show: false, muted: [] };

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
        settings: DEFAULT_SETTINGS,
      },
    });
  });

  it('answers the worker records only on the worker path', async () => {
    seed(WORKER_USER_ID, 'worker_onboarding', 'completed', '2026-10-21T09:00:00.000Z');
    seed(WORKER_USER_ID, 'employer_welcome', 'skipped', '2026-10-21T09:05:00.000Z');

    const res = await handler(workerEvent());

    expect(parsed(res)).toEqual({
      status: 200,
      body: {
        tutorials: [{ tutorial_id: 'worker_onboarding', outcome: 'completed', recorded_at: '2026-10-21T09:00:00.000Z' }],
        settings: DEFAULT_SETTINGS,
      },
    });
  });

  it("includes the role's app tour record, and never the other role's", async () => {
    seed(EMPLOYER_USER_ID, 'employer_app_tour', 'skipped', '2026-10-21T08:00:00.000Z');
    seed(EMPLOYER_USER_ID, 'worker_app_tour', 'completed', '2026-10-21T08:30:00.000Z');
    seed(WORKER_USER_ID, 'worker_app_tour', 'completed', '2026-10-21T09:00:00.000Z');
    seed(WORKER_USER_ID, 'employer_app_tour', 'completed', '2026-10-21T09:30:00.000Z');

    expect(parsed(await handler(makeEvent())).body.tutorials).toEqual([
      { tutorial_id: 'employer_app_tour', outcome: 'skipped', recorded_at: '2026-10-21T08:00:00.000Z' },
    ]);
    expect(parsed(await handler(workerEvent())).body.tutorials).toEqual([
      { tutorial_id: 'worker_app_tour', outcome: 'completed', recorded_at: '2026-10-21T09:00:00.000Z' },
    ]);
  });

  it('answers an empty list and the default settings when nothing is recorded', async () => {
    expect(parsed(await handler(makeEvent()))).toEqual({ status: 200, body: { tutorials: [], settings: DEFAULT_SETTINGS } });
  });

  it('answers the stored settings', async () => {
    settings.set(EMPLOYER_USER_ID, { always_show: true, muted: ['employer_post_job'] });

    expect(parsed(await handler(makeEvent()))).toEqual({
      status: 200,
      body: { tutorials: [], settings: { always_show: true, muted: ['employer_post_job'] } },
    });
  });

  it("answers muted filtered to the role's tutorial ids, in the role's list order", async () => {
    // A tour id, the other role's ids, an unknown id and a repeat are never
    // answered; the rest come back in EMPLOYER_TUTORIAL_IDS order.
    settings.set(EMPLOYER_USER_ID, {
      always_show: false,
      muted: ['employer_messages', 'worker_apply', 'employer_app_tour', 'employer_welcome', 'employer_billing', 'employer_messages'],
    });
    settings.set(WORKER_USER_ID, {
      always_show: true,
      muted: ['worker_profile', 'employer_welcome', 'worker_app_tour', 'worker_onboarding'],
    });

    expect(parsed(await handler(makeEvent())).body.settings).toEqual({
      always_show: false, muted: ['employer_welcome', 'employer_messages'],
    });
    expect(parsed(await handler(workerEvent())).body.settings).toEqual({
      always_show: true, muted: ['worker_onboarding', 'worker_profile'],
    });
  });

  it('sets the caller context inside the transaction before the first read, reads both in it, and commits', async () => {
    await handler(makeEvent());

    expect(mockSetRlsContext).toHaveBeenCalledTimes(1);
    expect(mockSetRlsContext.mock.calls[0][1]).toBe(EMPLOYER_SUB);
    expect(statements.slice(0, 3)).toEqual(['BEGIN', 'SET CALLER', 'SELECT id FROM users WHERE cognito_sub = $1']);
    expect(statements.slice(3, 5).map((s) => s.split(' FROM ')[1]?.split(' ')[0])).toEqual([
      'user_tutorial_progress', 'user_tutorial_settings',
    ]);
    expect(statements.slice(5)).toEqual(['COMMIT']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('answers 404 not_found when the caller has no users row', async () => {
    users.delete(EMPLOYER_SUB);

    const res = await handler(makeEvent());

    expect(parsed(res)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(statements.some((s) => s.includes('user_tutorial_progress'))).toBe(false);
    expect(statements.some((s) => s.includes('user_tutorial_settings'))).toBe(false);
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
    ['the employer app tour on the employer path', () => makeEvent({ method: 'POST', body: { tutorial_id: 'employer_app_tour', outcome: 'skipped' } }), EMPLOYER_USER_ID],
    ['the worker app tour on the worker path', () => workerEvent({ method: 'POST', body: { tutorial_id: 'worker_app_tour', outcome: 'skipped' } }), WORKER_USER_ID],
  ])('records %s like a tutorial, first outcome kept', async (_name, event, userId) => {
    const first = parsed(await handler(event()));
    const tourId = first.body.tutorial?.tutorial_id;

    expect(first).toEqual({
      status: 200,
      body: { tutorial: { tutorial_id: expect.stringMatching(/_app_tour$/), outcome: 'skipped', recorded_at: '2026-10-22T15:00:01.000Z' } },
    });
    const completed = await handler({ ...event(), body: JSON.stringify({ tutorial_id: tourId, outcome: 'completed' }) });
    expect(parsed(completed)).toEqual(first);
    expect(stored).toEqual([{ user_id: userId, tutorial_id: tourId, outcome: 'skipped', recorded_at: new Date('2026-10-22T15:00:01.000Z') }]);
  });

  it.each([
    ['the worker app tour on the employer path', makeEvent({ method: 'POST', body: { tutorial_id: 'worker_app_tour', outcome: 'completed' } })],
    ['the employer app tour on the worker path', workerEvent({ method: 'POST', body: { tutorial_id: 'employer_app_tour', outcome: 'completed' } })],
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

describe('PATCH guide settings (K1-v2)', () => {
  const patch = (body: unknown) => makeEvent({ method: 'PATCH', body });
  const workerPatch = (body: unknown) => workerEvent({ method: 'PATCH', body });

  it('saves always_show alone, starting from the defaults, and answers the stored settings', async () => {
    const res = await handler(patch({ always_show: true }));

    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({ status: 200, body: { settings: { always_show: true, muted: [] } } });
    expect(settings.get(EMPLOYER_USER_ID)).toEqual({ always_show: true, muted: [] });
    expect(statements[statements.length - 1]).toBe('COMMIT');
  });

  it('sends a field that is absent as NULL, so the stored value is kept', async () => {
    settings.set(EMPLOYER_USER_ID, { always_show: true, muted: ['employer_welcome'] });

    expect(parsed(await handler(patch({ muted: ['employer_messages'] })))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: ['employer_messages'] } },
    });
    expect(parsed(await handler(patch({ always_show: false })))).toEqual({
      status: 200, body: { settings: { always_show: false, muted: ['employer_messages'] } },
    });
    const upserts = mockQuery.mock.calls.filter(([sql]) => /^\s*INSERT INTO user_tutorial_settings/.test(sql));
    expect(upserts.map(([, params]) => params)).toEqual([
      [EMPLOYER_USER_ID, null, ['employer_messages']],
      [EMPLOYER_USER_ID, false, null],
    ]);
  });

  it('saves muted alone, and both fields together', async () => {
    expect(parsed(await handler(workerPatch({ muted: ['worker_details'] })))).toEqual({
      status: 200, body: { settings: { always_show: false, muted: ['worker_details'] } },
    });
    expect(parsed(await handler(workerPatch({ always_show: true, muted: ['worker_apply', 'worker_profile'] })))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: ['worker_apply', 'worker_profile'] } },
    });
    expect(settings.get(WORKER_USER_ID)).toEqual({ always_show: true, muted: ['worker_apply', 'worker_profile'] });
    expect(settings.has(EMPLOYER_USER_ID)).toBe(false);
  });

  it("replaces the stored list: an empty muted clears it, sent as an empty array, not NULL", async () => {
    settings.set(EMPLOYER_USER_ID, { always_show: true, muted: ['employer_welcome', 'employer_post_job'] });

    expect(parsed(await handler(patch({ muted: [] })))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: [] } },
    });
    const upsert = mockQuery.mock.calls.find(([sql]) => /^\s*INSERT INTO user_tutorial_settings/.test(sql));
    expect(upsert?.[1]).toEqual([EMPLOYER_USER_ID, null, []]);
  });

  it("de-duplicates muted and stores it in the role's list order", async () => {
    const res = await handler(patch({ muted: ['employer_messages', 'employer_welcome', 'employer_messages', 'employer_welcome'] }));

    expect(parsed(res)).toEqual({ status: 200, body: { settings: { always_show: false, muted: ['employer_welcome', 'employer_messages'] } } });
    expect(settings.get(EMPLOYER_USER_ID)?.muted).toEqual(['employer_welcome', 'employer_messages']);
  });

  it('ignores unknown fields', async () => {
    expect(parsed(await handler(patch({ always_show: true, theme: 'dark' })))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: [] } },
    });
  });

  it("answers the stored row filtered like GET, when an earlier list holds ids this role no longer lists", async () => {
    settings.set(EMPLOYER_USER_ID, { always_show: false, muted: ['employer_retired_guide', 'employer_post_job'] });

    expect(parsed(await handler(patch({ always_show: true })))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: ['employer_post_job'] } },
    });
  });

  it.each([
    ['the employer app tour in muted', patch({ muted: ['employer_app_tour'] })],
    ['the worker app tour in muted on the worker path', workerPatch({ muted: ['worker_app_tour'] })],
    ['a worker id on the employer path', patch({ muted: ['employer_welcome', 'worker_apply'] })],
    ['an employer id on the worker path', workerPatch({ muted: ['employer_welcome'] })],
    ['an unknown id', patch({ muted: ['employer_billing'] })],
    ['muted as a string', patch({ muted: 'employer_welcome' })],
    ['muted as an object', patch({ muted: { 0: 'employer_welcome' } })],
    ['muted as null', patch({ muted: null })],
    ['a number in muted', patch({ muted: ['employer_welcome', 7] })],
    ['null in muted', patch({ muted: [null] })],
    ['a nested array in muted', patch({ muted: [['employer_welcome']] })],
    ['always_show as a string', patch({ always_show: 'true' })],
    ['always_show as a number', patch({ always_show: 1 })],
    ['always_show as null', patch({ always_show: null })],
    ['a valid always_show with an invalid muted', patch({ always_show: true, muted: ['worker_apply'] })],
    ['an empty object', patch({})],
    ['only unknown fields', patch({ theme: 'dark' })],
    ['an empty body', patch('')],
    ['a body that is not JSON', patch('always_show=true')],
    ['a truncated JSON body', patch('{"always_show": tru')],
    ['a JSON array', patch(JSON.stringify([{ always_show: true }]))],
    ['a JSON string', patch(JSON.stringify('always_show'))],
    ['JSON true', patch('true')],
    ['JSON null', patch('null')],
  ])('answers 400 invalid_settings for %s and touches no database', async (_name, event) => {
    expect(parsed(await handler(event))).toEqual({ status: 400, body: { error: 'invalid_settings' } });
    expect(settings.size).toBe(0);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('answers 400 invalid_settings for no body at all', async () => {
    const event = makeEvent({ method: 'PATCH' });
    expect(event.body).toBeNull();
    expect(parsed(await handler(event))).toEqual({ status: 400, body: { error: 'invalid_settings' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  /** A valid settings patch padded with an ignored field to exactly `bytes` bytes of UTF-8. */
  function paddedSettings(bytes: number, pad = 'x'): string {
    const base = { always_show: true, note: '' };
    const filler = bytes - Buffer.byteLength(JSON.stringify(base), 'utf8');
    const width = Buffer.byteLength(pad, 'utf8');
    const body = JSON.stringify({ ...base, note: pad.repeat(Math.floor(filler / width)) + 'x'.repeat(filler % width) });
    expect(Buffer.byteLength(body, 'utf8')).toBe(bytes);
    return body;
  }

  it('accepts a body of exactly 1 KiB', async () => {
    expect(parsed(await handler(patch(paddedSettings(1024))))).toEqual({
      status: 200, body: { settings: { always_show: true, muted: [] } },
    });
  });

  it('answers 400 invalid_settings for a body over 1 KiB, counted in bytes', async () => {
    expect(parsed(await handler(patch(paddedSettings(1025))))).toEqual({ status: 400, body: { error: 'invalid_settings' } });
    const wide = paddedSettings(1026, '€');
    expect(wide.length).toBeLessThan(1024);
    expect(parsed(await handler(patch(wide)))).toEqual({ status: 400, body: { error: 'invalid_settings' } });
    expect(settings.size).toBe(0);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('answers 404 not_found when the caller has no users row, and writes nothing', async () => {
    users.delete(EMPLOYER_SUB);

    expect(parsed(await handler(patch({ always_show: true })))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(settings.size).toBe(0);
    expect(statements.some((s) => s.includes('user_tutorial_settings'))).toBe(false);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('sets the caller context inside the transaction before the upsert, and commits', async () => {
    await handler(workerPatch({ always_show: true }));

    expect(mockSetRlsContext.mock.calls[0][1]).toBe(WORKER_SUB);
    expect(statements.slice(0, 3)).toEqual(['BEGIN', 'SET CALLER', 'SELECT id FROM users WHERE cognito_sub = $1']);
    expect(statements[3]).toMatch(/^INSERT INTO user_tutorial_settings /);
    expect(statements.slice(4)).toEqual(['COMMIT']);
  });

  it('answers 500 internal_error, rolls back and releases when the upsert fails', async () => {
    failOn = /^INSERT INTO user_tutorial_settings/;

    const res = await handler(patch({ always_show: true }));

    expect(res.headers).toEqual(corsHeaders());
    expect(parsed(res)).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('requests the handler refuses before the database', () => {
  it.each([
    ['GET', makeEvent({ sub: null })],
    ['POST', makeEvent({ sub: null, method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } })],
    ['GET with an empty sub', makeEvent({ sub: '' })],
    ['PATCH', makeEvent({ sub: null, method: 'PATCH', body: { always_show: true } })],
  ])('answers 401 unauthorized when the caller has no sub (%s)', async (_name, event) => {
    expect(parsed(await handler(event))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each(['/tutorials', '/employer/tutorials/extra', '/admin/tutorials'])('answers 404 not_found on %s', async (resource) => {
    expect(parsed(await handler(makeEvent({ resource })))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each(['DELETE', 'PUT'])('answers 405 method_not_allowed for any other method (%s)', async (method) => {
    const res = await handler(makeEvent({ method, body: { always_show: true } }));
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

  it('writes one TutorialProgress line per request with role, method and outcome code, and never the sub or the settings', async () => {
    await handler(makeEvent());
    await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'completed' } }));
    await handler(makeEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'skipped' } }));
    await handler(workerEvent({ method: 'POST', body: { tutorial_id: 'employer_welcome', outcome: 'skipped' } }));
    await handler(makeEvent({ sub: null }));
    users.delete(WORKER_SUB);
    await handler(workerEvent());
    await handler(makeEvent({ method: 'PATCH', body: { always_show: true, muted: ['employer_welcome'] } }));
    await handler(makeEvent({ method: 'PATCH', body: { muted: ['employer_app_tour'] } }));
    await handler(workerEvent({ method: 'PATCH', body: { always_show: true } }));
    await handler(makeEvent({ method: 'PUT' }));
    failOn = /^SELECT id FROM users/;
    await handler(makeEvent());
    failOn = /^INSERT INTO user_tutorial_settings/;
    await handler(makeEvent({ method: 'PATCH', body: { always_show: false } }));

    expect(progressLines()).toEqual([
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'read' },
      { event: 'TutorialProgress', role: 'employer', method: 'POST', outcome: 'recorded' },
      { event: 'TutorialProgress', role: 'employer', method: 'POST', outcome: 'already_recorded' },
      { event: 'TutorialProgress', role: 'worker', method: 'POST', outcome: 'invalid_tutorial' },
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'unauthorized' },
      { event: 'TutorialProgress', role: 'worker', method: 'GET', outcome: 'not_found' },
      { event: 'TutorialProgress', role: 'employer', method: 'PATCH', outcome: 'settings_saved' },
      { event: 'TutorialProgress', role: 'employer', method: 'PATCH', outcome: 'invalid_settings' },
      { event: 'TutorialProgress', role: 'worker', method: 'PATCH', outcome: 'not_found' },
      { event: 'TutorialProgress', role: 'employer', method: 'PUT', outcome: 'method_not_allowed' },
      { event: 'TutorialProgress', role: 'employer', method: 'GET', outcome: 'internal_error', error: 'connection lost' },
      { event: 'TutorialProgress', role: 'employer', method: 'PATCH', outcome: 'internal_error', error: 'connection lost' },
    ]);
    const all = loggedLines().join('\n');
    expect(all).not.toContain(EMPLOYER_SUB);
    expect(all).not.toContain(WORKER_SUB);
    expect(all).not.toContain('employer_welcome');
  });
});

// K1.1 and K1-v2: the backend keeps the same four id lists as the frontend
// client (two tutorial lists, two tour lists). The client module cannot be
// imported across the package boundary, so its text is read and the array
// literals compared.
describe('the id lists match the frontend client (contracts K1.1 and K1-v2)', () => {
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

  it('lists the same employer and worker tour ids, one per role', () => {
    const source = fs.readFileSync(clientPath, 'utf8');
    const backend = tutorialProgress as unknown as Record<string, unknown>;
    const employer = listIn(source, 'EMPLOYER_TOUR_IDS');
    const worker = listIn(source, 'WORKER_TOUR_IDS');

    expect(employer).toEqual(['employer_app_tour']);
    expect(worker).toEqual(['worker_app_tour']);
    expect(backend.EMPLOYER_TOUR_IDS).toEqual(employer);
    expect(backend.WORKER_TOUR_IDS).toEqual(worker);
  });
});
