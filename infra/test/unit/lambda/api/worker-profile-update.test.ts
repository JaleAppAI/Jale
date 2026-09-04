import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-profile-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { setWorkerCoordinates } from '../../../../lambda/lib/location';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { requestTradeAliasGeneration } from '../../../../lambda/lib/trade-alias-request';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/location');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/trade-alias-request');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetWorkerCoordinates = setWorkerCoordinates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockRequestTradeAliasGeneration = requestTradeAliasGeneration as jest.Mock;
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
    mockRequestTradeAliasGeneration.mockResolvedValue(undefined);
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
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: 'full_time', years_experience: 3, experience_months: 36, location: 'TX', bio: null, certifications: [] }] });
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
      ['w', 'full_time', 7, 84, 'Austin', null, null, false],
    );
  });

  it('upserts worker_profiles without legacy skills and replaces worker_skills when provided', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE users')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: ['carpentry', 'welding'], availability: 'full_time', years_experience: 3, experience_months: 36, location: 'TX', bio: null, certifications: [] }] });
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
        return Promise.resolve({ rows: [{ user_id: 'u', skills: ['existing'], availability: 'weekends', years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
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
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
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

  it('accepts and normalizes worker certifications', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: 18, location: null, bio: null, certifications: ['OSHA 10', 'Forklift'] }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ experience_months: 18, certifications: [' OSHA 10 ', 'OSHA 10', 'Forklift'] }));

    expect(res.statusCode).toBe(200);
    const profileUpsertCall = mockQuery.mock.calls.find(([q]) => String(q).includes('INSERT INTO worker_profiles'));
    expect(profileUpsertCall?.[1]).toEqual(['w', null, null, 18, null, null, ['OSHA 10', 'Forklift'], true]);
    expect(JSON.parse(res.body).certifications).toEqual(['OSHA 10', 'Forklift']);
  });

  it.each([
    ['non-array certifications', { certifications: 'OSHA 10' }],
    ['blank certification', { certifications: [' '] }],
    ['overlong certification', { certifications: ['x'.repeat(201)] }],
    ['too many certifications', { certifications: Array.from({ length: 21 }, (_, index) => `cert-${index}`) }],
    ['invalid experience months', { experience_months: 961 }],
  ])('rejects %s before writing', async (_caseName, body) => {
    const res = await handler(mkEv(body));

    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects numeric years_experience above the 80-year cap before writing', async () => {
    const res = await handler(mkEv({ years_experience: 81 }));

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('invalid_years_experience');
    expect(parsed.max).toBe(80);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('accepts numeric years_experience exactly at the 80-year cap', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: 'full_time', years_experience: 80, experience_months: 960, location: 'TX', bio: null, certifications: [] }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ availability: 'full_time', years_experience: 80, location: 'TX' }));

    expect(res.statusCode).toBe(200);
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

  it('sets worker coordinates after profile upsert when both coordinates are present', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('INSERT INTO worker_profiles')) {
        return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ latitude: 39.961176, longitude: -82.998794 }));

    expect(res.statusCode).toBe(200);
    expect(mockSetWorkerCoordinates).toHaveBeenCalledWith(expect.any(Object), 'u', 39.961176, -82.998794, 'geocoded_address');
  });

  describe('preferred cities and location source', () => {
    const okQuery = () => {
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('INSERT INTO worker_profiles')) {
          return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
        }
        return Promise.resolve({});
      });
    };

    it('replaces preferred cities in the same transaction', async () => {
      okQuery();

      const res = await handler(mkEv({
        preferred_cities: [
          { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' },
          { city_key: 'austin-tx', city: 'Austin', state: 'TX' },
        ],
      }));

      expect(res.statusCode).toBe(200);
      const deleteCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM worker_preferred_cities'));
      expect(deleteCall).toBeDefined();
      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_preferred_cities'));
      expect(insertCall).toBeDefined();
      expect(insertCall?.[1]).toEqual(['u', JSON.stringify([
        { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX', latitude: null, longitude: null },
        { city_key: 'austin-tx', city: 'Austin', state: 'TX', latitude: null, longitude: null },
      ])]);
      expect(JSON.parse(res.body).preferred_cities).toHaveLength(2);
    });

    it('leaves preferred cities untouched when the field is omitted', async () => {
      okQuery();

      const res = await handler(mkEv({ availability: 'full_time' }));

      expect(res.statusCode).toBe(200);
      const deleteCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM worker_preferred_cities'));
      expect(deleteCall).toBeUndefined();
    });

    it('clears preferred cities when an empty list is sent', async () => {
      okQuery();

      const res = await handler(mkEv({ preferred_cities: [] }));

      expect(res.statusCode).toBe(200);
      const deleteCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM worker_preferred_cities'));
      expect(deleteCall).toBeDefined();
      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_preferred_cities'));
      expect(insertCall).toBeUndefined();
    });

    it('rejects more than 10 preferred cities (400)', async () => {
      const many = Array.from({ length: 11 }, (_, i) => ({ city_key: `city-${i}-tx`, city: `City ${i}`, state: 'TX' }));

      const res = await handler(mkEv({ preferred_cities: many }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('too_many_preferred_cities');
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('rejects malformed preferred cities (400)', async () => {
      const res = await handler(mkEv({ preferred_cities: [{ city: 'El Paso' }] }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_preferred_cities');
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('records the client-supplied geocoded_zip source', async () => {
      okQuery();

      const res = await handler(mkEv({ location: 'El Paso, TX 79901', latitude: 31.76, longitude: -106.49, location_source: 'geocoded_zip' }));

      expect(res.statusCode).toBe(200);
      expect(mockSetWorkerCoordinates).toHaveBeenCalledWith(expect.anything(), expect.anything(), 31.76, -106.49, 'geocoded_zip');
    });

    it('defaults to geocoded_address when source is omitted', async () => {
      okQuery();

      const res = await handler(mkEv({ location: 'El Paso, TX', latitude: 31.76, longitude: -106.49 }));

      expect(res.statusCode).toBe(200);
      expect(mockSetWorkerCoordinates).toHaveBeenCalledWith(expect.anything(), expect.anything(), 31.76, -106.49, 'geocoded_address');
    });

    it('ignores a location_source sent without coordinates', async () => {
      okQuery();

      const res = await handler(mkEv({ location: 'El Paso, TX', location_source: 'geocoded_zip' }));

      expect(res.statusCode).toBe(200);
      expect(mockSetWorkerCoordinates).not.toHaveBeenCalled();
    });

    it('rejects an invalid location_source (400)', async () => {
      const res = await handler(mkEv({ latitude: 31.76, longitude: -106.49, location_source: 'gps' }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_location_source');
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('stores preferred-city coordinates and returns them', async () => {
      okQuery();
      const res = await handler(mkEv({
        preferred_cities: [
          { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX', latitude: 31.7619, longitude: -106.485 },
        ],
      }));
      expect(res.statusCode).toBe(200);
      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_preferred_cities'));
      expect(insertCall?.[0]).toContain('latitude');
      expect(insertCall?.[1]).toEqual(['u', JSON.stringify([
        { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX', latitude: 31.7619, longitude: -106.485 },
      ])]);
      expect(JSON.parse(res.body).preferred_cities[0].latitude).toBe(31.7619);
    });
  });

  describe('trade alias generation trigger', () => {
    const okQuery = () => {
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('INSERT INTO worker_profiles')) {
          return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
        }
        return Promise.resolve({});
      });
    };

    it('triggers alias generation when main_trade is other with non-empty main_trade_other', async () => {
      okQuery();

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: '  Soldador de arco  ' }));

      expect(res.statusCode).toBe(200);
      expect(mockRequestTradeAliasGeneration).toHaveBeenCalledWith('Soldador de arco');
    });

    it('does not change the 200 response when alias generation fails', async () => {
      okQuery();
      mockRequestTradeAliasGeneration.mockRejectedValueOnce(new Error('invoke failed'));

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: 'Soldador' }));

      expect(res.statusCode).toBe(200);
    });

    it('does not trigger alias generation for a non-other trade', async () => {
      okQuery();

      const res = await handler(mkEv({ main_trade: 'electrician' }));

      expect(res.statusCode).toBe(200);
      expect(mockRequestTradeAliasGeneration).not.toHaveBeenCalled();
    });

    it('does not trigger alias generation when main_trade is unset', async () => {
      okQuery();

      const res = await handler(mkEv({ availability: 'full_time' }));

      expect(res.statusCode).toBe(200);
      expect(mockRequestTradeAliasGeneration).not.toHaveBeenCalled();
    });
  });

  // ── L6: the stored custom trade is canonicalised ───────────────────
  describe('custom trade canonicalisation', () => {
    /** Answers the one `trade_aliases` SELECT the way migration 060's seeded
     * rows would, and records the query order so the pre-BEGIN placement of
     * that lookup is observable. */
    const okQuery = (aliasRow?: Record<string, unknown>) => {
      const order: string[] = [];
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('FROM trade_aliases')) {
          order.push('alias');
          return Promise.resolve({ rows: aliasRow ? [aliasRow] : [] });
        }
        if (q.includes('BEGIN')) order.push('BEGIN');
        if (q.includes('UPDATE users SET')) order.push('users');
        if (q.includes('INSERT INTO worker_profiles')) {
          return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
        }
        return Promise.resolve({});
      });
      return order;
    };

    const WELDER = { trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null };
    const ELECTRICIAN = { trade_key: 'electrician', canonical_en: 'Electrician', canonical_es: 'Electricista', trade_category: 'electrician' };

    const usersUpdateCall = () =>
      mockQuery.mock.calls.find(([q]) => typeof q === 'string' && q.includes('UPDATE users SET'));

    it('stores the canonical Spanish name for a resolved custom trade', async () => {
      okQuery(WELDER);

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: '  soldador ' }));

      expect(res.statusCode).toBe(200);
      const params = usersUpdateCall()![1];
      expect(params[2]).toBe('other');
      expect(params[3]).toBe('Soldador');
      // Already in the cache — nothing to learn.
      expect(mockRequestTradeAliasGeneration).not.toHaveBeenCalled();
    });

    it('promotes a resolved standard trade onto the main_trade enum and clears the free text', async () => {
      okQuery(ELECTRICIAN);

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: 'electricista' }));

      expect(res.statusCode).toBe(200);
      const params = usersUpdateCall()![1];
      expect(params[2]).toBe('electrician');
      // $3 IS NOT NULL and != 'other', so the UPDATE's CASE clears
      // main_trade_other on its own; the param carries no stale spelling.
      expect(params[3]).toBeNull();
      expect(mockRequestTradeAliasGeneration).not.toHaveBeenCalled();
    });

    it('tidies an unresolved trade and asks the generator to learn it', async () => {
      okQuery();

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: '  soldador   de arco ' }));

      expect(res.statusCode).toBe(200);
      const params = usersUpdateCall()![1];
      expect(params[2]).toBe('other');
      expect(params[3]).toBe('Soldador de arco');
      expect(mockRequestTradeAliasGeneration).toHaveBeenCalledWith('Soldador de arco');
    });

    it('resolves the alias BEFORE opening the transaction', async () => {
      // A failed SELECT inside an open transaction aborts it, so every later
      // statement in this handler would fail and a trade_aliases outage would
      // turn a profile save into a 500.
      const order = okQuery(WELDER);

      await handler(mkEv({ main_trade: 'other', main_trade_other: 'soldador' }));

      expect(order.indexOf('alias')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('alias')).toBeLessThan(order.indexOf('BEGIN'));
    });

    it('still saves (200) with the raw text when the alias lookup fails', async () => {
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('FROM trade_aliases')) return Promise.reject(new Error('relation missing'));
        if (q.includes('INSERT INTO worker_profiles')) {
          return Promise.resolve({ rows: [{ user_id: 'u', skills: [], availability: null, years_experience: null, experience_months: null, location: null, bio: null, certifications: [] }] });
        }
        return Promise.resolve({});
      });

      const res = await handler(mkEv({ main_trade: 'other', main_trade_other: 'soldador' }));

      expect(res.statusCode).toBe(200);
      expect(usersUpdateCall()![1][3]).toBe('Soldador');
      // Unresolved, so the trade is still queued for the generator to learn.
      expect(mockRequestTradeAliasGeneration).toHaveBeenCalledWith('Soldador');
    });

    it('never looks up an alias for a standard trade', async () => {
      const order = okQuery(WELDER);

      const res = await handler(mkEv({ main_trade: 'painting' }));

      expect(res.statusCode).toBe(200);
      expect(order).not.toContain('alias');
    });
  });
});
