/**
 * The shared branded shell every Jale transactional email renders inside. Pure
 * string building — no DB, no AWS, no env reads — so the digest producer, the
 * billing-pause notice and the Cognito verification-code trigger all emit the
 * same document skeleton and only differ in the card they hand it.
 *
 * Design tokens are copied as literal hex values from the site's design system
 * (frontend/src/app/globals.css). Email clients have no CSS custom properties,
 * so `var(--jale-navy)` would render as nothing in Outlook: every colour here
 * is spelled out, and EMAIL_COLORS exists so the card renderers never re-type
 * a hex by hand.
 *
 * The document is deliberately primitive: nested presentation tables, inline
 * styles only, no <style> block, no @media, no gradients, no VML and no
 * conditional comments. Outlook therefore renders square corners and a
 * full-width band instead of the 600px rounded card — accepted by design, in
 * exchange for a document that cannot break anywhere. `font-family` is set on
 * every <td> because Outlook's word-processor engine inherits neither the
 * body's font nor a parent cell's.
 *
 * Trust boundary: `title`, `preheader` and `eyebrow` are RAW caller text and
 * are HTML-escaped here. `cardHtml` and `footerHtml` are TRUSTED pre-escaped
 * fragments inserted verbatim — a caller interpolating employer- or
 * worker-supplied free text into them must escape it with escapeHtml() first.
 *
 * renderEmailShell() inserts each fragment exactly once and never inspects,
 * trims or normalises it, so the rendered length is always the empty-shell
 * length plus both fragment lengths. Callers rely on that to size a body
 * against the email_outbox body_html cap (migration 037) before inserting.
 */

export type EmailLang = 'en' | 'es';

/** Lexend is the brand face; the rest is the fallback chain for clients that block webfonts. */
export const EMAIL_FONT_STACK =
  "'Lexend',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

/**
 * Hardcoded on purpose: email assets are always apex-absolute. A message
 * rendered from CI, staging or a local run is still read in an inbox weeks
 * later, where a relative or environment-derived host resolves to nothing.
 */
export const EMAIL_WORDMARK_URL = 'https://jaleapp.ai/brand/email/wordmark-white-2x.png';
export const EMAIL_LEGAL_TERMS_URL = 'https://jaleapp.ai/legal/terms';
export const EMAIL_LEGAL_PRIVACY_URL = 'https://jaleapp.ai/legal/privacy';
export const EMAIL_COPYRIGHT = '© 2026 Jale';

/** Literal hex lifted from globals.css. Never emit `var(--…)` into an email. */
export const EMAIL_COLORS = {
  paper: '#e3eaf2',
  navy: '#181855',
  card: '#ffffff',
  ink: '#181855',
  ink2: '#5b6480',
  link: '#0050ad',
  button: '#0064d6',
  divider: '#d1d1d1',
  eyebrow: '#CCCCDA',
  noticeBg: '#eaf2ff',
  dotStrong: '#1f7a44',
  dotGood: '#0064d6',
  dotFair: '#5b6480',
} as const;

/** Default preheader budget: what a phone inbox shows next to the subject. */
const PREHEADER_MAX = 90;

const FONT = EMAIL_FONT_STACK;
const C = EMAIL_COLORS;

/** Copied verbatim from employer-digest-template.ts:63-70, now the one shared copy. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Index of the last whitespace character at or before `upTo`, or -1. */
function lastWhitespaceIndex(text: string, upTo: number): number {
  for (let i = Math.min(upTo, text.length - 1); i >= 0; i -= 1) {
    if (/\s/.test(text.charAt(i))) {
      return i;
    }
  }
  return -1;
}

/**
 * Clip raw preheader text to `max` characters on a word boundary, appending
 * ' …' when something was dropped. Raw text in, raw text out — clipping must
 * happen BEFORE escaping, otherwise the cut can land inside an entity and
 * leave a dangling `&amp` in the inbox preview.
 *
 * A single word longer than `max` has no boundary to cut on and is hard-cut to
 * `max - 1` characters plus '…'. Text that already fits is returned untouched,
 * trailing whitespace included.
 */
export function clipPreheader(text: string, max: number = PREHEADER_MAX): string {
  if (text.length <= max) {
    return text;
  }
  // Look one character past the budget: if that character is whitespace the
  // word ending at `max` is whole and survives the cut.
  const boundary = lastWhitespaceIndex(text, max);
  const head = boundary > 0 ? text.slice(0, boundary).trimEnd() : '';
  return head.length > 0 ? `${head} …` : `${text.slice(0, max - 1)}…`;
}

export interface EmailShellInput {
  /** <html lang>. Bilingual emails pass 'en'. */
  lang: EmailLang;
  /** RAW; escaped here. Same string as the email subject. */
  title: string;
  /** RAW; escaped here. Already clipped by the caller (see clipPreheader). */
  preheader: string;
  /** RAW; escaped here. Short header-band kicker, e.g. "Daily digest". */
  eyebrow: string;
  /** TRUSTED pre-escaped HTML fragment; inserted verbatim in the white card. */
  cardHtml: string;
  /** TRUSTED pre-escaped HTML fragment; inserted verbatim under the card. */
  footerHtml: string;
}

function head(lang: EmailLang, title: string): string {
  return (
    `<!DOCTYPE html><html lang="${lang}"><head>` +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<meta name="supported-color-schemes" content="light">' +
    '<meta name="format-detection" content="telephone=no">' +
    `<title>${escapeHtml(title)}</title>` +
    '<link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;600;700;800&amp;display=swap" rel="stylesheet">' +
    `</head><body style="margin:0;padding:0;background:${C.paper};">`
  );
}

/** Off-screen text the inbox list shows after the subject; invisible once opened. */
function preheaderBlock(preheader: string): string {
  return (
    `<div style="display:none;font-size:1px;line-height:1px;color:${C.paper};` +
    'max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">' +
    `${escapeHtml(preheader)}</div>`
  );
}

/** Navy band: wordmark on the left, uppercase eyebrow on the right. */
function headerRow(eyebrow: string): string {
  return (
    `<tr><td bgcolor="${C.navy}" style="background:${C.navy};border-radius:16px 16px 0 0;` +
    `padding:20px 24px;font-family:${FONT};">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    `<td align="left" valign="middle" style="width:50%;font-family:${FONT};">` +
    '<a href="https://jaleapp.ai" style="text-decoration:none;">' +
    `<img src="${EMAIL_WORDMARK_URL}" width="78" height="40" alt="Jale" ` +
    `style="display:block;width:78px;height:40px;border:0;font-family:${FONT};` +
    `font-size:20px;font-weight:700;color:${C.card};"></a></td>` +
    `<td align="right" valign="middle" style="font-family:${FONT};font-size:11px;line-height:16px;` +
    `font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${C.eyebrow};">` +
    `${escapeHtml(eyebrow)}</td>` +
    '</tr></table></td></tr>'
  );
}

/** White card. `cardHtml` is trusted and inserted verbatim, exactly once. */
function cardRow(cardHtml: string): string {
  return (
    `<tr><td bgcolor="${C.card}" style="background:${C.card};border-radius:0 0 16px 16px;` +
    `padding:28px 24px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.ink};">` +
    `${cardHtml}</td></tr>`
  );
}

/** Fine print under the card, on the paper background. Always emitted, even when empty. */
function footerRow(footerHtml: string): string {
  return (
    `<tr><td style="padding:20px 24px 0;font-family:${FONT};font-size:13px;line-height:20px;` +
    `color:${C.ink2};">${footerHtml}</td></tr>`
  );
}

/**
 * Render the complete `<!DOCTYPE html>…</html>` document.
 *
 * Length guarantee: the result is always
 * `renderEmailShell({...input, cardHtml: '', footerHtml: ''}).length +
 * cardHtml.length + footerHtml.length`. Both rows are emitted unconditionally
 * and neither fragment is inspected, so callers can budget a body size against
 * the email_outbox length constraints before they build the card.
 */
export function renderEmailShell(input: EmailShellInput): string {
  return (
    head(input.lang, input.title) +
    preheaderBlock(input.preheader) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="${C.paper}" style="background:${C.paper};">` +
    `<tr><td align="center" style="padding:24px 12px;font-family:${FONT};">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="width:100%;max-width:600px;">' +
    headerRow(input.eyebrow) +
    cardRow(input.cardHtml) +
    footerRow(input.footerHtml) +
    '</table></td></tr></table></body></html>'
  );
}

/**
 * Bulletproof call-to-action: the background lives on a <td> (which Outlook
 * paints) and the padding lives on a block-level <a> (so the whole pill is the
 * click target). No VML, so Outlook shows a square button.
 */
export function emailButtonHtml(
  href: string,
  label: string,
  opts: { fullWidth?: boolean } = {},
): string {
  const width = opts.fullWidth ? ' width="100%"' : '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width}><tr>` +
    `<td align="center" bgcolor="${C.button}" style="background:${C.button};border-radius:9999px;">` +
    `<a href="${escapeHtml(href)}" style="display:block;padding:13px 24px;font-family:${FONT};` +
    `font-size:15px;line-height:20px;font-weight:600;color:${C.card};text-decoration:none;">` +
    `${escapeHtml(label)}</a></td></tr></table>`
  );
}

/** Hairline rule between card sections. A styled <div>, because <hr> is unstyleable in Outlook. */
export function emailDividerHtml(marginPx: number = 24): string {
  return `<div style="height:1px;background:${C.divider};margin:${marginPx}px 0;"></div>`;
}

const LEGAL_LABELS: Record<EmailLang | 'bilingual', { terms: string; privacy: string }> = {
  en: { terms: 'Terms', privacy: 'Privacy' },
  es: { terms: 'Términos', privacy: 'Privacidad' },
  bilingual: { terms: 'Terms / Términos', privacy: 'Privacy / Privacidad' },
};

/**
 * Footer legal line. 'bilingual' is for messages that carry both languages in
 * one body (the verification code, for instance), where picking one language
 * for the fine print would contradict the rest of the email.
 */
export function emailLegalLinksHtml(lang: EmailLang | 'bilingual'): string {
  const labels = LEGAL_LABELS[lang];
  const link = (href: string, text: string): string =>
    `<a href="${href}" style="color:${C.link};font-weight:600;">${text}</a>`;
  return (
    `${link(EMAIL_LEGAL_TERMS_URL, labels.terms)} · ` +
    `${link(EMAIL_LEGAL_PRIVACY_URL, labels.privacy)} · ${EMAIL_COPYRIGHT}`
  );
}
