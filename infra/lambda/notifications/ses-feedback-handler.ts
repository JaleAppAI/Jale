import type { SNSEvent, SNSEventRecord } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { errorMessage } from '../lib/http';

/**
 * SES bounce / complaint -> employer digest OFF.
 *
 * SNS delivers one SES event per record; a permanent bounce or any complaint
 * for a digest message switches that employer's daily digest off and bumps
 * their unsubscribe_token_version, through migration 088's SECURITY DEFINER
 * `public.disable_digest_for_employer(uuid)`. Nothing else in the system
 * reacts to delivery feedback today, so before this handler existed a dead
 * mailbox kept receiving a daily send forever -- which is precisely what
 * moves a sending domain onto a blocklist.
 *
 * ── Which employer ────────────────────────────────────────────────
 * NOT the bounced address. The notification's `mail.messageId` is the id SES
 * returned at send time, which the sweeper persisted into
 * email_outbox.ses_message_id (088). That row records `source_type` and
 * `source_id`, and for `source_type = 'employer_digest'` the source_id IS the
 * employer's users.id. So the employer is READ OFF THE MESSAGE THAT BOUNCED
 * rather than re-derived from an address -- which cannot mis-target an
 * employer who changed their email between send and bounce, and needs no
 * cross-tenant read of `users`. See 088's header for the full argument.
 *
 * ── eventType vs notificationType ─────────────────────────────────
 * SES has two SNS payload shapes and they disagree on the field name. A
 * CONFIGURATION SET event destination (what NotificationsStack creates) sends
 * `eventType`; a per-IDENTITY notification (the older mechanism, which an
 * operator may still have wired up on the domain) sends `notificationType`.
 * The values are the same strings. Reading whichever is present means the
 * handler works under both and does not silently no-op if the wiring is ever
 * changed.
 *
 * ── What is NOT logged ────────────────────────────────────────────
 * No recipient address, ever -- not in the happy path, not in an error. A
 * bounce log is exactly the place a full list of dead employer addresses would
 * accumulate in CloudWatch. The message id and the event type are enough to
 * follow any incident back to a row.
 *
 * ── Failure posture ───────────────────────────────────────────────
 * A malformed or unrecognised notification is COUNTED and dropped, never
 * thrown: no amount of retrying makes a garbage payload parse. A DATABASE
 * failure throws, because that is exactly the case retrying fixes -- Lambda
 * retries the async invocation twice and then sends it to
 * SesFeedbackHandlerDlq (NotificationsStack), whose depth alarm is the signal
 * that a bounce was accepted by SES and never applied here.
 */

interface SesFeedbackSummary {
  processed: number;
  disabled: number;
  transient: number;
  unknownMessage: number;
  notDigest: number;
  malformed: number;
}

interface OutboxLookupRow {
  source_type: string;
  source_id: string;
}

function metric(name: string, fields: Record<string, unknown> = {}): void {
  // A single JSON string argument: NotificationsStack's metric filters match a
  // quoted literal inside this, and a second console argument is formatted
  // separately by the runtime where no filter pattern can reach it. Same
  // constraint employer-digest-producer.ts documents at length.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ metric: name, ...fields }));
}

/**
 * `Permanent` is the only bounce worth acting on: `Transient` is a full mailbox
 * or a greylist.
 *
 * `not-spam` is the one complaint that must NOT disable anything. It is an ARF
 * feedback type meaning the recipient moved the message back OUT of their spam
 * folder -- the opposite of a complaint, delivered down the same channel
 * because the ARF report format carries both. Treating it as a complaint would
 * switch the digest off for someone who just told their provider they wanted
 * it. Every other feedback type (abuse, fraud, virus, other, or absent) is a
 * real complaint and disables.
 */
function shouldDisable(notification: Record<string, unknown>, eventType: string): boolean {
  if (eventType === 'Complaint') {
    const complaint = notification.complaint as Record<string, unknown> | undefined;
    return complaint?.complaintFeedbackType !== 'not-spam';
  }
  if (eventType !== 'Bounce') return false;
  const bounce = notification.bounce as Record<string, unknown> | undefined;
  return bounce?.bounceType === 'Permanent';
}

function parseNotification(record: SNSEventRecord): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(record.Sns.Message) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const handler = async (event: SNSEvent): Promise<SesFeedbackSummary> => {
  const summary: SesFeedbackSummary = {
    processed: 0, disabled: 0, transient: 0, unknownMessage: 0, notDigest: 0, malformed: 0,
  };

  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return summary;

  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    for (const record of records) {
      summary.processed += 1;

      const notification = parseNotification(record);
      const eventType = typeof notification?.eventType === 'string'
        ? notification.eventType
        : typeof notification?.notificationType === 'string'
          ? notification.notificationType
          : null;
      const mail = notification?.mail as Record<string, unknown> | undefined;
      const messageId = typeof mail?.messageId === 'string' ? mail.messageId : null;

      if (!eventType || !messageId) {
        summary.malformed += 1;
        metric('ses_feedback_malformed', { eventType: eventType ?? null });
        continue;
      }

      if (!shouldDisable(notification!, eventType)) {
        // Deliveries, sends, opens and TRANSIENT bounces all land here. A
        // transient bounce is counted rather than ignored: a mailbox that is
        // full every single day is a real signal, just not one that should
        // silently switch a paying employer's notifications off.
        summary.transient += 1;
        metric('ses_feedback_no_action', { eventType, messageId });
        continue;
      }

      // Runs as jale_admin under 037's email_outbox_admin_select USING (true),
      // so no RLS GUC is needed for the lookup -- and none is set, because the
      // definer below pins the only one that matters, itself.
      const lookup = await client.query<OutboxLookupRow>(
        `SELECT source_type, source_id FROM email_outbox WHERE ses_message_id = $1`,
        [messageId],
      );
      const row = lookup.rows[0];

      if (!row) {
        // Genuinely expected sometimes: mail SES sent before 088 shipped, and
        // any row whose finalising UPDATE lost its `status = 'send_unknown'`
        // guard. Never a write, always a count.
        summary.unknownMessage += 1;
        metric('ses_feedback_unknown_message', { eventType, messageId });
        continue;
      }

      if (row.source_type !== 'employer_digest') {
        // A billing-pause notice bounced. Its source_id is a billing event,
        // not an employer, so there is nothing here that could be switched off
        // without guessing.
        summary.notDigest += 1;
        metric('ses_feedback_not_digest', { eventType, messageId, sourceType: row.source_type });
        continue;
      }

      const disabled = await client.query<{ disabled: number }>(
        `SELECT public.disable_digest_for_employer($1::uuid) AS disabled`,
        [row.source_id],
      );
      if (Number(disabled.rows[0]?.disabled ?? 0) > 0) {
        summary.disabled += 1;
      }
      // eslint-disable-next-line no-console
      console.info(JSON.stringify({
        metric: 'ses_feedback_digest_disabled',
        eventType,
        messageId,
        changed: Number(disabled.rows[0]?.disabled ?? 0),
      }));
    }
  } catch (error) {
    // The DB half. Thrown so the Lambda service retries and, failing that,
    // the Errors alarm fires -- unlike every `continue` above, this IS the
    // kind of failure retrying fixes.
    metric('ses_feedback_failed', { error: errorMessage(error) });
    throw error;
  } finally {
    client.release();
  }

  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ metric: 'ses_feedback_run', ...summary }));
  return summary;
};
