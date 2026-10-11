import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { OBJECT_FORMAT, objectKeyFor, type ExportConnection, type ExportStore, type StoredObject } from '../../../../../lambda/ops/audit-export';

/**
 * In-memory stand-ins for the export job's two sides.
 *
 * FakeAuditDb models the export functions (migration 109) closely enough
 * to hold the job to their contract: windows are [watermark, xmin), a commit
 * is refused unless it starts at the watermark and reproduces the window's
 * count, seq range and digest from the rows, holds are recorded at commit and
 * excluded from comparisons, and a release batch chains after the stream's
 * last digest. Each stream's lines are canonical JSON, one per row.
 */

type Stream = 'events' | 'changes' | 'admin_actions_legacy';

export interface FakeRow {
  seq: number;
  xact: bigint;
  /** Fields of the canonical line besides seq and xact. */
  fields: Record<string, unknown>;
}

interface Batch {
  seq: number;
  stream: Stream;
  kind: 'window' | 'release';
  from?: bigint;
  to?: bigint;
  rowCount: number;
  digest: Buffer | null;
  objectKey: string | null;
}

const sha256 = (data: Buffer | string): Buffer => crypto.createHash('sha256').update(data).digest();

export class FakeAuditDb implements ExportConnection {
  readonly rows: Record<Stream, FakeRow[]> = { events: [], changes: [], admin_actions_legacy: [] };
  readonly watermark: Record<Stream, bigint> = { events: 0n, changes: 0n, admin_actions_legacy: 0n };
  readonly batches: Batch[] = [];
  readonly holds: Array<{ stream: Stream; seq: number; action: 'hold' | 'release' | 'export'; batch?: number }> = [];
  /** The current snapshot's xmin: every xact below it has finished. */
  xmin = 1000n;
  login = 'jale_job_audit_export';
  ended = false;
  readonly calls: string[] = [];
  purged: Record<Stream, number> = { events: 0, changes: 0, admin_actions_legacy: 0 };

  line(stream: Stream, row: FakeRow): string {
    return JSON.stringify({ seq: row.seq, xact: row.xact.toString(), ...row.fields });
  }

  addRow(stream: Stream, row: FakeRow): void {
    this.rows[stream].push(row);
    this.rows[stream].sort((a, b) => a.seq - b.seq);
  }

  private windowRows(stream: Stream, from: bigint, to: bigint): FakeRow[] {
    return this.rows[stream].filter((r) => r.xact >= from && r.xact < to);
  }

  private lastDigest(stream: Stream): Buffer | null {
    const withDigest = this.batches.filter((b) => b.stream === stream && b.digest !== null);
    return withDigest.length ? withDigest[withDigest.length - 1].digest : null;
  }

  private linesHash(stream: Stream, rows: FakeRow[]): Buffer {
    return sha256(rows.map((r) => `${this.line(stream, r)}\n`).join(''));
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    const fn = /jale_audit\.([a-z_]+)\(/.exec(text)?.[1] ?? (/session_user/.test(text) ? 'session_user' : 'unknown');
    this.calls.push(fn);
    const stream = values[0] as Stream;
    switch (fn) {
      case 'session_user':
        return { rows: [{ login: this.login }] };
      case 'export_window': {
        const from = this.watermark[stream];
        const to = this.xmin > from ? this.xmin : from;
        return { rows: [{ from_xact: from.toString(), to_xact: to.toString(), prev_digest: this.lastDigest(stream) }] };
      }
      case 'export_rows': {
        const [, from, to, after, limit] = values as [Stream, string, string, string, number];
        if (BigInt(to) > this.xmin) throw Object.assign(new Error('export_rows: invalid p_to'), { code: '22023' });
        const rows = this.windowRows(stream, BigInt(from), BigInt(to)).filter((r) => r.seq > Number(after)).slice(0, limit);
        return { rows: rows.map((r) => ({ seq: String(r.seq), line: this.line(stream, r) })) };
      }
      case 'export_commit': {
        const [, fromText, toText, rowCount, seqMin, seqMax, digest, objectKey, held] = values as
          [Stream, string, string, number, string | null, string | null, Buffer | null, string | null, string[]];
        const from = BigInt(fromText);
        const to = BigInt(toText);
        if (from !== this.watermark[stream]) throw Object.assign(new Error('not at the watermark'), { code: '55000' });
        if (to > this.xmin || to < from) throw Object.assign(new Error('invalid p_to'), { code: '22023' });
        if (to === from) return { rows: [{ batch: null }] };
        const heldSet = new Set((held ?? []).map(Number));
        const all = this.windowRows(stream, from, to);
        const kept = all.filter((r) => !heldSet.has(r.seq));
        if (all.filter((r) => heldSet.has(r.seq)).length !== heldSet.size) throw Object.assign(new Error('invalid p_held_seqs'), { code: '22023' });
        if (rowCount !== kept.length) throw Object.assign(new Error('invalid p_row_count'), { code: '22023' });
        const min = kept.length ? String(kept[0].seq) : null;
        const max = kept.length ? String(kept[kept.length - 1].seq) : null;
        if (seqMin !== min || seqMax !== max) throw Object.assign(new Error('invalid seq range'), { code: '22023' });
        let expected: Buffer | null = null;
        if (kept.length) {
          expected = sha256(Buffer.concat([this.lastDigest(stream) ?? Buffer.alloc(0), this.linesHash(stream, kept)]));
          if (!digest || !expected.equals(digest)) throw Object.assign(new Error('invalid p_digest'), { code: '22023' });
          if (!objectKey) throw Object.assign(new Error('invalid p_object_key'), { code: '22023' });
        } else if (digest !== null || objectKey !== null) {
          throw Object.assign(new Error('invalid p_digest'), { code: '22023' });
        }
        const batch: Batch = { seq: this.batches.length + 1, stream, kind: 'window', from, to, rowCount, digest: expected, objectKey };
        this.batches.push(batch);
        for (const seq of heldSet) this.holds.push({ stream, seq, action: 'hold', batch: batch.seq });
        this.watermark[stream] = to;
        return { rows: [{ batch: String(batch.seq) }] };
      }
      case 'export_released': {
        const released = this.holds
          .filter((h) => h.stream === stream && h.action === 'release'
            && !this.holds.some((x) => x.stream === stream && x.seq === h.seq && x.action === 'export'))
          .map((h) => h.seq);
        const rows = this.rows[stream].filter((r) => released.includes(r.seq));
        return { rows: rows.map((r) => ({ seq: String(r.seq), line: this.line(stream, r) })) };
      }
      case 'export_commit_release': {
        const [, seqs, digest, objectKey] = values as [Stream, string[], Buffer, string];
        const rows = this.rows[stream].filter((r) => seqs.map(Number).includes(r.seq));
        const expected = sha256(Buffer.concat([this.lastDigest(stream) ?? Buffer.alloc(0), this.linesHash(stream, rows)]));
        if (!expected.equals(digest)) throw Object.assign(new Error('invalid p_digest'), { code: '22023' });
        const batch: Batch = { seq: this.batches.length + 1, stream, kind: 'release', rowCount: rows.length, digest: expected, objectKey };
        this.batches.push(batch);
        for (const r of rows) this.holds.push({ stream, seq: r.seq, action: 'export', batch: batch.seq });
        return { rows: [{ batch: String(batch.seq) }] };
      }
      case 'compare_window': {
        const [, fromText, toText, held] = values as [Stream, string, string, string[] | null];
        const from = BigInt(fromText);
        const to = BigInt(toText);
        const batch = this.batches.find((b) => b.stream === stream && b.kind === 'window' && b.from === from && b.to === to);
        const excluded = new Set([
          ...(held ?? []).map(Number),
          ...this.holds.filter((h) => batch && h.batch === batch.seq && h.action === 'hold').map((h) => h.seq),
        ]);
        const rows = this.windowRows(stream, from, to).filter((r) => !excluded.has(r.seq));
        return { rows: [{ row_count: rows.length, lines_sha256: this.linesHash(stream, rows) }] };
      }
      case 'export_backlog': {
        // Committed rows at or above the watermark (every fake row is committed).
        const pending = this.rows[stream].filter((r) => r.xact >= this.watermark[stream]);
        const times = pending
          .map((r) => String(r.fields.occurred_at ?? r.fields.created_at ?? ''))
          .filter((s) => s.length > 0)
          .sort();
        return { rows: [{ pending_rows: String(pending.length), oldest_pending_at: times.length ? new Date(times[0]) : null }] };
      }
      case 'purge_expired':
        return { rows: (['events', 'changes', 'admin_actions_legacy'] as Stream[]).map((s) => ({ stream: s, deleted: this.purged[s] })) };
      default:
        throw new Error(`unexpected query: ${text}`);
    }
  }
}

export class MemoryStore implements ExportStore {
  readonly objects = new Map<string, { body: Buffer; metadata: Record<string, string>; lastModified: Date }>();
  readonly calls: string[] = [];
  deleteMarkers = false;
  /** The time new objects are stamped with. */
  clock: () => Date = () => new Date('2026-10-04T12:00:00Z');

  async putIfAbsent(key: string, body: Buffer, metadata: Record<string, string>): Promise<'created' | 'exists'> {
    this.calls.push(`put ${key}`);
    if (this.objects.has(key)) return 'exists';
    this.objects.set(key, { body, metadata, lastModified: this.clock() });
    return 'created';
  }

  async head(key: string): Promise<Record<string, string> | null> {
    this.calls.push(`head ${key}`);
    return this.objects.get(key)?.metadata ?? null;
  }

  async get(key: string): Promise<Buffer> {
    this.calls.push(`get ${key}`);
    const found = this.objects.get(key);
    if (!found) throw new Error(`no object ${key}`);
    return found.body;
  }

  async list(prefix: string): Promise<StoredObject[]> {
    this.calls.push(`list ${prefix}`);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, o]) => ({ key, lastModified: o.lastModified }));
  }

  async listPage(prefix: string, startAfter: string | undefined, maxKeys: number): Promise<{ objects: StoredObject[]; truncated: boolean }> {
    this.calls.push(`listPage ${prefix}`);
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, o]) => ({ key, lastModified: o.lastModified }));
    return { objects: all.slice(0, maxKeys), truncated: all.length > maxKeys };
  }

  async hasDeleteMarkers(): Promise<boolean> {
    return this.deleteMarkers;
  }

  text(key: string): string {
    return zlib.gunzipSync(this.objects.get(key)!.body).toString('utf8');
  }
}

/**
 * Writes a chain of `count` window objects straight into the store, as the
 * job would have written them, and records the chain's last batch in the
 * database: an archive too large to build one export run at a time. Each row
 * is a synthetic line of about the size of a real one (no real values).
 */
export function writeSyntheticChain(
  db: FakeAuditDb,
  store: MemoryStore,
  stream: Stream,
  count: number,
  options: { rowsPerObject?: number; writtenAt?: Date } = {},
): void {
  const rowsPerObject = options.rowsPerObject ?? 1;
  const writtenAt = (options.writtenAt ?? new Date('2026-09-30T10:00:00Z')).getTime();
  const fill = (n: number, salt: string) => sha256(`${salt}:${n}`).toString('hex');
  let prev: Buffer | null = db.batches.filter((b) => b.stream === stream && b.digest !== null).pop()?.digest ?? null;
  let seq = db.rows[stream].length + db.batches.filter((b) => b.stream === stream).reduce((n, b) => n + b.rowCount, 0);
  let xact = db.watermark[stream] > 0n ? db.watermark[stream] : 10n;
  for (let i = 0; i < count; i += 1) {
    const lines: string[] = [];
    const seqMin = seq + 1;
    for (let r = 0; r < rowsPerObject; r += 1) {
      seq += 1;
      const id = fill(seq, stream);
      lines.push(JSON.stringify({
        seq,
        xact: xact.toString(),
        event_id: `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`,
        occurred_at: new Date(writtenAt - (count - i) * 1000).toISOString(),
        kind: 'read',
        surface: 'employer.job_applicants',
        actor_ref: id.slice(32, 64),
        subject_ref: fill(seq, 'subject'),
        reason: null,
      }));
    }
    const body = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
    const digest = sha256(Buffer.concat([prev ?? Buffer.alloc(0), sha256(body)]));
    const from = xact;
    const to = xact + 10n;
    const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 1000) * 86_400_000).toISOString().slice(0, 10);
    const key = objectKeyFor(stream, day, from.toString());
    store.objects.set(key, {
      body: zlib.gzipSync(body),
      metadata: {
        format: OBJECT_FORMAT,
        stream,
        'batch-kind': 'window',
        'window-from': from.toString(),
        'window-to': to.toString(),
        'row-count': String(rowsPerObject),
        'seq-min': String(seqMin),
        'seq-max': String(seq),
        'held-count': '0',
        'held-seqs': '',
        'prev-digest': prev ? prev.toString('hex') : 'none',
        digest: digest.toString('hex'),
      },
      lastModified: new Date(writtenAt - (count - i)),
    });
    db.batches.push({ seq: db.batches.length + 1, stream, kind: 'window', from, to, rowCount: rowsPerObject, digest, objectKey: key });
    prev = digest;
    xact = to;
  }
  db.watermark[stream] = xact;
  if (db.xmin < xact) db.xmin = xact;
}

export { sha256 };
