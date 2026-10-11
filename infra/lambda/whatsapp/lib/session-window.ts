import type { PoolClient } from 'pg';

/**
 * Whether a WhatsApp number is inside the 24-hour
 * customer-service window, the only time WhatsApp delivers free-form text.
 * Outside it Twilio fails the send (63016) and the row blocks the worker's
 * queue behind it. Content templates are deliverable either way.
 *
 * The window opens with the worker's own last message, read from the inbound
 * log (`whatsapp_processed_messages`) for the number the row would be sent
 * to -- never by user id, because a number with no linked conversation has
 * none. Rows whose sid carries a '#' (`<sid>#err`, the synthetic `#vt`/`#vp`
 * voice re-entries) are written by us, not the worker, and never count.
 *
 * Computed on the DATABASE clock, the same clock that stamped
 * `first_seen_at`, with a 15-minute margin for the outbox drain: a row
 * written at 23h50m must not go out at 24h05m. The release asks once, and the
 * renderer stays clock-free.
 */
export async function isWithinSessionWindow(
  client: PoolClient,
  whatsappNumber: string,
): Promise<boolean> {
  const result = await client.query<{ within_window: boolean | null }>(
    `SELECT max(first_seen_at) > now() - interval '23 hours 45 minutes' AS within_window
       FROM whatsapp_processed_messages
      WHERE whatsapp_number = $1
        AND position('#' in message_sid) = 0`,
    [whatsappNumber],
  );
  // A number that never wrote to us has no rows: the max is NULL.
  return result.rows[0]?.within_window === true;
}
