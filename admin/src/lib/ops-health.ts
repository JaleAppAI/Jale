import { bucketLabel, formatCount, sum } from './analytics-format';
import type {
  BillingInboxFigures,
  BillingInboxNow,
  BillingInboxWeekly,
  FunnelWeeks,
  MessageBacklogLane,
  MessageFailureFigures,
  MessageFailuresWeekly,
  MessageLane,
  TrustExtractionFigures,
  TrustExtractionWeekly,
  VoiceExtractionFigures,
  VoiceExtractionWeekly,
} from './types';

const MINUTE_MS = 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;

// Code-point order, so a sort never depends on locale collation.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function hasWeek<T extends { weekStart: string | null }>(row: T): row is T & { weekStart: string } {
  return row.weekStart !== null;
}

// A whole-percent share that never rounds a fact away: some but not all of
// the whole reads "<1%" or ">99%", never "0%" or "100%". Nothing to divide
// by is a dash.
export function wholePercent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const share = Math.round((part * 100) / whole);
  if (share === 0 && part > 0) return '<1%';
  if (share === 100 && part < whole) return '>99%';
  return `${share}%`;
}

// ---- Lanes ------------------------------------------------------------------
// The SQL lane ids in display order, the page's labels, and each lane's retry
// window: a message still open this long after it was created is "stuck".
export const LANES: readonly { id: MessageLane; label: string; retryWindow: string }[] = [
  { id: 'reply', label: 'WhatsApp replies', retryWindow: '30 min' },
  { id: 'admin', label: 'Admin replies', retryWindow: '10 min' },
  { id: 'worker_notification', label: 'Worker notifications', retryWindow: '24 h' },
  { id: 'employer_invite', label: 'Employer invites', retryWindow: '30 min' },
  { id: 'employer_freeform', label: 'Employer free-text messages', retryWindow: '30 min' },
  { id: 'job_alert', label: 'Job alerts (old lane)', retryWindow: '30 min' },
];

export function isMessageLane(value: unknown): value is MessageLane {
  return LANES.some((lane) => lane.id === value);
}

function laneIndex(lane: MessageLane): number {
  return LANES.findIndex((entry) => entry.id === lane);
}

export function laneLabel(lane: MessageLane): string {
  return LANES[laneIndex(lane)].label;
}

// ---- Right now: message backlog -----------------------------------------------
export type BacklogRow = MessageBacklogLane & { label: string; stuckAfter: string };

// Display order whatever the SQL order. SQL returns the five active lanes
// (zeros included) and a job-alert row only while that lane has open messages.
export function backlogRows(lanes: MessageBacklogLane[]): BacklogRow[] {
  return [...lanes]
    .sort((a, b) => laneIndex(a.lane) - laneIndex(b.lane))
    .map((lane) => ({
      ...lane,
      label: laneLabel(lane.lane),
      stuckAfter: `stuck after ${LANES[laneIndex(lane.lane)].retryWindow}`,
    }));
}

// Every open message (the three age buckets, all under 48 h); stuck ones are a subset.
export function openMessages(lanes: MessageBacklogLane[]): number {
  return sum(lanes.map((lane) => lane.openUnder1h + lane.open1To24h + lane.open24To48h));
}

export function stuckMessages(lanes: MessageBacklogLane[]): number {
  return sum(lanes.map((lane) => lane.stuck));
}

// The oldest stuck message in any lane (its created_at and lane); null when
// none is stuck. On an exact tie the earlier lane in display order wins.
export function oldestStuck(lanes: MessageBacklogLane[]): { at: string; lane: MessageLane } | null {
  let oldest: { at: string; lane: MessageLane } | null = null;
  for (const { oldestStuckAt: at, lane } of backlogRows(lanes)) {
    if (at !== null && (oldest === null || Date.parse(at) < Date.parse(oldest.at))) oldest = { at, lane };
  }
  return oldest;
}

// How long ago, in whole units: minutes under an hour, hours under 48 hours,
// then days. A time ahead of the server clock reads as "under 1 min".
export function formatAge(sinceIso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(sinceIso)) / MINUTE_MS);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

// The Messages stuck now tile: how old the oldest stuck message is, and its lane.
export function messagesStuckNote(lanes: MessageBacklogLane[], now: Date = new Date()): string {
  const oldest = oldestStuck(lanes);
  return oldest === null ? 'nothing stuck' : `oldest ${formatAge(oldest.at, now)} · ${laneLabel(oldest.lane)}`;
}

// ---- Weeks ------------------------------------------------------------------
// The week holding `now` is still in progress (Monday 00:00 UTC to the next).
export function isCurrentWeek(weekStart: string, now: Date = new Date()): boolean {
  const start = Date.parse(weekStart);
  return start <= now.getTime() && now.getTime() < start + WEEK_MS;
}

// Weekly table rows, newest first. The sort is stable, so rows of the same
// week (one per extractor version) keep their order.
export function newestWeeksFirst<T extends { weekStart: string }>(
  weeks: T[],
  now: Date = new Date(),
): (T & { label: string; current: boolean })[] {
  return [...weeks]
    .sort((a, b) => Date.parse(b.weekStart) - Date.parse(a.weekStart))
    .map((week) => ({
      ...week,
      // bucketLabel's weekly form ("Week of Sep 28") is the '90d' branch.
      label: bucketLabel(week.weekStart, '90d'),
      current: isCurrentWeek(week.weekStart, now),
    }));
}

// ---- Message failures ---------------------------------------------------------
const ZERO_FAILURES: MessageFailureFigures = { created: 0, gaveUp: 0, deliveryFailed: 0 };

function failureFigures(row: MessageFailuresWeekly | undefined): MessageFailureFigures {
  return row ? { created: row.created, gaveUp: row.gaveUp, deliveryFailed: row.deliveryFailed } : { ...ZERO_FAILURES };
}

export type LaneFailures = {
  lane: MessageLane;
  label: string;
  // One entry per week in `weeks`; a week with no row reads as zero.
  weekly: MessageFailureFigures[];
  window: MessageFailureFigures;
};

export type MessageFailuresSplit = { weeks: string[]; lanes: LaneFailures[]; window: MessageFailureFigures };

// Weeks oldest first; lanes in display order, each lane present in the rows
// (SQL zero-fills the five active lanes; job alerts appear only with rows).
// `window` is the SQL all-lanes window row, never a sum of the weeks.
export function splitMessageFailures(rows: MessageFailuresWeekly[]): MessageFailuresSplit {
  const weeks = [...new Set(rows.filter(hasWeek).map((row) => row.weekStart))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const present = new Set(rows.map((row) => row.lane));
  const find = (lane: MessageLane | null, weekStart: string | null) =>
    rows.find((row) => row.lane === lane && row.weekStart === weekStart);
  return {
    weeks,
    lanes: LANES.filter((lane) => present.has(lane.id)).map((lane) => ({
      lane: lane.id,
      label: lane.label,
      weekly: weeks.map((weekStart) => failureFigures(find(lane.id, weekStart))),
      window: failureFigures(find(lane.id, null)),
    })),
    window: failureFigures(find(null, null)),
  };
}

export function failedMessages(figures: MessageFailureFigures): number {
  return figures.gaveUp + figures.deliveryFailed;
}

// (gave up + delivery failures) ÷ created, as a percentage with one decimal:
// the chart's value. Nothing created means no rate: a gap, never 0%.
export function failureRate(figures: MessageFailureFigures): number | null {
  if (figures.created <= 0) return null;
  return Math.round((failedMessages(figures) * 1000) / figures.created) / 10;
}

// The rate as text (tile, end labels). It never rounds a fact away: a failure
// that rounds to 0.0% reads "<0.1%", a success that rounds to 100.0% ">99.9%".
export function formatFailureRate(figures: MessageFailureFigures): string {
  const rate = failureRate(figures);
  if (rate === null) return '—';
  const failed = failedMessages(figures);
  if (rate === 0 && failed > 0) return '<0.1%';
  if (rate === 100 && failed < figures.created) return '>99.9%';
  return `${rate.toFixed(1)}%`;
}

export function failureRateNote(figures: MessageFailureFigures): string {
  return `${formatCount(failedMessages(figures))} failed of ${formatCount(figures.created)} created`;
}

// A table cell: "failed / created", or a dash when the lane created nothing.
export function failedOfCreated(figures: MessageFailureFigures): string {
  if (figures.created === 0) return '—';
  return `${formatCount(failedMessages(figures))} / ${formatCount(figures.created)}`;
}

// The end label of a lane's line: its current (last) week.
export function latestRateLabel(lane: LaneFailures): string {
  return formatFailureRate(lane.weekly[lane.weekly.length - 1] ?? ZERO_FAILURES);
}

// No lane created anything in any week: every point is a gap, so the chart
// shows its empty state instead of a bare axis.
export function failureChartEmpty(split: MessageFailuresSplit): boolean {
  return split.lanes.every((lane) => lane.weekly.every((week) => failureRate(week) === null));
}

export type FailureTableRow = {
  weekStart: string;
  label: string;
  current: boolean;
  // One cell per lane, in the order of `lanes`.
  cells: MessageFailureFigures[];
};

export function failureTableRows(split: MessageFailuresSplit, now: Date = new Date()): FailureTableRow[] {
  return newestWeeksFirst(
    split.weeks.map((weekStart, i) => ({ weekStart, cells: split.lanes.map((lane) => lane.weekly[i]) })),
    now,
  );
}

// ---- Voice extraction -----------------------------------------------------------
export type VoiceFailureCause =
  | 'transcribe'
  | 'empty_transcript'
  | 'audio_read'
  | 'model_call'
  | 'bad_json'
  | 'bad_shape'
  | 'pipeline_error'
  | 'unrecorded';

// failure_kind values in a fixed order (ties keep it); NULL = not recorded
// (failures from before migration 115).
export const FAILURE_CAUSES: readonly {
  cause: VoiceFailureCause;
  label: string;
  field: keyof VoiceExtractionFigures;
}[] = [
  { cause: 'transcribe', label: 'Transcription failed', field: 'failedTranscribe' },
  { cause: 'empty_transcript', label: 'Empty transcript', field: 'failedEmptyTranscript' },
  // The writer's S3 read of the Transcribe output failed (not the worker's audio).
  { cause: 'audio_read', label: 'Transcript unreadable', field: 'failedAudioRead' },
  { cause: 'model_call', label: 'AI call failed', field: 'failedModelCall' },
  { cause: 'bad_json', label: 'AI reply unreadable', field: 'failedBadJson' },
  { cause: 'bad_shape', label: 'AI reply incomplete', field: 'failedBadShape' },
  { cause: 'pipeline_error', label: 'Pipeline error', field: 'failedPipelineError' },
  { cause: 'unrecorded', label: 'Cause not recorded', field: 'failedUnrecorded' },
];

export type CauseCount = { cause: VoiceFailureCause; label: string; count: number };

// Causes with at least one failure, most first; ties keep the fixed order.
export function failureReasons(figures: VoiceExtractionFigures): CauseCount[] {
  return FAILURE_CAUSES.map(({ cause, label, field }) => ({ cause, label, count: figures[field] }))
    .filter((reason) => reason.count > 0)
    .sort((a, b) => b.count - a.count);
}

// Every cause with the highest count, in the fixed order: one cause, or a
// tie (never a winner picked by the order). Empty when nothing failed.
export function topFailureCauses(figures: VoiceExtractionFigures): CauseCount[] {
  const reasons = failureReasons(figures);
  return reasons.filter((reason) => reason.count === reasons[0]?.count);
}

// "AI call failed", "A, B (tied)", or a dash. With `max`, a longer tie names
// the first `max` causes and counts the rest: "A, B + 3 more (tied)".
export function topCauseLabel(figures: VoiceExtractionFigures, max: number = FAILURE_CAUSES.length): string {
  const top = topFailureCauses(figures);
  if (top.length === 0) return '—';
  if (top.length === 1) return top[0].label;
  const named = top.slice(0, max).map((reason) => reason.label).join(', ');
  return top.length > max ? `${named} + ${top.length - max} more (tied)` : `${named} (tied)`;
}

// Usable ÷ processed (attempts); no attempts, no share.
export function voiceSuccess(figures: VoiceExtractionFigures): string {
  return wholePercent(figures.usable, figures.processed);
}

// The tile names at most two tied causes; the weekly table names them all.
export function voiceSuccessNote(figures: VoiceExtractionFigures): string {
  if (figures.processed === 0) return 'no voice notes';
  const top = topFailureCauses(figures);
  if (top.length === 0) return 'no failures';
  return `${top.length === 1 ? 'top cause' : 'top causes'}: ${topCauseLabel(figures, 2)}`;
}

export type VoiceWeek = VoiceExtractionFigures & { weekStart: string };
export type VoiceModel = VoiceExtractionFigures & { model: string };
export type VoiceSplit = { weekly: VoiceWeek[]; window: VoiceExtractionFigures; models: VoiceModel[] };

const ZERO_VOICE: VoiceExtractionFigures = {
  processed: 0,
  failed: 0,
  failedTranscribe: 0,
  failedEmptyTranscript: 0,
  failedAudioRead: 0,
  failedModelCall: 0,
  failedBadJson: 0,
  failedBadShape: 0,
  failedPipelineError: 0,
  failedUnrecorded: 0,
  usable: 0,
  fullNameFound: 0,
  cityFound: 0,
  mainTradeFound: 0,
  mainTradeOtherDue: 0,
  mainTradeOtherFound: 0,
  yearsExperienceFound: 0,
  hasTransportationFound: 0,
  availabilityFound: 0,
};

// weekly: the all-model row of every week, oldest first. window: the SQL
// whole-window row (all zeros if missing). models: the window row of each
// model, most attempts first. (Week, model) rows are not shown.
export function splitVoiceExtraction(rows: VoiceExtractionWeekly[]): VoiceSplit {
  const weekly: VoiceWeek[] = [];
  const models: VoiceModel[] = [];
  let window: VoiceExtractionFigures = { ...ZERO_VOICE };
  for (const { weekStart, model, ...figures } of rows) {
    if (weekStart !== null && model === null) weekly.push({ ...figures, weekStart });
    else if (weekStart === null && model === null) window = figures;
    else if (weekStart === null && model !== null) models.push({ ...figures, model });
  }
  weekly.sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  models.sort((a, b) => b.processed - a.processed || byText(a.model, b.model));
  return { weekly, window, models };
}

export type CompletenessField =
  | 'fullName'
  | 'city'
  | 'mainTrade'
  | 'mainTradeOther'
  | 'yearsExperience'
  | 'hasTransportation'
  | 'availability';

export const COMPLETENESS_FIELDS: readonly { field: CompletenessField; label: string }[] = [
  { field: 'fullName', label: 'Full name' },
  { field: 'city', label: 'City' },
  { field: 'mainTrade', label: 'Main trade' },
  { field: 'mainTradeOther', label: 'Other trade (when main trade is "other")' },
  { field: 'yearsExperience', label: 'Years of experience' },
  { field: 'hasTransportation', label: 'Has transportation' },
  { field: 'availability', label: 'Availability' },
];

// Found over usable rows; Other trade only counts rows whose main trade is
// "other", in both the numerator and the denominator.
const FIELD_COUNTS: Record<CompletenessField, { found: keyof VoiceExtractionFigures; of: keyof VoiceExtractionFigures }> = {
  fullName: { found: 'fullNameFound', of: 'usable' },
  city: { found: 'cityFound', of: 'usable' },
  mainTrade: { found: 'mainTradeFound', of: 'usable' },
  mainTradeOther: { found: 'mainTradeOtherFound', of: 'mainTradeOtherDue' },
  yearsExperience: { found: 'yearsExperienceFound', of: 'usable' },
  hasTransportation: { found: 'hasTransportationFound', of: 'usable' },
  availability: { found: 'availabilityFound', of: 'usable' },
};

export type FieldShare = { found: number; of: number; share: string };

export function fieldShare(figures: VoiceExtractionFigures, field: CompletenessField): FieldShare {
  const found = figures[FIELD_COUNTS[field].found];
  const of = figures[FIELD_COUNTS[field].of];
  return { found, of, share: wholePercent(found, of) };
}

export type CompletenessColumn = { key: string; label: string; model: boolean; usable: number };
export type CompletenessRow = { field: CompletenessField; label: string; cells: FieldShare[] };

// One "Found" column; with more than one model, an "All models" column and
// then one column per model (in `models` order).
export function completenessTable(
  window: VoiceExtractionFigures,
  models: VoiceModel[],
): { columns: CompletenessColumn[]; rows: CompletenessRow[] } {
  const perModel = models.length > 1;
  const sources: { column: CompletenessColumn; figures: VoiceExtractionFigures }[] = [
    { column: { key: 'all', label: perModel ? 'All models' : 'Found', model: false, usable: window.usable }, figures: window },
    ...(perModel
      ? models.map((model) => ({
          column: { key: `model:${model.model}`, label: model.model, model: true, usable: model.usable },
          figures: model,
        }))
      : []),
  ];
  return {
    columns: sources.map((source) => source.column),
    rows: COMPLETENESS_FIELDS.map(({ field, label }) => ({
      field,
      label,
      cells: sources.map((source) => fieldShare(source.figures, field)),
    })),
  };
}

// ---- Trust extraction -------------------------------------------------------------
export type TrustWeek = TrustExtractionFigures & { weekStart: string; version: string | null };
export type TrustSplit = { weekly: TrustWeek[]; window: TrustExtractionFigures };

const ZERO_TRUST: TrustExtractionFigures = { extractions: 0, failed: 0, notEnoughDetail: 0, avgSections: null };

// weekly: oldest week first, one row per extractor version with rows that
// week (versions in name order); a week with none keeps its zero-filled
// all-version row (version null). window: the SQL whole-window row.
export function splitTrustExtraction(rows: TrustExtractionWeekly[]): TrustSplit {
  const allVersionWeeks = rows
    .filter(hasWeek)
    .filter((row) => row.extractorVersion === null)
    .sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  const weekly = allVersionWeeks.flatMap((week) => {
    const versions = rows
      .filter((row) => row.weekStart === week.weekStart && row.extractorVersion !== null)
      .sort((a, b) => byText(a.extractorVersion ?? '', b.extractorVersion ?? ''));
    return (versions.length > 0 ? versions : [week]).map(({ extractions, failed, notEnoughDetail, avgSections, extractorVersion }) => ({
      weekStart: week.weekStart,
      version: extractorVersion,
      extractions,
      failed,
      notEnoughDetail,
      avgSections,
    }));
  });
  const windowRow = rows.find((row) => row.weekStart === null && row.extractorVersion === null);
  const window: TrustExtractionFigures = windowRow
    ? {
        extractions: windowRow.extractions,
        failed: windowRow.failed,
        notEnoughDetail: windowRow.notEnoughDetail,
        avgSections: windowRow.avgSections,
      }
    : { ...ZERO_TRUST };
  return { weekly, window };
}

// Average non-empty sections out of five; null (no model-backed extraction) is a dash.
export function formatAvgSections(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

// ---- Billing inbox ------------------------------------------------------------------
export type BillingWeek = BillingInboxFigures & { weekStart: string };
export type BillingEventType = BillingInboxFigures & { eventType: string };
export type BillingSplit = { weekly: BillingWeek[]; window: BillingInboxFigures; eventTypes: BillingEventType[] };

const ZERO_BILLING: BillingInboxFigures = {
  received: 0,
  processed: 0,
  skipped: 0,
  failed: 0,
  retried: 0,
  paymentFailedInvoices: 0,
};

// weekly: the all-type row of every week, oldest first; window: the SQL
// whole-window row; eventTypes: the window row of each event type.
export function splitBillingInbox(rows: BillingInboxWeekly[]): BillingSplit {
  const weekly: BillingWeek[] = [];
  const eventTypes: BillingEventType[] = [];
  let window: BillingInboxFigures = { ...ZERO_BILLING };
  for (const { weekStart, eventType, ...figures } of rows) {
    if (weekStart !== null && eventType === null) weekly.push({ ...figures, weekStart });
    else if (weekStart === null && eventType === null) window = figures;
    else if (weekStart === null && eventType !== null) eventTypes.push({ ...figures, eventType });
  }
  weekly.sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  return { weekly, window, eventTypes };
}

// Event types with skipped events in the window, most first, then by name.
export function skippedByType(eventTypes: BillingEventType[]): { eventType: string; skipped: number }[] {
  return eventTypes
    .filter((type) => type.skipped > 0)
    .map(({ eventType, skipped }) => ({ eventType, skipped }))
    .sort((a, b) => b.skipped - a.skipped || byText(a.eventType, b.eventType));
}

// Stuck in received plus failed, both received in the last hour. The processor
// gives up on an event after about 20 minutes, so a failed one is no longer
// retried for most of that hour.
export function billingStuck(inbox: BillingInboxNow): number {
  return inbox.stuckReceived + inbox.failedNow;
}

const redrive = (count: number): string =>
  `${formatCount(count)} ${count === 1 ? 'needs' : 'need'} a manual redrive`;

// The Billing events stuck tile: the oldest stuck or failed event, then the
// events dead-lettered in the last 14 days (they wait in the queue for a
// manual redrive) when there are any; with none stuck or failed, just those.
export function billingStuckNote(inbox: BillingInboxNow, now: Date = new Date()): string {
  const parts: string[] = [];
  if (inbox.oldestStuckAt !== null) parts.push(`oldest ${formatAge(inbox.oldestStuckAt, now)}`);
  if (inbox.unresolvedOlder > 0) parts.push(redrive(inbox.unresolvedOlder));
  return parts.length > 0 ? parts.join(' · ') : 'nothing stuck';
}

// The oldest time covers both stuck and failed events, so it follows them;
// events dead-lettered in the last 14 days close the line when there are any.
export function billingLiveLine(inbox: BillingInboxNow, now: Date = new Date()): string {
  const parts = [
    `${formatCount(inbox.stuckReceived)} stuck in received`,
    `${formatCount(inbox.failedNow)} failed in the last hour`,
  ];
  if (inbox.oldestStuckAt !== null) parts.push(`oldest ${formatAge(inbox.oldestStuckAt, now)}`);
  if (inbox.unresolvedOlder > 0) {
    parts.push(`${formatCount(inbox.unresolvedOlder)} dead-lettered in the last 14 days (redrive from the DLQ)`);
  }
  return parts.join(' · ');
}

// The weeks picker stays on the Ops tab.
export function opsHref(weeks: FunnelWeeks): string {
  return `/analytics/ops?weeks=${weeks}`;
}
