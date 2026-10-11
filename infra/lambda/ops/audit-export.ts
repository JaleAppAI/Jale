import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { emitEmfMetrics, type EmfMetric } from '../lib/emf';
import { scanForValues } from './audit-value-patterns';

/**
 * The audit export job, AuditExport. It copies the database's
 * audit records into the archive, connected as its own login
 * (`jale_job_audit_export`), which can only call the export functions.
 *
 * EVERY FIVE MINUTES (`{"mode":"export"}`), for each stream (events, changes,
 * and the dashboard's frozen action records):
 *   0. commit a release batch a crashed run left behind (below);
 *   1. read the window, [watermark, current snapshot xmin);
 *   2. page through its rows, as canonical JSON lines built by the database;
 *   3. scan only the free text, an event's `reason` and a dashboard action
 *      record's justification: a row whose free text holds a phone number,
 *      an email address or a link is held, not exported;
 *   4. write the other rows as one gzip object with `If-None-Match: *` and an
 *      SDK checksum, under `db/<stream>/dt=<day>/<window start, 20 digits>.jsonl.gz`,
 *      with the window, the counts and the digest chain in its metadata;
 *   5. commit the window (the database recomputes it and refuses anything it
 *      cannot reproduce) and move on to the next.
 * Then released rows go out as a release batch. An empty window is left for
 * the daily run, so quiet streams do not write a batch row every 5 minutes.
 * Last, the stream's backlog (`export_backlog`): committed rows the export has
 * not reached. An open transaction holds the window back while its rows age
 * there, so the lag metric is the oldest of them, and a stream whose oldest
 * pending row is past ten minutes is stalled: the run is not complete.
 *
 * DIGEST. digest = sha256(previous digest || sha256(uncompressed object
 * bytes)). The metadata carries both, so the archive alone defines the chain.
 *
 * RETRY ADOPTION. The key depends only on the window start: the day is that
 * of the earliest row of the window's first transaction, which a later,
 * longer window still starts with. If the key already exists, a run crashed
 * between upload and commit: the job reads that object's metadata and bytes,
 * checks both against the database (compare_window) and commits that window,
 * instead of writing a second object. A release batch is keyed by the digest it follows,
 * so a crashed one is found and committed before any other batch could follow
 * that digest: the chain never forks.
 *
 * DAILY at 03:10 UTC (`{"mode":"daily"}`): the same export, committing empty
 * windows too; then, per stream, the digest chain checked from the archive's
 * objects and their metadata alone, incrementally from the last checkpoint,
 * and every batch committed since the last clean check read again, whatever
 * day it is filed under: each against its digest, and a window batch also
 * recomputed from the database. A release batch is checked by its bytes only;
 * the database checked its rows when it was committed.
 *
 * DAILY at 03:40 UTC (`{"mode":"purge"}`), on its own so a slow check never
 * holds it back: the retention purge, then a check that the trail is still
 * delivering to the archive.
 *
 * HOURLY (`{"mode":"full-verify"}`): once a week, a walk of the whole archive
 * in time-bounded, resumable chunks (see runFullVerify).
 *
 * Nothing here logs a row, a line or a value: only stages, counts and codes.
 */

export const EXPORT_STREAMS = ['events', 'changes', 'admin_actions_legacy'] as const;
export type ExportStream = (typeof EXPORT_STREAMS)[number];

export const OBJECT_FORMAT = 'jale-audit-jsonl-gzip-v1';

const METRIC_NAMESPACE = 'Jale/Audit';
const MASTER_LOGIN = 'jale_admin';
const PAGE_SIZE = 1000;
/** Windows per stream per run: a stream that keeps growing cannot keep one run going. */
export const MAX_WINDOWS_PER_RUN = 5;
/** export_commit's limit on held rows per window. */
const MAX_HELD = 10000;
/** S3 user metadata is limited to 2 KB in all; longer held lists are recomputed on adoption. */
const MAX_HELD_METADATA = 1500;
const PURGE_BATCH = 1000;
const MAX_PURGE_ROUNDS = 50;
/** The trail delivers every few minutes; two hours without a file is a stopped trail. */
const TRAIL_STALE_MS = 2 * 60 * 60 * 1000;
const HEAD_CONCURRENCY = 16;

const XID = /^\d{1,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

export interface ExportQueryable {
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ExportConnection extends ExportQueryable {
  end(): Promise<void>;
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

export interface ExportStore {
  /** Writes the object unless the key exists. */
  putIfAbsent(key: string, body: Buffer, metadata: Record<string, string>): Promise<'created' | 'exists'>;
  /** The object's metadata, or null when there is none. */
  head(key: string): Promise<Record<string, string> | null>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<StoredObject[]>;
  /** One page of keys under the prefix, in key order, after `startAfter`. */
  listPage(prefix: string, startAfter: string | undefined, maxKeys: number): Promise<{ objects: StoredObject[]; truncated: boolean }>;
  /** True when the lifecycle has expired anything under the prefix. */
  hasDeleteMarkers(prefix: string): Promise<boolean>;
}

export interface ExportDependencies {
  connect(): Promise<ExportConnection>;
  store: ExportStore;
  now(): Date;
  /** The login the job must be connected as (DB_EXPECTED_LOGIN). */
  expectedLogin: string;
  /** `cloudtrail/AWSLogs/<account>/CloudTrail/<region>/`, for the delivery check. */
  trailPrefix: string;
  /** Where the weekly full verification keeps its progress (outside the archive). */
  verifyState?: VerifyStateStore;
}

/** The part of the Lambda context the job reads: the time its invocation has left. */
export interface InvocationContext {
  getRemainingTimeInMillis(): number;
}

export interface ExportReport {
  mode: 'export' | 'daily' | 'purge' | 'full-verify';
  complete: boolean;
  exportedRows: number;
  heldRows: number;
  mismatches?: number;
  /** full-verify: this invocation finished a pass. */
  passFinished?: boolean;
}

// ── Keys and lines ──────────────────────────────────────────────────────

/** `db/<stream>/dt=<day>/<from, zero-padded to 20 digits>.jsonl.gz`. */
export function objectKeyFor(stream: ExportStream, day: string, from: string): string {
  if (!XID.test(from)) throw new Error('AUDIT_EXPORT_KEY: invalid window start');
  if (!DAY.test(day)) throw new Error('AUDIT_EXPORT_KEY: invalid day');
  return `db/${stream}/dt=${day}/${from.padStart(20, '0')}.jsonl.gz`;
}

/** A release batch's key: named by the digest it chains after, which a retry still sees. */
export function releaseKeyFor(stream: ExportStream, prev: Buffer | null): string {
  return `db/${stream}/releases/after-${prev ? prev.toString('hex') : 'genesis'}.jsonl.gz`;
}

interface Line {
  seq: string;
  line: string;
  xact: bigint;
  time: string | null;
  /** The line's free text: an event's reason, or a dashboard action record's justification. */
  freeText: string[];
  contextStatus: unknown;
}

/** The free text a line carries; every other field is a validated code, id, name, count or time. */
function freeTextOf(parsed: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof parsed.reason === 'string') out.push(parsed.reason);
  const metadata = parsed.metadata;
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const justification = (metadata as Record<string, unknown>).justification;
    if (typeof justification === 'string') out.push(justification);
  }
  return out;
}

function parseLine(seq: string, line: string): Line {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const time = typeof parsed.occurred_at === 'string' ? parsed.occurred_at
    : typeof parsed.created_at === 'string' ? parsed.created_at : null;
  if (typeof parsed.xact !== 'string' || !XID.test(parsed.xact)) throw new Error('AUDIT_EXPORT_LINE: no xact');
  return { seq, line, xact: BigInt(parsed.xact), time, freeText: freeTextOf(parsed), contextStatus: parsed.context_status };
}

function dayOfLines(lines: Line[]): string {
  let first: Line[] = [];
  for (const line of lines) {
    if (first.length === 0 || line.xact < first[0].xact) first = [line];
    else if (line.xact === first[0].xact) first.push(line);
  }
  const times = first.map((l) => l.time).filter((t): t is string => t !== null && DAY.test(t.slice(0, 10))).sort();
  if (times.length === 0) throw new Error('AUDIT_EXPORT_LINE: no time');
  return times[0].slice(0, 10);
}

/**
 * The UTC day a window is filed under: that of the earliest row of the
 * window's first transaction. A retry's longer window starts with the same
 * transaction, so the day, and the key, do not move.
 */
export function windowDay(lines: string[]): string {
  return dayOfLines(lines.map((line) => parseLine('0', line)));
}

function isHeld(line: Line): boolean {
  return line.freeText.some((text) => scanForValues(text).length > 0);
}

function bodyOf(lines: Line[]): Buffer {
  return Buffer.from(lines.map((l) => `${l.line}\n`).join(''), 'utf8');
}

function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function chain(prev: Buffer | null, linesHash: Buffer): Buffer {
  return sha256(Buffer.concat([prev ?? Buffer.alloc(0), linesHash]));
}

function hexOrNone(digest: Buffer | null): string {
  return digest ? digest.toString('hex') : 'none';
}

/** An object's uncompressed bytes, or null when they are not a readable gzip stream. */
function gunzipOrNull(data: Buffer): Buffer | null {
  try {
    return zlib.gunzipSync(data);
  } catch {
    return null;
  }
}

// ── Database calls ──────────────────────────────────────────────────────

interface Window { from: string; to: string; prev: Buffer | null }

async function exportWindow(db: ExportQueryable, stream: ExportStream): Promise<Window> {
  const { rows } = await db.query<{ from_xact: string; to_xact: string; prev_digest: Buffer | null }>(
    'SELECT from_xact::text AS from_xact, to_xact::text AS to_xact, prev_digest FROM jale_audit.export_window($1)',
    [stream],
  );
  const [row] = rows;
  if (!row || !XID.test(row.from_xact) || !XID.test(row.to_xact)) throw new Error('AUDIT_EXPORT_WINDOW');
  return { from: row.from_xact, to: row.to_xact, prev: row.prev_digest ?? null };
}

async function windowLines(db: ExportQueryable, stream: ExportStream, from: string, to: string): Promise<Line[]> {
  const lines: Line[] = [];
  let after = '0';
  for (;;) {
    const { rows } = await db.query<{ seq: string; line: string }>(
      'SELECT seq::text AS seq, line FROM jale_audit.export_rows($1, $2::xid8, $3::xid8, $4::bigint, $5::integer)',
      [stream, from, to, after, PAGE_SIZE],
    );
    for (const row of rows) lines.push(parseLine(String(row.seq), row.line));
    if (rows.length < PAGE_SIZE) return lines;
    after = String(rows[rows.length - 1].seq);
  }
}

interface Commit {
  from: string;
  to: string;
  rowCount: number;
  seqMin: string | null;
  seqMax: string | null;
  digest: Buffer | null;
  key: string | null;
  held: string[];
}

async function exportCommit(db: ExportQueryable, stream: ExportStream, c: Commit): Promise<void> {
  await db.query(
    'SELECT jale_audit.export_commit($1, $2::xid8, $3::xid8, $4::integer, $5::bigint, $6::bigint, $7::bytea, $8::text, $9::bigint[])::text AS batch',
    [stream, c.from, c.to, c.rowCount, c.seqMin, c.seqMax, c.digest, c.key, c.held],
  );
}

async function compareWindow(db: ExportQueryable, stream: ExportStream, from: string, to: string, held: string[] | null):
Promise<{ rowCount: number; linesSha256: Buffer }> {
  const { rows } = await db.query<{ row_count: number; lines_sha256: Buffer }>(
    'SELECT row_count, lines_sha256 FROM jale_audit.compare_window($1, $2::xid8, $3::xid8, $4::bigint[])',
    [stream, from, to, held],
  );
  return { rowCount: Number(rows[0].row_count), linesSha256: rows[0].lines_sha256 };
}

// ── The export run ──────────────────────────────────────────────────────

interface StreamResult {
  exported: number;
  held: number;
  contextInvalid: number;
  oldestExported: string | null;
}

function metadataFor(stream: ExportStream, c: Commit, prev: Buffer | null, kind: 'window' | 'release'): Record<string, string> {
  const metadata: Record<string, string> = {
    format: OBJECT_FORMAT,
    stream,
    'batch-kind': kind,
  };
  if (kind === 'window') {
    metadata['window-from'] = c.from;
    metadata['window-to'] = c.to;
  }
  metadata['row-count'] = String(c.rowCount);
  metadata['seq-min'] = c.seqMin ?? '';
  metadata['seq-max'] = c.seqMax ?? '';
  if (kind === 'window') {
    metadata['held-count'] = String(c.held.length);
    const held = c.held.join(',');
    if (held.length <= MAX_HELD_METADATA) metadata['held-seqs'] = held;
  }
  metadata['prev-digest'] = hexOrNone(prev);
  metadata.digest = hexOrNone(c.digest);
  return metadata;
}

/** What one committed window holds: the rows it exported and the rows it held. */
interface Committed { kept: Line[]; held: number }

/**
 * Commits the window a crashed run uploaded under `key`, after checking its
 * metadata and its stored bytes against the database: what is committed is
 * what the archive holds. Returns what that window holds, which can be less
 * than the window this run read.
 */
async function adoptWindow(db: ExportQueryable, store: ExportStore, stream: ExportStream, window: Window, key: string): Promise<Committed> {
  const meta = await store.head(key);
  if (!meta || meta.format !== OBJECT_FORMAT || meta.stream !== stream || meta['batch-kind'] !== 'window'
    || meta['window-from'] !== window.from || !XID.test(meta['window-to'] ?? '')
    || BigInt(meta['window-to']) <= BigInt(window.from) || BigInt(meta['window-to']) > BigInt(window.to)) {
    throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: object');
  }
  if (meta['prev-digest'] !== hexOrNone(window.prev)) throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: chain');
  const to = meta['window-to'];
  const lines = await windowLines(db, stream, window.from, to);
  const held = meta['held-seqs'] !== undefined
    ? meta['held-seqs'].split(',').filter((s) => s.length > 0)
    : lines.filter(isHeld).map((l) => l.seq);
  if (held.length !== Number(meta['held-count'])) throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: holds');
  const compared = await compareWindow(db, stream, window.from, to, held);
  const digest = chain(window.prev, compared.linesSha256);
  if (compared.rowCount !== Number(meta['row-count']) || digest.toString('hex') !== meta.digest) {
    throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: content');
  }
  // The bytes themselves: their hash is the database's, so their digest is the metadata's.
  const body = gunzipOrNull(await store.get(key));
  if (!body || !sha256(body).equals(compared.linesSha256)) throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: body');
  await exportCommit(db, stream, {
    from: window.from,
    to,
    rowCount: compared.rowCount,
    seqMin: meta['seq-min'] || null,
    seqMax: meta['seq-max'] || null,
    digest,
    key,
    held,
  });
  logLine({ event: 'window_adopted', stream });
  const heldSeqs = new Set(held);
  return { kept: lines.filter((l) => !heldSeqs.has(l.seq)), held: held.length };
}

/** Adds one committed window to the stream's counts, the same whether this run wrote it or adopted it. */
function countCommitted(result: StreamResult, committed: Committed): void {
  result.exported += committed.kept.length;
  result.held += committed.held;
  result.contextInvalid += committed.kept.filter((l) => l.contextStatus === 'invalid').length;
  for (const line of committed.kept) {
    if (line.time && (result.oldestExported === null || line.time < result.oldestExported)) result.oldestExported = line.time;
  }
}

async function exportWindows(db: ExportQueryable, store: ExportStore, stream: ExportStream, commitEmpty: boolean): Promise<StreamResult> {
  const result: StreamResult = { exported: 0, held: 0, contextInvalid: 0, oldestExported: null };
  for (let n = 0; n < MAX_WINDOWS_PER_RUN; n += 1) {
    const window = await exportWindow(db, stream);
    if (window.from === window.to) break;
    const lines = await windowLines(db, stream, window.from, window.to);
    if (lines.length === 0) {
      if (commitEmpty) {
        await exportCommit(db, stream, { from: window.from, to: window.to, rowCount: 0, seqMin: null, seqMax: null, digest: null, key: null, held: [] });
      }
      break;
    }
    const held = lines.filter(isHeld);
    const kept = lines.filter((l) => !isHeld(l));
    if (held.length > MAX_HELD) throw new Error('AUDIT_EXPORT_TOO_MANY_HELD');

    const commit: Commit = {
      from: window.from,
      to: window.to,
      rowCount: kept.length,
      seqMin: kept.length ? kept[0].seq : null,
      seqMax: kept.length ? kept[kept.length - 1].seq : null,
      digest: null,
      key: null,
      held: held.map((l) => l.seq),
    };
    if (kept.length > 0) {
      const body = bodyOf(kept);
      commit.digest = chain(window.prev, sha256(body));
      commit.key = objectKeyFor(stream, dayOfLines(lines), window.from);
      const stored = await store.putIfAbsent(commit.key, zlib.gzipSync(body), metadataFor(stream, commit, window.prev, 'window'));
      if (stored === 'exists') {
        countCommitted(result, await adoptWindow(db, store, stream, window, commit.key));
        continue;
      }
    }
    await exportCommit(db, stream, commit);
    countCommitted(result, { kept, held: held.length });
    logLine({ event: 'window_committed', stream, rows: kept.length, held: held.length });
  }
  return result;
}

/**
 * Commits the release batch stored under `key`, which follows `prev`: what a
 * crashed run wrote, read back and checked against the chain; the database
 * recomputes it from the rows and refuses anything it cannot reproduce.
 */
async function commitStoredRelease(db: ExportQueryable, store: ExportStore, stream: ExportStream, prev: Buffer | null, key: string): Promise<number> {
  const meta = await store.head(key);
  const body = zlib.gunzipSync(await store.get(key));
  const seqs = body.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => String(JSON.parse(l).seq));
  const digest = chain(prev, sha256(body));
  if (!meta || meta.format !== OBJECT_FORMAT || meta['batch-kind'] !== 'release' || meta['prev-digest'] !== hexOrNone(prev)
    || meta.digest !== digest.toString('hex') || seqs.length === 0) {
    throw new Error('AUDIT_EXPORT_ADOPT_MISMATCH: release');
  }
  await db.query(
    'SELECT jale_audit.export_commit_release($1, $2::bigint[], $3::bytea, $4::text)::text AS batch',
    [stream, seqs, digest, key],
  );
  logLine({ event: 'release_adopted', stream, rows: seqs.length });
  return seqs.length;
}

/**
 * A release batch a crashed run wrote but did not commit sits at the key
 * named by the stream's last digest. It is committed before anything else is
 * exported, so no other batch can claim that digest and fork the chain. A
 * listing with the exact key as the prefix finds it (a HEAD of a missing key
 * would need list rights on the whole bucket).
 */
async function adoptPendingRelease(db: ExportQueryable, store: ExportStore, stream: ExportStream): Promise<number> {
  const { prev } = await exportWindow(db, stream);
  const key = releaseKeyFor(stream, prev);
  const found = await store.list(key);
  if (!found.some((o) => o.key === key)) return 0;
  return commitStoredRelease(db, store, stream, prev, key);
}

async function exportReleases(db: ExportQueryable, store: ExportStore, stream: ExportStream): Promise<number> {
  const { rows } = await db.query<{ seq: string; line: string }>(
    'SELECT seq::text AS seq, line FROM jale_audit.export_released($1, $2::integer)',
    [stream, MAX_HELD],
  );
  if (rows.length === 0) return 0;
  const { prev } = await exportWindow(db, stream);
  const key = releaseKeyFor(stream, prev);
  const lines = rows.map((r) => parseLine(String(r.seq), r.line));
  const body = bodyOf(lines);
  const seqs = lines.map((l) => l.seq);
  const digest = chain(prev, sha256(body));
  const commit: Commit = { from: '', to: '', rowCount: lines.length, seqMin: seqs[0], seqMax: seqs[seqs.length - 1], digest, key, held: [] };
  const stored = await store.putIfAbsent(key, zlib.gzipSync(body), metadataFor(stream, commit, prev, 'release'));
  if (stored === 'exists') return commitStoredRelease(db, store, stream, prev, key);
  await db.query(
    'SELECT jale_audit.export_commit_release($1, $2::bigint[], $3::bytea, $4::text)::text AS batch',
    [stream, seqs, digest, key],
  );
  logLine({ event: 'release_committed', stream, rows: seqs.length });
  return seqs.length;
}

/** A stream whose oldest unexported row is older than this is stalled. */
const STALL_AFTER_MS = 10 * 60 * 1000;

interface Backlog { pendingRows: number; oldestPendingAt: Date | null }

/**
 * Committed rows the export has not reached: those at or above the watermark.
 * An open transaction holds the window back, so its rows wait here while the
 * export finds nothing to do; their age is the lag.
 */
async function exportBacklog(db: ExportQueryable, stream: ExportStream): Promise<Backlog> {
  const { rows } = await db.query<{ pending_rows: string | number; oldest_pending_at: Date | string | null }>(
    'SELECT pending_rows, oldest_pending_at FROM jale_audit.export_backlog($1)',
    [stream],
  );
  const row = rows[0];
  if (!row) throw new Error('AUDIT_EXPORT_BACKLOG');
  const pendingRows = Number(row.pending_rows);
  const oldest = row.oldest_pending_at === null ? null : new Date(row.oldest_pending_at);
  if (!Number.isInteger(pendingRows) || pendingRows < 0 || (oldest !== null && Number.isNaN(oldest.getTime()))
    || (pendingRows > 0) !== (oldest !== null)) {
    throw new Error('AUDIT_EXPORT_BACKLOG');
  }
  return { pendingRows, oldestPendingAt: oldest };
}

async function runExport(db: ExportQueryable, deps: ExportDependencies, commitEmpty: boolean): Promise<ExportReport> {
  let complete = true;
  let exported = 0;
  let held = 0;
  let contextInvalid = 0;
  let oldest: string | null = null;
  let lagMs = 0;
  const now = deps.now().getTime();
  for (const stream of EXPORT_STREAMS) {
    try {
      exported += await adoptPendingRelease(db, deps.store, stream);
      const r = await exportWindows(db, deps.store, stream, commitEmpty);
      exported += r.exported + await exportReleases(db, deps.store, stream);
      held += r.held;
      contextInvalid += r.contextInvalid;
      if (r.oldestExported && (oldest === null || r.oldestExported < oldest)) oldest = r.oldestExported;
      const backlog = await exportBacklog(db, stream);
      if (backlog.oldestPendingAt) {
        const age = Math.max(0, now - backlog.oldestPendingAt.getTime());
        lagMs = Math.max(lagMs, age);
        if (age > STALL_AFTER_MS) {
          complete = false;
          logLine({ event: 'stream_stalled', stream, pendingRows: backlog.pendingRows });
        }
      }
    } catch (error) {
      complete = false;
      logLine({ event: 'stream_failed', stream, ...errorShape(error) });
    }
  }
  const oldestMs = oldest ? Date.parse(oldest) : NaN;
  if (!Number.isNaN(oldestMs)) lagMs = Math.max(lagMs, now - oldestMs);
  const metrics: EmfMetric[] = [
    { name: 'AuditExportLagSeconds', value: Math.max(0, Math.floor(lagMs / 1000)), unit: 'Seconds' },
    { name: 'AuditValueScanHits', value: held },
    { name: 'AuditContextInvalid', value: contextInvalid },
  ];
  if (complete) metrics.push({ name: 'AuditExportRunCompleted', value: 1 });
  emitEmfMetrics(METRIC_NAMESPACE, metrics);
  return { mode: commitEmpty ? 'daily' : 'export', complete, exportedRows: exported, heldRows: held };
}

// ── The daily check ─────────────────────────────────────────────────────
//
// The chain is verified incrementally: each clean check writes a checkpoint
// (`checks/<stream>/<day>.json.gz`, write-once) naming the verified tail, and
// the next check reads only the objects filed since the checkpoint's day
// (plus a slack of a few days and the release batches), so its cost follows
// the days since the last clean check, not the archive's age. A chain that
// does not reach the database's last batch from there falls back to a walk of
// the whole stream. No checkpoint is written after a mismatch, so the next
// check starts again from the last good one.
//
// The comparison follows the chain too: every batch after the checkpoint's
// tail, which is every batch committed since the last clean check, is read,
// whatever day it is filed under, and its stored bytes are checked against
// its digest. A window batch is also recomputed from the database and must
// match it; a release batch is not, as the database checked its rows when it
// was committed. A check that finds a mismatch writes no checkpoint, so the
// next one compares those batches again.

const CHECK_FORMAT = 'jale-audit-check-v1';
/** Windows are filed under their first transaction's day, which can precede the day they are written. */
const CHECK_SLACK_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Lifecycle expiry starts after the retention (1096 days). */
const RETENTION_MS = 1096 * DAY_MS;

interface ObjectMeta { key: string; lastModified: Date; meta: Record<string, string> }

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function wellFormed(meta: Record<string, string> | null, stream: ExportStream): meta is Record<string, string> {
  return meta !== null
    && meta.format === OBJECT_FORMAT
    && meta.stream === stream
    && (meta['batch-kind'] === 'window' || meta['batch-kind'] === 'release')
    && HEX_DIGEST.test(meta.digest ?? '')
    && (meta['prev-digest'] === 'none' || HEX_DIGEST.test(meta['prev-digest'] ?? ''))
    && (meta['batch-kind'] === 'release' || (XID.test(meta['window-from'] ?? '') && XID.test(meta['window-to'] ?? '')));
}

export function checkpointKey(stream: ExportStream, day: string): string {
  return `checks/${stream}/${day}.json.gz`;
}

interface Checkpoint { day: string; tailDigest: string; tailKey: string | null; writtenAt: Date }

/** The latest checkpoint, checked against the object it names; `invalid` when it cannot be trusted. */
async function latestCheckpoint(store: ExportStore, stream: ExportStream): Promise<Checkpoint | 'none' | 'invalid'> {
  const listed = (await store.list(`checks/${stream}/`)).sort((a, b) => (a.key < b.key ? 1 : -1));
  if (listed.length === 0) return 'none';
  const latest = listed[0];
  try {
    const body = JSON.parse(zlib.gunzipSync(await store.get(latest.key)).toString('utf8')) as Record<string, unknown>;
    const day = String(body.day);
    const tailDigest = String(body.tailDigest);
    const tailKey = body.tailKey === null ? null : String(body.tailKey);
    if (body.format !== CHECK_FORMAT || body.stream !== stream || !DAY.test(day) || latest.key !== checkpointKey(stream, day)
      || !(tailDigest === 'none' || HEX_DIGEST.test(tailDigest)) || (tailDigest === 'none') !== (tailKey === null)) {
      return 'invalid';
    }
    if (tailKey !== null) {
      const meta = await store.head(tailKey);
      if (!wellFormed(meta, stream) || meta.digest !== tailDigest) return 'invalid';
    }
    return { day, tailDigest, tailKey, writtenAt: latest.lastModified };
  } catch {
    return 'invalid';
  }
}

async function headAll(store: ExportStore, listed: StoredObject[]): Promise<Array<StoredObject & { meta: Record<string, string> | null }>> {
  return mapLimited(listed, HEAD_CONCURRENCY, async (o) => ({ ...o, meta: await store.head(o.key) }));
}

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface Walk {
  mismatches: number;
  tailDigest: string;
  tailKey: string | null;
  /** Every well-formed object examined. */
  objects: ObjectMeta[];
  /** The digest the chain below follows: the checkpoint's tail, or `none` for the stream's start. */
  after: string;
  /** The chain's objects in order, from the first one after `after`. */
  chain: ObjectMeta[];
  /** The chain does not reach the database's last batch from the checkpoint. */
  incomplete?: boolean;
}

/** From the checkpoint, over the objects filed since its day. */
async function walkFromCheckpoint(store: ExportStore, stream: ExportStream, cp: Checkpoint, dbTail: string, now: Date): Promise<Walk> {
  const listed: StoredObject[] = [];
  const from = Date.parse(`${cp.day}T00:00:00Z`) - CHECK_SLACK_DAYS * DAY_MS;
  for (let day = from; day <= now.getTime(); day += DAY_MS) {
    listed.push(...await store.list(`db/${stream}/dt=${utcDayOf(day)}/`));
  }
  listed.push(...await store.list(`db/${stream}/releases/`));
  const heads = await headAll(store, listed);
  let mismatches = 0;
  const objects: ObjectMeta[] = [];
  for (const h of heads) {
    const isNew = h.lastModified.getTime() > cp.writtenAt.getTime();
    if (wellFormed(h.meta, stream)) objects.push(h as ObjectMeta);
    else if (isNew) mismatches += 1;
  }
  const byPrev = new Map<string, ObjectMeta[]>();
  for (const o of objects) byPrev.set(o.meta['prev-digest'], [...(byPrev.get(o.meta['prev-digest']) ?? []), o]);
  const isNew = (o: ObjectMeta) => o.lastModified.getTime() > cp.writtenAt.getTime();
  for (const followers of byPrev.values()) {
    if (followers.length > 1 && followers.some(isNew)) mismatches += followers.length - 1;
  }
  let tailDigest = cp.tailDigest;
  let tailKey = cp.tailKey;
  const chain: ObjectMeta[] = [];
  const visited = new Set<string>();
  for (let next = byPrev.get(tailDigest)?.[0]; next && !visited.has(next.key); next = byPrev.get(tailDigest)?.[0]) {
    visited.add(next.key);
    chain.push(next);
    tailDigest = next.meta.digest;
    tailKey = next.key;
  }
  const after = cp.tailDigest;
  if (tailDigest !== dbTail) return { mismatches, tailDigest, tailKey, objects, after, chain, incomplete: true };
  for (const o of objects) if (isNew(o) && !visited.has(o.key)) mismatches += 1;
  return { mismatches, tailDigest, tailKey, objects, after, chain };
}

/** The whole stream, from its first object. */
async function walkWholeStream(store: ExportStore, stream: ExportStream, dbTail: string, now: Date): Promise<Walk> {
  const prefix = `db/${stream}/`;
  const heads = await headAll(store, await store.list(prefix));
  let mismatches = 0;
  const objects: ObjectMeta[] = [];
  for (const h of heads) {
    if (wellFormed(h.meta, stream)) objects.push(h as ObjectMeta);
    else mismatches += 1;
  }
  const byDigest = new Map<string, ObjectMeta>();
  const byPrev = new Map<string, ObjectMeta[]>();
  for (const o of objects) {
    if (byDigest.has(o.meta.digest)) mismatches += 1;
    byDigest.set(o.meta.digest, o);
    byPrev.set(o.meta['prev-digest'], [...(byPrev.get(o.meta['prev-digest']) ?? []), o]);
  }
  for (const followers of byPrev.values()) if (followers.length > 1) mismatches += followers.length - 1;
  const starts = objects
    .filter((o) => o.meta['prev-digest'] === 'none' || !byDigest.has(o.meta['prev-digest']))
    .sort((a, b) => (a.meta['prev-digest'] === 'none' ? -1 : b.meta['prev-digest'] === 'none' ? 1 : a.key < b.key ? -1 : 1));
  let tailDigest = 'none';
  let tailKey: string | null = null;
  const chain: ObjectMeta[] = [];
  if (objects.length > 0) {
    if (starts.length !== 1) mismatches += Math.max(1, starts.length - 1);
    if (starts.length > 0) {
      const start = starts[0];
      // A chain may start after a missing object only once the lifecycle has
      // expired the oldest objects: delete markers exist, and the first
      // surviving object is itself past the retention.
      if (start.meta['prev-digest'] !== 'none') {
        const expired = await store.hasDeleteMarkers(prefix);
        if (!expired || now.getTime() - start.lastModified.getTime() < RETENTION_MS) mismatches += 1;
      }
      const seen = new Set<string>();
      for (let o: ObjectMeta | undefined = start; o && !seen.has(o.key); o = byPrev.get(o.meta.digest)?.[0]) {
        seen.add(o.key);
        chain.push(o);
        tailDigest = o.meta.digest;
        tailKey = o.key;
      }
      if (seen.size !== objects.length) mismatches += 1;
    }
  }
  if (tailDigest !== dbTail) mismatches += 1;
  return { mismatches, tailDigest, tailKey, objects, after: 'none', chain };
}

/**
 * The batches committed since the last clean check: the chain after the
 * checkpoint's tail (`none`: the whole chain), whatever day each is filed
 * under. Empty when that tail is not on the chain, which the walk has
 * already counted as a mismatch.
 */
function committedSince(walk: Walk, tail: string): ObjectMeta[] {
  if (walk.after === tail) return walk.chain;
  const at = walk.chain.findIndex((o) => o.meta.digest === tail);
  return at < 0 ? [] : walk.chain.slice(at + 1);
}

/** The objects written the previous UTC day. */
function writtenThePreviousDay(objects: ObjectMeta[], now: Date): ObjectMeta[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday = today - DAY_MS;
  return objects.filter((o) => o.lastModified.getTime() >= yesterday && o.lastModified.getTime() < today);
}

/**
 * Each object, once: its stored bytes against its digest, and a window
 * batch also against the database's recomputation of that window.
 */
async function compareObjects(db: ExportQueryable, store: ExportStore, stream: ExportStream, objects: ObjectMeta[]): Promise<number> {
  let mismatches = 0;
  const seen = new Set<string>();
  for (const o of objects) {
    if (seen.has(o.key)) continue;
    seen.add(o.key);
    // Bytes that do not decompress are a mismatch, and the check goes on.
    const body = gunzipOrNull(await store.get(o.key));
    let ok = body !== null;
    if (body) {
      const linesHash = sha256(body);
      const prev = o.meta['prev-digest'] === 'none' ? null : Buffer.from(o.meta['prev-digest'], 'hex');
      ok = chain(prev, linesHash).toString('hex') === o.meta.digest;
      if (o.meta['batch-kind'] === 'window') {
        const compared = await compareWindow(db, stream, o.meta['window-from'], o.meta['window-to'], null);
        ok = ok && compared.rowCount === Number(o.meta['row-count']) && compared.linesSha256.equals(linesHash);
      }
    }
    if (!ok) {
      mismatches += 1;
      logLine({ event: 'compare_mismatch', stream });
    }
  }
  return mismatches;
}

/**
 * Mismatches for one stream; a clean check records its checkpoint. Every
 * batch committed since the last clean check is checked: its stored bytes
 * against its digest, and a window batch also against the database's
 * recomputation of it. With a checkpoint that cannot be trusted, the objects
 * written the previous UTC day are checked instead.
 */
async function verifyStream(db: ExportQueryable, store: ExportStore, stream: ExportStream, now: Date): Promise<number> {
  const { prev: dbLast } = await exportWindow(db, stream);
  const dbTail = hexOrNone(dbLast);
  const cp = await latestCheckpoint(store, stream);
  let mismatches = cp === 'invalid' ? 1 : 0;
  let walk = typeof cp === 'object' ? await walkFromCheckpoint(store, stream, cp, dbTail, now) : undefined;
  if (!walk || walk.incomplete) {
    if (walk) logLine({ event: 'check_full_walk', stream });
    walk = await walkWholeStream(store, stream, dbTail, now);
  }
  const toCompare = cp === 'invalid'
    ? writtenThePreviousDay(walk.objects, now)
    : committedSince(walk, cp === 'none' ? 'none' : cp.tailDigest);
  mismatches += walk.mismatches + await compareObjects(db, store, stream, toCompare);
  if (mismatches === 0) {
    const day = utcDayOf(now.getTime());
    const body = { format: CHECK_FORMAT, stream, day, tailDigest: walk.tailDigest, tailKey: walk.tailKey };
    await store.putIfAbsent(checkpointKey(stream, day), zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf8')), { format: CHECK_FORMAT, stream });
  }
  return mismatches;
}

async function purge(db: ExportQueryable): Promise<void> {
  for (let round = 0; round < MAX_PURGE_ROUNDS; round += 1) {
    const { rows } = await db.query<{ stream: string; deleted: number }>(
      'SELECT stream, deleted FROM jale_audit.purge_expired($1::integer)',
      [PURGE_BATCH],
    );
    const deleted = rows.reduce((sum, r) => sum + Number(r.deleted), 0);
    logLine({ event: 'purged', rows: deleted });
    if (deleted === 0) return;
  }
}

async function trailStale(store: ExportStore, trailPrefix: string, now: Date): Promise<boolean> {
  let newest = 0;
  for (const offset of [0, 1]) {
    const day = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '/');
    for (const o of await store.list(`${trailPrefix}${day}/`)) newest = Math.max(newest, o.lastModified.getTime());
  }
  return now.getTime() - newest > TRAIL_STALE_MS;
}

/** Daily: the export, committing empty windows, then the chain and comparison check. */
async function runDaily(db: ExportQueryable, deps: ExportDependencies): Promise<ExportReport> {
  const report = await runExport(db, deps, true);
  let complete = true;
  let mismatches = 0;
  for (const stream of EXPORT_STREAMS) {
    try {
      mismatches += await verifyStream(db, deps.store, stream, deps.now());
    } catch (error) {
      complete = false;
      logLine({ event: 'compare_failed', stream, ...errorShape(error) });
    }
  }
  const metrics: EmfMetric[] = [{ name: 'AuditDailyCompareMismatch', value: mismatches }];
  if (complete) metrics.push({ name: 'AuditDailyCompareCompleted', value: 1 });
  emitEmfMetrics(METRIC_NAMESPACE, metrics);
  return { ...report, mode: 'daily', complete: report.complete && complete, mismatches };
}

/** Its own daily invocation, so a slow check never holds it back: the retention purge, then the trail check. */
async function runPurge(db: ExportQueryable, deps: ExportDependencies): Promise<ExportReport> {
  let complete = true;
  try {
    await purge(db);
    emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditPurgeCompleted', value: 1 }]);
  } catch (error) {
    complete = false;
    logLine({ event: 'purge_failed', ...errorShape(error) });
  }
  emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditTrailDeliveryStale', value: (await trailStale(deps.store, deps.trailPrefix, deps.now())) ? 1 : 0 }]);
  return { mode: 'purge', complete, exportedRows: 0, heldRows: 0 };
}

// ── The weekly full verification ────────────────────────────────────────
//
// The daily check reads only the days since its checkpoint, so it does not
// re-read older objects. Once a week the whole archive is walked again, in
// time-bounded chunks an hourly invocation continues until the pass is done:
//   - every object's body against its own digest (sha256(prev ||
//     sha256(body))), row count and seq range;
//   - the chain as a whole, without holding it in memory: for a chain from
//     its start to the tail, the sum of hash(prev-digest) over its objects
//     minus the sum of hash(digest) equals hash(start) - hash(tail). A
//     replaced, forked, duplicated or missing object breaks the equation;
//   - the tail against the database's last batch at the pass's start.
// Objects written after the pass started are left to the next pass. The
// progress lives outside the locked archive (`FULL_VERIFY_STATE_KEY` in the
// query-results bucket), so a crash resumes from the last saved page.
//
// An invocation starts no new object once FULL_VERIFY_TIME_SHARE of its time
// is spent, so it stops on its own well before the timeout. Each object is a
// HEAD and a GET, so the walk is bound by round trips: it keeps
// FULL_VERIFY_CONCURRENCY objects in flight, and a pass over the largest
// archive the retention allows still ends within days.

const FULL_VERIFY_FORMAT = 'jale-audit-full-verify-v1';
const FULL_VERIFY_EVERY_MS = 7 * DAY_MS;
/** The share of an invocation's time the walk may use before it stops starting objects. */
export const FULL_VERIFY_TIME_SHARE = 0.8;
/** Objects verified at once. */
export const FULL_VERIFY_CONCURRENCY = 16;
/** Keys listed per page; progress is saved after each. */
export const FULL_VERIFY_PAGE = 500;
/** The state object's key in its bucket. */
export const FULL_VERIFY_STATE_KEY = 'export-state/full-verify.json';
const HOUR_MS = 60 * 60 * 1000;
const MOD = 1n << 256n;
const SUM_HEX = /^[0-9a-f]{1,64}$/;

export interface VerifyStateStore {
  /** The saved state, or null when there is none. */
  read(): Promise<string | null>;
  write(body: string): Promise<void>;
}

interface StreamPass {
  tailAtStart: string;
  cursor: string | null;
  done: boolean;
  objects: number;
  mismatches: number;
  sumPrev: string;
  sumDigest: string;
  oldest: { lastModified: string; prev: string } | null;
  /** Digests of the objects that follow the tail the pass started from (a commit in flight). */
  followersOfTail: string[];
}

interface FullVerifyState {
  format: string;
  pass: { startedAt: string; streams: Record<ExportStream, StreamPass> } | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
}

function chainHash(value: string): bigint {
  return BigInt(`0x${crypto.createHash('sha256').update(`jale-audit-chain:${value}`).digest('hex')}`);
}

function sumAdd(sumHex: string, value: string): string {
  return ((BigInt(`0x${sumHex}`) + chainHash(value)) % MOD).toString(16);
}

function freshState(): FullVerifyState {
  return { format: FULL_VERIFY_FORMAT, pass: null, lastStartedAt: null, lastCompletedAt: null };
}

function validTime(value: unknown, now: number): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && ms <= now + HOUR_MS;
}

/** The saved state, or a fresh one when it is missing or cannot be trusted. */
function parseState(text: string | null, now: number): { state: FullVerifyState; reset: boolean } {
  if (text === null) return { state: freshState(), reset: false };
  try {
    const s = JSON.parse(text) as FullVerifyState;
    const timesOk = (s.lastStartedAt === null || validTime(s.lastStartedAt, now))
      && (s.lastCompletedAt === null || validTime(s.lastCompletedAt, now));
    let passOk = s.pass === null;
    if (s.pass && validTime(s.pass.startedAt, now)) {
      passOk = EXPORT_STREAMS.every((stream) => {
        const p = s.pass!.streams?.[stream];
        return p !== undefined && (p.tailAtStart === 'none' || HEX_DIGEST.test(p.tailAtStart))
          && (p.cursor === null || typeof p.cursor === 'string') && typeof p.done === 'boolean'
          && Number.isInteger(p.objects) && Number.isInteger(p.mismatches)
          && SUM_HEX.test(p.sumPrev) && SUM_HEX.test(p.sumDigest) && Array.isArray(p.followersOfTail);
      });
    }
    if (s.format !== FULL_VERIFY_FORMAT || !timesOk || !passOk) return { state: freshState(), reset: true };
    return { state: s, reset: false };
  } catch {
    return { state: freshState(), reset: true };
  }
}

/** One object, checked: its mismatches, and its chain link when its metadata is well formed. */
interface Inspection {
  mismatches: number;
  link: { prev: string; digest: string; written: string } | null;
}

/**
 * One object: its body against its digest, row count and seq range. Bytes
 * that do not decompress are one mismatch, and the walk goes on; the
 * object's chain link is still its metadata's. A store error still throws,
 * so the page is retried.
 */
async function inspectObject(store: ExportStore, stream: ExportStream, o: StoredObject): Promise<Inspection> {
  const meta = await store.head(o.key);
  if (!wellFormed(meta, stream)) return { mismatches: 1, link: null };
  const link = { prev: meta['prev-digest'], digest: meta.digest, written: o.lastModified.toISOString() };
  const body = gunzipOrNull(await store.get(o.key));
  if (!body) return { mismatches: 1, link };
  let mismatches = 0;
  const prev = meta['prev-digest'] === 'none' ? null : Buffer.from(meta['prev-digest'], 'hex');
  if (chain(prev, sha256(body)).toString('hex') !== meta.digest) mismatches += 1;
  const seqs = body.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => {
    try { return String(JSON.parse(l).seq); } catch { return ''; }
  });
  if (String(seqs.length) !== meta['row-count'] || seqs[0] !== meta['seq-min'] || seqs[seqs.length - 1] !== meta['seq-max']) mismatches += 1;
  return { mismatches, link };
}

/** Adds one inspected object to its stream's pass. */
function applyInspection(pass: StreamPass, r: Inspection): void {
  pass.objects += 1;
  pass.mismatches += r.mismatches;
  if (!r.link) return;
  pass.sumPrev = sumAdd(pass.sumPrev, r.link.prev);
  pass.sumDigest = sumAdd(pass.sumDigest, r.link.digest);
  if (!pass.oldest || r.link.written < pass.oldest.lastModified) pass.oldest = { lastModified: r.link.written, prev: r.link.prev };
  if (r.link.prev === pass.tailAtStart && pass.followersOfTail.length < 10) pass.followersOfTail.push(r.link.digest);
}

/**
 * A page's objects, FULL_VERIFY_CONCURRENCY at a time, in key order, until
 * `inTime` says stop: the results of the leading objects it finished (null
 * for one written after the pass started). Every object it starts, it
 * finishes, so they are a prefix of the page and the cursor can move past
 * them. On an error it waits for the objects in flight, then throws.
 */
async function inspectPage(
  store: ExportStore,
  stream: ExportStream,
  objects: StoredObject[],
  startedAt: number,
  inTime: () => boolean,
): Promise<Array<Inspection | null>> {
  const results: Array<Inspection | null> = [];
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < objects.length && inTime()) {
      const index = next;
      next += 1;
      const o = objects[index];
      try {
        results[index] = o.lastModified.getTime() > startedAt ? null : await inspectObject(store, stream, o);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(FULL_VERIFY_CONCURRENCY, objects.length) }, worker));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return results.slice(0, next);
}

/** The chain equation for a finished stream; 0 when it holds. */
async function chainMismatches(store: ExportStore, stream: ExportStream, pass: StreamPass, now: number): Promise<number> {
  if (pass.followersOfTail.length > 1) return 1;
  const residual = (BigInt(`0x${pass.sumPrev}`) - BigInt(`0x${pass.sumDigest}`) + MOD) % MOD;
  const starts = ['none'];
  if (pass.oldest && pass.oldest.prev !== 'none' && now - Date.parse(pass.oldest.lastModified) >= RETENTION_MS
    && await store.hasDeleteMarkers(`db/${stream}/`)) {
    starts.push(pass.oldest.prev);
  }
  const tails = [pass.tailAtStart, ...pass.followersOfTail];
  const holds = starts.some((start) => tails.some((tail) => residual === ((chainHash(start) - chainHash(tail) + MOD) % MOD)));
  return holds ? 0 : 1;
}

function emitFullVerifyAge(state: FullVerifyState, now: number): void {
  const since = state.lastCompletedAt ?? state.lastStartedAt;
  const hours = since ? Math.max(0, Math.floor((now - Date.parse(since)) / HOUR_MS)) : 0;
  emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditFullVerifyHoursSinceCompleted', value: hours, unit: 'None' }]);
}

/**
 * Hourly: starts a pass when one is due, continues one in progress, and
 * finishes it. Starts no object at or after `deadline`.
 */
async function runFullVerify(db: ExportQueryable, deps: ExportDependencies, deadline: number): Promise<ExportReport> {
  if (!deps.verifyState) throw new Error('AUDIT_EXPORT_CONFIG: no state store for the full verification');
  const now = deps.now().getTime();
  const parsed = parseState(await deps.verifyState.read(), now);
  const state = parsed.state;
  if (parsed.reset) logLine({ event: 'full_verify_state_reset' });
  const save = () => deps.verifyState!.write(JSON.stringify(state));

  if (!state.pass) {
    if (state.lastStartedAt && now - Date.parse(state.lastStartedAt) < FULL_VERIFY_EVERY_MS) {
      emitFullVerifyAge(state, now);
      return { mode: 'full-verify', complete: true, exportedRows: 0, heldRows: 0, passFinished: false };
    }
    const streams = {} as Record<ExportStream, StreamPass>;
    for (const stream of EXPORT_STREAMS) {
      const { prev } = await exportWindow(db, stream);
      streams[stream] = {
        tailAtStart: hexOrNone(prev), cursor: null, done: false, objects: 0, mismatches: 0,
        sumPrev: '0', sumDigest: '0', oldest: null, followersOfTail: [],
      };
    }
    state.pass = { startedAt: new Date(now).toISOString(), streams };
    state.lastStartedAt = state.pass.startedAt;
    await save();
    logLine({ event: 'full_verify_started' });
  }

  const pass = state.pass!;
  const startedAt = Date.parse(pass.startedAt);
  const inTime = () => deps.now().getTime() < deadline;
  let stopped = false;
  for (const stream of EXPORT_STREAMS) {
    const s = pass.streams[stream];
    while (!s.done && !stopped) {
      if (!inTime()) {
        stopped = true;
        break;
      }
      const page = await deps.store.listPage(`db/${stream}/`, s.cursor ?? undefined, FULL_VERIFY_PAGE);
      const results = await inspectPage(deps.store, stream, page.objects, startedAt, inTime);
      results.forEach((r, i) => {
        s.cursor = page.objects[i].key;
        if (r) applyInspection(s, r);
      });
      if (results.length < page.objects.length) stopped = true;
      else if (!page.truncated) s.done = true;
      await save();
    }
    if (stopped) break;
  }

  const objects = EXPORT_STREAMS.reduce((n, stream) => n + pass.streams[stream].objects, 0);
  if (EXPORT_STREAMS.some((stream) => !pass.streams[stream].done)) {
    emitFullVerifyAge(state, now);
    logLine({ event: 'full_verify_progress', objects });
    return { mode: 'full-verify', complete: true, exportedRows: 0, heldRows: 0, passFinished: false };
  }

  let mismatches = 0;
  for (const stream of EXPORT_STREAMS) {
    const s = pass.streams[stream];
    mismatches += s.mismatches + await chainMismatches(deps.store, stream, s, now);
  }
  state.pass = null;
  state.lastCompletedAt = new Date(now).toISOString();
  await save();
  emitEmfMetrics(METRIC_NAMESPACE, [
    { name: 'AuditFullVerifyMismatch', value: mismatches },
    { name: 'AuditFullVerifyCompleted', value: 1 },
  ]);
  emitFullVerifyAge(state, now);
  logLine({ event: 'full_verify_completed', mismatches, objects });
  return { mode: 'full-verify', complete: true, exportedRows: 0, heldRows: 0, mismatches, passFinished: true };
}

// ── The handler ─────────────────────────────────────────────────────────

function logLine(fields: Record<string, string | number | boolean | undefined>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(fields));
}

/** An error's name and code, which identify it without its message. */
function errorShape(error: unknown): { errorName?: string; errorCode?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  const safe = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
  const ownCode = typeof message === 'string' ? /^(AUDIT_EXPORT_[A-Z_]+)/.exec(message)?.[1] : undefined;
  return { errorName: safe(name), errorCode: safe(code) ?? ownCode };
}

async function checkIdentity(db: ExportQueryable, expectedLogin: string): Promise<void> {
  const { rows } = await db.query<{ login: string }>('SELECT session_user AS login');
  const login = rows[0]?.login;
  if (!expectedLogin || expectedLogin === MASTER_LOGIN || login !== expectedLogin) {
    const metrics: EmfMetric[] = [{ name: 'DbIdentityCheckFailed', value: 1 }];
    emitEmfMetrics('Jale/Database', metrics);
    emitEmfMetrics('Jale/Database', metrics, { Login: expectedLogin || 'unset' });
    throw new Error('AUDIT_EXPORT_IDENTITY: not connected as the expected login');
  }
}

export function createExportHandler(deps: ExportDependencies): (event: unknown, context?: InvocationContext) => Promise<ExportReport> {
  return async (event: unknown, context?: InvocationContext) => {
    const enteredAt = deps.now().getTime();
    const mode = (event as { mode?: unknown } | null)?.mode;
    if (mode !== 'export' && mode !== 'daily' && mode !== 'purge' && mode !== 'full-verify') {
      throw new Error('AUDIT_EXPORT_MODE: expected export, daily, purge or full-verify');
    }
    let deadline = 0;
    if (mode === 'full-verify') {
      const remaining = context?.getRemainingTimeInMillis();
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining <= 0) {
        throw new Error('AUDIT_EXPORT_CONFIG: the full verification needs the time its invocation has left');
      }
      deadline = enteredAt + FULL_VERIFY_TIME_SHARE * remaining;
    }
    const db = await deps.connect();
    try {
      await checkIdentity(db, deps.expectedLogin);
      if (mode === 'daily') return await runDaily(db, deps);
      if (mode === 'purge') return await runPurge(db, deps);
      if (mode === 'full-verify') return await runFullVerify(db, deps, deadline);
      return await runExport(db, deps, false);
    } finally {
      await db.end().catch(() => undefined);
    }
  };
}

// ── Production wiring ───────────────────────────────────────────────────

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`AUDIT_EXPORT_CONFIG: ${name} is not set`);
  return value;
}

function rdsCaBundle(): string {
  const candidates = [path.join(__dirname, 'rds-ca-bundle.pem'), path.join(__dirname, '..', 'lib', 'rds-ca-bundle.pem')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('AUDIT_EXPORT_CONFIG: the RDS CA bundle is missing');
  return fs.readFileSync(found, 'utf8');
}

const secretsManager = new SecretsManagerClient({});

/** One short-lived connection as the export login, by the secret DB_SECRET_ARN names. */
async function connectAsExportLogin(): Promise<ExportConnection> {
  const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: required('DB_SECRET_ARN') }));
  const raw = JSON.parse(secret.SecretString ?? '') as Record<string, unknown>;
  const client = new Client({
    host: String(raw.host),
    port: Number(raw.port),
    user: String(raw.username),
    password: String(raw.password),
    database: String(raw.dbname),
    ssl: { rejectUnauthorized: true, ca: rdsCaBundle() },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    query_timeout: 150_000,
    application_name: 'jale-audit-export',
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** The archive through S3. */
export function s3ExportStore(client: S3Client, bucket: string): ExportStore {
  return {
    async putIfAbsent(key, body, metadata) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/gzip',
          Metadata: metadata,
          IfNoneMatch: '*',
          ChecksumAlgorithm: 'SHA256',
        }));
        return 'created';
      } catch (error) {
        if (statusOf(error) === 412) return 'exists';
        throw error;
      }
    },
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return result.Metadata ?? {};
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await result.Body!.transformToByteArray());
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async listPage(prefix, startAfter, maxKeys) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, StartAfter: startAfter, MaxKeys: maxKeys }));
      const objects: StoredObject[] = [];
      for (const o of page.Contents ?? []) {
        if (o.Key && o.LastModified) objects.push({ key: o.Key, lastModified: o.LastModified });
      }
      return { objects, truncated: page.IsTruncated === true };
    },
    async hasDeleteMarkers(prefix) {
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await client.send(new ListObjectVersionsCommand({
          Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker,
        }));
        if ((page.DeleteMarkers ?? []).length > 0) return true;
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker);
      return false;
    },
  };
}

/** The full verification's progress, in the query-results bucket (no Object Lock). */
export function s3VerifyStateStore(client: S3Client, bucket: string): VerifyStateStore {
  return {
    async read() {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: FULL_VERIFY_STATE_KEY }));
        return await result.Body!.transformToString();
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async write(body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: FULL_VERIFY_STATE_KEY, Body: body, ContentType: 'application/json' }));
    },
  };
}

let production: ((event: unknown, context?: InvocationContext) => Promise<ExportReport>) | undefined;

export async function handler(event: unknown, context?: InvocationContext): Promise<ExportReport> {
  production ??= createExportHandler({
    connect: connectAsExportLogin,
    store: s3ExportStore(new S3Client({}), required('AUDIT_ARCHIVE_BUCKET')),
    now: () => new Date(),
    expectedLogin: process.env.DB_EXPECTED_LOGIN ?? '',
    trailPrefix: required('AUDIT_TRAIL_PREFIX'),
    verifyState: s3VerifyStateStore(new S3Client({}), required('AUDIT_STATE_BUCKET')),
  });
  return production(event, context);
}
