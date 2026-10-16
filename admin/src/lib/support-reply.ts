// Sprint 28 contract K2.7 (CCR-7): how a support reply is measured. Client
// safe on purpose: no imports, so the reply box's counter and the server
// count the same way.
//
// While the worker's 24-hour window is closed, a reply travels inside the
// support template as one paragraph: every whitespace run (line breaks
// included) becomes one space and the ends are trimmed. Its length is the
// JavaScript string length (UTF-16 code units). Over the cap the server
// answers `reply_too_long_for_template`; it never cuts the text. Migration
// 122 counts the same way in SQL (admin_support_one_line and
// admin_support_utf16_length).

/** The template cap, in UTF-16 code units of the one-paragraph text. */
export const TEMPLATE_REPLY_MAX_CHARS = 250;

/** The free-text cap while the window is open, in UTF-16 code units of the trimmed text. */
export const FREEFORM_REPLY_MAX_CHARS = 1000;

/** The reply as the template carries it: whitespace runs as one space, trimmed. */
export function templateReplyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The reply's length as the template cap counts it. */
export function templateReplyLength(text: string): number {
  return templateReplyText(text).length;
}
