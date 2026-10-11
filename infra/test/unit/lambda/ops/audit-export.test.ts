import * as zlib from 'zlib';
import {
  EXPORT_STREAMS,
  FULL_VERIFY_CONCURRENCY,
  FULL_VERIFY_STATE_KEY,
  FULL_VERIFY_TIME_SHARE,
  MAX_WINDOWS_PER_RUN,
  checkpointKey,
  createExportHandler,
  objectKeyFor,
  s3ExportStore,
  s3VerifyStateStore,
  windowDay,
  type ExportDependencies,
  type VerifyStateStore,
} from '../../../../lambda/ops/audit-export';
import { FakeAuditDb, MemoryStore, sha256, writeSyntheticChain } from './fixtures/audit-export-fakes';

/**
 * The AuditExport job: window -> rows -> scan of `reason` only
 * -> conditional put -> commit; retry adoption; release batches; the daily
 * chain rebuild and comparison; purge; and the metrics the stack alarms on.
 */

const NOW = new Date('2026-10-04T12:00:00Z');
const T = (minute: number) => new Date(Date.UTC(2026, 9, 4, 11, minute)).toISOString();

function event(seq: number, xact: bigint, reason: string | null = null, occurredAt = T(seq % 60)) {
  return { seq, xact, fields: { event_id: `e-${seq}`, occurred_at: occurredAt, kind: 'read', surface: 'employer.job_applicants', reason } };
}

function change(seq: number, xact: bigint, contextStatus = 'set', occurredAt = T(seq % 60)) {
  return { seq, xact, fields: { event_id: `c-${seq}`, occurred_at: occurredAt, table_name: 'public.users', context_status: contextStatus } };
}

function setup(db = new FakeAuditDb(), store = new MemoryStore(), now = NOW) {
  const deps: ExportDependencies = {
    connect: async () => db,
    store,
    now: () => now,
    expectedLogin: 'jale_job_audit_export',
    trailPrefix: 'cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/',
  };
  return { db, store, handler: createExportHandler(deps) };
}

let log: jest.SpyInstance;
beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => log.mockRestore());

/** The value of each EMF metric emitted, summed by name. */
function metrics(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [line] of log.mock.calls) {
    let parsed: any;
    try { parsed = JSON.parse(String(line)); } catch { continue; }
    if (!parsed?._aws) continue;
    for (const { Name } of parsed._aws.CloudWatchMetrics[0].Metrics) out[Name] = (out[Name] ?? 0) + parsed[Name];
  }
  return out;
}

function gunzipLines(store: MemoryStore, key: string): string[] {
  return store.text(key).split('\n').filter((l) => l.length > 0);
}

/** [stream, error code] of every stream the job reported as failed. */
function streamFailures(): Array<[unknown, unknown]> {
  const out: Array<[unknown, unknown]> = [];
  for (const [line] of log.mock.calls) {
    let parsed: any;
    try { parsed = JSON.parse(String(line)); } catch { continue; }
    if (parsed?.event === 'stream_failed') out.push([parsed.stream, parsed.errorCode]);
  }
  return out;
}

describe('audit export: the five-minute run', () => {
  it('reads the window, pages the rows, puts the object, then commits', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.addRow('events', event(2, 501n));
    await handler({ mode: 'export' });

    // A pending release is looked for first (none), then the window is exported.
    expect(db.calls.filter((c) => c !== 'session_user').slice(0, 4)).toEqual(['export_window', 'export_window', 'export_rows', 'export_commit']);
    const key = 'db/events/dt=2026-10-04/00000000000000000000.jsonl.gz';
    expect([...store.objects.keys()]).toEqual([key]);
    const lines = gunzipLines(store, key);
    expect(lines).toEqual([db.line('events', db.rows.events[0]), db.line('events', db.rows.events[1])]);

    // digest = sha256(prev || sha256(uncompressed object bytes)), prev empty for the first batch.
    const body = zlib.gunzipSync(store.objects.get(key)!.body);
    const digest = sha256(Buffer.concat([Buffer.alloc(0), sha256(body)]));
    expect(store.objects.get(key)!.metadata).toEqual({
      format: 'jale-audit-jsonl-gzip-v1',
      stream: 'events',
      'batch-kind': 'window',
      'window-from': '0',
      'window-to': '1000',
      'row-count': '2',
      'seq-min': '1',
      'seq-max': '2',
      'held-count': '0',
      'held-seqs': '',
      'prev-digest': 'none',
      digest: digest.toString('hex'),
    });
    expect(db.batches).toEqual([expect.objectContaining({ stream: 'events', kind: 'window', from: 0n, to: 1000n, rowCount: 2, objectKey: key })]);
    expect(db.watermark.events).toBe(1000n);
    expect(metrics()).toMatchObject({ AuditExportRunCompleted: 1, AuditValueScanHits: 0 });
    expect(db.ended).toBe(true);
  });

  it('pads the window start to 20 digits, so keys sort by window', () => {
    expect(objectKeyFor('changes', '2026-10-04', '987654321')).toBe('db/changes/dt=2026-10-04/00000000000987654321.jsonl.gz');
    expect(objectKeyFor('events', '2026-10-04', '18446744073709551615')).toBe('db/events/dt=2026-10-04/18446744073709551615.jsonl.gz');
    expect(() => objectKeyFor('events', '2026-10-04', '-1')).toThrow();
  });

  it('chains each batch to the previous one', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.xmin = 600n;
    await handler({ mode: 'export' });
    db.addRow('events', event(2, 700n));
    db.xmin = 800n;
    await handler({ mode: 'export' });
    const first = store.objects.get('db/events/dt=2026-10-04/00000000000000000000.jsonl.gz')!.metadata;
    const second = store.objects.get('db/events/dt=2026-10-04/00000000000000000600.jsonl.gz')!.metadata;
    expect(second['prev-digest']).toBe(first.digest);
    expect(db.batches.map((b) => b.digest!.toString('hex'))).toEqual([first.digest, second.digest]);
  });

  it('scans only the reason: a value there is held, the same shape elsewhere is not', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n, 'reveal for the 555-010-1234 dispute'));
    db.addRow('events', { seq: 2, xact: 501n, fields: { occurred_at: T(2), surface: 'call 555-010-1234', reason: 'a long enough neutral reason' } });
    await handler({ mode: 'export' });
    const key = 'db/events/dt=2026-10-04/00000000000000000000.jsonl.gz';
    expect(gunzipLines(store, key)).toEqual([db.line('events', db.rows.events[1])]);
    expect(store.objects.get(key)!.metadata).toMatchObject({ 'row-count': '1', 'held-count': '1', 'held-seqs': '1', 'seq-min': '2' });
    expect(db.holds).toEqual([expect.objectContaining({ stream: 'events', seq: 1, action: 'hold' })]);
    expect(metrics().AuditValueScanHits).toBe(1);
  });

  it('commits a window whose every row is held without writing an object', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n, 'mail jane@example.com'));
    await handler({ mode: 'export' });
    expect(store.objects.size).toBe(0);
    expect(db.batches).toEqual([expect.objectContaining({ rowCount: 0, digest: null, objectKey: null })]);
    expect(db.watermark.events).toBe(1000n);
  });

  it('leaves an empty window uncommitted; the daily run commits it', async () => {
    const { db, handler } = setup();
    await handler({ mode: 'export' });
    expect(db.batches).toEqual([]);
    await handler({ mode: 'daily' });
    expect(db.batches.map((b) => b.stream).sort()).toEqual(['admin_actions_legacy', 'changes', 'events']);
    expect(db.batches.every((b) => b.rowCount === 0 && b.digest === null)).toBe(true);
  });

  it('counts change rows recorded with an invalid audit context', async () => {
    const { db, handler } = setup();
    db.addRow('changes', change(1, 500n, 'invalid'));
    db.addRow('changes', change(2, 501n, 'set'));
    await handler({ mode: 'export' });
    expect(metrics().AuditContextInvalid).toBe(1);
  });

  it('reports the lag of the oldest row it exported', async () => {
    const { db, handler } = setup();
    db.addRow('events', event(1, 500n, null, '2026-10-04T11:30:00.000000Z'));
    await handler({ mode: 'export' });
    expect(metrics().AuditExportLagSeconds).toBe(1800);
  });

  it('adopts an object a crashed run wrote but did not commit, instead of writing a second one', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.xmin = 600n;
    // A run that uploaded the window [0, 600) and died before committing it.
    const crashed = new FakeAuditDb();
    crashed.addRow('events', event(1, 500n));
    crashed.xmin = 600n;
    const crashedStore = store;
    const original = crashed.query.bind(crashed);
    crashed.query = async (text: string, values?: unknown[]) => {
      if (/export_commit\(/.test(text)) throw new Error('connection lost');
      return original(text, values);
    };
    await setup(crashed, crashedStore).handler({ mode: 'export' });
    expect(metrics().AuditExportRunCompleted ?? 0).toBe(0);
    expect(store.objects.size).toBe(1);

    // The retry sees a later xmin, so its window would be [0, 900).
    db.addRow('events', event(2, 700n));
    db.xmin = 900n;
    log.mockClear();
    await handler({ mode: 'export' });
    expect(db.calls).toContain('compare_window');
    expect(db.batches[0]).toEqual(expect.objectContaining({ from: 0n, to: 600n, rowCount: 1, objectKey: 'db/events/dt=2026-10-04/00000000000000000000.jsonl.gz' }));
    // ...and then the rest of the window, as its own batch.
    expect(db.batches[1]).toEqual(expect.objectContaining({ from: 600n, to: 900n, rowCount: 1, objectKey: 'db/events/dt=2026-10-04/00000000000000000600.jsonl.gz' }));
    expect(store.objects.size).toBe(2);
    expect(metrics().AuditExportRunCompleted).toBe(1);
  });

  it('counts an adopted window as it counts one it commits itself: rows, holds, invalid contexts and lag', async () => {
    const at = '2026-10-04T11:00:00.000000Z';
    const rows = () => [
      ['events', event(1, 500n, 'call 555-010-1234 please', at)],
      ['events', event(2, 501n, null, at)],
      ['changes', change(1, 500n, 'invalid', at)],
      ['changes', change(2, 501n, 'set', at)],
    ] as const;
    // A run that uploaded the window [0, 600) of both streams and died before committing either.
    const store = new MemoryStore();
    const crashed = new FakeAuditDb();
    for (const [stream, row] of rows()) crashed.addRow(stream, row);
    crashed.xmin = 600n;
    const original = crashed.query.bind(crashed);
    crashed.query = async (text: string, values?: unknown[]) => {
      if (/export_commit\(/.test(text)) throw new Error('connection lost');
      return original(text, values);
    };
    await setup(crashed, store).handler({ mode: 'export' });
    expect(store.objects.size).toBe(2);

    // The retry sees a longer window, with one more held row after the adopted one.
    const { db, handler } = setup(new FakeAuditDb(), store);
    for (const [stream, row] of rows()) db.addRow(stream, row);
    db.addRow('events', event(3, 700n, 'mail jane@example.com', at));
    db.xmin = 900n;
    log.mockClear();
    const report = await handler({ mode: 'export' });
    expect(db.batches.map((b) => [b.stream, b.from, b.to, b.rowCount])).toEqual([
      ['events', 0n, 600n, 1], ['events', 600n, 900n, 0], ['changes', 0n, 600n, 2],
    ]);
    expect(report).toMatchObject({ complete: true, exportedRows: 3, heldRows: 2 });
    expect(metrics()).toMatchObject({ AuditContextInvalid: 1, AuditValueScanHits: 2, AuditExportLagSeconds: 3600, AuditExportRunCompleted: 1 });
  });

  it('refuses to adopt an object that does not match the database, and commits nothing', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.xmin = 600n;
    await store.putIfAbsent('db/events/dt=2026-10-04/00000000000000000000.jsonl.gz', zlib.gzipSync('{}\n'), {
      format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'window', 'window-from': '0', 'window-to': '600',
      'row-count': '1', 'seq-min': '1', 'seq-max': '1', 'held-count': '0', 'held-seqs': '', 'prev-digest': 'none',
      digest: 'ab'.repeat(32),
    });
    await handler({ mode: 'export' });
    expect(db.batches.filter((b) => b.stream === 'events')).toEqual([]);
    expect(metrics().AuditExportRunCompleted ?? 0).toBe(0);
  });

  it('reads the stored bytes before adopting: metadata that matches the database over other bytes is refused, and nothing is committed', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.xmin = 600n;
    const key = 'db/events/dt=2026-10-04/00000000000000000000.jsonl.gz';
    // Exactly the metadata the job writes for this window: its count, range
    // and digest match the database.
    const body = `${db.line('events', db.rows.events[0])}\n`;
    const metadata = {
      format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'window', 'window-from': '0', 'window-to': '600',
      'row-count': '1', 'seq-min': '1', 'seq-max': '1', 'held-count': '0', 'held-seqs': '', 'prev-digest': 'none',
      digest: sha256(Buffer.concat([Buffer.alloc(0), sha256(Buffer.from(body, 'utf8'))])).toString('hex'),
    };
    const otherBytes = [
      zlib.gzipSync(body.replace('employer.job_applicants', 'employer.other_surface')),
      zlib.gzipSync(''),
      Buffer.from('not a gzip object'),
    ];
    for (const stored of otherBytes) {
      store.objects.set(key, { body: stored, metadata: { ...metadata }, lastModified: NOW });
      log.mockClear();
      await handler({ mode: 'export' });
      expect(db.batches.filter((b) => b.stream === 'events')).toEqual([]);
      expect(db.watermark.events).toBe(0n);
      expect(metrics().AuditExportRunCompleted ?? 0).toBe(0);
      expect(streamFailures()).toEqual([['events', 'AUDIT_EXPORT_ADOPT_MISMATCH']]);
    }
    // The bytes the metadata describes are adopted.
    store.objects.set(key, { body: zlib.gzipSync(body), metadata: { ...metadata }, lastModified: NOW });
    log.mockClear();
    await handler({ mode: 'export' });
    expect(db.batches.filter((b) => b.stream === 'events')).toEqual([expect.objectContaining({ from: 0n, to: 600n, rowCount: 1, objectKey: key })]);
    expect(metrics().AuditExportRunCompleted).toBe(1);
  });

  it('keeps going with the other streams when one fails, but does not report the run complete', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    db.addRow('changes', change(1, 500n));
    const original = db.query.bind(db);
    db.query = async (text: string, values?: unknown[]) => {
      if (/export_rows/.test(text) && (values as unknown[])[0] === 'events') throw new Error('boom');
      return original(text, values);
    };
    await handler({ mode: 'export' });
    expect([...store.objects.keys()]).toEqual(['db/changes/dt=2026-10-04/00000000000000000000.jsonl.gz']);
    expect(metrics().AuditExportRunCompleted ?? 0).toBe(0);
  });

  it('exports released rows as a release batch chained after the last batch', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n, 'call 555-010-1234'));
    db.addRow('events', event(2, 501n));
    await handler({ mode: 'export' });
    const windowDigest = db.batches[0].digest!.toString('hex');
    db.holds.push({ stream: 'events', seq: 1, action: 'release' });
    await handler({ mode: 'export' });
    const key = `db/events/releases/after-${windowDigest}.jsonl.gz`;
    expect(gunzipLines(store, key)).toEqual([db.line('events', db.rows.events[0])]);
    expect(db.batches[1]).toEqual(expect.objectContaining({ kind: 'release', rowCount: 1, objectKey: key }));
    expect(store.objects.get(key)!.metadata).toMatchObject({ 'batch-kind': 'release', 'prev-digest': windowDigest, 'seq-min': '1', 'seq-max': '1' });
  });

  it('refuses to run as any login but its own, and says so', async () => {
    const db = new FakeAuditDb();
    db.login = 'jale_admin';
    const { store, handler } = setup(db);
    await expect(handler({ mode: 'export' })).rejects.toThrow('AUDIT_EXPORT_IDENTITY');
    expect(store.calls).toEqual([]);
    expect(metrics().DbIdentityCheckFailed).toBe(2);
    expect(db.ended).toBe(true);
  });
});

describe('audit export: the window day', () => {
  it("is the UTC day of the earliest row of the window's first transaction", () => {
    const lines = [
      JSON.stringify({ seq: 5, xact: '700', occurred_at: '2026-10-03T23:00:00.000000Z' }),
      JSON.stringify({ seq: 6, xact: '650', occurred_at: '2026-10-04T00:10:00.000000Z' }),
      JSON.stringify({ seq: 7, xact: '650', occurred_at: '2026-10-04T00:05:00.000000Z' }),
    ];
    expect(windowDay(lines)).toBe('2026-10-04');
  });

  it('uses the legacy stream’s created_at', () => {
    expect(windowDay([JSON.stringify({ seq: 1, xact: '9', created_at: '2025-01-02T03:04:05.000000Z' })])).toBe('2025-01-02');
  });

  it('does not move when a retry sees more of the window', () => {
    const first = [JSON.stringify({ seq: 1, xact: '500', occurred_at: '2026-10-04T00:01:00.000000Z' })];
    const later = [...first, JSON.stringify({ seq: 2, xact: '600', occurred_at: '2026-10-03T23:59:00.000000Z' })];
    expect(windowDay(later)).toBe(windowDay(first));
  });
});

describe('audit export: the daily run', () => {
  async function exported(): Promise<{ db: FakeAuditDb; store: MemoryStore; handler: (e: unknown) => Promise<any> }> {
    const ctx = setup();
    ctx.store.clock = () => new Date('2026-10-03T15:00:00Z');
    ctx.db.addRow('events', event(1, 500n));
    ctx.db.addRow('changes', change(1, 500n));
    ctx.db.xmin = 600n;
    await ctx.handler({ mode: 'export' });
    ctx.db.addRow('events', event(2, 700n));
    ctx.db.xmin = 800n;
    await ctx.handler({ mode: 'export' });
    ctx.store.clock = () => new Date('2026-10-04T11:55:00Z');
    await ctx.store.putIfAbsent('cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/2026/10/04/file.json.gz', Buffer.from('x'), {});
    log.mockClear();
    return ctx;
  }

  it('rebuilds the chain from the archive, recomputes the previous day from the database, and finds nothing wrong', async () => {
    const { db, store, handler } = await exported();
    await handler({ mode: 'daily' });
    expect(db.calls.filter((c) => c === 'compare_window')).toHaveLength(3);
    expect(store.calls.filter((c) => c.startsWith('get db/'))).toHaveLength(3);
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 0 });
  });

  it('leaves the purge and the trail check to their own invocation', async () => {
    const { db, handler } = await exported();
    await handler({ mode: 'daily' });
    expect(db.calls).not.toContain('purge_expired');
    expect(metrics()).not.toHaveProperty('AuditTrailDeliveryStale');
  });

  it('emits a mismatch when a row changed after it was exported', async () => {
    const { db, handler } = await exported();
    db.rows.events[0].fields.surface = 'changed.after_export';
    await handler({ mode: 'daily' });
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 1 });
  });

  it('emits a mismatch for an object whose bytes are not a readable gzip stream, and completes the check', async () => {
    const { store, handler } = await exported();
    store.objects.get('db/events/dt=2026-10-04/00000000000000000000.jsonl.gz')!.body = Buffer.from('not a gzip object');
    const r = await handler({ mode: 'daily' });
    expect(r.mismatches).toBe(1);
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 1 });
  });

  it('emits a mismatch when an object leaves the chain', async () => {
    const { store, handler } = await exported();
    const key = 'db/events/dt=2026-10-04/00000000000000000600.jsonl.gz';
    store.objects.get(key)!.metadata['prev-digest'] = 'cd'.repeat(32);
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
  });

  it('emits a mismatch when the chain ends short of the database', async () => {
    const { store, handler } = await exported();
    store.objects.delete('db/events/dt=2026-10-04/00000000000000000600.jsonl.gz');
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
  });

  it('accepts a missing chain start only when the lifecycle expired it: delete markers and a surviving start past the retention', async () => {
    const { store, handler } = await exported();
    store.objects.delete('db/events/dt=2026-10-04/00000000000000000000.jsonl.gz');
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
    // A delete marker alone (anyone can make one) is not enough.
    log.mockClear();
    store.deleteMarkers = true;
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
    // The surviving start is itself past the 1096-day retention: expiry.
    log.mockClear();
    store.objects.get('db/events/dt=2026-10-04/00000000000000000600.jsonl.gz')!.lastModified = new Date('2023-10-01T00:00:00Z');
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBe(0);
  });
});

describe('audit export: the incremental check', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW_MS = NOW.getTime();
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  /**
   * A history of `days` days of window objects ending two days ago, chained,
   * and the database's last batch at its tail; plus a checkpoint written
   * yesterday naming that tail.
   */
  function seeded(days: number, perDay = 4): { db: FakeAuditDb; store: MemoryStore; handler: (e: unknown) => Promise<any>; tail: string } {
    const ctx = setup();
    let prev = 'none';
    let n = 0;
    let tailKey = '';
    for (let d = days + 1; d >= 2; d -= 1) {
      const dayStart = Date.parse(`${day(NOW_MS - d * DAY)}T00:00:00Z`);
      for (let i = 0; i < perDay; i += 1) {
        n += 1;
        const digest = sha256(Buffer.from(`events-${n}`)).toString('hex');
        const key = `db/events/dt=${day(dayStart)}/${String(n * 10).padStart(20, '0')}.jsonl.gz`;
        ctx.store.objects.set(key, {
          body: zlib.gzipSync(''),
          metadata: {
            format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'window', 'window-from': String(n * 10),
            'window-to': String(n * 10 + 10), 'row-count': '1', 'seq-min': String(n), 'seq-max': String(n),
            'held-count': '0', 'held-seqs': '', 'prev-digest': prev, digest,
          },
          lastModified: new Date(dayStart + (i + 1) * 60_000),
        });
        prev = digest;
        tailKey = key;
      }
    }
    ctx.db.batches.push({ seq: 1, stream: 'events', kind: 'window', from: 0n, to: 1n, rowCount: 1, digest: Buffer.from(prev, 'hex'), objectKey: tailKey });
    const cpDay = day(NOW_MS - DAY);
    ctx.store.objects.set(checkpointKey('events', cpDay), {
      body: zlib.gzipSync(JSON.stringify({ format: 'jale-audit-check-v1', stream: 'events', day: cpDay, tailDigest: prev, tailKey })),
      metadata: {},
      lastModified: new Date(`${cpDay}T03:15:00Z`),
    });
    return { ...ctx, tail: prev };
  }

  const headsOf = (store: MemoryStore) => store.calls.filter((c) => c.startsWith('head db/events/')).length;

  it('reads only the days since the last checkpoint: its cost does not grow with the archive age', async () => {
    const young = seeded(10);
    await young.handler({ mode: 'daily' });
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 0 });
    log.mockClear();
    const old = seeded(400);
    await old.handler({ mode: 'daily' });
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 0 });
    expect(headsOf(old.store)).toBe(headsOf(young.store));
    // The checkpoint's tail, plus the objects filed within the slack before its day.
    expect(headsOf(old.store)).toBeLessThanOrEqual(1 + 2 * 4);
    expect(old.store.objects.size).toBeGreaterThan(1600);
  });

  it('records a checkpoint after a clean check, naming the verified tail', async () => {
    const { store, handler, tail } = seeded(5);
    await handler({ mode: 'daily' });
    const written = JSON.parse(zlib.gunzipSync(store.objects.get(checkpointKey('events', day(NOW_MS)))!.body).toString('utf8'));
    expect(written).toMatchObject({ format: 'jale-audit-check-v1', stream: 'events', day: day(NOW_MS), tailDigest: tail });
  });

  it('records no checkpoint after a mismatch, so the next check starts from the last good one', async () => {
    const { store, handler } = seeded(5);
    const orphanKey = `db/events/dt=${day(NOW_MS)}/99999999999999999999.jsonl.gz`;
    store.objects.set(orphanKey, {
      body: zlib.gzipSync(''),
      metadata: { format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'window', 'window-from': '9', 'window-to': '10', 'row-count': '1', 'prev-digest': 'ab'.repeat(32), digest: 'cd'.repeat(32) },
      lastModified: new Date(NOW_MS - 60_000),
    });
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(checkpointKey('events', day(NOW_MS)))).toBe(false);
  });

  it('distrusts a checkpoint whose tail object does not carry its digest', async () => {
    const { store, handler } = seeded(5);
    const cp = checkpointKey('events', day(NOW_MS - DAY));
    const body = JSON.parse(zlib.gunzipSync(store.objects.get(cp)!.body).toString('utf8'));
    store.objects.get(cp)!.body = zlib.gzipSync(JSON.stringify({ ...body, tailDigest: 'ef'.repeat(32) }));
    await handler({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBeGreaterThanOrEqual(1);
  });

  describe('a window filed under an old day, written before the check that checkpoints it', () => {
    const TODAY_EARLY = new Date(NOW_MS - 11 * 60 * 60 * 1000); // 01:00 on the check's day
    const TOMORROW = new Date(NOW_MS + DAY - 9 * 60 * 60 * 1000 + 10 * 60 * 1000); // 03:10 the next day

    /** The seeded history, then one export run at 01:00 of a window whose first transaction is ten days old. */
    async function withOldDatedWindow() {
      const ctx = seeded(5);
      ctx.db.addRow('events', event(1001, 500n, null, `${day(NOW_MS - 10 * DAY)}T22:00:00.000000Z`));
      ctx.db.xmin = 600n;
      ctx.store.clock = () => TODAY_EARLY;
      await setup(ctx.db, ctx.store, TODAY_EARLY).handler({ mode: 'export' });
      const key = `db/events/dt=${day(NOW_MS - 10 * DAY)}/00000000000000000000.jsonl.gz`;
      expect(ctx.store.objects.get(key)?.lastModified).toEqual(TODAY_EARLY);
      log.mockClear();
      return { ...ctx, key };
    }

    it('is compared with the database by that check or the next', async () => {
      const { db, store, key } = await withOldDatedWindow();
      // The row changes after its export: comparing the window must show it.
      db.rows.events.find((r) => r.seq === 1001)!.fields.surface = 'changed.after_export';
      store.clock = () => NOW;
      const today = await setup(db, store, NOW).handler({ mode: 'daily' });
      store.clock = () => TOMORROW;
      const tomorrow = await setup(db, store, TOMORROW).handler({ mode: 'daily' });
      expect((today.mismatches ?? 0) + (tomorrow.mismatches ?? 0)).toBeGreaterThanOrEqual(1);
      expect(store.calls).toContain(`get ${key}`);
    });

    it('is compared once when it matches, and the checks stay clean', async () => {
      const { db, store, key } = await withOldDatedWindow();
      store.clock = () => NOW;
      const today = await setup(db, store, NOW).handler({ mode: 'daily' });
      store.clock = () => TOMORROW;
      const tomorrow = await setup(db, store, TOMORROW).handler({ mode: 'daily' });
      expect([today.mismatches, tomorrow.mismatches]).toEqual([0, 0]);
      expect(store.calls.filter((c) => c === `get ${key}`)).toHaveLength(1);
    });
  });

  it('walks the whole stream when the chain from the checkpoint does not reach the database', async () => {
    const { db, store, handler } = seeded(5);
    // A window filed under a day far before the checkpoint, written after it.
    const lastKey = [...store.objects.keys()].filter((k) => k.startsWith('db/events/')).sort().pop()!;
    const lastDigest = store.objects.get(lastKey)!.metadata.digest;
    const lateKey = `db/events/dt=${day(NOW_MS - 30 * DAY)}/00000000000000099999.jsonl.gz`;
    // The window as the job writes it: its one row is in the database, below the watermark.
    const lateRow = { seq: 9001, xact: 99999n, fields: { event_id: 'e-late', occurred_at: `${day(NOW_MS - 30 * DAY)}T10:00:00.000000Z`, kind: 'read', reason: null } };
    db.addRow('events', lateRow);
    db.watermark.events = 100000n;
    db.xmin = 100000n;
    const lateBody = Buffer.from(`${db.line('events', lateRow)}\n`, 'utf8');
    const lateDigest = sha256(Buffer.concat([Buffer.from(lastDigest, 'hex'), sha256(lateBody)])).toString('hex');
    store.objects.set(lateKey, {
      body: zlib.gzipSync(lateBody),
      metadata: {
        format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'window', 'window-from': '99999', 'window-to': '100000',
        'row-count': '1', 'seq-min': '9001', 'seq-max': '9001', 'held-count': '0', 'held-seqs': '', 'prev-digest': lastDigest, digest: lateDigest,
      },
      lastModified: new Date(NOW_MS - 2 * 60 * 60 * 1000),
    });
    db.batches.push({ seq: 2, stream: 'events', kind: 'window', from: 99999n, to: 100000n, rowCount: 1, digest: Buffer.from(lateDigest, 'hex'), objectKey: lateKey });
    await handler({ mode: 'daily' });
    expect(log.mock.calls.map(([l]) => String(l)).some((l) => l.includes('check_full_walk'))).toBe(true);
    expect(metrics()).toMatchObject({ AuditDailyCompareCompleted: 1, AuditDailyCompareMismatch: 0 });
    // It was committed after the last clean check, so it is compared, whatever day it is filed under.
    expect(store.calls).toContain(`get ${lateKey}`);
  });
});

describe('audit export: the purge invocation', () => {
  it('purges until nothing is left, and reports completion', async () => {
    const { db, handler } = setup();
    let rounds = 0;
    const original = db.query.bind(db);
    db.query = async (text: string, values?: unknown[]) => {
      if (/purge_expired/.test(text)) {
        rounds += 1;
        db.purged = rounds < 3
          ? { events: 1000, changes: 0, admin_actions_legacy: 0 }
          : { events: 0, changes: 0, admin_actions_legacy: 0 };
      }
      return original(text, values);
    };
    await handler({ mode: 'purge' });
    expect(rounds).toBe(3);
    expect(metrics().AuditPurgeCompleted).toBe(1);
  });

  it('runs no export and no check', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 500n));
    await handler({ mode: 'purge' });
    expect(db.calls.filter((c) => c !== 'session_user')).toEqual(['purge_expired']);
    expect(store.calls.filter((c) => !c.startsWith('list cloudtrail/'))).toEqual([]);
  });

  it('flags a trail that has stopped delivering', async () => {
    const { store, handler } = setup();
    await handler({ mode: 'purge' });
    expect(metrics().AuditTrailDeliveryStale).toBe(1);
    log.mockClear();
    store.clock = () => new Date('2026-10-04T11:55:00Z');
    await store.putIfAbsent('cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/2026/10/04/file.json.gz', Buffer.from('x'), {});
    await handler({ mode: 'purge' });
    expect(metrics().AuditTrailDeliveryStale).toBe(0);
  });

  it('reports no completion when the purge fails', async () => {
    const { db, handler } = setup();
    const original = db.query.bind(db);
    db.query = async (text: string, values?: unknown[]) => {
      if (/purge_expired/.test(text)) throw new Error('boom');
      return original(text, values);
    };
    await handler({ mode: 'purge' });
    expect(metrics().AuditPurgeCompleted ?? 0).toBe(0);
  });
});

describe('audit export: release batches across a crash', () => {
  it('commits a release object a crashed run left behind before anything else, so the chain never forks', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 10n));
    db.addRow('events', event(2, 11n, 'call 555-010-1234 please'));
    db.xmin = 20n;
    await handler({ mode: 'export' });
    db.holds.push({ stream: 'events', seq: 2, action: 'release' });
    // The release object is written, then its commit fails.
    const realQuery = db.query.bind(db);
    let failRelease = true;
    db.query = async (text: string, values?: unknown[]) => {
      if (failRelease && /export_commit_release/.test(text)) {
        failRelease = false;
        throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      }
      return realQuery(text, values);
    };
    expect((await handler({ mode: 'export' })).complete).toBe(false);
    // New rows arrive before the retry.
    db.addRow('events', event(3, 25n));
    db.xmin = 30n;
    expect((await handler({ mode: 'export' })).complete).toBe(true);

    const releaseKeys = [...store.objects.keys()].filter((k) => k.includes('/releases/'));
    expect(releaseKeys).toHaveLength(1);
    const prevs = [...store.objects.entries()].filter(([k]) => k.startsWith('db/')).map(([, o]) => o.metadata['prev-digest']);
    expect(new Set(prevs).size).toBe(prevs.length);
    // The window after the release chains to it.
    const release = store.objects.get(releaseKeys[0])!.metadata.digest;
    expect(prevs).toContain(release);
    log.mockClear();
    const daily = await handler({ mode: 'daily' });
    expect(daily.mismatches).toBe(0);
    expect(metrics().AuditDailyCompareMismatch).toBe(0);
  });

  it('refuses to adopt a release object that does not chain, and exports nothing after it', async () => {
    const { db, store, handler } = setup();
    db.addRow('events', event(1, 10n));
    db.xmin = 20n;
    await handler({ mode: 'export' });
    const last = db.batches[0].digest!.toString('hex');
    await store.putIfAbsent(`db/events/releases/after-${last}.jsonl.gz`, zlib.gzipSync('{"seq":1}\n'), {
      format: 'jale-audit-jsonl-gzip-v1', stream: 'events', 'batch-kind': 'release', 'prev-digest': 'ab'.repeat(32), digest: 'cd'.repeat(32),
    });
    db.addRow('events', event(2, 25n));
    db.xmin = 30n;
    const r = await handler({ mode: 'export' });
    expect(r.complete).toBe(false);
    expect(db.batches.filter((b) => b.stream === 'events')).toHaveLength(1);
  });
});

describe('audit export: a stalled window', () => {
  it('reports the age of rows held back by an open transaction, and no completed run', async () => {
    const { db, handler } = setup(new FakeAuditDb(), new MemoryStore(), new Date('2026-10-06T12:00:00Z'));
    db.watermark.events = 10n;
    db.xmin = 10n;
    db.addRow('events', { seq: 7, xact: 11n, fields: { event_id: 'e-7', occurred_at: '2026-10-04T11:00:00.000000Z', kind: 'read', reason: null } });
    db.addRow('events', { seq: 8, xact: 12n, fields: { event_id: 'e-8', occurred_at: '2026-10-04T11:01:00.000000Z', kind: 'read', reason: null } });
    const r = await handler({ mode: 'export' });
    expect(r.complete).toBe(false);
    expect(r.exportedRows).toBe(0);
    const m = metrics();
    expect(m.AuditExportLagSeconds).toBe(2 * 24 * 60 * 60 + 60 * 60);
    expect(m.AuditExportRunCompleted ?? 0).toBe(0);
  });

  it('counts rows pending for under ten minutes as lag, not a stall', async () => {
    const { db, handler } = setup(new FakeAuditDb(), new MemoryStore(), new Date('2026-10-04T12:00:00Z'));
    db.watermark.events = 10n;
    db.xmin = 10n;
    db.addRow('events', { seq: 7, xact: 11n, fields: { event_id: 'e-7', occurred_at: '2026-10-04T11:55:00.000000Z', kind: 'read', reason: null } });
    await handler({ mode: 'export' });
    expect(metrics()).toMatchObject({ AuditExportLagSeconds: 300, AuditExportRunCompleted: 1 });
  });

  it('fails closed when the backlog cannot be read', async () => {
    const { db, handler } = setup();
    const original = db.query.bind(db);
    db.query = async (text: string, values?: unknown[]) => {
      if (/export_backlog/.test(text)) throw Object.assign(new Error('function does not exist'), { code: '42883' });
      return original(text, values);
    };
    const r = await handler({ mode: 'export' });
    expect(r.complete).toBe(false);
    expect(metrics().AuditExportRunCompleted ?? 0).toBe(0);
  });
});

describe('audit export: the dashboard action stream', () => {
  it('exports legacy lines by their own time field, whatever identity columns they carry', async () => {
    const { db, store, handler } = setup();
    db.addRow('admin_actions_legacy', { seq: 1, xact: 500n, fields: { id: 'a-1', created_at: '2026-10-02T09:00:00.000000Z', actor_admin_id: 'f-1', action: 'resolve_case' } });
    await handler({ mode: 'export' });
    expect([...store.objects.keys()]).toEqual(['db/admin_actions_legacy/dt=2026-10-02/00000000000000000000.jsonl.gz']);
  });

  it('holds a record whose justification carries a value, whatever separators it uses, and exports the rest', async () => {
    const { db, store, handler } = setup();
    const legacy = (seq: number, justification: string) => ({
      seq, xact: BigInt(500 + seq), fields: {
        id: `a-${seq}`, created_at: '2026-10-02T09:00:00.000000Z', actor_admin_id: 'f-1', action: 'reveal_contact',
        metadata: { justification, summary: 'admin_ops requested reveal_contact for admin_case.' },
      },
    });
    db.addRow('admin_actions_legacy', legacy(1, 'Calling back on 555 010-1234 about the case.'));
    db.addRow('admin_actions_legacy', legacy(2, 'Wrote to someone@example.com about it.'));
    db.addRow('admin_actions_legacy', legacy(3, 'A neutral reason that is long enough.'));
    const report = await handler({ mode: 'export' });
    const key = 'db/admin_actions_legacy/dt=2026-10-02/00000000000000000000.jsonl.gz';
    expect(gunzipLines(store, key)).toEqual([db.line('admin_actions_legacy', db.rows.admin_actions_legacy[2])]);
    expect(store.objects.get(key)!.metadata).toMatchObject({ 'row-count': '1', 'held-count': '2', 'held-seqs': '1,2' });
    expect(db.holds.map((h) => [h.stream, h.seq, h.action])).toEqual([
      ['admin_actions_legacy', 1, 'hold'], ['admin_actions_legacy', 2, 'hold'],
    ]);
    expect(report).toMatchObject({ exportedRows: 1, heldRows: 2 });
    expect(metrics().AuditValueScanHits).toBe(2);
  });
});

describe('audit export: the weekly full verification', () => {
  class MemoryState implements VerifyStateStore {
    body: string | null = null;
    writes = 0;
    async read() { return this.body; }
    async write(body: string) { this.writes += 1; this.body = body; }
  }

  /** The export function's timeout (the stack's 600 s). */
  const TIMEOUT_MS = 600_000;

  /** A handler on a fixed clock: time never runs out, so each invocation goes as far as it can. */
  function at(iso: string, db: FakeAuditDb, store: MemoryStore, state: MemoryState) {
    const handler = createExportHandler({
      connect: async () => db,
      store,
      now: () => new Date(iso),
      expectedLogin: 'jale_job_audit_export',
      trailPrefix: 'cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/',
      verifyState: state,
    });
    return (e: unknown) => handler(e, { getRemainingTimeInMillis: () => TIMEOUT_MS });
  }

  /** An archive written by the job itself: `windows` windows of one row each in the events stream. */
  async function archive(windows: number): Promise<{ db: FakeAuditDb; store: MemoryStore; state: MemoryState }> {
    const db = new FakeAuditDb();
    const store = new MemoryStore();
    const state = new MemoryState();
    for (let i = 1; i <= windows; i += 1) {
      db.addRow('events', event(i, BigInt(i * 10), null, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000000Z`));
      db.xmin = BigInt(i * 10 + 5);
      store.clock = () => new Date('2026-09-30T10:00:00Z');
      await at('2026-09-30T10:00:00Z', db, store, state)({ mode: 'export' });
    }
    log.mockClear();
    return { db, store, state };
  }

  async function runPass(handler: (e: unknown) => Promise<any>, max = 100): Promise<any> {
    for (let i = 0; i < max; i += 1) {
      const r = await handler({ mode: 'full-verify' });
      if (r.passFinished) return r;
    }
    throw new Error('the pass never finished');
  }

  /**
   * Virtual time for a paced walk. Each store request takes `requestMs`, and
   * requests in flight together overlap, as round trips do; each object read
   * also takes `cpuMs` of the job's own time, which does not. A walk that
   * keeps several objects in flight therefore goes faster, and one that does
   * not, does not.
   */
  class Pace {
    now: number;
    inFlight = 0;
    maxInFlight = 0;
    private pending: Array<{ due: number; resolve: () => void }> = [];
    private scheduled = false;

    constructor(start: string, readonly requestMs: number, readonly cpuMs: number) {
      this.now = Date.parse(start);
    }

    async request(): Promise<void> {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise<void>((resolve) => {
        this.pending.push({ due: this.now + this.requestMs, resolve });
        this.wake();
      });
      this.inFlight -= 1;
    }

    /** Once everything runnable has run, completes the earliest requests due. */
    private wake(): void {
      if (this.scheduled) return;
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        if (this.pending.length === 0) return;
        this.now = Math.max(this.now, Math.min(...this.pending.map((p) => p.due)));
        const ready = this.pending.filter((p) => p.due <= this.now);
        this.pending = this.pending.filter((p) => p.due > this.now);
        for (const p of ready) p.resolve();
        if (this.pending.length > 0) this.wake();
      });
    }
  }

  /** One hourly invocation on the paced clock; how long it ran. */
  async function invokePaced(pace: Pace, db: FakeAuditDb, store: MemoryStore, state: MemoryState, failGet?: (n: number) => boolean) {
    let gets = 0;
    const handler = createExportHandler({
      connect: async () => db,
      store: {
        putIfAbsent: (key, body, metadata) => store.putIfAbsent(key, body, metadata),
        head: async (key) => { await pace.request(); return store.head(key); },
        get: async (key) => {
          gets += 1;
          const n = gets;
          await pace.request();
          if (failGet?.(n)) throw new Error('Task timed out');
          pace.now += pace.cpuMs;
          return store.get(key);
        },
        list: (prefix) => store.list(prefix),
        listPage: async (prefix, after, max) => { await pace.request(); return store.listPage(prefix, after, max); },
        hasDeleteMarkers: () => store.hasDeleteMarkers(),
      },
      now: () => new Date(pace.now),
      expectedLogin: 'jale_job_audit_export',
      trailPrefix: 'cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/',
      verifyState: {
        read: async () => { await pace.request(); return state.read(); },
        write: async (body) => { await pace.request(); return state.write(body); },
      },
    });
    const enteredAt = pace.now;
    const report = await handler({ mode: 'full-verify' }, { getRemainingTimeInMillis: () => enteredAt + TIMEOUT_MS - pace.now });
    return { report, elapsedMs: pace.now - enteredAt };
  }

  function savedPass(state: MemoryState): any {
    return JSON.parse(state.body!).pass;
  }

  /** Every value the job reported for the hours since its last completed pass. */
  function hoursSinceCompleted(): number[] {
    const out: number[] = [];
    for (const [line] of log.mock.calls) {
      let parsed: any;
      try { parsed = JSON.parse(String(line)); } catch { continue; }
      if (parsed?._aws && typeof parsed.AuditFullVerifyHoursSinceCompleted === 'number') out.push(parsed.AuditFullVerifyHoursSinceCompleted);
    }
    return out;
  }

  it('finds nothing wrong in an archive the job wrote, and reports completion', async () => {
    const { db, store, state } = await archive(6);
    const r = await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    expect(r.mismatches).toBe(0);
    expect(metrics()).toMatchObject({ AuditFullVerifyMismatch: 0, AuditFullVerifyCompleted: 1 });
  });

  it("detects a replaced body on an object far older than the daily check's window", async () => {
    const { db, store, state } = await archive(6);
    // A clean daily check writes a checkpoint; the next one reads only recent days.
    store.clock = () => new Date('2026-10-04T03:10:00Z');
    await at('2026-10-04T03:10:00Z', db, store, state)({ mode: 'daily' });
    const oldKey = [...store.objects.keys()].filter((k) => k.startsWith('db/events/dt=2026-09-')).sort()[0];
    const old = store.objects.get(oldKey)!;
    store.objects.set(oldKey, { body: zlib.gzipSync('{"seq":1,"forged":true}\n'), metadata: { ...old.metadata }, lastModified: new Date('2026-10-04T09:00:00Z') });
    log.mockClear();
    await at('2026-10-05T03:10:00Z', db, store, state)({ mode: 'daily' });
    expect(metrics().AuditDailyCompareMismatch).toBe(0); // the incremental check does not see it
    log.mockClear();
    const r = await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    expect(r.mismatches).toBeGreaterThan(0);
    expect(metrics().AuditFullVerifyMismatch).toBeGreaterThan(0);
  });

  it('detects an object whose digest was recomputed to match its forged body: the chain no longer closes', async () => {
    const { db, store, state } = await archive(5);
    const keys = [...store.objects.keys()].filter((k) => k.startsWith('db/events/')).sort();
    const target = store.objects.get(keys[1])!;
    const forged = Buffer.from('{"seq":99}\n');
    const prev = Buffer.from(target.metadata['prev-digest'], 'hex');
    const digest = sha256(Buffer.concat([prev, sha256(forged)])).toString('hex');
    store.objects.set(keys[1], { body: zlib.gzipSync(forged), metadata: { ...target.metadata, digest, 'row-count': '1', 'seq-min': '99', 'seq-max': '99' }, lastModified: target.lastModified });
    const r = await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    expect(r.mismatches).toBeGreaterThan(0);
  });

  it('counts an object whose bytes are not a readable gzip stream as a mismatch, and finishes the pass', async () => {
    const { db, store, state } = await archive(4);
    const keys = [...store.objects.keys()].filter((k) => k.startsWith('db/events/')).sort();
    store.objects.get(keys[1])!.body = Buffer.from('not a gzip object');
    const r = await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    // One mismatch, the unreadable object: its chain link is still the metadata's.
    expect(r).toMatchObject({ passFinished: true, mismatches: 1 });
    expect(metrics()).toMatchObject({ AuditFullVerifyMismatch: 1, AuditFullVerifyCompleted: 1 });
    // Every object after it was read too, once.
    expect(store.calls.filter((c) => c.startsWith('get db/events/')).sort()).toEqual(keys.map((k) => `get ${k}`));
  });

  it('detects a duplicated object and a chain that ends short of the database', async () => {
    const dup = await archive(4);
    const key = [...dup.store.objects.keys()].filter((k) => k.startsWith('db/events/')).sort()[0];
    dup.store.objects.set(key.replace('.jsonl.gz', '0.jsonl.gz'), { ...dup.store.objects.get(key)! });
    expect((await runPass(at('2026-10-05T05:00:00Z', dup.db, dup.store, dup.state))).mismatches).toBeGreaterThan(0);

    const short = await archive(4);
    const last = [...short.store.objects.keys()].filter((k) => k.startsWith('db/events/')).sort().pop()!;
    short.store.objects.delete(last);
    expect((await runPass(at('2026-10-05T05:00:00Z', short.db, short.store, short.state))).mismatches).toBeGreaterThan(0);
  });

  it('refuses to walk without the time its invocation has left', async () => {
    const { db, store, state } = await archive(1);
    const handler = createExportHandler({
      connect: async () => db, store, now: () => new Date('2026-10-05T05:00:00Z'), expectedLogin: 'jale_job_audit_export',
      trailPrefix: 'cloudtrail/AWSLogs/111122223333/CloudTrail/us-east-2/', verifyState: state,
    });
    await expect(handler({ mode: 'full-verify' })).rejects.toThrow('AUDIT_EXPORT_CONFIG');
    await expect(handler({ mode: 'full-verify' }, { getRemainingTimeInMillis: () => 0 })).rejects.toThrow('AUDIT_EXPORT_CONFIG');
    expect(state.writes).toBe(0);
  });

  it(`keeps ${FULL_VERIFY_CONCURRENCY} objects in flight, starts none after ${FULL_VERIFY_TIME_SHARE * 100}% of its time, and resumes where it stopped`, async () => {
    const db = new FakeAuditDb();
    const store = new MemoryStore();
    const state = new MemoryState();
    writeSyntheticChain(db, store, 'events', 1000);
    const keys = [...store.objects.keys()].sort();
    // Ten seconds a request: an object (a HEAD and a GET) takes twenty.
    const pace = new Pace('2026-10-05T05:00:00Z', 10_000, 0);

    const first = await invokePaced(pace, db, store, state);
    expect(first.report.passFinished).toBe(false);
    expect(pace.maxInFlight).toBe(FULL_VERIFY_CONCURRENCY);
    // It stopped starting objects at 480 s: what it had in flight finished
    // (one object, twenty seconds), then it saved (one request).
    expect(first.elapsedMs).toBeGreaterThanOrEqual(FULL_VERIFY_TIME_SHARE * TIMEOUT_MS);
    expect(first.elapsedMs).toBeLessThanOrEqual(FULL_VERIFY_TIME_SHARE * TIMEOUT_MS + 3 * pace.requestMs);
    const saved = savedPass(state).streams.events;
    expect(saved.objects).toBeGreaterThan(300);
    expect(saved.cursor).toBe(keys[saved.objects - 1]);

    let gets = store.calls.filter((c) => c.startsWith('get db/')).length;
    expect(gets).toBe(saved.objects);
    let finished: any;
    for (let hour = 6; hour < 12 && !finished; hour += 1) {
      pace.now = Date.parse(`2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`);
      const run = await invokePaced(pace, db, store, state);
      expect(run.elapsedMs).toBeLessThan(TIMEOUT_MS);
      if (run.report.passFinished) finished = run.report;
    }
    expect(finished).toMatchObject({ passFinished: true, mismatches: 0 });
    // Each object was read exactly once across the invocations.
    gets = store.calls.filter((c) => c.startsWith('get db/')).length;
    expect(gets).toBe(1000);
    expect(log.mock.calls.map(([l]) => String(l)).some((l) => l.includes('"event":"full_verify_completed"') && l.includes('"objects":1000'))).toBe(true);
  });

  it('loses only the unsaved work of a run that is cut off, and the next run resumes from the saved page', async () => {
    const db = new FakeAuditDb();
    const store = new MemoryStore();
    const state = new MemoryState();
    writeSyntheticChain(db, store, 'events', 1200);
    const pace = new Pace('2026-10-05T05:00:00Z', 10_000, 0);
    await invokePaced(pace, db, store, state);
    const afterFirst = state.body;

    // The second run dies mid-walk (a timeout, a lost sandbox): nothing it read since its last save is kept.
    pace.now = Date.parse('2026-10-05T06:00:00Z');
    await expect(invokePaced(pace, db, store, state, (n) => n === 100)).rejects.toThrow('Task timed out');
    expect(state.body).toBe(afterFirst);

    let finished: any;
    for (let hour = 7; hour < 14 && !finished; hour += 1) {
      pace.now = Date.parse(`2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`);
      const run = await invokePaced(pace, db, store, state);
      if (run.report.passFinished) finished = run.report;
    }
    // Counted once each: a double-counted or skipped object would break the chain equation.
    expect(finished).toMatchObject({ passFinished: true, mismatches: 0 });
    expect(log.mock.calls.map(([l]) => String(l)).some((l) => l.includes('"event":"full_verify_completed"') && l.includes('"objects":1200'))).toBe(true);
  });

  it('walks the largest archive the retention allows within a week, so the overdue alarm stays quiet', async () => {
    // The largest archive: every five-minute run writing its most windows on
    // every stream, for the whole lifecycle (objects expire on day 1097).
    const LARGEST = MAX_WINDOWS_PER_RUN * EXPORT_STREAMS.length * 288 * 1097;
    // The pace. S3 round trips cannot be measured here (no AWS calls): 50 ms
    // a request, so 100 ms an object, is the upper end of the 40-100 ms an
    // object is expected to take. The job's own time was measured locally at
    // 1.6 ms for a 1,000-row object; 5 ms allows for a 1,024 MB function's
    // share of a vCPU.
    const REQUEST_MS = 50;
    const CPU_MS = 5;
    // Simulated with fewer objects, each costing proportionally more time, so
    // the pass needs as many hourly invocations as the largest archive would.
    const PER_STREAM = 5000;
    const SIMULATED = PER_STREAM * EXPORT_STREAMS.length;
    const scale = LARGEST / SIMULATED;
    const db = new FakeAuditDb();
    const store = new MemoryStore();
    const state = new MemoryState();
    for (const stream of EXPORT_STREAMS) writeSyntheticChain(db, store, stream, PER_STREAM);
    const start = Date.parse('2026-10-05T00:00:00Z');
    const pace = new Pace('2026-10-05T00:00:00Z', REQUEST_MS * scale, CPU_MS * scale);

    const completedAtHour: number[] = [];
    let longest = 0;
    for (let hour = 0; completedAtHour.length < 2; hour += 1) {
      if (hour > 2 * 168) throw new Error('two passes did not finish in two weeks');
      pace.now = start + hour * 3_600_000;
      const run = await invokePaced(pace, db, store, state);
      longest = Math.max(longest, run.elapsedMs);
      if (run.report.passFinished) {
        expect(run.report.mismatches).toBe(0);
        completedAtHour.push(hour);
      }
    }
    // Each invocation ends on its own, before the timeout.
    expect(longest).toBeLessThan(TIMEOUT_MS);
    // The first pass (started at hour 0) and the next (due at hour 168) each take under a week...
    expect(completedAtHour[0]).toBeLessThan(168);
    expect(completedAtHour[1] - 168).toBeLessThan(168);
    // ...so the age the overdue alarm reads never passes its 192 hours.
    expect(Math.max(...hoursSinceCompleted())).toBeLessThanOrEqual(192);
  }, 120_000);

  it('runs a new pass only once a week, and reports how long since the last one', async () => {
    const { db, store, state } = await archive(3);
    await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    store.calls.length = 0;
    log.mockClear();
    const idle = await at('2026-10-08T05:00:00Z', db, store, state)({ mode: 'full-verify' });
    expect(idle.passFinished).toBe(false);
    expect(store.calls).toEqual([]);
    expect(metrics().AuditFullVerifyHoursSinceCompleted).toBe(72);
    log.mockClear();
    const due = await runPass(at('2026-10-12T05:00:00Z', db, store, state));
    expect(due.mismatches).toBe(0);
    expect(metrics().AuditFullVerifyCompleted).toBe(1);
  });

  it('leaves objects written after the pass started to the next pass, and accepts a commit in flight', async () => {
    const db = new FakeAuditDb();
    const store = new MemoryStore();
    const state = new MemoryState();
    writeSyntheticChain(db, store, 'events', 600);
    const pace = new Pace('2026-10-05T05:00:00Z', 10_000, 0);
    const first = await invokePaced(pace, db, store, state);
    expect(first.report.passFinished).toBe(false);
    // A new window is exported mid-pass.
    db.addRow('events', event(5000, db.watermark.events + 1n));
    db.xmin = db.watermark.events + 5n;
    store.clock = () => new Date('2026-10-05T05:30:00Z');
    await at('2026-10-05T05:30:00Z', db, store, state)({ mode: 'export' });
    let finished: any;
    for (let hour = 6; hour < 12 && !finished; hour += 1) {
      pace.now = Date.parse(`2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`);
      const run = await invokePaced(pace, db, store, state);
      if (run.report.passFinished) finished = run.report;
    }
    expect(finished).toMatchObject({ passFinished: true, mismatches: 0 });
  });

  it('starts over when its saved state cannot be trusted', async () => {
    const { db, store, state } = await archive(2);
    state.body = '{"format":"jale-audit-full-verify-v1","pass":null,"lastStartedAt":"2099-01-01T00:00:00Z","lastCompletedAt":null}';
    const r = await runPass(at('2026-10-05T05:00:00Z', db, store, state));
    expect(r.mismatches).toBe(0);
    expect(log.mock.calls.map(([l]) => String(l)).some((l) => l.includes('full_verify_state_reset'))).toBe(true);
  });
});

it('keeps the full verification state outside the archive', () => {
  expect(FULL_VERIFY_STATE_KEY.startsWith('db/') || FULL_VERIFY_STATE_KEY.startsWith('checks/')).toBe(false);
});

it('refuses an unknown mode', async () => {
  const { handler } = setup();
  await expect(handler({ mode: 'other' })).rejects.toThrow('AUDIT_EXPORT_MODE');
});

describe('the S3 export store', () => {
  function failure(status: number): Error {
    return Object.assign(new Error(`status ${status}`), { $metadata: { httpStatusCode: status } });
  }

  it('writes with the metadata, a checksum and If-None-Match, and reports an existing key', async () => {
    const send = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure(412)).mockRejectedValueOnce(failure(500));
    const store = s3ExportStore({ send } as any, 'archive');
    await expect(store.putIfAbsent('db/events/x.jsonl.gz', Buffer.from('b'), { stream: 'events' })).resolves.toBe('created');
    await expect(store.putIfAbsent('db/events/x.jsonl.gz', Buffer.from('b'), { stream: 'events' })).resolves.toBe('exists');
    await expect(store.putIfAbsent('db/events/x.jsonl.gz', Buffer.from('b'), { stream: 'events' })).rejects.toThrow('status 500');
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'archive', Key: 'db/events/x.jsonl.gz', Body: Buffer.from('b'), ContentType: 'application/gzip',
      Metadata: { stream: 'events' }, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256',
    });
  });

  it('reads metadata, and answers null for a missing key', async () => {
    const send = jest.fn().mockResolvedValueOnce({ Metadata: { digest: 'd' } }).mockRejectedValueOnce(failure(404));
    const store = s3ExportStore({ send } as any, 'archive');
    await expect(store.head('k')).resolves.toEqual({ digest: 'd' });
    await expect(store.head('k')).resolves.toBeNull();
  });

  it('lists every page', async () => {
    const at = new Date('2026-10-04T00:00:00Z');
    const send = jest.fn()
      .mockResolvedValueOnce({ Contents: [{ Key: 'a', LastModified: at }], IsTruncated: true, NextContinuationToken: 't' })
      .mockResolvedValueOnce({ Contents: [{ Key: 'b', LastModified: at }], IsTruncated: false });
    const store = s3ExportStore({ send } as any, 'archive');
    await expect(store.list('db/events/')).resolves.toEqual([{ key: 'a', lastModified: at }, { key: 'b', lastModified: at }]);
    expect(send.mock.calls[1][0].input).toMatchObject({ Prefix: 'db/events/', ContinuationToken: 't' });
  });

  it('finds a delete marker on any page', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ DeleteMarkers: [], IsTruncated: true, NextKeyMarker: 'k', NextVersionIdMarker: 'v' })
      .mockResolvedValueOnce({ DeleteMarkers: [{ Key: 'x' }], IsTruncated: false });
    await expect(s3ExportStore({ send } as any, 'archive').hasDeleteMarkers('db/events/')).resolves.toBe(true);
    const none = jest.fn().mockResolvedValueOnce({ IsTruncated: false });
    await expect(s3ExportStore({ send: none } as any, 'archive').hasDeleteMarkers('db/events/')).resolves.toBe(false);
  });
});

describe('the S3 export store pages and the full verification state', () => {
  it('lists one page after a key', async () => {
    const at = new Date('2026-10-04T00:00:00Z');
    const send = jest.fn().mockResolvedValueOnce({ Contents: [{ Key: 'b', LastModified: at }], IsTruncated: true });
    const store = s3ExportStore({ send } as any, 'archive');
    await expect(store.listPage('db/events/', 'a', 1)).resolves.toEqual({ objects: [{ key: 'b', lastModified: at }], truncated: true });
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'archive', Prefix: 'db/events/', StartAfter: 'a', MaxKeys: 1 });
  });

  it('reads and writes the state object, and answers null when there is none', async () => {
    const failure = (status: number) => Object.assign(new Error(`status ${status}`), { $metadata: { httpStatusCode: status } });
    const send = jest.fn()
      .mockResolvedValueOnce({ Body: { transformToString: async () => '{"x":1}' } })
      .mockRejectedValueOnce(failure(404))
      .mockRejectedValueOnce(failure(403))
      .mockResolvedValueOnce({});
    const state = s3VerifyStateStore({ send } as any, 'results');
    await expect(state.read()).resolves.toBe('{"x":1}');
    await expect(state.read()).resolves.toBeNull();
    await expect(state.read()).rejects.toThrow('status 403');
    await state.write('{"y":2}');
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'results', Key: FULL_VERIFY_STATE_KEY });
    expect(send.mock.calls[3][0].input).toEqual({ Bucket: 'results', Key: FULL_VERIFY_STATE_KEY, Body: '{"y":2}', ContentType: 'application/json' });
  });
});
