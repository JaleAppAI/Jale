import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-profile';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';
import { corsHeaders } from '../../../../lambda/lib/http';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
// Equal to the users.id the existing assertions already expect.
const EMPLOYER_ID = 'usr-123';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerActor = (scopeUserIds: string[] = [EMPLOYER_ID]) => ({
  ok: true,
  actor: { userId: EMPLOYER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds },
});

describe('Employer Profile API Lambda', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      }),
    });
    mockResolveEmployerActor.mockResolvedValue(ownerActor());
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const mockEvent = {
    httpMethod: 'GET',
    requestContext: {
      authorizer: {
        claims: {
          sub: 'test-user-sub',
        },
      },
    },
  } as unknown as APIGatewayProxyEvent;

  it('should return 409 if user row does not exist (post-confirmation sync failed)', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      currentVersion: null,
      userExists: false,
    });
    mockQuery.mockResolvedValue({});

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: 'user_not_provisioned',
      message: 'Account setup incomplete. Please try signing out and back in.',
    });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 403 if legal compliance is not met', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      currentVersion: 'v0.9',
      userExists: true,
    });
    mockQuery.mockResolvedValue({});

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(403);
    expect(response.headers).toEqual(corsHeaders());
    expect(JSON.parse(response.body)).toEqual({
      error: 'legal_required',
      requiredVersion: 'v1.0',
      currentVersion: 'v0.9',
    });
    
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'test-user-sub');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT'); // Commit after blocking
    expect(mockRelease).toHaveBeenCalled();

    // Verify RLS setup order: BEGIN → setRlsContext → checkCompliance → COMMIT
    expect(mockQuery.mock.calls[0]).toEqual(['BEGIN']);
    expect(mockQuery.mock.calls[1]).toEqual(['COMMIT']);
  });

  it('should return 404 if user profile is not found', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    // Simulate empty result for user query
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('LEFT JOIN employer_profiles')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({});
    });

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'profile_not_found',
      message: 'Please complete profile setup',
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 200 and user profile if successful', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const mockUser = {
      id: 'usr-123',
      user_type: 'employer',
      email: 'test@example.com',
      phone: '1234567890',
      full_name: 'Test Employer',
      tenant_id: 'tnt-123',
      created_at: new Date().toISOString(),
      company_name: 'Test Employer',
      contact_name: 'Test Contact',
      city: 'Austin',
      service_area: 'Austin metro',
      hiring_trades: ['carpenter'],
      typical_job_types: ['full-time'],
      company_size: '1-10',
      company_description: 'Builder'
    };
    
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('LEFT JOIN employer_profiles')) {
        return Promise.resolve({ rows: [mockUser] });
      }
      if (queryText.includes('FROM jale_cap.org_team_membership')) {
        return Promise.resolve({ rows: [{ role: 'owner', company_name: 'Test Employer' }] });
      }
      return Promise.resolve({});
    });

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ...mockUser, role: 'owner', companyName: 'Test Employer' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should upsert employer profile fields on PATCH and mirror company name to users.full_name', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const updated = {
      id: 'usr-123',
      user_type: 'employer',
      email: 'test@example.com',
      phone: '+15551234567',
      full_name: 'Acme Builders',
      tenant_id: null,
      created_at: 'ts',
      company_name: 'Acme Builders',
      contact_name: 'Ava Manager',
      city: 'Austin',
      service_area: 'Central Texas',
      hiring_trades: ['electrician', 'plumber'],
      typical_job_types: ['full-time', 'contract'],
      company_size: '11-50',
      company_description: 'Commercial contractor',
    };
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('LEFT JOIN employer_profiles')) {
        return Promise.resolve({ rows: [updated] });
      }
      if (queryText.includes('FROM jale_cap.org_team_membership')) {
        return Promise.resolve({ rows: [{ role: 'owner', company_name: 'Acme Builders' }] });
      }
      return Promise.resolve({});
    });

    const response = await handler({
      ...mockEvent,
      httpMethod: 'PATCH',
      body: JSON.stringify({
        company_name: 'Acme Builders',
        contact_name: 'Ava Manager',
        phone: '+15551234567',
        city: 'Austin',
        service_area: 'Central Texas',
        hiring_trades: ['electrician', 'plumber'],
        typical_job_types: ['full-time', 'contract'],
        company_size: '11-50',
        company_description: 'Commercial contractor',
      }),
    } as unknown as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    // The PATCH answers in the GET's shape: the frontend replaces its profile with it.
    expect(JSON.parse(response.body)).toEqual({ ...updated, role: 'owner', companyName: 'Acme Builders' });
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE users SET full_name = $1, phone = COALESCE($2, phone) WHERE cognito_sub = $3',
      ['Acme Builders', '+15551234567', 'test-user-sub'],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO employer_profiles'),
      [
        EMPLOYER_ID,
        'Acme Builders',
        'Ava Manager',
        '+15551234567',
        'Austin',
        'Central Texas',
        ['electrician', 'plumber'],
        ['full-time', 'contract'],
        '11-50',
        'Commercial contractor',
        true,
        true,
      ],
    );
  });

  it('should reject invalid employer profile values before writing profile rows', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockResolvedValue({});

    const response = await handler({
      ...mockEvent,
      httpMethod: 'PATCH',
      body: JSON.stringify({ hiring_trades: ['roofer'] }),
    } as unknown as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid_hiring_trades');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_profiles'), expect.anything());
  });

  it('should return 500 on internal errors and rollback', async () => {
    mockCheckCompliance.mockRejectedValue(new Error('DB failure'));

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
    });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  test('should return 401 if cognitoSub is missing from authorizer claims', async () => {
    const event = {
      requestContext: { authorizer: { claims: {} } },
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'unauthorized' });
  });

  // ── Sprint 28 (K3.6): where the employer's signup started ──────────────
  describe('signup_source on the first profile save', () => {
    const RECORD = 'SELECT jale_cap.record_signup_source($1, $2, $3, $4)';
    const patch = (body: object) => ({ ...mockEvent, httpMethod: 'PATCH', body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;
    const statements = () => mockQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

    beforeEach(() => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: 'usr-123', company_name: 'Fixture Co' }] });
        return Promise.resolve({});
      });
    });

    it('records the source once with door web, after the profile write and before the commit', async () => {
      const res = await handler(patch({ company_name: 'Fixture Co', signup_source: { src: 'flyer', entry: 'signup_page' } }));

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(RECORD, ['usr-123', 'web', 'signup_page', 'flyer']);
      const s = statements();
      const iProfile = s.findIndex((q) => q.startsWith('INSERT INTO employer_profiles'));
      const iRecord = s.indexOf(RECORD);
      expect(iProfile).toBeGreaterThan(-1);
      expect(s.slice(iRecord - 1, iRecord + 2)).toEqual(['SAVEPOINT analytics_capture', RECORD, 'RELEASE SAVEPOINT analytics_capture']);
      expect(iRecord).toBeGreaterThan(iProfile);
      expect(s.lastIndexOf('COMMIT')).toBeGreaterThan(iRecord);
    });

    it('records nothing when the request carries no valid source', async () => {
      await handler(patch({ company_name: 'Fixture Co' }));
      await handler(patch({ company_name: 'Fixture Co', signup_source: { src: 'flyer', entry: 'whatsapp' } }));
      await handler(patch({ company_name: 'Fixture Co', signup_source: 'flyer' }));
      expect(statements().filter((q) => q.includes('record_signup_source'))).toEqual([]);
    });

    it('a failing record never fails the save: the profile is returned and the transaction commits', async () => {
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: 'usr-123', company_name: 'Fixture Co' }] });
        if (queryText === RECORD) return Promise.reject(Object.assign(new Error('no such function'), { code: '42883' }));
        return Promise.resolve({});
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await handler(patch({ company_name: 'Fixture Co', signup_source: { src: null, entry: 'signup_page' } }));
      warnSpy.mockRestore();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: 'usr-123', company_name: 'Fixture Co', role: 'owner', companyName: null });
      const s = statements();
      expect(s).toContain('ROLLBACK TO SAVEPOINT analytics_capture');
      expect(s[s.length - 1]).toBe('COMMIT');
      expect(s).not.toContain('ROLLBACK');
    });
  });

  describe('change context', () => {
    const patch = (body: object) => ({ ...mockEvent, httpMethod: 'PATCH', body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

    beforeEach(() => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: 'usr-123' }] });
        return Promise.resolve({});
      });
    });

    it('states the employer before the profile writes', async () => {
      const res = await handler(withRequestId(patch({ company_name: 'Fixture Co' })));
      expect(res.statusCode).toBe(200);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }), callerFor('employer', 'usr-123'), 'employer.profile_update');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /^UPDATE users SET/);
    });

    it('states nothing on a read', async () => {
      await handler(mockEvent);
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });

  describe('organization actor (Phase 1)', () => {
    it('resolves the actor on GET after the compliance check', async () => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: EMPLOYER_ID }] });
        if (queryText.includes('FROM jale_cap.org_team_membership')) return Promise.resolve({ rows: [{ role: 'owner', company_name: 'Co' }] });
        return Promise.resolve({});
      });

      const response = await handler(mockEvent);

      expect(response.statusCode).toBe(200);
      expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'test-user-sub');
      expect(mockCheckCompliance.mock.invocationCallOrder[0])
        .toBeLessThan(mockResolveEmployerActor.mock.invocationCallOrder[0]);
    });

    it("keys the profile upsert on actor.userId (per person, never the owner's scope) and drops the sub lookup", async () => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: EMPLOYER_ID }] });
        return Promise.resolve({});
      });

      const response = await handler({ ...mockEvent, httpMethod: 'PATCH', body: JSON.stringify({ contact_name: 'Ava' }) } as unknown as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(200);
      const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_profiles'));
      expect(String(upsert![0])).not.toContain('cognito_sub');
      expect(upsert![1][0]).toBe(EMPLOYER_ID);
      expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('SELECT id FROM users WHERE cognito_sub'))).toBe(false);
    });

    it('returns the actor failure, commits, and reads no profile when the membership is inactive', async () => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
      mockQuery.mockResolvedValue({});

      const response = await handler(mockEvent);

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'membership_inactive' });
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('employer_profiles'))).toBe(false);
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });

  // ── Phase 3: company fields are the owner's ───────────────────────────
  describe('owner-only company profile (Phase 3)', () => {
    const FOREMAN_PHONE = '+15559876543';
    const foremanActor = { ok: true, actor: { userId: FOREMAN_ID, organizationId: ORG_ID, role: 'foreman', scopeUserIds: [FOREMAN_ID] } };
    const patch = (body: object) => ({ ...mockEvent, httpMethod: 'PATCH', body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;
    const statements = () => mockQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
    const writes = () => statements().filter((q) => /^(INSERT|UPDATE|DELETE)\b/.test(q) || q.includes('record_signup_source'));

    beforeEach(() => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: FOREMAN_ID }] });
        if (queryText.includes('FROM jale_cap.org_team_membership')) return Promise.resolve({ rows: [{ role: 'foreman', company_name: 'Gate Co' }] });
        return Promise.resolve({ rows: [] });
      });
    });

    it.each([
      ['company_name', 'Foreman Co'],
      ['company_description', 'We build'],
      ['service_area', 'Austin metro'],
      ['hiring_trades', ['plumber']],
      ['typical_job_types', ['contract']],
      ['company_size', '1-10'],
      ['city', 'Austin'],
      ['full_name', 'Ana Foreman'],
    ])('foreman PATCH with a company field (%s): 403 owner_required, nothing written', async (field, value) => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(patch({ contact_name: 'Ana', phone: FOREMAN_PHONE, [field]: value }));

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
      expect(writes()).toEqual([]);
      expect(setAuditContext).not.toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });

    it('foreman PATCH with a company field set to null is refused too', async () => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(patch({ contact_name: 'Ana', company_name: null }));

      expect(res.statusCode).toBe(403);
      expect(writes()).toEqual([]);
    });

    it('foreman PATCH contact_name and phone: written to their own row, users.full_name untouched', async () => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(withRequestId(patch({ contact_name: 'Ana Foreman', phone: FOREMAN_PHONE })));

      expect(res.statusCode).toBe(200);
      const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_profiles'));
      expect(upsert![1]).toEqual([
        FOREMAN_ID, null, 'Ana Foreman', FOREMAN_PHONE, null, null, [], [], null, null, false, false,
      ]);
      expect(writes().some((q) => q.includes('full_name'))).toBe(false);
      // Their own users row keeps their phone, as the owner's does.
      expect(mockQuery).toHaveBeenCalledWith('UPDATE users SET phone = $1 WHERE cognito_sub = $2', [FOREMAN_PHONE, 'test-user-sub']);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.anything(), callerFor('employer', FOREMAN_ID), 'employer.profile_update');
      expect(statements()[statements().length - 1]).toBe('COMMIT');
      // The PATCH answers in the GET's shape, with the company's name.
      expect(JSON.parse(res.body)).toEqual({ id: FOREMAN_ID, role: 'foreman', companyName: 'Gate Co' });
    });

    it('foreman PATCH contact_name only: every company column and phone is left as it is', async () => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(patch({ contact_name: 'Ana Foreman' }));

      expect(res.statusCode).toBe(200);
      const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_profiles'));
      // Every null is COALESCEd to the stored value; false keeps both arrays.
      expect(upsert![1]).toEqual([
        FOREMAN_ID, null, 'Ana Foreman', null, null, null, [], [], null, null, false, false,
      ]);
      expect(String(upsert![0])).toContain('company_name = COALESCE(EXCLUDED.company_name, employer_profiles.company_name)');
      expect(writes().filter((q) => q.startsWith('UPDATE users'))).toEqual([]);
    });

    describe('before migration 134 (org_team_membership missing)', () => {
      const missing = () => Promise.reject(Object.assign(new Error('function jale_cap.org_team_membership() does not exist'), { code: '42883' }));

      it('falls back to the actor and the own row under a savepoint, logs once, and still answers 200', async () => {
        mockResolveEmployerActor.mockResolvedValue(ownerActor());
        mockQuery.mockImplementation((queryText: string) => {
          if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: EMPLOYER_ID, company_name: 'Own Co' }] });
          if (queryText.includes('FROM jale_cap.org_team_membership')) return missing();
          return Promise.resolve({ rows: [] });
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const first = await handler(mockEvent);
        const second = await handler(patch({ contact_name: 'Olivia' }));
        const warned = warn.mock.calls.map(([line]) => String(line));
        warn.mockRestore();

        expect(first.statusCode).toBe(200);
        expect(JSON.parse(first.body)).toEqual({ id: EMPLOYER_ID, company_name: 'Own Co', role: 'owner', companyName: 'Own Co' });
        expect(second.statusCode).toBe(200);
        expect(JSON.parse(second.body)).toMatchObject({ role: 'owner', companyName: 'Own Co' });
        const s = statements();
        const read = s.indexOf('SELECT role, company_name FROM jale_cap.org_team_membership()');
        expect(s.slice(read - 1, read + 2)).toEqual([
          'SAVEPOINT org_team_membership',
          'SELECT role, company_name FROM jale_cap.org_team_membership()',
          'ROLLBACK TO SAVEPOINT org_team_membership',
        ]);
        expect(s[s.length - 1]).toBe('COMMIT');
        expect(s).not.toContain('ROLLBACK');
        expect(warned.filter((line) => line.includes('employer_profile_membership_fallback'))).toHaveLength(1);
      });

      it('a foreman falls back to no company name, never their own row\'s', async () => {
        mockResolveEmployerActor.mockResolvedValue(foremanActor);
        mockQuery.mockImplementation((queryText: string) => {
          if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: FOREMAN_ID, company_name: 'Stale Co' }] });
          if (queryText.includes('FROM jale_cap.org_team_membership')) return missing();
          return Promise.resolve({ rows: [] });
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await handler(mockEvent);
        warn.mockRestore();

        expect(JSON.parse(res.body)).toMatchObject({ role: 'foreman', companyName: null });
      });

      it('any other error is not swallowed: 500 and ROLLBACK', async () => {
        mockQuery.mockImplementation((queryText: string) => {
          if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: EMPLOYER_ID }] });
          if (queryText.includes('FROM jale_cap.org_team_membership')) return Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' }));
          return Promise.resolve({ rows: [] });
        });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await handler(mockEvent);
        error.mockRestore();

        expect(res.statusCode).toBe(500);
        expect(statements()).toContain('ROLLBACK');
        expect(statements()).not.toContain('COMMIT');
      });
    });

    // Review focus 7: a foreman's first profile flush must never 403. A flush
    // from a build before invite mode carries signup_source; it is accepted
    // and ignored (a foreman's sign-up is not a company sign-up).
    it('foreman PATCH carrying signup_source: saved, the source ignored, never 403', async () => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(patch({
        contact_name: 'Ana Foreman', phone: FOREMAN_PHONE, signup_source: { src: 'flyer', entry: 'signup_page' },
      }));

      expect(res.statusCode).toBe(200);
      expect(statements().some((q) => q.startsWith('INSERT INTO employer_profiles'))).toBe(true);
      expect(statements().some((q) => q.includes('record_signup_source'))).toBe(false);
    });

    it('owner PATCH unchanged', async () => {
      mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));

      const res = await handler(patch({
        company_name: 'Gate Co',
        contact_name: 'Olivia Owner',
        phone: '+15551234567',
        city: 'Austin',
        service_area: 'Central Texas',
        hiring_trades: ['plumber'],
        typical_job_types: ['contract'],
        company_size: '11-50',
        company_description: 'Builder',
        signup_source: { src: 'flyer', entry: 'signup_page' },
      }));

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE users SET full_name = $1, phone = COALESCE($2, phone) WHERE cognito_sub = $3',
        ['Gate Co', '+15551234567', 'test-user-sub'],
      );
      const upsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO employer_profiles'));
      expect(upsert![1]).toEqual([
        EMPLOYER_ID, 'Gate Co', 'Olivia Owner', '+15551234567', 'Austin', 'Central Texas',
        ['plumber'], ['contract'], '11-50', 'Builder', true, true,
      ]);
      expect(mockQuery).toHaveBeenCalledWith('SELECT jale_cap.record_signup_source($1, $2, $3, $4)', [EMPLOYER_ID, 'web', 'signup_page', 'flyer']);
    });

    it('GET returns role and companyName', async () => {
      mockResolveEmployerActor.mockResolvedValue(foremanActor);

      const res = await handler(mockEvent);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: FOREMAN_ID, role: 'foreman', companyName: 'Gate Co' });
      expect(statements()).toContain('SELECT role, company_name FROM jale_cap.org_team_membership()');
      expect(writes()).toEqual([]);
    });

    it('GET for an owner returns role owner and the company name', async () => {
      mockQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: EMPLOYER_ID }] });
        if (queryText.includes('FROM jale_cap.org_team_membership')) return Promise.resolve({ rows: [{ role: 'owner', company_name: 'Gate Co' }] });
        return Promise.resolve({ rows: [] });
      });

      const res = await handler(mockEvent);

      expect(JSON.parse(res.body)).toEqual({ id: EMPLOYER_ID, role: 'owner', companyName: 'Gate Co' });
    });
  });
});
