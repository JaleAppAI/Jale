import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-digest-settings';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const EMPLOYER_ID = '11111111-2222-4333-8444-555555555555';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    requestContext: { authorizer: { claims: { sub: 'emp-sub' } } },
    body: null,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function patchEvent(body: unknown): APIGatewayProxyEvent {
  return makeEvent({ httpMethod: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Routes the handler's statements. `settingsRow` is the row the SELECT/upsert
 * returns; null means "no row for this employer yet".
 */
function configureDb(options: {
  employerId?: string | null;
  settingsRow?: Record<string, unknown> | null;
  upsertRow?: Record<string, unknown> | null;
  upsertError?: unknown;
} = {}): void {
  const employerId = options.employerId === undefined ? EMPLOYER_ID : options.employerId;
  mockQuery.mockImplementation((sql: string) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (/FROM users\b/.test(text)) {
      return Promise.resolve({ rows: employerId ? [{ id: employerId }] : [], rowCount: employerId ? 1 : 0 });
    }
    if (text.includes('INSERT INTO employer_digest_settings')) {
      if (options.upsertError) return Promise.reject(options.upsertError);
      return Promise.resolve({ rows: options.upsertRow ? [options.upsertRow] : [], rowCount: 1 });
    }
    if (text.includes('FROM employer_digest_settings')) {
      const row = options.settingsRow ?? null;
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('employer-digest-settings', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    configureDb();
  });
  afterAll(() => { process.env = env; });

  // ── Auth and compliance preamble ─────────────────────────────────────────

  it('returns 401 with no Cognito sub', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as never));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 409 user_not_provisioned when the user row is missing', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: false });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
  });

  it('returns 403 legal_required when the ToS version is stale', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'legal_required', requiredVersion: 'v1.0' });
  });

  it('returns 409 when the users row cannot be resolved to an employer id', async () => {
    configureDb({ employerId: null });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
  });

  it('sets the cognito-sub RLS context then the internal-id one', async () => {
    await handler(makeEvent());
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'emp-sub');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);
  });

  it('always releases the connection', async () => {
    await handler(makeEvent());
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  // ── GET ───────────────────────────────────────────────────────────────────

  it('GET returns the four documented fields for an existing row', async () => {
    configureDb({
      settingsRow: { enabled: true, send_hour_local: 17, timezone: 'America/New_York', language: 'es' },
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      enabled: true,
      send_hour_local: 17,
      timezone: 'America/New_York',
      language: 'es',
    });
  });

  it('GET returns the opt-out defaults when no row exists — and creates nothing', async () => {
    configureDb({ settingsRow: null });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      enabled: false,
      send_hour_local: 8,
      timezone: 'America/Chicago',
      language: 'en',
    });
    // migration 082 is explicit that creating a settings row must never by
    // itself start sending mail: the read path must not write at all.
    const statements = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes('INSERT INTO employer_digest_settings'))).toBe(false);
  });

  it('GET does not take a row lock', async () => {
    await handler(makeEvent());
    const userSelect = mockQuery.mock.calls.find((c) => /FROM users\b/.test(String(c[0])));
    expect(String(userSelect![0])).not.toContain('FOR UPDATE');
  });

  // ── PATCH: subsets ───────────────────────────────────────────────────────

  it('PATCH is the write verb — PUT is not in corsHeaders Allow-Methods', async () => {
    const res = await handler(makeEvent({ httpMethod: 'PUT', body: '{}' }));
    expect(res.statusCode).toBe(405);
    expect(res.headers!['Access-Control-Allow-Methods']).toBe('GET,POST,PATCH,DELETE,OPTIONS');
  });

  it('PATCH locks the employer row before upserting', async () => {
    configureDb({ upsertRow: { enabled: true, send_hour_local: 8, timezone: 'America/Chicago', language: 'en' } });
    await handler(patchEvent({ enabled: true }));
    const userSelect = mockQuery.mock.calls.find((c) => /FROM users\b/.test(String(c[0])));
    expect(String(userSelect![0])).toContain('FOR UPDATE');
  });

  it('PATCH echoes the full stored row, not the request', async () => {
    configureDb({
      upsertRow: { enabled: true, send_hour_local: 6, timezone: 'America/Denver', language: 'es' },
    });
    const res = await handler(patchEvent({ enabled: true }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      enabled: true,
      send_hour_local: 6,
      timezone: 'America/Denver',
      language: 'es',
    });
  });

  it.each([
    ['enabled only', { enabled: true }, [true, null, null, null]],
    ['hour only', { send_hour_local: 0 }, [null, 0, null, null]],
    ['hour 23', { send_hour_local: 23 }, [null, 23, null, null]],
    ['timezone only', { timezone: 'Europe/Madrid' }, [null, null, 'Europe/Madrid', null]],
    ['language only', { language: 'es' }, [null, null, null, 'es']],
    ['all four', { enabled: false, send_hour_local: 9, timezone: 'UTC', language: 'en' },
      [false, 9, 'UTC', 'en']],
    ['empty object', {}, [null, null, null, null]],
  ])('PATCH %s sends null for every omitted field so the stored value survives', async (_label, body, expected) => {
    configureDb({ upsertRow: { enabled: false, send_hour_local: 8, timezone: 'America/Chicago', language: 'en' } });
    const res = await handler(patchEvent(body));
    expect(res.statusCode).toBe(200);
    const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_digest_settings'));
    expect(upsert![1]).toEqual([EMPLOYER_ID, ...expected]);
    // Omitted columns must be preserved by COALESCE against the existing row,
    // never reset to the table default on the update path.
    const sql = String(upsert![0]);
    expect(sql).toContain('ON CONFLICT (employer_id) DO UPDATE');
    for (const column of ['enabled', 'send_hour_local', 'timezone', 'language']) {
      expect(sql).toMatch(new RegExp(`${column}\\s*=\\s*COALESCE\\(\\$\\d(?:::\\w+)?,\\s*employer_digest_settings\\.${column}\\)`));
    }
  });

  it('PATCH trims a padded timezone before it reaches the shape CHECK', async () => {
    configureDb({ upsertRow: { enabled: false, send_hour_local: 8, timezone: 'Europe/Madrid', language: 'en' } });
    await handler(patchEvent({ timezone: '  Europe/Madrid  ' }));
    const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_digest_settings'));
    expect(upsert![1]![3]).toBe('Europe/Madrid');
  });

  it('PATCH accepts UTC — the shape regex must not gate on Intl.supportedValuesOf', async () => {
    configureDb({ upsertRow: { enabled: false, send_hour_local: 8, timezone: 'UTC', language: 'en' } });
    const res = await handler(patchEvent({ timezone: 'UTC' }));
    expect(res.statusCode).toBe(200);
  });

  // ── PATCH: validation ─────────────────────────────────────────────────────

  it('PATCH rejects malformed JSON', async () => {
    const res = await handler(makeEvent({ httpMethod: 'PATCH', body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    -1, 24, 25, 1.5, '8', null, true, Number.NaN,
  ])('PATCH rejects send_hour_local %p with invalid_hour before opening a transaction', async (hour) => {
    const res = await handler(patchEvent({ send_hour_local: hour }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_hour');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['fr', 'EN', '', 'en-US', 1, null, true])(
    'PATCH rejects language %p with invalid_language',
    async (language) => {
      const res = await handler(patchEvent({ language }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_language');
    },
  );

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['hostile text', "America/Chicago'; DROP TABLE users --"],
    ['too many segments', 'a/b/c/d'],
    ['illegal character', 'America/Chicago;'],
    ['over 64 chars', `America/${'x'.repeat(70)}`],
    ['non-string', 42],
    ['null', null],
  ])('PATCH rejects a %s timezone with invalid_timezone (shape regex, before the DB)', async (_label, timezone) => {
    const res = await handler(patchEvent({ timezone }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_timezone');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('PATCH rejects a non-boolean enabled', async () => {
    for (const bad of ['true', 1, null, {}]) {
      const res = await handler(patchEvent({ enabled: bad }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_enabled');
    }
  });

  // ── PATCH: the DB is the authoritative IANA validator ────────────────────

  it.each(['timezone_iana_valid', 'employer_digest_settings_timezone_shape'])(
    'maps a 23514 on %s to 400 invalid_timezone instead of a 500',
    async (constraint) => {
      // The shape regex passes 'Zzz/Not_A_Zone' -- only pg_timezone_names can
      // say otherwise, and it does so through the migration's BEFORE trigger.
      configureDb({ upsertError: Object.assign(new Error('invalid IANA time zone'), { code: '23514', constraint }) });
      const res = await handler(patchEvent({ timezone: 'Zzz/Not_A_Zone' }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_timezone');
      expect(mockQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    },
  );

  it('does not swallow an unrelated 23514 as invalid_timezone', async () => {
    configureDb({ upsertError: Object.assign(new Error('nope'), { code: '23514', constraint: 'some_other_check' }) });
    const res = await handler(patchEvent({ send_hour_local: 8 }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
  });

  it('rolls back and returns 500 on an unexpected database failure', async () => {
    configureDb({ upsertError: new Error('connection reset') });
    const res = await handler(patchEvent({ enabled: true }));
    expect(res.statusCode).toBe(500);
    expect(mockQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the upsert returns no row', async () => {
    configureDb({ upsertRow: null });
    const res = await handler(patchEvent({ enabled: true }));
    expect(res.statusCode).toBe(500);
  });

  // ── CORS ──────────────────────────────────────────────────────────────────

  it('returns CORS headers on success and on failure', async () => {
    const ok = await handler(makeEvent());
    expect(ok.headers).toHaveProperty('Access-Control-Allow-Origin');
    const bad = await handler(patchEvent({ language: 'fr' }));
    expect(bad.headers).toHaveProperty('Access-Control-Allow-Origin');
  });

  // ── Unsubscribe token revocation (sprint 22 R3-E) ────────────────────────

  /**
   * The counter is the ONLY revocation mechanism an unsubscribe link has --
   * lib/unsubscribe-token.ts embeds no expiry on purpose. Re-enabling the
   * digest has to kill every link mailed during the previous ON period, or a
   * mail client prefetching one silently undoes the change the employer just
   * made. The shape of the bump is proved against a real database in
   * test/unit/db/email-outbox-088.integration.test.ts; this pins that the
   * handler still sends the statement that does it.
   */
  it('bumps unsubscribe_token_version only on the false -> true transition', async () => {
    configureDb({ upsertRow: { enabled: true, send_hour_local: 8, timezone: 'America/Chicago', language: 'en' } });
    await handler(patchEvent({ enabled: true }));

    const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_digest_settings'));
    const sql = String(upsert![0]);
    expect(sql).toContain('unsubscribe_token_version = CASE');
    // The guard is "the new value is on AND the stored value was off".
    expect(sql).toContain('WHEN COALESCE($2::boolean, employer_digest_settings.enabled)');
    expect(sql).toContain('AND NOT employer_digest_settings.enabled');
    expect(sql).toContain('THEN LEAST(employer_digest_settings.unsubscribe_token_version + 1, 32767)');
    expect(sql).toContain('ELSE employer_digest_settings.unsubscribe_token_version');
  });

  it('never writes the token version outside that one CASE, and never on the GET path', async () => {
    configureDb({ settingsRow: { enabled: true, send_hour_local: 8, timezone: 'America/Chicago', language: 'en' } });
    await handler(makeEvent());
    expect(mockQuery.mock.calls.map((c) => String(c[0])).join('\n'))
      .not.toContain('unsubscribe_token_version');
  });
});
