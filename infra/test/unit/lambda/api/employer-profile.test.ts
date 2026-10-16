import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-profile';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';
import { corsHeaders } from '../../../../lambda/lib/http';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

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
      return Promise.resolve({});
    });

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(mockUser);
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
      if (queryText.includes('SELECT id FROM users WHERE cognito_sub')) {
        return Promise.resolve({ rows: [{ id: 'usr-123' }] });
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
    expect(JSON.parse(response.body)).toEqual(updated);
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE users SET full_name = $1, phone = COALESCE($2, phone) WHERE cognito_sub = $3',
      ['Acme Builders', '+15551234567', 'test-user-sub'],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO employer_profiles'),
      [
        'test-user-sub',
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
        if (queryText.includes('SELECT id FROM users WHERE cognito_sub')) return Promise.resolve({ rows: [{ id: 'usr-123' }] });
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
        if (queryText.includes('SELECT id FROM users WHERE cognito_sub')) return Promise.resolve({ rows: [{ id: 'usr-123' }] });
        if (queryText.includes('LEFT JOIN employer_profiles')) return Promise.resolve({ rows: [{ id: 'usr-123', company_name: 'Fixture Co' }] });
        if (queryText === RECORD) return Promise.reject(Object.assign(new Error('no such function'), { code: '42883' }));
        return Promise.resolve({});
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await handler(patch({ company_name: 'Fixture Co', signup_source: { src: null, entry: 'signup_page' } }));
      warnSpy.mockRestore();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: 'usr-123', company_name: 'Fixture Co' });
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
        if (queryText.includes('SELECT id FROM users WHERE cognito_sub')) return Promise.resolve({ rows: [{ id: 'usr-123' }] });
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
});
