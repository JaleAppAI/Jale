import {
  loadRequirementSnapshot,
  computeRemaining,
  nextStep,
  detailsStatusFor,
  computeNextStep,
  countRemainingRequirements,
  persistMergedAnswers,
  mergeFieldAnswers,
  mergeCertificationClaims,
  mergePromptAnswers,
  seedAnswersFromDefaults,
  markDetailsCompleteIfDone,
  HIRE_REQUIREMENTS_CONSTRAINT,
  parseHireGateError,
  type RequirementSnapshot,
} from '../../../../lambda/lib/application-requirements';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const DOC_ID = '44444444-4444-4444-4444-444444444444';

const makeClient = (query: jest.Mock) => ({ query }) as any;

/** The raw shape loadRequirementSnapshot's single SELECT returns. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    worker_id: WORKER_ID,
    job_id: JOB_ID,
    application_status: 'pending',
    application_answers: {},
    prompt_answers: {},
    details_requested_at: null,
    details_completed_at: null,
    applied_at: 'applied-ts',
    updated_at: 'updated-ts',
    job_status: 'active',
    job_title: 'Framer',
    required_fields: [],
    optional_fields: [],
    required_docs: [],
    optional_docs: [],
    certification_requirements: [],
    pre_application_prompts: [],
    have_docs: [],
    ...overrides,
  };
}

/** A parsed snapshot, for the pure functions. */
function snapshot(overrides: Partial<RequirementSnapshot> = {}): RequirementSnapshot {
  return {
    applicationId: APP_ID,
    workerId: WORKER_ID,
    jobId: JOB_ID,
    applicationStatus: 'pending',
    jobStatus: 'active',
    jobTitle: 'Framer',
    answers: {},
    promptAnswers: {},
    prompts: [],
    requiredFields: [],
    optionalFields: [],
    requiredDocs: [],
    optionalDocs: [],
    certificationRequirements: [],
    haveDocs: [],
    detailsRequestedAt: null,
    detailsCompletedAt: null,
    appliedAt: 'applied-ts',
    updatedAt: 'updated-ts',
    stage: 'apply',
    ...overrides,
  };
}

const detailsStage = (overrides: Partial<RequirementSnapshot> = {}) =>
  snapshot({ stage: 'details', detailsRequestedAt: 'req-ts', ...overrides });

// ───────────────────────────────────────────────────────────────────────────
describe('loadRequirementSnapshot', () => {
  it('derives everything from ONE SELECT that joins jobs and folds job-scoped have_docs into an ARRAY(...) subquery', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [dbRow({
        required_fields: ['date_of_birth'],
        required_docs: ['resume'],
        have_docs: ['resume'],
        pre_application_prompts: [{ id: 'p1', text: 'Years?' }],
        prompt_answers: { p1: 'five' },
      })],
    });

    const snap = await loadRequirementSnapshot(makeClient(query), APP_ID);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('FROM job_applications ja JOIN jobs j');
    expect(sql).toMatch(/ARRAY\(SELECT DISTINCT wd\.doc_type\s+FROM worker_documents wd\s+WHERE wd\.worker_id = ja\.worker_id\s+AND wd\.job_id = ja\.job_id\) AS have_docs/);
    expect(query.mock.calls[0][1]).toEqual([APP_ID]);

    expect(snap).not.toBeNull();
    expect(snap!.workerId).toBe(WORKER_ID);
    expect(snap!.jobId).toBe(JOB_ID);
    expect(snap!.requiredFields).toEqual(['date_of_birth']);
    expect(snap!.haveDocs).toEqual(['resume']);
    expect(snap!.prompts).toEqual([{ id: 'p1', text: 'Years?' }]);
    expect(snap!.promptAnswers).toEqual({ p1: 'five' });
    expect(snap!.stage).toBe('apply');
  });

  it('returns null for a vanished application (its job CASCADE-deleted, or the row gone)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await loadRequirementSnapshot(makeClient(query), APP_ID)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads stage from details_requested_at, never from the literal status (B4.0 §7)', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [dbRow({ application_status: 'talking', details_requested_at: 'req-ts' })],
    });
    const snap = await loadRequirementSnapshot(makeClient(query), APP_ID);
    expect(snap!.stage).toBe('details');
  });

  it('coerces NULL jsonb/array columns to safe empties', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [dbRow({
        application_answers: null,
        prompt_answers: null,
        required_fields: null,
        optional_fields: null,
        required_docs: null,
        optional_docs: null,
        certification_requirements: null,
        pre_application_prompts: null,
        have_docs: null,
      })],
    });
    const snap = await loadRequirementSnapshot(makeClient(query), APP_ID);
    expect(snap).toMatchObject({
      answers: {},
      promptAnswers: {},
      prompts: [],
      requiredFields: [],
      optionalFields: [],
      requiredDocs: [],
      optionalDocs: [],
      certificationRequirements: [],
      haveDocs: [],
    });
  });

  it('with syncDocumentSnapshots sets the internal-user GUC, copies vault docs onto the job, then RE-READS have_docs so job-scoped counting matches the vault', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [dbRow({ required_docs: ['resume'], optional_docs: ['driver_license'], have_docs: [] })] })
      .mockResolvedValueOnce({ rows: [] })  // set_config GUC
      .mockResolvedValueOnce({ rowCount: 1 }) // non-cert snapshot copy
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] }); // have_docs re-read

    const snap = await loadRequirementSnapshot(makeClient(query), APP_ID, { syncDocumentSnapshots: true });

    expect(String(query.mock.calls[1][0])).toContain('app.current_internal_user_id');
    expect(query.mock.calls[1][1]).toEqual([WORKER_ID]);
    expect(String(query.mock.calls[2][0])).toContain('INSERT INTO worker_documents');
    expect(snap!.haveDocs).toEqual(['resume']);
  });

  it('with syncDocumentSnapshots but a job that asks for no documents at all, issues no GUC / copy / re-read', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [dbRow()] });
    const snap = await loadRequirementSnapshot(makeClient(query), APP_ID, { syncDocumentSnapshots: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(snap!.haveDocs).toEqual([]);
  });

  it('never sets a GUC when sync is off (employer sessions read through computeRemaining with their own GUC)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [dbRow({ required_docs: ['resume'] })] });
    await loadRequirementSnapshot(makeClient(query), APP_ID);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).not.toContain('set_config');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('computeRemaining', () => {
  it('an empty job is complete', () => {
    const r = computeRemaining(snapshot());
    expect(r.complete).toBe(true);
    expect(r.counts).toEqual({ prompts: 0, fields: 0, certifications: 0, docs: 0 });
  });

  it('walks required_fields in column order and uses hasOwnProperty presence (a stored false/null counts as answered)', () => {
    const r = computeRemaining(snapshot({
      requiredFields: ['work_authorization', 'date_of_birth', 'desired_pay'],
      answers: { work_authorization: false, date_of_birth: null },
    }));
    expect(r.fields).toEqual(['desired_pay']);
    expect(r.complete).toBe(false);
  });

  it('separates uncollectable docs (legacy ssn) from collectable ones and never blocks completion on them', () => {
    const r = computeRemaining(snapshot({ requiredDocs: ['ssn', 'resume'], haveDocs: ['resume'] }));
    expect(r.uncollectableDocs).toEqual(['ssn']);
    expect(r.docs).toEqual([]);
    expect(r.counts.docs).toBe(0);
    expect(r.complete).toBe(true);
  });

  it('counts a missing collectable required doc', () => {
    const r = computeRemaining(snapshot({ requiredDocs: ['resume', 'driver_license'], haveDocs: ['resume'] }));
    expect(r.docs).toEqual(['driver_license']);
    expect(r.complete).toBe(false);
  });

  it('reports unanswered optional fields and missing optional docs WITHOUT blocking completion', () => {
    const r = computeRemaining(snapshot({
      optionalFields: ['education', 'references'],
      answers: { education: { level: 'high_school' } },
      optionalDocs: ['driver_license'],
    }));
    expect(r.optionalFields).toEqual(['references']);
    expect(r.optionalDocs).toEqual(['driver_license']);
    expect(r.complete).toBe(true);
  });

  it('reports unanswered prompt ids in prompt order and blocks completion on them', () => {
    const r = computeRemaining(snapshot({
      prompts: [{ id: 'p1', text: 'a' }, { id: 'p2', text: 'b' }],
      promptAnswers: { p2: 'yes' },
    }));
    expect(r.prompts).toEqual(['p1']);
    expect(r.counts.prompts).toBe(1);
    expect(r.complete).toBe(false);
  });

  it('splits certifications into unclaimed then unproven, required tier only', () => {
    const r = computeRemaining(snapshot({
      certificationRequirements: [
        { name: 'OSHA 30', tier: 'required', proof_required: false },
        { name: 'Forklift', tier: 'required', proof_required: true },
        { name: 'Welding', tier: 'optional', proof_required: true },
      ],
      answers: { certifications: [{ name: 'Forklift', has: true, doc_ids: [] }] },
    }));
    expect(r.certifications).toEqual({ unclaimed: ['OSHA 30'], unproven: ['Forklift'] });
    expect(r.counts.certifications).toBe(2);
    expect(r.complete).toBe(false);
  });

  it('an optional-tier certification never blocks completion', () => {
    const r = computeRemaining(snapshot({
      certificationRequirements: [{ name: 'Welding', tier: 'optional', proof_required: true }],
    }));
    expect(r.certifications).toEqual({ unclaimed: [], unproven: [] });
    expect(r.complete).toBe(true);
  });

  it('tolerates a non-array answers.certifications value without throwing', () => {
    const r = computeRemaining(snapshot({
      certificationRequirements: [{ name: 'OSHA 30', tier: 'required', proof_required: false }],
      answers: { certifications: 'garbage' },
    }));
    expect(r.certifications.unclaimed).toEqual(['OSHA 30']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('nextStep', () => {
  it('exits on a filled/closed job BEFORE anything else', () => {
    for (const jobStatus of ['filled', 'closed']) {
      expect(nextStep(detailsStage({ jobStatus, requiredFields: ['date_of_birth'] }))).toEqual({
        kind: 'exit', reason: 'job_inactive',
      });
    }
  });

  it('exits on a hired/not_interested application', () => {
    for (const applicationStatus of ['hired', 'not_interested']) {
      expect(nextStep(detailsStage({ applicationStatus, requiredFields: ['date_of_birth'] }))).toEqual({
        kind: 'exit', reason: 'application_closed',
      });
    }
  });

  it('a paused job keeps going (only filled/closed exit)', () => {
    expect(nextStep(detailsStage({ jobStatus: 'paused', requiredFields: ['date_of_birth'] }))).toEqual({
      kind: 'field', key: 'date_of_birth',
    });
  });

  it("the new 'details_requested' status is not an exit", () => {
    expect(nextStep(detailsStage({ applicationStatus: 'details_requested', requiredFields: ['date_of_birth'] }))).toEqual({
      kind: 'field', key: 'date_of_birth',
    });
  });

  it('exits application_gone for a null snapshot', () => {
    expect(nextStep(null)).toEqual({ kind: 'exit', reason: 'application_gone' });
  });

  it('asks prompts before everything else, in prompt order', () => {
    expect(nextStep(detailsStage({
      prompts: [{ id: 'p1', text: 'Years?' }, { id: 'p2', text: 'Tools?' }],
      promptAnswers: {},
      requiredFields: ['date_of_birth'],
      requiredDocs: ['resume'],
    }))).toEqual({ kind: 'prompt', promptId: 'p1', text: 'Years?' });
  });

  it('STAGE GATE: in the apply stage, once prompts are done the answer is complete/apply -- fields, certs and docs are never asked', () => {
    expect(nextStep(snapshot({
      prompts: [{ id: 'p1', text: 'Years?' }],
      promptAnswers: { p1: 'five' },
      requiredFields: ['date_of_birth'],
      requiredDocs: ['resume'],
      certificationRequirements: [{ name: 'OSHA 30', tier: 'required', proof_required: false }],
    }))).toEqual({ kind: 'complete', stage: 'apply' });
  });

  it('in the details stage the order is fields -> certifications -> docs -> complete', () => {
    const base = {
      requiredFields: ['work_authorization', 'date_of_birth'],
      certificationRequirements: [
        { name: 'OSHA 30', tier: 'required' as const, proof_required: false },
        { name: 'Forklift', tier: 'required' as const, proof_required: true },
      ],
      requiredDocs: ['resume'],
    };

    expect(nextStep(detailsStage(base))).toEqual({ kind: 'field', key: 'work_authorization' });

    expect(nextStep(detailsStage({ ...base, answers: { work_authorization: true } })))
      .toEqual({ kind: 'field', key: 'date_of_birth' });

    const fieldsDone = { work_authorization: true, date_of_birth: '1990-04-03' };
    expect(nextStep(detailsStage({ ...base, answers: fieldsDone })))
      .toEqual({ kind: 'certification', name: 'OSHA 30', proofRequired: false });

    // unclaimed first, then unproven
    expect(nextStep(detailsStage({
      ...base,
      answers: { ...fieldsDone, certifications: [{ name: 'OSHA 30', has: true }, { name: 'Forklift', has: true, doc_ids: [] }] },
    }))).toEqual({ kind: 'certification', name: 'Forklift', proofRequired: true });

    const certsDone = {
      ...fieldsDone,
      certifications: [{ name: 'OSHA 30', has: true }, { name: 'Forklift', has: true, doc_ids: [DOC_ID] }],
    };
    expect(nextStep(detailsStage({ ...base, answers: certsDone })))
      .toEqual({ kind: 'doc', docType: 'resume' });

    expect(nextStep(detailsStage({ ...base, answers: certsDone, haveDocs: ['resume'] })))
      .toEqual({ kind: 'complete', stage: 'details' });
  });

  it('skips an uncollectable required doc and still reports complete/details', () => {
    expect(nextStep(detailsStage({ requiredDocs: ['ssn'] }))).toEqual({ kind: 'complete', stage: 'details' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('detailsStatusFor', () => {
  it('not_requested while details_requested_at is NULL, whatever the status says', () => {
    expect(detailsStatusFor({ details_requested_at: null, details_completed_at: null })).toBe('not_requested');
  });

  it('requested once details_requested_at is set and nothing is complete', () => {
    expect(detailsStatusFor({ details_requested_at: 'ts', details_completed_at: null })).toBe('requested');
  });

  it('complete once details_completed_at is set', () => {
    expect(detailsStatusFor({ details_requested_at: 'ts', details_completed_at: 'ts2' })).toBe('complete');
  });

  it('complete wins even if the requested timestamp was never written (defensive)', () => {
    expect(detailsStatusFor({ details_requested_at: null, details_completed_at: 'ts2' })).toBe('complete');
  });

  it('reports complete from a remaining snapshot that has nothing left, before markDetailsCompleteIfDone has flipped the timestamp', () => {
    const remaining = computeRemaining(detailsStage());
    expect(detailsStatusFor({ details_requested_at: 'ts', details_completed_at: null }, remaining)).toBe('complete');
  });

  it('stays requested when a remaining snapshot still has gaps', () => {
    const remaining = computeRemaining(detailsStage({ requiredFields: ['date_of_birth'] }));
    expect(detailsStatusFor({ details_requested_at: 'ts', details_completed_at: null }, remaining)).toBe('requested');
  });

  it('a remaining snapshot never promotes a not-yet-requested application', () => {
    const remaining = computeRemaining(snapshot());
    expect(detailsStatusFor({ details_requested_at: null, details_completed_at: null }, remaining)).toBe('not_requested');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('compat wrappers (Ivan swaps only the import path)', () => {
  /** SELECT, then the sync trio (GUC, snapshot copy, have_docs re-read). */
  const withSync = (row: Record<string, unknown>, haveDocs: string[] = []) => jest.fn()
    .mockResolvedValueOnce({ rows: [row] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rows: haveDocs.map((doc_type) => ({ doc_type })) });

  it('computeNextStep keeps the legacy 4-kind shape with `uncollectable`, and never returns prompt/certification', async () => {
    const query = withSync(dbRow({
      // A prompt and a required cert are both outstanding, but the legacy
      // wrapper walks fields -> docs only: prompts and certifications are
      // reachable ONLY through nextStep(), so Ivan's exhaustive switch
      // over NextStep keeps compiling.
      pre_application_prompts: [{ id: 'p1', text: 'Years?' }],
      certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: false }],
      details_requested_at: 'req-ts',
      required_fields: ['date_of_birth'],
      required_docs: ['ssn'],
    }));

    const step = await computeNextStep(makeClient(query), APP_ID);
    expect(step).toEqual({ kind: 'field', key: 'date_of_birth', uncollectable: ['ssn'] });
  });

  it('computeNextStep returns complete with uncollectable once fields and collectable docs are done, even in the apply stage', async () => {
    const query = withSync(dbRow({ required_docs: ['ssn'] }));
    expect(await computeNextStep(makeClient(query), APP_ID)).toEqual({ kind: 'complete', uncollectable: ['ssn'] });
  });

  it('computeNextStep maps exits with an uncollectable list, and application_gone with an empty one', async () => {
    const gone = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await computeNextStep(makeClient(gone), APP_ID)).toEqual({
      kind: 'exit', reason: 'application_gone', uncollectable: [],
    });

    const closed = withSync(dbRow({ job_status: 'filled', required_docs: ['ssn'] }));
    expect(await computeNextStep(makeClient(closed), APP_ID)).toEqual({
      kind: 'exit', reason: 'job_inactive', uncollectable: ['ssn'],
    });
  });

  it('computeNextStep syncs vault docs onto the job first, so a vault-only doc is not re-asked forever', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [dbRow({ required_docs: ['resume'], have_docs: [] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] });

    expect(await computeNextStep(makeClient(query), APP_ID)).toEqual({ kind: 'complete', uncollectable: [] });
  });

  it('countRemainingRequirements keeps nFields/nDocs/uncollectable and ADDS nCerts/nPrompts', async () => {
    const query = withSync(dbRow({
      required_fields: ['work_authorization', 'date_of_birth'],
      application_answers: { work_authorization: true },
      required_docs: ['resume', 'driver_license', 'ssn'],
      certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: false }],
      pre_application_prompts: [{ id: 'p1', text: 'Years?' }, { id: 'p2', text: 'Tools?' }],
      prompt_answers: { p1: 'five' },
    }), ['resume']);

    expect(await countRemainingRequirements(makeClient(query), APP_ID)).toEqual({
      nFields: 1, nDocs: 1, nCerts: 1, nPrompts: 1, uncollectable: ['ssn'],
    });
  });

  it('countRemainingRequirements returns all-zero for a vanished application', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await countRemainingRequirements(makeClient(query), APP_ID)).toEqual({
      nFields: 0, nDocs: 0, nCerts: 0, nPrompts: 0, uncollectable: [],
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('persistMergedAnswers', () => {
  // BINDING: this exact literal is regex-pinned by
  // infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts (~:496) as
  // mockQuery.mock.calls[1] with exactly two params -- so this function must
  // issue EXACTLY ONE query and take no SAVEPOINT of its own.
  const PIN = /UPDATE job_applications\s+SET application_answers = application_answers \|\| \$1::jsonb, updated_at = now\(\)\s+WHERE id = \$2/;

  it('issues exactly one UPDATE whose SQL satisfies the application-fill.test.ts merge-SQL pin, with exactly [json, id] params', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ total: 42 }], rowCount: 1 });
    const merged = JSON.stringify({ date_of_birth: '1990-04-03' });

    const res = await persistMergedAnswers(makeClient(query), APP_ID, merged);

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(PIN);
    expect(query.mock.calls[0][1]).toEqual([merged, APP_ID]);
    expect(res).toEqual({ total: 42 });
  });

  it('measures the post-merge total in CHARACTERS (length, not octet_length) so it agrees with the validator MAX_ANSWERS_JSON_LENGTH check', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 });
    await persistMergedAnswers(makeClient(query), APP_ID, '{}');
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('RETURNING length(application_answers::text) AS total');
    expect(sql).not.toContain('octet_length(application_answers');
  });

  it('tolerates a caller/test mock that returns no rows (total unknown, never a crash)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await persistMergedAnswers(makeClient(query), APP_ID, '{}')).toEqual({ total: null });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('mergeFieldAnswers', () => {
  const detailsRow = (overrides: Record<string, unknown> = {}) =>
    dbRow({ details_requested_at: 'req-ts', ...overrides });

  it('validates every key, merges the whole batch in ONE UPDATE, writes the defaults back, and flips details_completed_at', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['work_authorization', 'date_of_birth'] })] })
      .mockResolvedValueOnce({ rows: [] })                       // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 80 }] })           // the merge UPDATE
      .mockResolvedValueOnce({ rows: [] })                       // RELEASE SAVEPOINT
      .mockResolvedValueOnce({ rowCount: 1 })                    // defaults upsert
      .mockResolvedValueOnce({ rowCount: 1 });                   // details_completed_at

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID,
      workerId: WORKER_ID,
      answers: { work_authorization: true, date_of_birth: '1990-04-03' },
    });

    expect(res).toEqual({ ok: true, keys: ['work_authorization', 'date_of_birth'], detailsCompleted: true });

    expect(String(query.mock.calls[1][0])).toContain('SAVEPOINT');
    // ONE merge UPDATE for the whole batch, not one per key
    const [updateSql, updateParams] = query.mock.calls[2];
    expect(String(updateSql)).toContain('application_answers = application_answers || $1::jsonb');
    expect(JSON.parse(String(updateParams[0]))).toEqual({ work_authorization: true, date_of_birth: '1990-04-03' });

    expect(String(query.mock.calls[3][0])).toContain('RELEASE SAVEPOINT');
    expect(String(query.mock.calls[4][0])).toContain('INSERT INTO worker_application_defaults');
    expect(JSON.parse(String(query.mock.calls[4][1][1]))).toEqual({
      work_authorization: true, date_of_birth: '1990-04-03',
    });
    const completeSql = String(query.mock.calls[5][0]);
    expect(completeSql).toContain('details_completed_at = now()');
    expect(completeSql).toContain('details_completed_at IS NULL');
  });

  it('accepts an optional field key and writes it back as a default too', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ optional_fields: ['education'] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      answers: { education: { level: 'high_school' } },
    });
    expect(res).toMatchObject({ ok: true, keys: ['education'] });
  });

  it('rejects a key that is not in the job required/optional lists, per key, and writes nothing', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth'] })] });

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      answers: { date_of_birth: '1990-04-03', desired_pay: { amount: 25, interval: 'hourly' } },
    });

    expect(res).toEqual({ ok: false, reason: 'invalid', errors: { desired_pay: 'unknown_answer_key' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects the reserved certifications key through the field door', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [detailsRow()] });
    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      answers: { certifications: [{ name: 'OSHA 30', has: true }] },
    });
    expect(res).toEqual({ ok: false, reason: 'invalid', errors: { certifications: 'unknown_answer_key' } });
  });

  it('reports per-key validator failures as an errors map keyed on the answer key -- all or nothing, no partial write', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth', 'work_authorization'] })] });

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      answers: { date_of_birth: 'not-a-date', work_authorization: true },
    });

    expect(res).toEqual({ ok: false, reason: 'invalid', errors: { date_of_birth: 'invalid_date_of_birth' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty batch and a non-object answers payload without touching the DB', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [detailsRow()] });
    expect(await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: {},
    })).toEqual({ ok: false, reason: 'invalid', errors: {} });
    expect(await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: 'nope' as any,
    })).toEqual({ ok: false, reason: 'invalid', errors: {} });
    expect(query).not.toHaveBeenCalled();
  });

  // PER-MERGE 8192 cap (the backstop lifted from the WhatsApp mergeAnswer,
  // spec §12). It is measured on the POST-validation batch, so by
  // construction no legal input can trip it today: every per-key validator
  // bounds its own value, and the widest legal batch -- all eleven required
  // fields at their maximum bounds, work_history and references both at
  // their 3-entry ceiling -- lands well under it. That is the point of a
  // backstop, and this test is its regression guard: if a validator is ever
  // loosened enough for one merge to approach 8 KB, this fails and whoever
  // loosened it has to decide deliberately rather than silently growing the
  // column.
  const WIDEST_LEGAL_BATCH: Record<string, unknown> = {
    work_authorization: true,
    date_available: '2027-01-04',
    desired_pay: { amount: 9999, interval: 'hourly' },
    home_address: { street: 'S'.repeat(200), apartment: 'A'.repeat(50), city: 'C'.repeat(100), state: 'TX', zip: '78640-1234' },
    date_of_birth: '1990-04-03',
    emergency_contact: { name: 'N'.repeat(100), phone: '(512) 555-0000' },
    worked_here_before: { answer: true, when: 'W'.repeat(100) },
    education: { level: 'high_school', graduated: true },
    references: Array.from({ length: 3 }, () => ({
      name: 'N'.repeat(100), relationship: 'R'.repeat(50), company: 'C'.repeat(100), phone: '(512) 555-0000',
    })),
    work_history: Array.from({ length: 3 }, () => ({
      company: 'C'.repeat(100), title: 'T'.repeat(100), from: 'F'.repeat(20), to: 'T'.repeat(20),
      responsibilities: 'R'.repeat(500), reason_for_leaving: 'L'.repeat(300), may_contact: true,
    })),
    military_service: {
      served: true, branch: 'B'.repeat(50), from: 'F'.repeat(20), to: 'T'.repeat(20),
      rank_at_discharge: 'R'.repeat(50), discharge_type: 'D'.repeat(50),
    },
  };

  it('PER-MERGE 8192 backstop: the widest legally-validatable batch still merges, and stays comfortably under the cap', async () => {
    const keys = Object.keys(WIDEST_LEGAL_BATCH);
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: keys })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 6000 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: WIDEST_LEGAL_BATCH,
    });

    expect(res).toMatchObject({ ok: true });
    expect((res as { keys: string[] }).keys).toEqual(keys);
    // The merged payload actually written, measured the same way the cap is.
    const merged = String(query.mock.calls[2][1][0]);
    expect(merged.length).toBeLessThan(8192);
  });

  it('the two caps are INDEPENDENT: the widest legal batch clears the per-merge cap and is still rejected by the post-merge total, rolled back with no defaults write', async () => {
    const keys = Object.keys(WIDEST_LEGAL_BATCH);
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: keys })] })
      .mockResolvedValueOnce({ rows: [] })                    // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 20000 }] })     // merge UPDATE
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK TO SAVEPOINT

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: WIDEST_LEGAL_BATCH,
    });

    expect(res).toEqual({ ok: false, reason: 'too_large' });
    expect(String(query.mock.calls[3][0])).toContain('ROLLBACK TO SAVEPOINT');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some((c) => String(c[0]).includes('worker_application_defaults'))).toBe(false);
  });

  it('TOTAL 16384 cap: the post-merge total is checked inside a SAVEPOINT and rolled back to too_large, with no defaults write-back', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth'] })] })
      .mockResolvedValueOnce({ rows: [] })                         // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 16385 }] })          // merge UPDATE
      .mockResolvedValueOnce({ rows: [] });                        // ROLLBACK TO SAVEPOINT

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    });

    expect(res).toEqual({ ok: false, reason: 'too_large' });
    expect(String(query.mock.calls[3][0])).toContain('ROLLBACK TO SAVEPOINT');
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('accepts a post-merge total at exactly 16384', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth'] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 16384 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    expect((await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    })).ok).toBe(true);
    expect(String(query.mock.calls[3][0])).toContain('RELEASE SAVEPOINT');
  });

  it('STAGE GATE: stage_locked while the employer has not requested details yet', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [dbRow({ required_fields: ['date_of_birth'] })], // details_requested_at NULL
    });
    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    });
    expect(res).toEqual({ ok: false, reason: 'stage_locked' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('closed on a hired/not_interested application and on a filled/closed job', async () => {
    for (const overrides of [
      { application_status: 'hired' },
      { application_status: 'not_interested' },
      { job_status: 'filled' },
      { job_status: 'closed' },
    ]) {
      const query = jest.fn().mockResolvedValueOnce({
        rows: [detailsRow({ required_fields: ['date_of_birth'], ...overrides })],
      });
      expect(await mergeFieldAnswers(makeClient(query), {
        applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
      })).toEqual({ ok: false, reason: 'closed' });
    }
  });

  it('closed takes precedence over stage_locked (a hired apply-stage row is not "come back later")', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [dbRow({ application_status: 'hired', required_fields: ['date_of_birth'] })],
    });
    expect(await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    })).toEqual({ ok: false, reason: 'closed' });
  });

  it('not_found for a vanished application', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('does NOT flip details_completed_at while another requirement is still outstanding', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth'], required_docs: ['resume'], have_docs: [] })] })
      .mockResolvedValueOnce({ rows: [] })   // GUC (sync)
      .mockResolvedValueOnce({ rowCount: 0 }) // snapshot copy
      .mockResolvedValueOnce({ rows: [] })   // have_docs re-read: still nothing
      .mockResolvedValueOnce({ rows: [] })   // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 60 }] })
      .mockResolvedValueOnce({ rows: [] })   // RELEASE
      .mockResolvedValueOnce({ rowCount: 1 }); // defaults

    const res = await mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    });

    // Exactly 8 calls: there is no 9th "SET details_completed_at" UPDATE.
    expect(res).toEqual({ ok: true, keys: ['date_of_birth'], detailsCompleted: false });
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.some((c) => String(c[0]).includes('SET details_completed_at'))).toBe(false);
  });

  it('a defaults-upsert failure propagates, never swallowed, so the caller can roll the whole merge back', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [detailsRow({ required_fields: ['date_of_birth'] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' }));

    await expect(mergeFieldAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { date_of_birth: '1990-04-03' },
    })).rejects.toThrow('permission denied');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('mergeCertificationClaims', () => {
  const certRow = (overrides: Record<string, unknown> = {}) =>
    dbRow({
      details_requested_at: 'req-ts',
      certification_requirements: [
        { name: 'OSHA 30', tier: 'required', proof_required: false },
        { name: 'Forklift', tier: 'required', proof_required: true },
      ],
      ...overrides,
    });

  it('DB-confirms every claimed doc id belongs to this worker as a certification_doc, then persists under the reserved key', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID }] })   // doc ownership
      .mockResolvedValueOnce({ rows: [] })                 // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })    // merge UPDATE
      .mockResolvedValueOnce({ rows: [] })                 // RELEASE
      .mockResolvedValueOnce({ rowCount: 1 });             // details_completed_at

    const res = await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      claims: [{ name: 'OSHA 30', has: true }, { name: 'Forklift', has: true, doc_ids: [DOC_ID] }],
    });

    expect(res).toEqual({
      ok: true,
      certifications: [{ name: 'OSHA 30', has: true }, { name: 'Forklift', has: true, doc_ids: [DOC_ID] }],
      detailsCompleted: true,
    });

    const ownershipSql = String(query.mock.calls[1][0]);
    expect(ownershipSql).toContain("doc_type = 'certification_doc'");
    expect(ownershipSql).not.toContain('cert_name');
    expect(query.mock.calls[1][1]).toEqual([WORKER_ID, [DOC_ID]]);

    expect(JSON.parse(String(query.mock.calls[3][1][0]))).toEqual({
      certifications: [{ name: 'OSHA 30', has: true }, { name: 'Forklift', has: true, doc_ids: [DOC_ID] }],
    });
  });

  it('UNION by name: a claim for one cert leaves an already-stored claim for another intact', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow({
        application_answers: { certifications: [{ name: 'OSHA 30', has: true }] },
      })] })
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      claims: [{ name: 'Forklift', has: true, doc_ids: [DOC_ID] }],
    });

    expect(JSON.parse(String(query.mock.calls[3][1][0])).certifications).toEqual([
      { name: 'OSHA 30', has: true },
      { name: 'Forklift', has: true, doc_ids: [DOC_ID] },
    ]);
  });

  it('a new claim for the same name REPLACES the stored one (latest answer wins)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow({
        application_answers: { certifications: [{ name: 'OSHA 30', has: false }] },
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });

    await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      claims: [{ name: 'OSHA 30', has: true }],
    });

    expect(JSON.parse(String(query.mock.calls[2][1][0])).certifications).toEqual([
      { name: 'OSHA 30', has: true },
    ]);
  });

  it('drops a hostile/unowned doc id rather than trusting it -- only DB-confirmed ids reach the column', async () => {
    const hostile = '55555555-5555-4555-8555-555555555555';
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID }] })  // hostile id absent
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      claims: [{ name: 'Forklift', has: true, doc_ids: [DOC_ID, hostile] }],
    });

    expect(JSON.parse(String(query.mock.calls[3][1][0])).certifications).toEqual([
      { name: 'Forklift', has: true, doc_ids: [DOC_ID] },
    ]);
  });

  it('runs no ownership query when no claim carries a doc id', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });

    await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    });
    expect(query.mock.calls.every((c) => !String(c[0]).includes("doc_type = 'certification_doc'"))).toBe(true);
  });

  it('TIER DRIFT: a claim for a cert no longer in the requirements is dropped silently, never a 500', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });

    const res = await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID,
      claims: [{ name: 'OSHA 30', has: true }, { name: 'Gone', has: true }],
    });
    expect(res).toMatchObject({ ok: true });
    expect(JSON.parse(String(query.mock.calls[2][1][0])).certifications).toEqual([{ name: 'OSHA 30', has: true }]);
  });

  it('SHAPE-ONLY: an incomplete claim set is accepted (partial progress), unlike the old all-at-once apply gate', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });

    const res = await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    });
    expect(res).toMatchObject({ ok: true, detailsCompleted: false });
  });

  it('invalid for a malformed claims payload, before any write', async () => {
    for (const claims of ['nope', [{ name: 'OSHA 30' }], [{ name: 'OSHA 30', has: 'yes' }], [{ name: '', has: true }], [{ name: 'OSHA 30', has: true, doc_ids: ['../../x'] }]]) {
      const query = jest.fn().mockResolvedValueOnce({ rows: [certRow()] });
      expect(await mergeCertificationClaims(makeClient(query), {
        applicationId: APP_ID, workerId: WORKER_ID, claims,
      })).toEqual({ ok: false, reason: 'invalid' });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it('stage_locked / closed / not_found mirror the field door', async () => {
    const locked = jest.fn().mockResolvedValueOnce({ rows: [certRow({ details_requested_at: null })] });
    expect(await mergeCertificationClaims(makeClient(locked), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    })).toEqual({ ok: false, reason: 'stage_locked' });

    const closed = jest.fn().mockResolvedValueOnce({ rows: [certRow({ application_status: 'hired' })] });
    expect(await mergeCertificationClaims(makeClient(closed), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    })).toEqual({ ok: false, reason: 'closed' });

    const gone = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await mergeCertificationClaims(makeClient(gone), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps either 078 trigger cap constraint raised by the doc-snapshot sync to certification_document_limit instead of a 500', async () => {
    for (const constraint of ['certification_document_limit', 'certification_document_name_limit']) {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [certRow({ required_docs: ['certification_doc'] })] })
        .mockResolvedValueOnce({ rows: [] })  // GUC
        .mockRejectedValueOnce(Object.assign(new Error('cap'), { code: '23514', constraint }));

      expect(await mergeCertificationClaims(makeClient(query), {
        applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
      })).toEqual({ ok: false, reason: 'certification_document_limit' });
    }
  });

  it('TOTAL cap: rolls back to the savepoint and reports too_large', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [certRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 16385 }] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await mergeCertificationClaims(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, claims: [{ name: 'OSHA 30', has: true }],
    })).toEqual({ ok: false, reason: 'too_large' });
    expect(String(query.mock.calls[3][0])).toContain('ROLLBACK TO SAVEPOINT');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('mergePromptAnswers', () => {
  const promptRow = (overrides: Record<string, unknown> = {}) =>
    dbRow({
      pre_application_prompts: [{ id: 'p1', text: 'Years?' }, { id: 'p2', text: 'Tools?' }],
      ...overrides,
    });

  it('merges with the NEW object on the LEFT so an existing prompt answer wins -- write-once at SQL level', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [promptRow({ prompt_answers: { p1: 'first' } })] })
      .mockResolvedValueOnce({ rows: [] })                 // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ total: 40 }] })     // merge UPDATE
      .mockResolvedValueOnce({ rows: [] });                // RELEASE

    const res = await mergePromptAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p1: 'second', p2: 'yes' },
    });

    expect(res).toEqual({ ok: true, keys: ['p1', 'p2'] });
    const [sql, params] = query.mock.calls[2];
    expect(String(sql)).toMatch(/UPDATE job_applications\s+SET prompt_answers = \$1::jsonb \|\| prompt_answers, updated_at = now\(\)\s+WHERE id = \$2/);
    expect(JSON.parse(String(params[0]))).toEqual({ p1: 'second', p2: 'yes' });
    expect(params[1]).toBe(APP_ID);
  });

  it('works in the APPLY stage (that is where prompts live) -- never stage_locked', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [promptRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 40 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect((await mergePromptAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p1: 'a' },
    })).ok).toBe(true);
  });

  it('accepts a PARTIAL set (a WhatsApp worker finishing prompt 2 of 2 on web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [promptRow({ prompt_answers: { p1: 'first' } })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 40 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await mergePromptAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p2: 'yes' },
    })).toEqual({ ok: true, keys: ['p2'] });
  });

  it('is a no-op (no write) for an empty answers object', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [promptRow()] });
    expect(await mergePromptAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: {},
    })).toEqual({ ok: true, keys: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('invalid for an unknown prompt id, a blank answer or an oversize answer', async () => {
    for (const answers of [{ nope: 'x' }, { p1: '   ' }, { p1: 'x'.repeat(1001) }, 'nope' as any]) {
      const query = jest.fn().mockResolvedValueOnce({ rows: [promptRow()] });
      expect(await mergePromptAnswers(makeClient(query), {
        applicationId: APP_ID, workerId: WORKER_ID, answers,
      })).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('closed / not_found mirror the other doors', async () => {
    const closed = jest.fn().mockResolvedValueOnce({ rows: [promptRow({ application_status: 'not_interested' })] });
    expect(await mergePromptAnswers(makeClient(closed), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p1: 'a' },
    })).toEqual({ ok: false, reason: 'closed' });

    const gone = jest.fn().mockResolvedValueOnce({ rows: [] });
    expect(await mergePromptAnswers(makeClient(gone), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p1: 'a' },
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('guards the 12288-byte column CHECK on the POST-MERGE total inside a savepoint', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [promptRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 12289 }] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await mergePromptAnswers(makeClient(query), {
      applicationId: APP_ID, workerId: WORKER_ID, answers: { p1: 'a' },
    })).toEqual({ ok: false, reason: 'too_large' });
    expect(String(query.mock.calls[2][0])).toContain('RETURNING octet_length(prompt_answers::text) AS total');
    expect(String(query.mock.calls[3][0])).toContain('ROLLBACK TO SAVEPOINT');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('markDetailsCompleteIfDone', () => {
  it('flips details_completed_at exactly once, guarded by IS NULL', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 });
    const done = await markDetailsCompleteIfDone(makeClient(query), APP_ID, detailsStage());

    expect(done).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE job_applications\s+SET details_completed_at = now\(\), updated_at = now\(\)\s+WHERE id = \$1\s+AND details_completed_at IS NULL/);
    expect(params).toEqual([APP_ID]);
  });

  it('is a no-op in the APPLY stage even when nothing is outstanding', async () => {
    const query = jest.fn();
    expect(await markDetailsCompleteIfDone(makeClient(query), APP_ID, snapshot())).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('is a no-op while any required field / cert / doc / prompt is still outstanding', async () => {
    const query = jest.fn();
    for (const overrides of [
      { requiredFields: ['date_of_birth'] },
      { requiredDocs: ['resume'] },
      { certificationRequirements: [{ name: 'OSHA 30', tier: 'required' as const, proof_required: false }] },
      { prompts: [{ id: 'p1', text: 'Years?' }] },
    ]) {
      expect(await markDetailsCompleteIfDone(makeClient(query), APP_ID, detailsStage(overrides))).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('reports false when the guarded UPDATE matched nothing (already complete)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 0 });
    expect(await markDetailsCompleteIfDone(makeClient(query), APP_ID, detailsStage())).toBe(false);
  });

  it('loads its own snapshot when none is supplied (the GET path)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [dbRow({ details_requested_at: 'req-ts' })] })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect(await markDetailsCompleteIfDone(makeClient(query), APP_ID)).toBe(true);
    expect(String(query.mock.calls[0][0])).toContain('FROM job_applications ja JOIN jobs j');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('seedAnswersFromDefaults', () => {
  it('sets the RLS GUC first, seeds only job-relevant + absent + valid keys, in exactly one UPDATE, and returns key NAMES only', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })  // set_config
      .mockResolvedValueOnce({ rows: [{ answers: {
        work_authorization: true,
        date_of_birth: '1990-04-03',
        desired_pay: 'not-a-pay-object',
        education: { level: 'high_school' },
        military_service: { served: false },
      } }] })
      .mockResolvedValueOnce({ rows: [{ application_answers: { work_authorization: false } }] })
      .mockResolvedValueOnce({ rows: [{ total: 200 }] });

    const seeded = await seedAnswersFromDefaults(
      makeClient(query),
      { applicationId: APP_ID, workerId: WORKER_ID },
      ['work_authorization', 'date_of_birth', 'desired_pay'],
      ['education'],
    );

    // work_authorization: already answered -> skipped.
    // desired_pay: fails re-validation -> skipped silently.
    // military_service: not asked by this job -> skipped.
    expect(seeded).toEqual(['date_of_birth', 'education']);

    expect(String(query.mock.calls[0][0])).toContain('app.current_internal_user_id');
    expect(query.mock.calls[0][1]).toEqual([WORKER_ID]);
    expect(String(query.mock.calls[1][0])).toContain('FROM worker_application_defaults');
    expect(JSON.parse(String(query.mock.calls[3][1][0]))).toEqual({
      date_of_birth: '1990-04-03',
      education: { level: 'high_school' },
    });
  });

  it('short-circuits with no job_applications SELECT and no UPDATE when the worker has no defaults', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await seedAnswersFromDefaults(makeClient(query), { applicationId: APP_ID, workerId: WORKER_ID }, ['date_of_birth'], [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('short-circuits when the defaults row exists but its answers object is empty', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ answers: {} }] });
    expect(await seedAnswersFromDefaults(makeClient(query), { applicationId: APP_ID, workerId: WORKER_ID }, ['date_of_birth'], [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('issues no UPDATE when every candidate is already answered', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ answers: { date_of_birth: '1990-04-03' } }] })
      .mockResolvedValueOnce({ rows: [{ application_answers: { date_of_birth: '1988-01-01' } }] });
    expect(await seedAnswersFromDefaults(makeClient(query), { applicationId: APP_ID, workerId: WORKER_ID }, ['date_of_birth'], [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('keeps the ApplicationFillStep telemetry the WhatsApp flow emitted -- key NAMES and outcomes only, never a value', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ answers: { date_of_birth: '1990-04-03', desired_pay: 'bad' } }] })
        .mockResolvedValueOnce({ rows: [{ application_answers: {} }] })
        .mockResolvedValueOnce({ rows: [{ total: 60 }] });

      await seedAnswersFromDefaults(
        makeClient(query),
        { applicationId: APP_ID, workerId: WORKER_ID },
        ['date_of_birth', 'desired_pay'],
        [],
      );

      const events = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(events).toEqual([
        { event: 'ApplicationFillStep', key: 'desired_pay', outcome: 'seed_skipped', reason: 'invalid_default' },
        { event: 'ApplicationFillStep', key: 'date_of_birth', outcome: 'seeded' },
      ]);
      // No answer VALUE ever reaches a log line.
      expect(logSpy.mock.calls.every((c) => !String(c[0]).includes('1990-04-03'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('goes through the SAME merge choke point (application_answers || $1)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ answers: { date_of_birth: '1990-04-03' } }] })
      .mockResolvedValueOnce({ rows: [{ application_answers: {} }] })
      .mockResolvedValueOnce({ rows: [{ total: 60 }] });
    await seedAnswersFromDefaults(makeClient(query), { applicationId: APP_ID, workerId: WORKER_ID }, ['date_of_birth'], []);
    expect(String(query.mock.calls[3][0])).toMatch(/UPDATE job_applications\s+SET application_answers = application_answers \|\| \$1::jsonb, updated_at = now\(\)\s+WHERE id = \$2/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('parseHireGateError', () => {
  it('pins the constraint name the 091 trigger raises', () => {
    expect(HIRE_REQUIREMENTS_CONSTRAINT).toBe('job_applications_hire_requirements_check');
  });

  it('parses the DETAIL JSON into {fields, docs, certifications}', () => {
    const err = {
      code: '23514',
      constraint: HIRE_REQUIREMENTS_CONSTRAINT,
      detail: JSON.stringify({ fields: ['date_of_birth'], docs: ['resume'], certifications: ['OSHA 30'] }),
    };
    expect(parseHireGateError(err)).toEqual({
      fields: ['date_of_birth'], docs: ['resume'], certifications: ['OSHA 30'],
    });
  });

  it('defaults any absent bucket to an empty array', () => {
    const err = { code: '23514', constraint: HIRE_REQUIREMENTS_CONSTRAINT, detail: JSON.stringify({ docs: ['resume'] }) };
    expect(parseHireGateError(err)).toEqual({ fields: [], docs: ['resume'], certifications: [] });
  });

  it('drops non-string members rather than forwarding them to a JSON response', () => {
    const err = { code: '23514', constraint: HIRE_REQUIREMENTS_CONSTRAINT, detail: JSON.stringify({ fields: ['ok', 7, null] }) };
    expect(parseHireGateError(err)).toEqual({ fields: ['ok'], docs: [], certifications: [] });
  });

  it('returns null for a different constraint, a different SQLSTATE, or a non-error', () => {
    expect(parseHireGateError({ code: '23514', constraint: 'job_applications_status_check', detail: '{}' })).toBeNull();
    expect(parseHireGateError({ code: '23505', constraint: HIRE_REQUIREMENTS_CONSTRAINT, detail: '{}' })).toBeNull();
    expect(parseHireGateError(undefined)).toBeNull();
    expect(parseHireGateError(new Error('boom'))).toBeNull();
  });

  it('degrades to all-empty buckets when DETAIL is missing or unparseable, never throws', () => {
    expect(parseHireGateError({ code: '23514', constraint: HIRE_REQUIREMENTS_CONSTRAINT })).toEqual({
      fields: [], docs: [], certifications: [],
    });
    expect(parseHireGateError({ code: '23514', constraint: HIRE_REQUIREMENTS_CONSTRAINT, detail: 'not json' })).toEqual({
      fields: [], docs: [], certifications: [],
    });
  });
});
