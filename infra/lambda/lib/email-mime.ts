import { randomBytes } from 'node:crypto';

/**
 * RFC 5322 / 2045 / 2047 message construction for the email outbox sweeper.
 *
 * WHY RAW MIME AND NOT THE STRUCTURED SES BODY
 *
 * SESv1's `SendEmail` (and SESv2's `Content.Simple`) build the message for us,
 * and neither lets us set an arbitrary header. RFC 8058 one-click unsubscribe
 * IS a pair of headers -- `List-Unsubscribe` and `List-Unsubscribe-Post` --
 * and Gmail/Yahoo bulk-sender rules require them on marketing-class mail. The
 * only way to put them on the wire is to hand SES the whole message, so this
 * module exists to produce that byte string and nothing else. No AWS, no DB,
 * no env: the caller passes a complete model, the same way
 * employer-digest-template.ts is pure.
 *
 * HEADER INJECTION IS THE ONE REAL HAZARD HERE
 *
 * Every value below reaches this module from the database. email_outbox's
 * CHECKs bound the LENGTH of recipient_email and subject but say nothing about
 * their CONTENT, so a stored CR or LF would end the header and let the rest of
 * the value become headers of its own -- a Bcc, a second To, a replaced
 * From. `assertHeaderSafe` rejects the row instead. It throws rather than
 * strips: silently mailing a mangled version of a message someone tampered
 * with is worse than not mailing it, and the sweeper turns the throw into a
 * terminal `failed` row an operator can see.
 *
 * ENCODING: BASE64, DELIBERATELY, FOR BOTH PARTS
 *
 * Quoted-printable would preserve ~25% more of the Gmail clip budget, but it
 * has four separate ways to be subtly wrong (soft line breaks, `=3D`, trailing
 * whitespace, never splitting a `=XX` triplet) and each of them fails as a
 * corrupted message in somebody's inbox rather than as a test. base64 is
 * `Buffer.toString('base64')` plus a 76-character wrap, and it cannot be
 * subtly wrong. The cost is paid once, in
 * employer-digest-template.ts's DIGEST_BODY_HTML_SOFT_MAX, which is calibrated
 * against the ENCODED size this module produces -- see the byte-budget block
 * in employer-digest-template.test.ts.
 */

/** RFC 2045 base64 line length. */
const BASE64_LINE_LENGTH = 76;
/**
 * RFC 2047 caps an encoded word at 75 characters INCLUDING `=?UTF-8?B?` (10)
 * and `?=` (2). 63 base64 characters fit; 63 is not a multiple of 4, so the
 * usable payload is 60 characters == 45 raw bytes.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 45;
const CRLF = '\r\n';

export interface RawEmailInput {
  /** Full From value — `Jale <no-reply@jaleapp.ai>` or a bare address. */
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /**
   * RFC 8058 one-click endpoint. Present only for digest mail; when absent no
   * List-Unsubscribe pair is emitted at all, which is the correct shape for
   * transactional mail such as the billing-pause notice.
   */
  unsubscribeUrl?: string | null;
  /** SES configuration set that routes bounce/complaint events to SNS. */
  configurationSet?: string | null;
  /** Injectable for deterministic tests; defaults to now. */
  date?: Date;
}

/**
 * Thrown with a stable `name` so the sweeper can record it as a terminal
 * last_error code (safeErrorCode() in email-outbox.ts reads `name`, and its
 * character-class guard is what keeps an arbitrary provider string out of the
 * column). The code is repeated in the message because that is the half a
 * CloudWatch log line and a Jest `toThrow` matcher actually see.
 */
class MimeBuildError extends Error {
  constructor(name: string, detail: string) {
    super(`${name}: ${detail}`);
    this.name = name;
  }
}

/**
 * Character-code checks rather than a regex with escape sequences: CR, LF and
 * NUL are the three bytes that can end a header line or truncate it, and
 * spelling them as literals in a pattern is how a tooling round-trip puts a
 * real control byte in the source file.
 */
function assertHeaderSafe(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MimeBuildError('email_mime_header_empty', field + ' is empty');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 13 || code === 10 || code === 0) {
      throw new MimeBuildError(
        'email_mime_header_injection',
        field + ' contains a line break or NUL',
      );
    }
  }
}

/** Printable US-ASCII only. Anything else -- an accent, an em dash, a tab -- gets encoded. */
function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

/**
 * RFC 2047 `=?UTF-8?B?...?=`, split on CODE POINT boundaries so a multi-byte
 * character is never cut in half across two encoded words, and folded with
 * CRLF + a single space (the continuation form RFC 2047 §5 requires between
 * adjacent encoded words).
 */
export function encodeHeaderWord(value: string): string {
  const words: string[] = [];
  let chunk = Buffer.alloc(0);

  for (const codePoint of Array.from(value)) {
    const bytes = Buffer.from(codePoint, 'utf8');
    if (chunk.length + bytes.length > ENCODED_WORD_PAYLOAD_BYTES) {
      words.push(`=?UTF-8?B?${chunk.toString('base64')}?=`);
      chunk = Buffer.alloc(0);
    }
    chunk = Buffer.concat([chunk, bytes]);
  }
  words.push(`=?UTF-8?B?${chunk.toString('base64')}?=`);

  return words.join(`${CRLF} `);
}

/** Pure ASCII passes through untouched — encoding it would only cost bytes. */
export function encodeHeaderValue(value: string): string {
  return isAscii(value) ? value : encodeHeaderWord(value);
}

/**
 * An address header must keep its `<addr>` literal: wrapping the whole thing
 * in an encoded word would produce a message with no parseable recipient. Only
 * the display-name phrase is ever encoded.
 */
export function formatAddressHeader(value: string): string {
  if (isAscii(value)) return value;
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  if (!match) {
    throw new MimeBuildError(
      'email_mime_address_not_ascii',
      'a bare address header must be ASCII',
    );
  }
  const [, displayName, address] = match;
  if (!isAscii(address)) {
    throw new MimeBuildError('email_mime_address_not_ascii', 'the address itself must be ASCII');
  }
  return `${encodeHeaderWord(displayName)} <${address}>`;
}

/**
 * How many bytes `base64Part` will produce for a body of `byteLength` bytes.
 *
 * Exported because employer-digest-template.ts budgets against the ENCODED
 * message, not the source: Gmail clips at roughly 102 kB of what it actually
 * received, and base64 is 4/3 plus a CRLF every 76 characters. Sharing this
 * function is what stops the template's budget and the builder's output from
 * drifting apart -- a drift whose only symptom is a truncated email.
 */
export function base64EncodedLength(byteLength: number): number {
  const characters = Math.ceil(byteLength / 3) * 4;
  const lines = Math.max(1, Math.ceil(characters / BASE64_LINE_LENGTH));
  return characters + (lines - 1) * CRLF.length;
}

/** RFC 2045: base64, hard-wrapped at 76 characters, CRLF-terminated lines. */
export function base64Part(body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(offset, offset + BASE64_LINE_LENGTH));
  }
  // An empty body would otherwise produce zero lines and a part with no
  // content line at all.
  if (lines.length === 0) lines.push('');
  return lines.join(CRLF);
}

/**
 * RFC 5322 date. `Date.prototype.toUTCString()` is the HTTP-date form and ends
 * in `GMT`, which is an OBSOLETE zone token in 5322; `+0000` is the current
 * one, so it is written out here rather than borrowed.
 */
export function rfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} `
    + `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:`
    + `${pad(date.getUTCSeconds())} +0000`;
}

/**
 * Builds the complete message.
 *
 * Message-ID is deliberately NOT set: SES stamps its own and returns it as
 * `MessageId`, which is the value the bounce handler joins on
 * (email_outbox.ses_message_id, migration 087). Minting one here would leave
 * two competing identifiers for the same message.
 */
export function buildRawEmail(input: RawEmailInput): Buffer {
  // Injection is checked on the RAW values, before any formatting can turn a
  // stray newline into a confusing "not ASCII" complaint.
  assertHeaderSafe('From', input.from);
  assertHeaderSafe('To', input.to);
  assertHeaderSafe('Subject', input.subject);
  const from = formatAddressHeader(input.from);
  if (!isAscii(input.to)) {
    throw new MimeBuildError('email_mime_address_not_ascii', 'To must be ASCII');
  }

  const headers: string[] = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${rfc5322Date(input.date ?? new Date())}`,
    'MIME-Version: 1.0',
  ];

  if (input.unsubscribeUrl) {
    assertHeaderSafe('List-Unsubscribe', input.unsubscribeUrl);
    if (!isAscii(input.unsubscribeUrl)) {
      throw new MimeBuildError('email_mime_unsubscribe_url_invalid', 'the unsubscribe URL must be ASCII');
    }
    if (input.unsubscribeUrl.includes('<') || input.unsubscribeUrl.includes('>')) {
      throw new MimeBuildError('email_mime_unsubscribe_url_invalid', 'the unsubscribe URL must not contain <>');
    }
    // The pair is meaningless apart: List-Unsubscribe alone is the pre-8058
    // header that mail clients render as a link, and only
    // List-Unsubscribe-Post turns it into the one-click POST Gmail/Yahoo
    // require of bulk senders. Emit both or neither.
    headers.push(`List-Unsubscribe: <${input.unsubscribeUrl}>`);
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  if (input.configurationSet) {
    assertHeaderSafe('X-SES-CONFIGURATION-SET', input.configurationSet);
    headers.push(`X-SES-CONFIGURATION-SET: ${input.configurationSet}`);
  }

  if (!input.bodyHtml) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    return Buffer.from(
      `${headers.join(CRLF)}${CRLF}${CRLF}${base64Part(input.bodyText)}${CRLF}`,
      'utf8',
    );
  }

  // 24 hex characters of randomness. The delimiter must not occur anywhere in
  // either part; base64 output has no `=?` or `_` and cannot contain this.
  const boundary = `----=_Jale_${randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  // text/plain FIRST: RFC 2046 says a multipart/alternative's parts run
  // worst-to-best and clients pick the LAST one they can render, so the order
  // is what makes an HTML client show HTML.
  const parts = [
    [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Part(input.bodyText),
    ].join(CRLF),
    [
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Part(input.bodyHtml),
    ].join(CRLF),
  ];

  const body = parts.map((part) => `--${boundary}${CRLF}${part}${CRLF}`).join('')
    + `--${boundary}--${CRLF}`;

  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${body}`, 'utf8');
}
