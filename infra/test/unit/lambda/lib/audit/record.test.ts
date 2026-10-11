jest.mock('../../../../../lambda/lib/audit/fallback', () => {
  const actual = jest.requireActual('../../../../../lambda/lib/audit/fallback');
  return { ...actual, writeAuditFallback: jest.fn(async () => undefined) };
});

import { auditCallerFor } from '../../../../../lambda/lib/audit/caller';
import { writeAuditFallback } from '../../../../../lambda/lib/audit/fallback';
import {
  AuditRecordError,
  RECORD_EVENT_SQL,
  buildAccessPayloads,
  buildAttemptPayload,
  normalizeFieldNames,
  recordAccess,
  recordAttempt,
  responseFieldNames,
} from '../../../../../lambda/lib/audit/record';

const EMPLOYER = '22222222-2222-4222-8222-222222222222';
const WORKER = '11111111-1111-4111-8111-111111111111';
const APPLICATION = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const REQUEST = 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef';

const employer = auditCallerFor(REQUEST, { kind: 'employer', id: EMPLOYER }, 'web');

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function sentPayloads(query: jest.Mock): Record<string, unknown>[] {
  return query.mock.calls
    .filter(([sql]) => sql === RECORD_EVENT_SQL)
    .map(([, values]) => JSON.parse((values as string[])[0]));
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('buildAccessPayloads', () => {
  it('builds the exact record_event payload for a read', () => {
    const linkExpiresAt = new Date('2026-10-05T12:15:00.000Z');
    expect(buildAccessPayloads(employer, {
      surface: 'employer.worker_profile',
      subjectUserIds: [WORKER],
      recordIds: [APPLICATION],
      resultCount: 1,
      fieldNames: ['phone', 'full_name', 'trust_assessment'],
      purpose: { kind: 'job', id: JOB },
      linkExpiresAt,
    })).toEqual([{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'employer',
      actor_id: EMPLOYER,
      channel: 'web',
      surface: 'employer.worker_profile',
      categories: ['profile', 'contact_details', 'application_answers', 'trust_assessments'],
      subject_user_ids: [WORKER],
      record_type: 'job_application',
      record_ids: [APPLICATION],
      result_count: 1,
      field_names: ['full_name', 'phone', 'trust_assessment'],
      purpose_kind: 'job',
      purpose_id: JOB,
      link_expires_at: '2026-10-05T12:15:00.000Z',
      part: 1,
      parts: 1,
      request_id: REQUEST,
    }]);
  });

  it('leaves out what does not apply: no record type, no purpose id, no link', () => {
    const worker = auditCallerFor(REQUEST, { kind: 'worker', id: WORKER }, 'web');
    const [payload] = buildAccessPayloads(worker, {
      surface: 'worker.application_defaults',
      subjectUserIds: [WORKER],
      resultCount: 1,
      fieldNames: ['answers', 'updated_at'],
      purpose: { kind: 'self' },
    });
    expect(payload).toEqual({
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'worker',
      actor_id: WORKER,
      channel: 'web',
      surface: 'worker.application_defaults',
      categories: ['saved_application_details'],
      subject_user_ids: [WORKER],
      record_ids: [],
      result_count: 1,
      field_names: ['answers', 'updated_at'],
      purpose_kind: 'self',
      part: 1,
      parts: 1,
      request_id: REQUEST,
    });
  });

  it('splits at 500 subjects or records into parts that share the request id and repeat the count', () => {
    const subjects = Array.from({ length: 1201 }, (_, i) => uuid(i + 1));
    const records = Array.from({ length: 1201 }, (_, i) => uuid(100_000 + i));
    const parts = buildAccessPayloads(employer, {
      surface: 'employer.job_applicants',
      subjectUserIds: subjects,
      recordIds: records,
      resultCount: 1201,
      purpose: { kind: 'job', id: JOB },
    });
    expect(parts.map((p) => [p.part, p.parts, p.subject_user_ids.length, p.record_ids.length, p.result_count]))
      .toEqual([[1, 3, 500, 500, 1201], [2, 3, 500, 500, 1201], [3, 3, 201, 201, 1201]]);
    expect(new Set(parts.map((p) => p.request_id))).toEqual(new Set([REQUEST]));
    expect(parts.flatMap((p) => p.subject_user_ids)).toEqual(subjects);
    expect(parts.flatMap((p) => p.record_ids)).toEqual(records);
  });

  it('splits on whichever list is longer', () => {
    const parts = buildAccessPayloads(employer, {
      surface: 'employer.applicants_overview',
      subjectUserIds: [WORKER],
      recordIds: Array.from({ length: 501 }, (_, i) => uuid(i + 1)),
      resultCount: 501,
    });
    expect(parts.map((p) => [p.part, p.subject_user_ids.length, p.record_ids.length]))
      .toEqual([[1, 1, 500], [2, 0, 1]]);
  });

  it('records exactly 500 in one part', () => {
    const parts = buildAccessPayloads(employer, {
      surface: 'employer.applicants_overview',
      subjectUserIds: Array.from({ length: 500 }, (_, i) => uuid(i + 1)),
      resultCount: 500,
    });
    expect(parts).toHaveLength(1);
  });

  it('de-duplicates ids, keeping their first order', () => {
    const [payload] = buildAccessPayloads(employer, {
      surface: 'employer.inbox',
      subjectUserIds: [WORKER, uuid(2), WORKER.toUpperCase()],
      recordIds: [uuid(9), uuid(9)],
      resultCount: 3,
    });
    expect(payload.subject_user_ids).toEqual([WORKER, uuid(2)]);
    expect(payload.record_ids).toEqual([uuid(9)]);
  });

  it('refuses what the database would refuse, before sending anything', () => {
    const base = { surface: 'employer.inbox' as const, subjectUserIds: [WORKER], resultCount: 1 };
    expect(() => buildAccessPayloads(employer, { ...base, surface: 'employer.unknown' as never })).toThrow('unknown access surface');
    expect(() => buildAccessPayloads(employer, { ...base, subjectUserIds: ['not-a-uuid'] })).toThrow('subject ids must be UUIDs');
    expect(() => buildAccessPayloads(employer, { ...base, recordIds: [42 as never] })).toThrow('record ids must be UUIDs');
    expect(() => buildAccessPayloads(employer, { ...base, resultCount: -1 })).toThrow('whole number');
    expect(() => buildAccessPayloads(employer, { ...base, resultCount: 1.5 })).toThrow('whole number');
    expect(() => buildAccessPayloads(employer, { ...base, purpose: { kind: 'job', id: 'x' } })).toThrow('needs its id');
    expect(() => buildAccessPayloads(employer, {
      surface: 'worker.application_defaults', subjectUserIds: [WORKER], recordIds: [APPLICATION], resultCount: 1,
    })).toThrow('records no record ids');
  });

  it('refuses an actor id that does not fit its kind', () => {
    const notUuid = auditCallerFor(REQUEST, { kind: 'employer', id: 'employer-id' }, 'web');
    expect(() => buildAccessPayloads(notUuid, { surface: 'employer.inbox', subjectUserIds: [], resultCount: 0 }))
      .toThrow('actor id does not fit');
    const forged = { actorKind: 'anonymous', actorId: WORKER, channel: 'web', requestId: REQUEST } as never;
    expect(() => buildAttemptPayload(forged, { surface: 'employer.inbox', outcome: 'failed' })).toThrow('actor id does not fit');
  });
});

describe('field names', () => {
  it('takes the names, never the values, of each object or list item', () => {
    expect(responseFieldNames(
      [{ worker_id: WORKER, phone: 'fixture-value' }, { worker_id: WORKER, fullName: 'fixture-value' }],
      { linkExpiresAt: 1 },
    )).toEqual(['full_name', 'link_expires_at', 'phone', 'worker_id']);
  });

  it('leaves out keys that cannot be field names and keeps at most 100', () => {
    expect(normalizeFieldNames(['ok_name', '1st', 'has-dash', 'Spaced Out', '', '_lead'])).toEqual(['ok_name']);
    expect(normalizeFieldNames(Array.from({ length: 150 }, (_, i) => `field_${String(i).padStart(3, '0')}`))).toHaveLength(100);
  });
});

describe('recordAccess', () => {
  it('writes one record_event call per part, in the open transaction', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ seq: '1' }] });
    await recordAccess({ query }, employer, {
      surface: 'employer.job_applicants',
      subjectUserIds: Array.from({ length: 600 }, (_, i) => uuid(i + 1)),
      resultCount: 600,
      purpose: { kind: 'job', id: JOB },
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([RECORD_EVENT_SQL, RECORD_EVENT_SQL]);
    expect(sentPayloads(query).map((p) => p.part)).toEqual([1, 2]);
  });

  it('throws a value-free error and emits AuditWriteFailed when the database refuses it', async () => {
    const query = jest.fn().mockRejectedValue(new Error('record_event: invalid surface'));
    const failure = recordAccess({ query }, employer, {
      surface: 'employer.worker_documents', subjectUserIds: [WORKER], resultCount: 0,
    });
    await expect(failure).rejects.toBeInstanceOf(AuditRecordError);
    await expect(failure).rejects.toThrow('audit: the access record for employer.worker_documents could not be written');
    const emf = logSpy.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(emf).toEqual([expect.objectContaining({
      _aws: expect.objectContaining({
        CloudWatchMetrics: [{ Namespace: 'Jale/Audit', Dimensions: [['Surface']], Metrics: [{ Name: 'AuditWriteFailed', Unit: 'Count' }] }],
      }),
      Surface: 'employer.worker_documents',
      AuditWriteFailed: 1,
    })]);
  });

  it('throws before querying when the event is malformed', async () => {
    const query = jest.fn();
    await expect(recordAccess({ query }, employer, {
      surface: 'employer.inbox', subjectUserIds: ['nope'], resultCount: 1,
    })).rejects.toBeInstanceOf(AuditRecordError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('buildAttemptPayload', () => {
  it('builds an attempt with no results and no field names', () => {
    expect(buildAttemptPayload(employer, {
      surface: 'employer.job_candidates',
      outcome: 'denied',
      purpose: { kind: 'job', id: JOB },
    })).toEqual({
      kind: 'attempt',
      outcome: 'denied',
      actor_kind: 'employer',
      actor_id: EMPLOYER,
      channel: 'web',
      surface: 'employer.job_candidates',
      categories: ['contact_details', 'profile', 'trust_assessments'],
      subject_user_ids: [],
      record_type: 'user',
      record_ids: [],
      result_count: 0,
      field_names: [],
      purpose_kind: 'job',
      purpose_id: JOB,
      part: 1,
      parts: 1,
      request_id: REQUEST,
    });
  });

  it('drops ids and a purpose id that are not UUIDs: they name no one', () => {
    const payload = buildAttemptPayload(employer, {
      surface: 'employer.worker_profile',
      outcome: 'not_found',
      subjectUserIds: ['not-a-uuid', WORKER, undefined],
      recordIds: ['x'],
      purpose: { kind: 'job', id: 'also-not-a-uuid' },
    });
    expect(payload.subject_user_ids).toEqual([WORKER]);
    expect(payload.record_ids).toEqual([]);
    expect(payload).not.toHaveProperty('purpose_kind');
    expect(payload).not.toHaveProperty('purpose_id');
  });
});

describe('recordAttempt', () => {
  function idleClient(query: jest.Mock) {
    return { query, getTransactionStatus: () => 'I' };
  }

  it('writes the attempt in its own transaction after the request transaction ended', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await recordAttempt(idleClient(query), employer, { surface: 'employer.worker_documents', outcome: 'denied', subjectUserIds: [WORKER] });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', RECORD_EVENT_SQL, 'COMMIT']);
    expect(sentPayloads(query)).toEqual([expect.objectContaining({ kind: 'attempt', outcome: 'denied', subject_user_ids: [WORKER] })]);
    expect(writeAuditFallback).not.toHaveBeenCalled();
  });

  it('rolls back and sends the record to the fallback when the database refuses it, without throwing', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql === RECORD_EVENT_SQL) throw new Error('connection terminated');
      return { rows: [] };
    });
    await expect(recordAttempt(idleClient(query), employer, { surface: 'employer.inbox', outcome: 'failed' })).resolves.toBeUndefined();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', RECORD_EVENT_SQL, 'ROLLBACK']);
    expect(writeAuditFallback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'attempt', outcome: 'failed', surface: 'employer.inbox' }));
  });

  it('still falls back when even ROLLBACK fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection terminated'));
    await expect(recordAttempt(idleClient(query), employer, { surface: 'employer.inbox', outcome: 'failed' })).resolves.toBeUndefined();
    expect(writeAuditFallback).toHaveBeenCalledTimes(1);
  });

  it('never runs inside a transaction it did not open', async () => {
    for (const status of ['T', 'E']) {
      const query = jest.fn();
      await recordAttempt({ query, getTransactionStatus: () => status }, employer, { surface: 'employer.inbox', outcome: 'failed' });
      expect(query).not.toHaveBeenCalled();
    }
    expect(writeAuditFallback).toHaveBeenCalledTimes(2);
  });

  it('treats a client without a status reader as idle', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await recordAttempt({ query }, employer, { surface: 'employer.inbox', outcome: 'not_found' });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', RECORD_EVENT_SQL, 'COMMIT']);
  });

  it('never throws on a malformed attempt; it reports the loss with codes only', async () => {
    const query = jest.fn();
    await expect(recordAttempt({ query }, employer, { surface: 'nope' as never, outcome: 'failed' })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(lines).toEqual([expect.objectContaining({ AuditFallbackFailed: 1, kind: 'attempt', surface: 'invalid' })]);
  });
});
