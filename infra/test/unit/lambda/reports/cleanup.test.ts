import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { getDbPool } from '../../../../lambda/lib/db';
import { handler, MAX_BATCHES } from '../../../../lambda/reports/cleanup';
import { answerS3, captureConsole, fakeDb, s3Error, type ConsoleCapture, type FakeDb } from './harness';

jest.mock('../../../../lambda/lib/db', () => ({ getDbPool: jest.fn(), setRlsContext: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })) };
});

const mockGetDbPool = getDbPool as jest.Mock;
const mockS3Send = (S3Client as unknown as jest.Mock).mock.results[0].value.send as jest.Mock;

let timeline: string[];
let db: FakeDb;
let out: ConsoleCapture;

const zeros = { contents_erased: 0, images_expired: 0, pending_cleared: 0, notifications_deleted: 0, buckets_deleted: 0 };
const batch = (overrides: Record<string, unknown> = {}) => [{ ...zeros, delete_keys: [], ...overrides }];
const imageKey = () => `images/${randomUUID()}/${randomUUID()}.jpg`;
const pendingKey = () => `incoming/${randomUUID()}`;

/** Answers each cleanup call with the next batch, then all zeros. */
function batches(...answers: Array<Array<Record<string, unknown>>>) {
  let i = 0;
  db.answers.problem_report_cleanup = () => answers[i++] ?? batch();
}

beforeEach(() => {
  jest.clearAllMocks();
  timeline = [];
  db = fakeDb(timeline);
  mockGetDbPool.mockResolvedValue(db.pool);
  process.env.REPORT_IMAGES_BUCKET = 'test-report-images';
  out = captureConsole();
});

afterEach(() => {
  out.restore();
});

describe('report clean-up', () => {
  it('runs each batch in its own short transaction and deletes its keys only after the commit', async () => {
    const keys = [imageKey(), imageKey(), pendingKey()];
    batches(batch({ images_expired: 2, pending_cleared: 1, contents_erased: 4, delete_keys: keys }));
    const calls = answerS3(mockS3Send, timeline, {});

    await handler();

    expect(timeline).toEqual([
      'CONNECT',
      'BEGIN', 'problem_report_cleanup', 'COMMIT', 'S3:DeleteObjects',
      'BEGIN', 'problem_report_cleanup', 'COMMIT',
      'RELEASE',
    ]);
    expect(db.calls.problem_report_cleanup).toEqual([[500], [500]]);
    expect(calls).toEqual([{
      command: 'DeleteObjectsCommand',
      input: { Bucket: 'test-report-images', Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } },
    }]);
  });

  it('deletes exactly the keys SQL returned, across batches, and none when a batch returns none', async () => {
    const first = [imageKey(), pendingKey()];
    const second = [imageKey()];
    batches(
      batch({ images_expired: 1, pending_cleared: 1, delete_keys: first }),
      batch({ notifications_deleted: 3 }),
      batch({ images_expired: 1, delete_keys: second }),
    );
    const calls = answerS3(mockS3Send, timeline, {});
    await handler();
    expect(calls.flatMap((c) => c.input.Delete.Objects.map((o: { Key: string }) => o.Key))).toEqual([...first, ...second]);
    expect(db.calls.problem_report_cleanup).toHaveLength(4);
  });

  it('emits each kind and the run total with no dimensions once the loop is done', async () => {
    batches(
      batch({ contents_erased: 2, images_expired: 1, delete_keys: [imageKey()] }),
      batch({ notifications_deleted: 5, buckets_deleted: 7 }),
    );
    answerS3(mockS3Send, timeline, {});
    await handler();
    const metrics = out.metrics();
    expect(metrics).toEqual(expect.arrayContaining([
      { name: 'ReportCleanupDeleted', value: 2, dimensions: { Kind: 'contents_erased' } },
      { name: 'ReportCleanupDeleted', value: 1, dimensions: { Kind: 'images_expired' } },
      { name: 'ReportCleanupDeleted', value: 0, dimensions: { Kind: 'pending_cleared' } },
      { name: 'ReportCleanupDeleted', value: 5, dimensions: { Kind: 'notifications_deleted' } },
      { name: 'ReportCleanupDeleted', value: 7, dimensions: { Kind: 'buckets_deleted' } },
      { name: 'ReportCleanupDeleted', value: 15, dimensions: {} },
    ]));
    expect(metrics).toHaveLength(6);
    expect(metrics.filter((m) => m.name === 'ReportCleanupFailed')).toEqual([]);
  });

  it('emits a zero total for a run with nothing to delete', async () => {
    batches();
    answerS3(mockS3Send, timeline, {});
    await handler();
    expect(out.metrics()).toContainEqual({ name: 'ReportCleanupDeleted', value: 0, dimensions: {} });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(db.calls.problem_report_cleanup).toHaveLength(1);
  });

  it(`stops after ${50} batches and still reports the run`, async () => {
    expect(MAX_BATCHES).toBe(50);
    db.answers.problem_report_cleanup = () => batch({ buckets_deleted: 500 });
    answerS3(mockS3Send, timeline, {});
    await handler();
    expect(db.calls.problem_report_cleanup).toHaveLength(50);
    expect(out.metrics()).toContainEqual({ name: 'ReportCleanupDeleted', value: 25000, dimensions: {} });
    expect(out.logs).toEqual([expect.objectContaining({ tag: 'report_cleanup', outcome: 'capped', batches: 50 })]);
  });

  it('on a database failure rolls back, emits ReportCleanupFailed and no run total, and fails the run', async () => {
    batches(batch({ contents_erased: 3 }));
    let call = 0;
    const base = db.answers.problem_report_cleanup as (args: unknown[]) => Array<Record<string, unknown>>;
    db.answers.problem_report_cleanup = (args) => (++call === 2 ? new Error('statement timeout') : base(args));
    answerS3(mockS3Send, timeline, {});

    await expect(handler()).rejects.toThrow('statement timeout');
    expect(timeline).toContain('ROLLBACK');
    expect(timeline[timeline.length - 1]).toBe('RELEASE');
    const metrics = out.metrics();
    expect(metrics).toContainEqual({ name: 'ReportCleanupFailed', value: 1, dimensions: {} });
    expect(metrics.filter((m) => m.name === 'ReportCleanupDeleted')).toEqual([]);
  });

  it('on a storage failure emits ReportCleanupFailed and no run total, and fails the run', async () => {
    batches(batch({ images_expired: 1, delete_keys: [imageKey()] }));
    answerS3(mockS3Send, timeline, { batchDelete: s3Error('SlowDown', 503) });
    await expect(handler()).rejects.toThrow('SlowDown');
    expect(out.metrics()).toEqual([{ name: 'ReportCleanupFailed', value: 1, dimensions: {} }]);
  });

  it('fails the run when S3 reports a key it could not delete', async () => {
    const key = imageKey();
    batches(batch({ images_expired: 1, delete_keys: [key] }));
    answerS3(mockS3Send, timeline, { batchDelete: { Errors: [{ Key: key, Code: 'AccessDenied' }] } });
    await expect(handler()).rejects.toThrow();
    expect(out.metrics()).toEqual([{ name: 'ReportCleanupFailed', value: 1, dimensions: {} }]);
    expect(out.lines.join('\n')).not.toContain(key);
  });

  it('fails the run when the database cannot be reached', async () => {
    mockGetDbPool.mockRejectedValueOnce(new Error('database identity check failed'));
    await expect(handler()).rejects.toThrow();
    expect(out.metrics()).toEqual([{ name: 'ReportCleanupFailed', value: 1, dimensions: {} }]);
  });

  it('logs counts only, never a key', async () => {
    const keys = [imageKey(), pendingKey()];
    batches(batch({ images_expired: 1, pending_cleared: 1, delete_keys: keys }));
    answerS3(mockS3Send, timeline, {});
    await handler();
    expect(out.logs).toEqual([{
      tag: 'report_cleanup',
      outcome: 'ok',
      batches: 2,
      objects_deleted: 2,
      ...zeros,
      images_expired: 1,
      pending_cleared: 1,
    }]);
    for (const key of keys) expect(out.lines.join('\n')).not.toContain(key);
  });
});
