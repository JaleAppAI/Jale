// The Reports actions, behind POST /api/report-actions: reveal a contact,
// open a screenshot, set the status, set the internal note, and change the
// report settings. They have their own route and policy; the case console's
// dispatch is separate and unchanged.
//
// Each action runs in one transaction on the console login and records its
// event on the same client before COMMIT:
//   reveal_contact   reveal function -> access event (with the account) -> COMMIT -> value
//   view_screenshot  image function  -> access event (link expiry)      -> COMMIT -> presigned GET
//   set_status       status function -> action event                    -> COMMIT
//   set_note         note function   -> action event                    -> COMMIT
//   update_settings  settings function -> action event                  -> COMMIT
// A refusal from the database (an outcome code other than 'ok') rolls the
// transaction back, so no event is kept for something that did not happen.
// Every refusal, and every failure, is then recorded as an attempt, after
// the transaction has ended and its client has been released.
//
// Never logged: the revealed contact, object keys, links, notes, the team
// mailbox, or any database message (it can carry row values). Log lines
// carry an event tag, the action, a SQLSTATE and the request id.
import { createHash } from 'node:crypto';
import {
  recordAdminAccess,
  recordAdminAction,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AdminAttemptEvent,
  type AdminSurface,
  type AttemptOutcome,
  type AuditCategory,
} from './audit/record';
import type { AdminSession } from './session-claims';
import {
  REPORT_NOTE_MAX_LENGTH,
  REPORT_STATUS_LABELS,
  REVEAL_REASON_MAX_LENGTH,
  REVEAL_REASON_MIN_LENGTH,
  SIGNED_OUT_DAILY_CAP_MAX,
  canReport,
  isReportActionId,
  isReportId,
  isReportStatus,
  type ReportActionId,
  type ReportStatus,
} from '../report-policy';
import {
  REPORT_IMAGE_LINK_SECONDS,
  isReportImageContentType,
  presignReportImage,
  reportImagesBucket,
  type ReportImageContentType,
} from './report-images';

export const REVEAL_CONTACT_SQL =
  'SELECT outcome, contact_kind, contact, account_user_id FROM jale_cap.problem_report_reveal_contact($1::uuid)';
export const REPORT_IMAGE_SQL =
  'SELECT outcome, image_key, content_type, account_user_id FROM jale_cap.problem_report_image($1::uuid)';
export const SET_STATUS_SQL = 'SELECT outcome, status FROM jale_cap.problem_report_set_status($1::uuid, $2::text)';
export const SET_NOTE_SQL = 'SELECT outcome FROM jale_cap.problem_report_set_note($1::uuid, $2::text)';
export const SETTINGS_SET_SQL = `
  SELECT outcome FROM jale_cap.problem_report_settings_set(
    $1::uuid, $2::boolean, $3::boolean, $4::boolean, $5::boolean, $6::text, $7::text, $8::integer)
`;

/** The admin origin is CloudFront in front of a signed Function URL: every body carries its SHA-256. */
const PAYLOAD_HASH_HEADER = 'x-amz-content-sha256';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_BODY_LENGTH = 65_536;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const OUTCOME_CODE_PATTERN = /^[a-z_]{1,40}$/;

type ActionEvent = {
  surface: AdminSurface;
  categories: readonly AuditCategory[];
  fieldNames: readonly string[];
};

const ACTION_EVENTS: Readonly<Record<ReportActionId, ActionEvent>> = {
  reveal_contact: {
    surface: 'admin.report_contact_reveal',
    categories: ['problem_reports', 'contact_details'],
    fieldNames: ['contact'],
  },
  view_screenshot: { surface: 'admin.report_screenshot', categories: ['problem_reports'], fieldNames: [] },
  set_status: { surface: 'admin.report_status', categories: ['problem_reports'], fieldNames: ['status'] },
  set_note: { surface: 'admin.report_note', categories: ['problem_reports'], fieldNames: ['internal_note'] },
  update_settings: { surface: 'admin.report_settings', categories: ['problem_reports'], fieldNames: [] },
};

// --- Requests ------------------------------------------------------------------

type ReportSettingsChange = {
  reportingEnabled: boolean | null;
  signedOutEnabled: boolean | null;
  screenshotsEnabled: boolean | null;
  teamEmailEnabled: boolean | null;
  signedOutDailyCap: number | null;
  teamRecipient: string | null;
  adminBaseUrl: string | null;
};

// Table column order; NULL means unchanged.
const SETTINGS_COLUMNS: readonly [keyof ReportSettingsChange, string][] = [
  ['reportingEnabled', 'reporting_enabled'],
  ['signedOutEnabled', 'signed_out_enabled'],
  ['screenshotsEnabled', 'screenshots_enabled'],
  ['teamEmailEnabled', 'team_email_enabled'],
  ['signedOutDailyCap', 'signed_out_daily_cap'],
  ['teamRecipient', 'team_recipient'],
  ['adminBaseUrl', 'admin_base_url'],
];

type ReportActionRequest =
  | { action: 'reveal_contact'; reportId: string; reason: string }
  | { action: 'view_screenshot'; reportId: string }
  | { action: 'set_status'; reportId: string; status: ReportStatus }
  | { action: 'set_note'; reportId: string; note: string | null }
  | { action: 'update_settings'; settings: ReportSettingsChange };

/** What an attempt event may name about a request, valid or not. */
type AttemptTarget = { action: ReportActionId; reportId?: string; reason?: string };

type Parsed = { request: ReportActionRequest } | { message: string };

const INVALID = Symbol('invalid');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Optional text: absent or blank is NULL (unchanged); anything else is trimmed and bounded. */
function optionalText(value: unknown, max: number): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return INVALID;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max || trimmed.includes('\u0000') ? INVALID : trimmed;
}

function parseSettingsChange(value: unknown): ReportSettingsChange | null {
  const settings = asRecord(value);
  if (!settings) return null;

  const change: ReportSettingsChange = {
    reportingEnabled: null,
    signedOutEnabled: null,
    screenshotsEnabled: null,
    teamEmailEnabled: null,
    signedOutDailyCap: null,
    teamRecipient: null,
    adminBaseUrl: null,
  };

  for (const key of ['reportingEnabled', 'signedOutEnabled', 'screenshotsEnabled', 'teamEmailEnabled'] as const) {
    const flag = settings[key];
    if (flag === undefined || flag === null) continue;
    if (typeof flag !== 'boolean') return null;
    change[key] = flag;
  }

  const cap = settings.signedOutDailyCap;
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0 || cap > SIGNED_OUT_DAILY_CAP_MAX) return null;
    change.signedOutDailyCap = cap;
  }

  const recipient = optionalText(settings.teamRecipient, 320);
  if (recipient === INVALID) return null;
  change.teamRecipient = recipient;

  // Host names are case-insensitive; the stored form is lower case with no
  // trailing slash, as the settings row requires.
  const baseUrl = optionalText(settings.adminBaseUrl, 300);
  if (baseUrl === INVALID) return null;
  if (baseUrl !== null) {
    const normalized = baseUrl.replace(/\/+$/, '').toLowerCase();
    if (!normalized) return null;
    change.adminBaseUrl = normalized;
  }

  return SETTINGS_COLUMNS.some(([key]) => change[key] !== null) ? change : null;
}

function parseActionRequest(value: unknown): Parsed {
  const body = asRecord(value);
  const action = body?.action;
  if (!body || !isReportActionId(action)) {
    return { message: 'The request was not valid.' };
  }
  const reportId = isReportId(body.reportId) ? body.reportId.toLowerCase() : null;
  if (!reportId && action !== 'update_settings') {
    return { message: 'The report id is not valid.' };
  }

  switch (action) {
    case 'reveal_contact': {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (
        reason.length < REVEAL_REASON_MIN_LENGTH
        || reason.length > REVEAL_REASON_MAX_LENGTH
        || reason.includes('\u0000')
      ) {
        return { message: `Give a reason of ${REVEAL_REASON_MIN_LENGTH} to ${REVEAL_REASON_MAX_LENGTH} characters.` };
      }
      return { request: { action: 'reveal_contact', reportId: reportId as string, reason } };
    }
    case 'view_screenshot':
      return { request: { action: 'view_screenshot', reportId: reportId as string } };
    case 'set_status':
      return isReportStatus(body.status)
        ? { request: { action: 'set_status', reportId: reportId as string, status: body.status } }
        : { message: 'Choose one of the four statuses.' };
    case 'set_note': {
      if (typeof body.note !== 'string') {
        return { message: 'The note must be text.' };
      }
      const note = body.note.trim();
      // Counted the way the database counts characters.
      if ([...note].length > REPORT_NOTE_MAX_LENGTH || note.includes('\u0000')) {
        return { message: `Notes are plain text of at most ${REPORT_NOTE_MAX_LENGTH.toLocaleString('en-US')} characters.` };
      }
      return { request: { action: 'set_note', reportId: reportId as string, note: note === '' ? null : note } };
    }
    case 'update_settings': {
      const settings = parseSettingsChange(body.settings);
      return settings
        ? { request: { action: 'update_settings', settings } }
        : { message: 'Check the settings: the switches are on or off, and the daily cap is a whole number from 0 to 5,000.' };
    }
  }
}

/** The action, report and reason a body names, for an attempt event, even when the body is not valid. */
function attemptTargetOf(value: unknown): AttemptTarget | null {
  const body = asRecord(value);
  const action = body?.action;
  if (!body || !isReportActionId(action)) return null;
  return {
    action,
    ...(isReportId(body.reportId) ? { reportId: body.reportId.toLowerCase() } : {}),
    ...(typeof body.reason === 'string' ? { reason: body.reason.trim() } : {}),
  };
}

function targetOf(request: ReportActionRequest): AttemptTarget {
  switch (request.action) {
    case 'reveal_contact':
      return { action: request.action, reportId: request.reportId, reason: request.reason };
    case 'update_settings':
      return { action: request.action };
    default:
      return { action: request.action, reportId: request.reportId };
  }
}

function attemptEvent(session: AdminSession | null, target: AttemptTarget, outcome: AttemptOutcome): AdminAttemptEvent {
  const event = ACTION_EVENTS[target.action];
  // Only a signed-in admin's reason is kept, and only when the access record
  // can hold it.
  const reason = target.action === 'reveal_contact' && session && target.reason
    && target.reason.length <= REVEAL_REASON_MAX_LENGTH && !target.reason.includes('\u0000')
    ? target.reason
    : undefined;
  return {
    surface: event.surface,
    categories: event.categories,
    fieldNames: event.fieldNames,
    ...(target.reportId ? { recordType: 'problem_report' as const, recordIds: [target.reportId] } : {}),
    ...(reason ? { purpose: { kind: 'reveal' as const, reason } } : {}),
    outcome,
  };
}

// --- Responses -------------------------------------------------------------------

type ReplyBody = { ok: true; [key: string]: unknown } | { ok: false; error: string; message: string };

/** Never cached: a revealed contact and a link are shown once and gone. */
function reply(status: number, body: ReplyBody): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function refusal(error: string, message: string): ReplyBody {
  return { ok: false, error, message };
}

const REFUSAL_MESSAGES = new Map<string, string>([
  ['not_found', 'This report no longer exists. Go back to the reports list.'],
  ['content_erased', "This report's personal content has been erased, so there is nothing to reveal or change."],
  ['no_contact', 'This report has no contact to reveal.'],
  ['no_image', 'This report has no screenshot.'],
  ['image_expired', 'This screenshot has expired. Screenshots are kept for 90 days.'],
  ['invalid_status', 'Choose one of the four statuses.'],
  ['invalid_note', `Notes are plain text of at most ${REPORT_NOTE_MAX_LENGTH.toLocaleString('en-US')} characters.`],
  ['invalid_recipient', 'Enter a valid address for the team mailbox.'],
  ['invalid_base_url', 'The dashboard address must be https:// and a host name, with no path.'],
  ['invalid_cap', 'The daily cap must be a whole number from 0 to 5,000.'],
]);

/** A refusal from the database: an outcome code other than 'ok'. The transaction rolls back. */
class ReportRefusal extends Error {
  constructor(readonly outcome: string) {
    super('refused');
  }
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : 'unknown';
}

async function fail(session: AdminSession, target: AttemptTarget, error: unknown, code?: string): Promise<Response> {
  console.error(JSON.stringify({
    event: 'report_action_failed',
    action: target.action,
    code: code ?? sqlStateOf(error),
    request_id: session.requestId,
  }));
  await recordAdminAttempt(session, attemptEvent(session, target, 'failed'));
  return reply(500, refusal('failed', 'Something went wrong. Please try again.'));
}

/** not_found answers 404; every other refusal 400; anything else is a failure (500). */
async function refuse(session: AdminSession, target: AttemptTarget, error: unknown): Promise<Response> {
  if (!(error instanceof ReportRefusal)) {
    return fail(session, target, error);
  }
  const notFound = error.outcome === 'not_found';
  await recordAdminAttempt(session, attemptEvent(session, target, notFound ? 'not_found' : 'failed'));
  const code = OUTCOME_CODE_PATTERN.test(error.outcome) ? error.outcome : 'refused';
  return reply(notFound ? 404 : 400, refusal(code, REFUSAL_MESSAGES.get(code) ?? 'The action was refused.'));
}

function oneRow<Row>(rows: Row[]): Row {
  if (rows.length !== 1) {
    throw new Error('expected one outcome row');
  }
  return rows[0];
}

function subjectsOf(accountUserId: string | null): string[] {
  return accountUserId ? [accountUserId] : [];
}

// --- The actions ------------------------------------------------------------------

type RevealRow = { outcome: string; contact_kind: string | null; contact: string | null; account_user_id: string | null };

async function revealContact(session: AdminSession, request: Extract<ReportActionRequest, { action: 'reveal_contact' }>) {
  try {
    const revealed = await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<RevealRow>(REVEAL_CONTACT_SQL, [request.reportId])).rows);
      if (row.outcome !== 'ok') {
        throw new ReportRefusal(row.outcome);
      }
      if ((row.contact_kind !== 'account' && row.contact_kind !== 'typed') || typeof row.contact !== 'string' || !row.contact) {
        throw new Error('reveal: the outcome row has no usable contact');
      }
      // The event names whose contact this is, so it follows the function;
      // it commits with the read, and the value leaves only after COMMIT.
      await recordAdminAccess(session, {
        surface: ACTION_EVENTS.reveal_contact.surface,
        categories: ACTION_EVENTS.reveal_contact.categories,
        subjectUserIds: subjectsOf(row.account_user_id),
        recordType: 'problem_report',
        recordIds: [request.reportId],
        fieldNames: ACTION_EVENTS.reveal_contact.fieldNames,
        purpose: { kind: 'reveal', reason: request.reason },
      }, client);
      return { kind: row.contact_kind, contact: row.contact };
    });
    return reply(200, { ok: true, revealed });
  } catch (error) {
    return refuse(session, targetOf(request), error);
  }
}

type ImageRow = { outcome: string; image_key: string | null; content_type: string | null; account_user_id: string | null };
type ScreenshotLink = { key: string; contentType: ReportImageContentType; issuedAt: Date; expiresAt: Date };

async function viewScreenshot(session: AdminSession, request: Extract<ReportActionRequest, { action: 'view_screenshot' }>) {
  const target = targetOf(request);
  // Checked before the transaction, so no access event is kept for a link
  // that could not be minted.
  const bucket = reportImagesBucket();
  if (!bucket) {
    return fail(session, target, undefined, 'images_bucket_unset');
  }

  let link: ScreenshotLink;
  try {
    link = await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<ImageRow>(REPORT_IMAGE_SQL, [request.reportId])).rows);
      if (row.outcome !== 'ok') {
        throw new ReportRefusal(row.outcome);
      }
      // The key is used exactly as returned; only its presence is checked.
      if (typeof row.image_key !== 'string' || !row.image_key || !isReportImageContentType(row.content_type)) {
        throw new Error('image: the outcome row has no usable image');
      }
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + REPORT_IMAGE_LINK_SECONDS * 1000);
      await recordAdminAccess(session, {
        surface: ACTION_EVENTS.view_screenshot.surface,
        categories: ACTION_EVENTS.view_screenshot.categories,
        subjectUserIds: subjectsOf(row.account_user_id),
        recordType: 'problem_report',
        recordIds: [request.reportId],
        linkExpiresAt: expiresAt,
      }, client);
      return { key: row.image_key, contentType: row.content_type, issuedAt, expiresAt };
    });
  } catch (error) {
    return refuse(session, target, error);
  }

  try {
    const url = await presignReportImage({
      bucket,
      key: link.key,
      contentType: link.contentType,
      issuedAt: link.issuedAt,
    });
    return reply(200, { ok: true, url, expiresAt: link.expiresAt.toISOString() });
  } catch (error) {
    return fail(session, target, error);
  }
}

type StatusRow = { outcome: string; status: string | null };

async function setStatus(session: AdminSession, request: Extract<ReportActionRequest, { action: 'set_status' }>) {
  try {
    const status = await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<StatusRow>(SET_STATUS_SQL, [request.reportId, request.status])).rows);
      if (row.outcome !== 'ok') {
        throw new ReportRefusal(row.outcome);
      }
      await recordAdminAction(session, {
        surface: ACTION_EVENTS.set_status.surface,
        categories: ACTION_EVENTS.set_status.categories,
        recordType: 'problem_report',
        recordIds: [request.reportId],
        fieldNames: ACTION_EVENTS.set_status.fieldNames,
      }, client);
      return isReportStatus(row.status) ? row.status : request.status;
    });
    return reply(200, { ok: true, status, message: `Status set to ${REPORT_STATUS_LABELS[status]}.` });
  } catch (error) {
    return refuse(session, targetOf(request), error);
  }
}

async function setNote(session: AdminSession, request: Extract<ReportActionRequest, { action: 'set_note' }>) {
  try {
    await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<{ outcome: string }>(SET_NOTE_SQL, [request.reportId, request.note])).rows);
      if (row.outcome !== 'ok') {
        throw new ReportRefusal(row.outcome);
      }
      await recordAdminAction(session, {
        surface: ACTION_EVENTS.set_note.surface,
        categories: ACTION_EVENTS.set_note.categories,
        recordType: 'problem_report',
        recordIds: [request.reportId],
        fieldNames: ACTION_EVENTS.set_note.fieldNames,
      }, client);
    });
    return reply(200, { ok: true, message: request.note === null ? 'Note cleared.' : 'Note saved.' });
  } catch (error) {
    return refuse(session, targetOf(request), error);
  }
}

async function updateSettings(session: AdminSession, request: Extract<ReportActionRequest, { action: 'update_settings' }>) {
  const { settings } = request;
  try {
    await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<{ outcome: string }>(SETTINGS_SET_SQL, [
        // The local preview session has no admin id: NULL.
        session.adminUserId ?? null,
        settings.reportingEnabled,
        settings.signedOutEnabled,
        settings.screenshotsEnabled,
        settings.teamEmailEnabled,
        settings.teamRecipient,
        settings.adminBaseUrl,
        settings.signedOutDailyCap,
      ])).rows);
      if (row.outcome !== 'ok') {
        throw new ReportRefusal(row.outcome);
      }
      await recordAdminAction(session, {
        surface: ACTION_EVENTS.update_settings.surface,
        categories: ACTION_EVENTS.update_settings.categories,
        // Names of the settings written, never their values.
        fieldNames: SETTINGS_COLUMNS.filter(([key]) => settings[key] !== null).map(([, column]) => column),
        resultCount: 1,
      }, client);
    });
    return reply(200, { ok: true, message: 'Settings saved.' });
  } catch (error) {
    return refuse(session, targetOf(request), error);
  }
}

// --- The route -----------------------------------------------------------------------

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_LENGTH) {
    return null;
  }
  try {
    const text = await request.text();
    return text.length > MAX_BODY_LENGTH ? null : text;
  } catch {
    return null;
  }
}

function payloadHashMatches(request: Request, text: string): boolean {
  const header = request.headers.get(PAYLOAD_HASH_HEADER)?.trim().toLowerCase();
  if (!header || !SHA256_HEX.test(header)) {
    return false;
  }
  return header === createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * POST /api/report-actions. Only the five actions exist. A request that names
 * no known action has no surface to record against, so it is answered (401
 * or 400) without an attempt event.
 */
export async function handleReportActionRequest(request: Request, session: AdminSession | undefined): Promise<Response> {
  const text = await readBody(request);
  const body = text === null ? undefined : parseJson(text);
  const named = attemptTargetOf(body);

  if (!session) {
    if (named) await recordAdminAttempt(null, attemptEvent(null, named, 'denied'));
    return reply(401, refusal('unauthorized', 'Your admin session has expired. Sign in again.'));
  }

  if (text === null || !payloadHashMatches(request, text)) {
    if (named) await recordAdminAttempt(session, attemptEvent(session, named, 'failed'));
    return reply(400, refusal('invalid_request', 'The request could not be checked. Reload the page and try again.'));
  }

  const parsed = parseActionRequest(body);
  if (!('request' in parsed)) {
    if (named) await recordAdminAttempt(session, attemptEvent(session, named, 'failed'));
    return reply(400, refusal('invalid_request', parsed.message));
  }

  const action = parsed.request;
  if (!canReport(session.role, action.action)) {
    await recordAdminAttempt(session, attemptEvent(session, targetOf(action), 'denied'));
    return reply(403, refusal('forbidden', 'Your role cannot do this. Ask an admin with the ops or superadmin role.'));
  }

  switch (action.action) {
    case 'reveal_contact':
      return revealContact(session, action);
    case 'view_screenshot':
      return viewScreenshot(session, action);
    case 'set_status':
      return setStatus(session, action);
    case 'set_note':
      return setNote(session, action);
    case 'update_settings':
      return updateSettings(session, action);
  }
}
