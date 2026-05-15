import {
  extractZip,
  listMatchedJobsForWorker,
  normalizeProfessionText,
  scoreJobCandidate,
} from '../../../../lambda/lib/job-matching';

describe('job-matching pure scoring', () => {
  const now = new Date('2026-05-14T12:00:00Z');

  it('extracts a 5 digit zip from free text', () => {
    expect(extractZip('El Paso, TX 79928')).toBe('79928');
    expect(extractZip('79928')).toBe('79928');
    expect(extractZip('Denver, CO')).toBeNull();
  });

  it('normalizes custom profession text for matching', () => {
    expect(normalizeProfessionText('Drywall Finisher / Taper')).toContain('drywall');
    expect(normalizeProfessionText('Sheetrock hanger')).toContain('drywall');
    expect(normalizeProfessionText('Tablaroca')).toContain('drywall');
  });

  it('ranks same profession and same zip above unrelated nearby jobs', () => {
    const worker = {
      id: 'worker-1',
      main_trade: 'other',
      main_trade_other: 'Drywaller',
      years_experience: '5-9',
      availability: 'full_time',
      city: '79928',
      profile_location: '79928',
      latitude: null,
      longitude: null,
    };

    const drywallNearby = scoreJobCandidate(worker, {
      id: 'job-1',
      title: 'Drywall Finisher',
      company: 'Finish Builders',
      location: 'El Paso, TX 79928',
      pay: '$30/hr',
      job_type: 'full-time',
      description: 'Tape, mud, sand, sheetrock, texture, Level 5 walls.',
      created_at: now,
      latitude: null,
      longitude: null,
    }, now);

    const plumberNearby = scoreJobCandidate(worker, {
      id: 'job-2',
      title: 'Plumber Helper',
      company: 'Pipe Co',
      location: 'El Paso, TX 79928',
      pay: '$22/hr',
      job_type: 'full-time',
      description: 'Assist plumbers with pipe runs and fixture installs.',
      created_at: now,
      latitude: null,
      longitude: null,
    }, now);

    expect(drywallNearby.score).toBeGreaterThan(plumberNearby.score);
    expect(drywallNearby.reasons).toContain('profession_exact_or_alias');
    expect(drywallNearby.reasons).toContain('zip_exact');
    expect(plumberNearby.components.profession).toBe(0);
  });

  it('uses coordinates when both worker and job have them', () => {
    const worker = {
      id: 'worker-1',
      main_trade: 'electrician',
      main_trade_other: null,
      years_experience: '2-4',
      availability: 'flexible',
      city: 'El Paso',
      profile_location: '79928',
      latitude: '31.6813',
      longitude: '-106.1908',
    };

    const result = scoreJobCandidate(worker, {
      id: 'job-3',
      title: 'Electrician Apprentice',
      company: 'Wire Co',
      location: '79928',
      pay: '$24/hr',
      job_type: 'contract',
      description: 'Residential wiring and panels.',
      created_at: now,
      latitude: '31.6900',
      longitude: '-106.2000',
    }, now);

    expect(result.components.location).toBe(30);
    expect(result.reasons).toContain('distance_under_5_miles');
  });

  it('filters out location-only matches when the worker has profession data', async () => {
    const worker = {
      id: 'worker-1',
      main_trade: 'other',
      main_trade_other: 'Drywaller',
      years_experience: '5-9',
      availability: 'full_time',
      city: '79928',
      profile_location: '79928',
      latitude: null,
      longitude: null,
    };

    const unrelatedNearby = scoreJobCandidate(worker, {
      id: 'job-plumber',
      title: 'Plumber Helper',
      company: 'Pipe Co',
      location: '79928',
      pay: '$22/hr',
      job_type: 'full-time',
      description: 'Assist with pipes and fixtures.',
      created_at: now,
      latitude: null,
      longitude: null,
    }, now);

    expect(unrelatedNearby.components.profession).toBe(0);
  });

  it('lists matches when optional coordinate columns are absent', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'worker-1',
          main_trade: 'other',
          main_trade_other: 'Drywaller',
          years_experience: '5-9',
          availability: 'weekends',
          city: '79928',
          profile_location: '79928',
          latitude: null,
          longitude: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Drywall Profile Match Crew',
          company: 'Jale Profile Match Fixtures',
          location: 'El Paso, TX 79928',
          pay: '$30/hr',
          job_type: 'contract',
          description: 'Drywall hanging, taping, and texture project.',
          required_docs: [],
          created_at: now,
          latitude: null,
          longitude: null,
        }],
      });

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'api' },
    );

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1][0]).toContain('NULL::numeric AS latitude');
    expect(query.mock.calls[1][0]).toContain('NULL::numeric AS longitude');
    expect(query.mock.calls[3][0]).toContain('NULL::numeric AS latitude');
    expect(query.mock.calls[3][0]).toContain('NULL::numeric AS longitude');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Drywall Profile Match Crew');
    expect(result[0].match_components.profession).toBeGreaterThan(0);
  });

  it('scores a wider candidate window before applying the requested limit', async () => {
    const newerIrrelevantJobs = Array.from({ length: 5 }, (_, index) => ({
      id: `job-plumber-${index}`,
      title: `Plumber Helper ${index}`,
      company: 'Pipe Co',
      location: 'El Paso, TX 79928',
      pay: '$22/hr',
      job_type: 'full-time',
      description: 'Pipe runs and fixture installs.',
      required_docs: [],
      created_at: new Date(now.getTime() - index * 1000),
      latitude: null,
      longitude: null,
    }));
    const olderRelevantJob = {
      id: 'job-drywall-older',
      title: 'Drywall Finisher',
      company: 'Finish Builders',
      location: 'El Paso, TX 79928',
      pay: '$30/hr',
      job_type: 'full-time',
      description: 'Sheetrock hanging, taping, mud, and texture.',
      required_docs: [],
      created_at: new Date(now.getTime() - 10_000),
      latitude: null,
      longitude: null,
    };

    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'worker-1',
          main_trade: 'other',
          main_trade_other: 'Drywaller',
          years_experience: '5-9',
          availability: 'full_time',
          city: '79928',
          profile_location: '79928',
          latitude: null,
          longitude: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [...newerIrrelevantJobs, olderRelevantJob],
      });

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    expect(query.mock.calls[3][1]).toContain(50);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('job-drywall-older');
  });
});
