import * as fs from 'node:fs';
import * as path from 'node:path';
import { isWithinSessionWindow } from '../../../../../lambda/whatsapp/lib/session-window';

/**
 * WhatsApp delivers free-form text only within 24h of the
 * worker's last message (Twilio 63016 otherwise). The release asks this
 * helper once and supersedes every free-form row when the answer is no.
 */
describe('isWithinSessionWindow', () => {
  const NUMBER = '+15125551234';

  function scripted(row: { within_window: boolean | null } | null) {
    const query = jest.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
    return { query, client: { query } as any };
  }

  it("reads the recipient's own inbound log on the DATABASE clock, with the 15-minute drain margin, skipping bot-side # rows", async () => {
    const { query, client } = scripted({ within_window: true });

    await expect(isWithinSessionWindow(client, NUMBER)).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = (query.mock.calls[0] as unknown) as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');
    expect(text).toContain('FROM whatsapp_processed_messages');
    expect(text).toContain('max(first_seen_at)');
    // now(), not a JavaScript Date: the comparison and the log share a clock.
    expect(text).toContain("now() - interval '23 hours 45 minutes'");
    // Keyed by the number the row will be sent to, never by a user id.
    expect(text).toContain('whatsapp_number = $1');
    // `<sid>#err`, `#vt` and `#vp` rows are ours, not the worker's.
    expect(text).toContain("position('#' in message_sid) = 0");
    expect(params).toEqual([NUMBER]);
  });

  it('is false outside the window', async () => {
    const { client } = scripted({ within_window: false });
    await expect(isWithinSessionWindow(client, NUMBER)).resolves.toBe(false);
  });

  it('is false for a number that never wrote to us (the max over no rows is NULL)', async () => {
    const { client } = scripted({ within_window: null });
    await expect(isWithinSessionWindow(client, NUMBER)).resolves.toBe(false);
  });

  it('is false when the statement returns no row at all', async () => {
    const { client } = scripted(null);
    await expect(isWithinSessionWindow(client, NUMBER)).resolves.toBe(false);
  });

  it('reads no clock of its own (source scan)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../../lambda/whatsapp/lib/session-window.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new Date\s*\(/);
  });
});
