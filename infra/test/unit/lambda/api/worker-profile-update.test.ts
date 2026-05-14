import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-profile-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { setWorkerCoordinates } from '../../../../lambda/lib/location';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/location');
jest.mock('../../../../lambda/legal/check-compliance');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetWorkerCoordinates = setWorkerCoordinates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (body: any) => ({
  requestContext: { authorizer: { claims: { sub: 'w' } } },
  body: JSON.stringify(body),
  httpMethod: 'PATCH',
} as unknown as APIGatewayProxyEvent);

describe('worker-profile-update', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetWorkerCoordinates.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid availability', async () => {
    const res = await handler(mkEv({ availability: 'immediate' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid WhatsApp-compatible profile fields before writing', async () => {
    const trade = await handler(mkEv({ main_trade: 'roofer' }));
    const experience = await handler(mkEv({ years_experience: '11-20' }));
    const transport = await handler(mkEv({ has_transportation: 'yes' }));

    expect(trade.statusCode).toBe(400);
    expect(experience.statusCode).toBe(400);
    expect(transport.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('requires main_trade_other when main_trade is other', async () => {
    const res = await handler(mkEv({ main_trade: 'other' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('main_trade_other_required');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('accepts canonical database availability values', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: 'full_time', years_experience: 3, location: 'TX', bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ availability: 'full_time', years_experience: 3, location: 'TX' }));

    expect(res.statusCode).toBe(200);
  });

  it('writes WhatsApp-compatible fields to users and display fields to worker_profiles', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: 'full_time', years_experience: 7, location: 'Austin', bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({
      full_name: 'Ana Worker',
      city: 'Austin',
      main_trade: 'painting',
      years_experience: '5-9',
      has_transportation: true,
      availability: 'full_time',
    }));

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET'),
      ['Ana Worker', 'Austin', 'painting', null, '5-9', true, 'full_time', 'w'],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO worker_profiles'),
      ['w', 'full_time', 7, 'Austin', null],
    );
  });

  it('upserts worker_profiles without legacy skills and replaces worker_skills when provided', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE users')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: ['carpentry', 'welding'], availability: 'full_time', years_experience: 3, location: 'TX', bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({
      full_name: 'John',
      skills: [' Welding ', 'welding', 'CARPENTRY'],
      availability: 'full_time',
      years_experience: 3,
      location: 'TX',
    }));

    expect(res.statusCode).toBe(200);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('UPDATE users'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_profiles'))).toBe(true);
    const profileUpsert = calls.find((c: string) => c.includes('INSERT INTO worker_profiles')) as string;
    expect(profileUpsert).not.toMatch(/INSERT INTO worker_profiles\s*\(\s*user_id\s*,\s*skills/i);
    expect(profileUpsert).not.toContain('worker_profiles.skills');
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_skills'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_skills'))).toBe(true);
    const skillInsertCall = mockQuery.mock.calls.find(([q]) => String(q).includes('INSERT INTO worker_skills'));
    expect(skillInsertCall?.[1]).toEqual(['u', ['welding', 'carpentry']]);
  });

  it('preserves existing worker_skills when skills are omitted', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: ['existing'], availability: 'weekends', years_experience: null, location: null, bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ availability: 'weekends' }));

    expect(res.statusCode).toBe(200);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_skills'))).toBe(false);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_skills'))).toBe(false);
  });

  it('clears worker_skills when skills is an explicit empty array', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, location: null, bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ skills: [] }));

    expect(res.statusCode).toBe(200);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_skills'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_skills'))).toBe(false);
  });

  it('rejects blank and overlong skills before writing', async () => {
    const blank = await handler(mkEv({ skills: [' '] }));
    const overlong = await handler(mkEv({ skills: ['x'.repeat(101)] }));

    expect(blank.statusCode).toBe(400);
    expect(overlong.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects partial coordinate payloads before writing', async () => {
    const res = await handler(mkEv({ latitude: 39.961176 }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_coordinates');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects out-of-range coordinate payloads before writing', async () => {
    const res = await handler(mkEv({ latitude: 39.961176, longitude: -181 }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_longitude');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('sets worker map_pin coordinates after profile upsert when both coordinates are present', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, location: null, bio: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ latitude: 39.961176, longitude: -82.998794 }));

    expect(res.statusCode).toBe(200);
    expect(mockSetWorkerCoordinates).toHaveBeenCalledWith(expect.any(Object), 'u', 39.961176, -82.998794, 'map_pin');
  });
});
