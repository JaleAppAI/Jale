import {
  applyWorkerToJob,
  copyRequiredDocumentSnapshots,
  resolveCertificationDocIds,
} from '../../../../lambda/lib/applications';

const makeClient = (query: jest.Mock) => ({ query }) as any;

// mockImplementation-based helper: routes by SQL substring instead of call
// position.
function makeRoutedClient(routes: Array<[string, unknown]>) {
  const query = jest.fn((sql: string, _params?: unknown[]) => {
    for (const [needle, result] of routes) {
      if (sql.includes(needle)) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
    }
    return Promise.resolve({});
  });
  return { client: { query } as any, query };
}

const APPLIED_ROW = { id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' };

/** The stage-1 job SELECT is now down to snapshot doc types + prompts. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return { id: 'job-1', required_docs: [], optional_docs: [], pre_application_prompts: [], ...overrides };
}

describe('applyWorkerToJob -- stage 1', () => {
  it('returns job_closed when the active job is not visible', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [] }); // job lookup

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    });

    expect(result).toEqual({ status: 'job_closed' });
    // No FOR UPDATE: the row lock needs UPDATE on `jobs`, which jale_whatsapp
    // lacks (ADR-W05). Idempotency comes from INSERT ... ON CONFLICT instead.
    expect(String(query.mock.calls[1][0])).not.toContain('FOR UPDATE');
  });

  it('the job SELECT reads pre_application_prompts and the doc-snapshot columns, and no longer reads the requirement columns stage 2 owns', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await applyWorkerToJob(makeClient(query), { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain('pre_application_prompts');
    expect(sql).toContain('required_docs');
    expect(sql).toContain('optional_docs');
    expect(sql).toContain("status = 'active'");
    // Fields, certification requirements and the answers gate all moved to
    // application-requirements.ts -- apply must not re-derive them.
    expect(sql).not.toContain('required_fields');
    expect(sql).not.toContain('certification_requirements');
  });

  it('inserts with an empty application_answers and copies required document snapshots with S3 version IDs', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['resume'] })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    });

    expect(result).toEqual({ status: 'applied', application: APPLIED_ROW });
    const insertSql = String(query.mock.calls[2][0]);
    expect(insertSql).toContain('prompt_answers');
    expect(insertSql).toContain('ON CONFLICT (job_id, worker_id) DO NOTHING');
    const copySql = String(query.mock.calls[3][0]);
    expect(copySql).toContain('s3_version_id');
    expect(copySql).toContain('AND (job_id IS NULL OR job_id = $1::uuid)');
  });

  it('NO LONGER bounces on missing required documents -- every stage-1 apply is incomplete by design (the 022 INSERT guard is dropped in 091)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['resume', 'driver_license'] })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    });

    expect(result).toEqual({ status: 'applied', application: APPLIED_ROW });
    // The old pre-INSERT `SELECT DISTINCT doc_type` presence probe is gone.
    expect(query.mock.calls.some((c) => String(c[0]).includes('SELECT DISTINCT doc_type'))).toBe(false);
  });

  it('never sets app.allow_incomplete_docs for either surface -- the GUC is dead once 091 drops the guard', async () => {
    for (const surface of ['web', 'whatsapp'] as const) {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['resume'] })] })
        .mockResolvedValueOnce({ rows: [APPLIED_ROW] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await applyWorkerToJob(makeClient(query), { workerId: 'worker-1', jobId: 'job-1', surface });
      expect(query.mock.calls.some((c) => String(c[0]).includes('allow_incomplete_docs'))).toBe(false);
    }
  });

  it('never validates or writes application answers, certification claims or defaults at apply time', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [jobRow({ required_docs: ['resume'] })] }],
      ['INSERT INTO job_applications', { rows: [APPLIED_ROW] }],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    expect(result.status).toBe('applied');
    for (const gone of ['worker_application_defaults', "doc_type = 'certification_doc'"]) {
      expect(query.mock.calls.some((c: any[]) => String(c[0]).includes(gone))).toBe(false);
    }
    const insertParams = query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO job_applications'))![1] as any[];
    // application_answers is a literal '{}' in the statement; the only jsonb
    // parameter left is prompt_answers.
    expect(insertParams).toEqual(['job-1', 'worker-1', '{}']);
  });

  it('repairs missing snapshots before returning already_applied', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['resume'] })] })
      .mockResolvedValueOnce({ rows: [] })      // INSERT ... DO NOTHING
      .mockResolvedValueOnce({ rowCount: 1 })   // snapshot repair
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    });

    expect(result).toEqual({ status: 'already_applied', application: APPLIED_ROW });
    expect(String(query.mock.calls[3][0])).toContain('INSERT INTO worker_documents');
  });

  it('returns forbidden when the row cannot be read back after a DO NOTHING (RLS)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).toEqual({ status: 'forbidden' });
  });

  it('maps 42501 to forbidden', async () => {
    const { client } = makeRoutedClient([
      ['FROM jobs', { rows: [jobRow()] }],
      ['INSERT INTO job_applications', Object.assign(new Error('denied'), { code: '42501' })],
    ]);
    expect(await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' }))
      .toEqual({ status: 'forbidden' });
  });

  it('still applies for a legacy job requiring the ssn doc type', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['ssn'] })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] })
      .mockResolvedValueOnce({ rowCount: 0 });

    expect((await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).status).toBe('applied');
  });

  it('issues no snapshot copy at all for a job that asks for no documents', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    expect((await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).status).toBe('applied');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('copies certification_doc rows with a dedicated dedup-by-s3_key query, separate from the non-cert DISTINCT ON copy', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ required_docs: ['resume', 'certification_doc'] })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })  // non-cert copy
      .mockResolvedValueOnce({ rowCount: 1 }); // cert copy

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    });

    expect(result.status).toBe('applied');
    expect(query.mock.calls).toHaveLength(5);
    const nonCertSql = String(query.mock.calls[3][0]);
    const certSql = String(query.mock.calls[4][0]);
    expect(nonCertSql).toContain('DISTINCT ON (doc_type)');
    expect(nonCertSql).not.toContain('certification_doc');
    expect(certSql).not.toContain('DISTINCT ON');
    expect(certSql).toContain("doc_type = 'certification_doc'");
    expect(certSql).toContain('NOT EXISTS');
    expect(certSql).toContain('dst.s3_key = src.s3_key');
    expect(certSql).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('applyWorkerToJob -- pre-application prompts', () => {
  const PROMPTS = [{ id: 'p1', text: 'Years of framing?' }, { id: 'p2', text: 'Own tools?' }];

  it('stores validated, trimmed prompt answers as the INSERT prompt_answers param (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      promptAnswers: { p1: '  five years ', p2: 'yes' },
    });

    expect(result.status).toBe('applied');
    const [insertSql, insertParams] = query.mock.calls[2];
    expect(String(insertSql)).toMatch(/INSERT INTO job_applications \(job_id, worker_id, status, application_answers, prompt_answers\)/);
    expect(JSON.parse(String((insertParams as any[])[2]))).toEqual({ p1: 'five years', p2: 'yes' });
  });

  it('web: missing_prompt_answers lists the unanswered prompt ids and never reaches the INSERT', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] });

    expect(await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web', promptAnswers: { p1: 'five' },
    })).toEqual({ status: 'missing_prompt_answers', missing: ['p2'] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('web: an omitted promptAnswers on a job WITH prompts is missing_prompt_answers, not invalid', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] });

    expect(await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).toEqual({ status: 'missing_prompt_answers', missing: ['p1', 'p2'] });
  });

  it('web: invalid_prompt_answers for an unknown id, a blank answer, an oversize answer or a non-object payload', async () => {
    for (const promptAnswers of [
      { p1: 'a', p2: 'b', p9: 'c' },
      { p1: '   ', p2: 'b' },
      { p1: 'x'.repeat(1001), p2: 'b' },
      'nope' as any,
      ['a'] as any,
    ]) {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] });

      expect(await applyWorkerToJob(makeClient(query), {
        workerId: 'worker-1', jobId: 'job-1', surface: 'web', promptAnswers,
      })).toEqual({ status: 'invalid_prompt_answers' });
      expect(query).toHaveBeenCalledTimes(2);
    }
  });

  it('web: a job with NO prompts applies with an empty prompt_answers and never bounces', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    expect((await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).status).toBe('applied');
    expect((query.mock.calls[2][1] as any[])[2]).toBe('{}');
  });

  it("whatsapp: prompts are collected conversationally AFTER the one-tap accept, so the INSERT always stores '{}' and never bounces", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'whatsapp',
    });

    expect(result.status).toBe('applied');
    expect((query.mock.calls[2][1] as any[])[2]).toBe('{}');
  });

  it('whatsapp: a promptAnswers value supplied by a caller is ignored, never validated and never stored', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'whatsapp',
      promptAnswers: { p9: 'not a real prompt' },
    });

    expect(result.status).toBe('applied');
    expect((query.mock.calls[2][1] as any[])[2]).toBe('{}');
  });

  it('already_applied still DISCARDS the supplied prompt answers -- top-ups go through mergePromptAnswers, never this idempotent re-apply', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: PROMPTS })] })
      .mockResolvedValueOnce({ rows: [] })                     // DO NOTHING
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });          // read-back

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      promptAnswers: { p1: 'five', p2: 'yes' },
    });

    expect(result).toEqual({ status: 'already_applied', application: APPLIED_ROW });
    expect(query.mock.calls.some((c) => String(c[0]).startsWith('UPDATE job_applications'))).toBe(false);
  });

  it('tolerates a malformed pre_application_prompts column value (fails open to "no prompts"), never a 500', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ pre_application_prompts: 'garbage' })] })
      .mockResolvedValueOnce({ rows: [APPLIED_ROW] });

    expect((await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
    })).status).toBe('applied');
  });
});

describe('applyWorkerToJob -- 078 trigger cap constraint mapping', () => {
  it.each([
    ['certification_document_limit'],
    ['certification_document_name_limit'],
  ])('maps a 23514 %s from the snapshot copy to a graceful certification_document_limit result, not a 500', async (constraint) => {
    const pgErr = Object.assign(new Error('trigger cap'), { code: '23514', constraint });
    const { client } = makeRoutedClient([
      ['FROM jobs', { rows: [jobRow({ required_docs: ['certification_doc'] })] }],
      ['INSERT INTO job_applications', { rows: [APPLIED_ROW] }],
      ['INSERT INTO worker_documents', pgErr],
    ]);

    expect(await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' }))
      .toEqual({ status: 'certification_document_limit' });
  });

  it('re-throws any other database error rather than inventing a result', async () => {
    const { client } = makeRoutedClient([
      ['FROM jobs', { rows: [jobRow()] }],
      ['INSERT INTO job_applications', Object.assign(new Error('deadlock'), { code: '40P01' })],
    ]);
    await expect(applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' }))
      .rejects.toThrow('deadlock');
  });
});

describe('resolveCertificationDocIds', () => {
  const DOC_A = '11111111-1111-4111-8111-111111111111';
  const DOC_B = '22222222-2222-4222-8222-222222222222';

  it('returns only the ids this worker owns as a certification_doc, and never filters on cert_name', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: DOC_A }] });
    const valid = await resolveCertificationDocIds(makeClient(query), 'worker-1', [DOC_A, DOC_B]);

    expect(valid).toEqual(new Set([DOC_A]));
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('FROM worker_documents');
    expect(sql).toContain("doc_type = 'certification_doc'");
    expect(sql).toContain('id = ANY($2::uuid[])');
    expect(sql).not.toContain('cert_name');
    expect(query.mock.calls[0][1]).toEqual(['worker-1', [DOC_A, DOC_B]]);
  });

  it('issues no query for an empty id list', async () => {
    const query = jest.fn();
    expect(await resolveCertificationDocIds(makeClient(query), 'worker-1', [])).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('de-dupes the ids it sends to the database', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    await resolveCertificationDocIds(makeClient(query), 'worker-1', [DOC_A, DOC_A, DOC_B]);
    expect(query.mock.calls[0][1]).toEqual(['worker-1', [DOC_A, DOC_B]]);
  });
});

// ── L3: copyRequiredDocumentSnapshots now REPORTS what it copied ─────────
//
// Mechanism 3 of the 2026-09-04 incident: this function silently satisfied a
// required work-authorization DOCUMENT from the worker's vault, so the bot
// never asked for it and the worker was never told it had been attached.
// Decision D3 keeps the auto-attach (it is genuinely useful) and requires
// that the worker be TOLD -- which needs the list of what was actually
// copied.
describe('copyRequiredDocumentSnapshots -- copied-document reporting', () => {
  it('returns one entry per newly copied doc_type, sourced from the vault', async () => {
    const { client, query } = makeRoutedClient([
      ['SELECT DISTINCT ON (doc_type)', { rows: [{ doc_type: 'resume' }, { doc_type: 'work_auth_doc' }] }],
    ]);

    const copied = await copyRequiredDocumentSnapshots(client, 'worker-1', 'job-1', ['resume', 'work_auth_doc']);

    expect(copied).toEqual([
      { docType: 'resume', source: 'vault' },
      { docType: 'work_auth_doc', source: 'vault' },
    ]);
    // Still ONE statement for the non-cert branch -- the report rides on a
    // RETURNING, never a second read.
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain('RETURNING doc_type');
  });

  it('reports the certification branch separately from the non-cert one', async () => {
    const { client } = makeRoutedClient([
      ['SELECT DISTINCT ON (doc_type)', { rows: [{ doc_type: 'resume' }] }],
      ['FROM worker_documents src', { rows: [{ doc_type: 'certification_doc' }, { doc_type: 'certification_doc' }] }],
    ]);

    const copied = await copyRequiredDocumentSnapshots(client, 'worker-1', 'job-1', ['resume', 'certification_doc']);

    // Two cert FILES copied collapse to ONE reported doc_type: the report is
    // "which requirement got satisfied from the vault", not a file count.
    expect(copied).toEqual([
      { docType: 'resume', source: 'vault' },
      { docType: 'certification_doc', source: 'vault' },
    ]);
  });

  it('returns an empty list when the copy was a no-op (nothing in the vault, or already copied)', async () => {
    const { client } = makeRoutedClient([
      ['SELECT DISTINCT ON (doc_type)', { rows: [] }],
    ]);
    expect(await copyRequiredDocumentSnapshots(client, 'worker-1', 'job-1', ['resume'])).toEqual([]);
  });

  it('returns an empty list for an empty doc-type list, still issuing no query', async () => {
    const query = jest.fn();
    expect(await copyRequiredDocumentSnapshots(makeClient(query), 'worker-1', 'job-1', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('tolerates a driver/test double that returns rowCount without rows', async () => {
    const { client } = makeRoutedClient([
      ['SELECT DISTINCT ON (doc_type)', { rowCount: 1 }],
    ]);
    expect(await copyRequiredDocumentSnapshots(client, 'worker-1', 'job-1', ['resume'])).toEqual([]);
  });
});
