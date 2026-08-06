import {
  buildWorkerProfessionContext,
  extractZip,
  listMatchedJobsForWorker,
  loadWorkerPreferredCityKeys,
  normalizeProfessionText,
  scoreJobCandidate,
  type MatchableJobRow,
  type TradeAliasRow,
  type WorkerMatchProfile,
} from '../../../../lambda/lib/job-matching';

// ── Dispatching query mock ──────────────────────────────────────────────
//
// Review finding: positional `mockResolvedValueOnce` chains break every time
// a query is added/removed/reordered. Routes match on a SQL substring (and
// optionally params), so tests stay valid regardless of call order/count.

type QueryRoute = {
  test: (sql: string, params: unknown[]) => boolean;
  handler: (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;
};

function buildQuery(routes: QueryRoute[]): jest.Mock {
  return jest.fn((sql: string, params: unknown[] = []) => {
    for (const route of routes) {
      if (route.test(sql, params)) {
        return route.handler(sql, params);
      }
    }
    return { rows: [] };
  });
}

/** `coordinateSelects` -- identical SQL for both `worker_profiles` and
 * `jobs`, distinguished only by the table-name param. Defaults to "no
 * lat/lon columns" (NULL::numeric fallback) for every table unless
 * overridden. */
function coordinateColumnsRoute(hasCoords: Partial<Record<'worker_profiles' | 'jobs', boolean>> = {}): QueryRoute {
  return {
    test: (sql) => /FROM information_schema\.columns/.test(sql),
    handler: (_sql, params) => {
      const table = params[0] as 'worker_profiles' | 'jobs';
      return { rows: hasCoords[table] ? [{ column_name: 'latitude' }, { column_name: 'longitude' }] : [] };
    },
  };
}

function workerRoute(row: Record<string, unknown> | null): QueryRoute {
  return {
    test: (sql) => /FROM users u/.test(sql),
    handler: () => ({ rows: row ? [row] : [] }),
  };
}

function tradeAliasesRoute(rowsOrError: TradeAliasRow[] | Error): QueryRoute {
  return {
    test: (sql) => /FROM trade_aliases/.test(sql),
    handler: () => {
      if (rowsOrError instanceof Error) {
        throw rowsOrError;
      }
      return { rows: rowsOrError };
    },
  };
}

function jobsListRoute(rows: Record<string, unknown>[]): QueryRoute {
  return {
    test: (sql) => /FROM jobs j/.test(sql) && /ORDER BY j\.created_at/.test(sql),
    handler: () => ({ rows }),
  };
}

function pinFetchRoute(rows: Record<string, unknown>[]): QueryRoute {
  return {
    test: (sql) => /FROM jobs j/.test(sql) && /j\.id = \$2/.test(sql),
    handler: () => ({ rows }),
  };
}

function findCall(query: jest.Mock, pattern: RegExp): [string, unknown[]] | undefined {
  return query.mock.calls.find(([sql]) => pattern.test(sql)) as [string, unknown[]] | undefined;
}

function worker(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'worker-1',
    main_trade: 'other',
    main_trade_other: 'Drywaller',
    years_experience: '5-9',
    availability: 'weekends',
    city: '79928',
    profile_location: '79928',
    latitude: null,
    longitude: null,
    worker_skills: [],
    attributed_job_id: null,
    ...overrides,
  };
}

function job(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    title: 'Generic Job',
    company: 'Jale',
    location: 'El Paso, TX 79928',
    pay: '$25/hr',
    job_type: 'full-time',
    description: '',
    required_docs: [],
    created_at: new Date('2026-05-14T12:00:00Z'),
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

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
    const w: WorkerMatchProfile = {
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

    const drywallNearby = scoreJobCandidate(w, {
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

    const plumberNearby = scoreJobCandidate(w, {
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
    const w: WorkerMatchProfile = {
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

    const result = scoreJobCandidate(w, {
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
    const w: WorkerMatchProfile = {
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

    const unrelatedNearby = scoreJobCandidate(w, {
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

  it('awards a full profession score on a true enum-to-enum trade_category match with no shared words', () => {
    const w: WorkerMatchProfile = {
      id: 'worker-1',
      main_trade: 'carpenter',
      main_trade_other: null,
      years_experience: '5-9',
      availability: 'full_time',
      city: '79928',
      profile_location: '79928',
      latitude: null,
      longitude: null,
    };

    const result = scoreJobCandidate(w, {
      id: 'job-carpenter',
      title: 'Site Crew Position #4471',
      company: 'Acme',
      location: '79928',
      pay: '$28/hr',
      job_type: 'full-time',
      description: 'General labor at a residential build site.',
      trade_category: 'carpenter',
      created_at: now,
      latitude: null,
      longitude: null,
    } as MatchableJobRow, now);

    expect(result.components.profession).toBe(50);
    expect(result.reasons).toContain('profession_exact_or_alias');
  });

  it('regression: TRADE_TO_PROFESSION maps drywall so the enum-to-enum path works for it too', () => {
    const w: WorkerMatchProfile = {
      id: 'worker-1',
      main_trade: 'drywall',
      main_trade_other: null,
      years_experience: '5-9',
      availability: 'full_time',
      city: '79928',
      profile_location: '79928',
      latitude: null,
      longitude: null,
    };

    const result = scoreJobCandidate(w, {
      id: 'job-drywall',
      title: 'Site Crew Position #9912',
      company: 'Acme',
      location: '79928',
      pay: '$28/hr',
      job_type: 'full-time',
      description: 'General labor at a residential build site.',
      trade_category: 'drywall',
      created_at: now,
      latitude: null,
      longitude: null,
    } as MatchableJobRow, now);

    expect(result.components.profession).toBe(50);
  });

  it('buildWorkerProfessionContext keeps strongTerms empty on an alias-cache miss (no unwarranted whole-word upgrade)', () => {
    const w: WorkerMatchProfile = {
      id: 'worker-1',
      main_trade: 'other',
      main_trade_other: 'Roofer',
      years_experience: '2-4',
      availability: 'weekends',
      city: '79928',
      profile_location: '79928',
      latitude: null,
      longitude: null,
    };

    const context = buildWorkerProfessionContext(w, []);
    expect(context.strongTerms).toEqual([]);
    expect(context.terms).toContain('roofer');
  });
});

describe('listMatchedJobsForWorker', () => {
  it('lists matches when optional coordinate columns are absent', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ availability: 'weekends' })),
      tradeAliasesRoute([]),
      jobsListRoute([job({
        id: 'job-1',
        title: 'Drywall Profile Match Crew',
        company: 'Jale Profile Match Fixtures',
        description: 'Drywall hanging, taping, and texture project.',
        job_type: 'contract',
      })]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'api' },
    );

    const workerCall = findCall(query, /FROM users u/);
    const jobsCall = findCall(query, /FROM jobs j/);
    expect(workerCall?.[0]).toContain('NULL::numeric AS latitude');
    expect(workerCall?.[0]).toContain('NULL::numeric AS longitude');
    expect(jobsCall?.[0]).toContain('NULL::numeric AS latitude');
    expect(jobsCall?.[0]).toContain('NULL::numeric AS longitude');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Drywall Profile Match Crew');
    expect(result[0].match_components.profession).toBeGreaterThan(0);
  });

  it('scores a wider candidate window before applying the requested limit', async () => {
    const now = new Date('2026-05-14T12:00:00Z');
    const newerIrrelevantJobs = Array.from({ length: 5 }, (_, index) => job({
      id: `job-plumber-${index}`,
      title: `Plumber Helper ${index}`,
      company: 'Pipe Co',
      description: 'Pipe runs and fixture installs.',
      created_at: new Date(now.getTime() - index * 1000),
    }));
    const olderRelevantJob = job({
      id: 'job-drywall-older',
      title: 'Drywall Finisher',
      company: 'Finish Builders',
      description: 'Sheetrock hanging, taping, mud, and texture.',
      created_at: new Date(now.getTime() - 10_000),
    });

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker()),
      tradeAliasesRoute([]),
      jobsListRoute([...newerIrrelevantJobs, olderRelevantJob]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    const jobsCall = findCall(query, /FROM jobs j/);
    expect(jobsCall?.[1]).toContain(50);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('job-drywall-older');
  });

  it('pins the referred job even when the profession filter would drop it', async () => {
    // The live gap this guards: a "Soldador" worker referred to a "Welder"
    // job never saw it in `jobs` -- no alias bridges the two, profession
    // scored 0, and the filter removed it.
    const welderJob = job({
      id: 'job-welder',
      title: 'Test refer me',
      description: 'Welder',
    });

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade_other: 'Soldador', attributed_job_id: 'job-welder' })),
      tradeAliasesRoute([]),
      jobsListRoute([]),
      pinFetchRoute([welderJob]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('job-welder');
    expect(result[0].match_reasons[0]).toBe('referred_job');
  });

  it('moves an already-ranked referred job to the top without refetching it', async () => {
    const drywallJob = (id: string, createdAt: Date) => job({
      id,
      title: `Drywall Crew ${id}`,
      description: 'Sheetrock hanging, taping, mud, and texture.',
      created_at: createdAt,
    });

    const now = new Date('2026-05-14T12:00:00Z');
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ attributed_job_id: 'job-referred' })),
      tradeAliasesRoute([]),
      jobsListRoute([drywallJob('job-newer', now), drywallJob('job-referred', new Date(now.getTime() - 10_000))]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    // No pin-fetch query should have run -- the referred job was already
    // in the ranked candidate set.
    expect(query.mock.calls.some(([sql]) => /j\.id = \$2/.test(sql as string))).toBe(false);
    expect(result[0].id).toBe('job-referred');
    expect(result[0].match_reasons[0]).toBe('referred_job');
    expect(result.map((j) => j.id)).toEqual(['job-referred', 'job-newer']);
  });

  it('skips the referral pin when the worker searched for something specific', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ attributed_job_id: 'job-welder' })),
      tradeAliasesRoute([]),
      jobsListRoute([]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp', search: 'plumber' },
    );

    expect(query.mock.calls.some(([sql]) => /j\.id = \$2/.test(sql as string))).toBe(false);
    expect(result).toHaveLength(0);
  });

  it('does not pin a referred job the worker already applied to', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade_other: 'Soldador', attributed_job_id: 'job-welder' })),
      tradeAliasesRoute([]),
      jobsListRoute([]),
      pinFetchRoute([]), // active + not-applied fetch finds nothing (applied or closed)
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    expect(result).toHaveLength(0);
  });

  it('resolves an organic Soldador-to-Welder match via the trade_aliases cache, without any pin', async () => {
    const welderRow: TradeAliasRow = {
      trade_key: 'welder',
      canonical_en: 'Welder',
      canonical_es: 'Soldador',
      aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
      trade_category: null,
    };

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade_other: 'Soldador', attributed_job_id: null })),
      tradeAliasesRoute([welderRow]),
      jobsListRoute([job({ id: 'job-welder', title: 'Welder needed', description: 'Arc welding for structural steel.' })]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    expect(result).toHaveLength(1);
    expect(result[0].match_components.profession).toBe(50);
    expect(result[0].match_reasons).not.toContain('referred_job');
  });

  it('folds accents so "Albañil" resolves the seeded concrete trade_aliases row', async () => {
    const concreteRow: TradeAliasRow = {
      trade_key: 'concrete',
      canonical_en: 'Concrete',
      canonical_es: 'Concreto',
      aliases: ['concrete', 'cement', 'concreto', 'cemento', 'albanil', 'rebar', 'formwork', 'finisher'],
      trade_category: 'concrete',
    };

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade_other: 'Albañil', attributed_job_id: null })),
      tradeAliasesRoute([concreteRow]),
      jobsListRoute([job({ id: 'job-concrete', title: 'Concrete Crew', description: 'Pouring and finishing foundations.' })]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    // The real proof the accent actually folded: the trade_aliases lookup
    // key is the unaccented 'albanil', not the raw 'Albañil' input.
    const aliasCall = findCall(query, /FROM trade_aliases/);
    expect(aliasCall?.[1]).toEqual([['albanil']]);

    expect(result).toHaveLength(1);
    expect(result[0].match_components.profession).toBe(50);
  });

  it('degrades to legacy behavior on a trade_aliases cache miss, without throwing', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade: 'other', main_trade_other: 'Roofer', attributed_job_id: null })),
      tradeAliasesRoute([]),
      jobsListRoute([job({ id: 'job-roofer', title: 'Helper wanted', description: 'General site helper, various tasks.' })]),
    ]);

    await expect(listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    )).resolves.toBeDefined();
  });

  it('degrades gracefully when the trade_aliases query itself rejects', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ main_trade_other: 'Soldador', attributed_job_id: null })),
      tradeAliasesRoute(new Error('connection reset')),
      jobsListRoute([job({ id: 'job-welder', title: 'Welder needed', description: 'Arc welding.' })]),
    ]);

    await expect(listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    )).resolves.toBeDefined();
  });

  it('resolves a trade via worker_skills even when main_trade is unrelated', async () => {
    const welderRow: TradeAliasRow = {
      trade_key: 'welder',
      canonical_en: 'Welder',
      canonical_es: 'Soldador',
      aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
      trade_category: null,
    };

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({
        main_trade: 'electrician',
        main_trade_other: null,
        worker_skills: ['soldador'],
        attributed_job_id: null,
      })),
      tradeAliasesRoute([welderRow]),
      jobsListRoute([
        job({ id: 'job-welder', title: 'Welder needed', description: 'Arc welding for structural steel.' }),
        job({ id: 'job-unrelated', title: 'Front desk clerk', description: 'Answer phones and greet visitors.' }),
      ]),
    ]);

    const result = await listMatchedJobsForWorker(
      { query } as never,
      'worker-1',
      { limit: 5, channel: 'whatsapp' },
    );

    expect(result.map((j) => j.id)).toEqual(['job-welder']);
    expect(result[0].match_components.profession).toBe(50);

    const aliasCall = findCall(query, /FROM trade_aliases/);
    expect(aliasCall?.[1]).toEqual([expect.arrayContaining(['electrician', 'soldador'])]);
  });

  it('filters by preferred city keys in SQL', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker()),
      tradeAliasesRoute([]),
      jobsListRoute([]),
    ]);

    await listMatchedJobsForWorker({ query } as never, 'worker-1', {
      limit: 5,
      channel: 'api',
      cityKeys: ['el-paso-tx', 'austin-tx'],
    });

    const jobsCall = findCall(query, /FROM jobs j/);
    expect(jobsCall?.[0]).toContain('j.city_key = ANY(');
    expect(jobsCall?.[1]).toEqual(expect.arrayContaining([['el-paso-tx', 'austin-tx']]));
  });

  it('excludes city keys for the fallback query', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker()),
      tradeAliasesRoute([]),
      jobsListRoute([]),
    ]);

    await listMatchedJobsForWorker({ query } as never, 'worker-1', {
      limit: 5,
      channel: 'api',
      excludeCityKeys: ['el-paso-tx'],
    });

    const jobsCall = findCall(query, /FROM jobs j/);
    expect(jobsCall?.[0]).toContain('j.city_key IS NULL OR NOT (j.city_key = ANY(');
    expect(jobsCall?.[1]).toEqual(expect.arrayContaining([['el-paso-tx']]));
  });

  it('still pins the referred job when a city filter is applied', async () => {
    // Load-bearing: the `cityKeys` branch must NOT set `isFiltered`. A worker
    // referred to a job OUTSIDE their preferred cities must still see it
    // pinned -- the referral is a stronger signal than the city preference.
    // The handler tests can't catch a regression here (they mock this lib).
    const outOfCityJob = job({
      id: 'job-referred-elsewhere',
      title: 'Drywall Crew',
      description: 'Sheetrock hanging, taping, mud, and texture.',
      location: 'Austin, TX',
    });

    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ attributed_job_id: 'job-referred-elsewhere' })),
      tradeAliasesRoute([]),
      jobsListRoute([]),
      pinFetchRoute([outOfCityJob]),
    ]);

    const result = await listMatchedJobsForWorker({ query } as never, 'worker-1', {
      limit: 5,
      channel: 'api',
      cityKeys: ['el-paso-tx'],
    });

    expect(result[0]?.id).toBe('job-referred-elsewhere');
    expect(result[0]?.match_reasons[0]).toBe('referred_job');
  });

  it('skips the referral pin on the excludeCityKeys fallback query', async () => {
    // The fallback runs alongside a primary query that already pinned the
    // referral; re-pinning here would surface the same job in both lists.
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker({ attributed_job_id: 'job-referred-elsewhere' })),
      tradeAliasesRoute([]),
      jobsListRoute([]),
      pinFetchRoute([job({ id: 'job-referred-elsewhere' })]),
    ]);

    const result = await listMatchedJobsForWorker({ query } as never, 'worker-1', {
      limit: 5,
      channel: 'api',
      excludeCityKeys: ['el-paso-tx'],
    });

    expect(query.mock.calls.some(([sql]) => /j\.id = \$2/.test(sql as string))).toBe(false);
    expect(result).toHaveLength(0);
  });

  it('applies no city clause when no keys are given', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker()),
      tradeAliasesRoute([]),
      jobsListRoute([]),
    ]);

    await listMatchedJobsForWorker({ query } as never, 'worker-1', { limit: 5, channel: 'api' });

    const jobsCall = findCall(query, /FROM jobs j/);
    expect(jobsCall?.[0]).not.toContain('city_key');
  });

  it('keeps the LIMIT placeholder index correct when city filters are applied', async () => {
    const query = buildQuery([
      coordinateColumnsRoute(),
      workerRoute(worker()),
      tradeAliasesRoute([]),
      jobsListRoute([]),
    ]);

    await listMatchedJobsForWorker({ query } as never, 'worker-1', {
      limit: 5,
      channel: 'api',
      search: 'drywall',
      jobType: 'contract',
      cityKeys: ['el-paso-tx'],
      excludeCityKeys: ['austin-tx'],
    });

    const [sql, params] = findCall(query, /FROM jobs j/)!;
    // Every `$n` in the WHERE/LIMIT clauses must resolve to a real param, and
    // the LIMIT must still be the last one (city filters push before it).
    const limitIndex = Number(/LIMIT \$(\d+)/.exec(sql)?.[1]);
    expect(limitIndex).toBe(params.length);
    expect(params[limitIndex - 1]).toBe(50);

    const includeIndex = params.findIndex((p) => Array.isArray(p) && p[0] === 'el-paso-tx') + 1;
    const excludeIndex = params.findIndex((p) => Array.isArray(p) && p[0] === 'austin-tx') + 1;
    expect(sql).toContain(`j.city_key = ANY($${includeIndex}::text[])`);
    expect(sql).toContain(`NOT (j.city_key = ANY($${excludeIndex}::text[]))`);
  });
});

describe('loadWorkerPreferredCityKeys', () => {
  it('returns the worker preferred city keys in created_at order', async () => {
    const query = buildQuery([
      {
        test: (sql) => /FROM worker_preferred_cities/.test(sql),
        handler: () => ({ rows: [{ city_key: 'el-paso-tx' }, { city_key: 'las-cruces-nm' }] }),
      },
    ]);

    const keys = await loadWorkerPreferredCityKeys({ query } as never, 'worker-1');

    expect(keys).toEqual(['el-paso-tx', 'las-cruces-nm']);
    const [sql, params] = findCall(query, /FROM worker_preferred_cities/)!;
    expect(sql).toContain('ORDER BY created_at');
    expect(params).toEqual(['worker-1']);
  });

  it('returns an empty list for a worker with no preferred cities', async () => {
    const query = buildQuery([]);

    const keys = await loadWorkerPreferredCityKeys({ query } as never, 'worker-1');

    expect(keys).toEqual([]);
  });
});
