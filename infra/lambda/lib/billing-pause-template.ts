/**
 * Pure rendering for the billing-pause notice: the email an employer receives
 * when a subscription change drops their active-job limit below the number of
 * jobs they have live, and `billing_pause_over_limit_jobs` pauses the excess.
 *
 * No DB, no AWS, no env reads — the billing processor hands over a typed model
 * and gets back (subject, bodyText, bodyHtml). The HTML is the shared branded
 * shell (lib/email-shell.ts); only the card differs from the other Jale
 * transactional emails.
 *
 * Limits come from email_outbox (migration 037): subject 1..200, body_text
 * 1..100000, body_html NULL or 1..200000. A violation is a 23514 at INSERT
 * time, which aborts the processor's transaction and hands the Stripe event
 * back to SQS for redelivery — an unbounded title list would therefore loop
 * forever. So the list is capped at BILLING_PAUSE_MAX_TITLES, and the render
 * is re-run against a smaller list on the (unreachable in practice) chance
 * that 50 titles still overflow.
 *
 * Job titles are employer-supplied free text: escaped on every interpolation
 * into bodyHtml, raw in bodyText, which is not HTML.
 *
 * Bilingual in one body (English first, then Spanish) because the processor
 * has no language preference for the employer at this point in the flow.
 * Spanish copy is formal (usted) throughout.
 */
import {
  EMAIL_COLORS,
  clipPreheader,
  emailButtonHtml,
  emailDividerHtml,
  emailLegalLinksHtml,
  escapeHtml,
  renderEmailShell,
} from './email-shell';

export const BILLING_PAUSE_SUBJECT = 'Job postings paused · Empleos pausados';
/** Titles listed per language block before the "+N more" line takes over. */
export const BILLING_PAUSE_MAX_TITLES = 50;
/** Well under the 200000 body_html ceiling: inboxes clip long HTML anyway. */
export const BILLING_PAUSE_BODY_HTML_MAX = 70000;
export const BILLING_PAUSE_BODY_TEXT_MAX = 100000;

const EYEBROW = 'Billing · Facturación';

const EN_INTRO =
  'Your subscription changed and these job postings were paused to match your active-job limit:';
const ES_INTRO =
  'Su suscripción cambió y estas ofertas de trabajo se pausaron para respetar su '
  + 'límite de empleos activos:';
const EN_BUTTON = 'Manage billing';
const ES_BUTTON = 'Administrar facturación';
const EN_WHY = 'You are receiving this because your Jale employer account has a subscription.';
const ES_WHY =
  'Está recibiendo este correo porque su cuenta de empleador de Jale tiene una suscripción.';

const enMore = (count: number): string =>
  `+ ${count} more job posting${count === 1 ? '' : 's'}`;
const esMore = (count: number): string =>
  `+ ${count} empleo${count === 1 ? '' : 's'} más`;
const preheaderText = (count: number): string =>
  count === 1
    ? '1 job posting paused · 1 empleo pausado'
    : `${count} job postings paused · ${count} empleos pausados`;

const C = EMAIL_COLORS;

export interface BillingPauseModel {
  /** Every job the enforcement function paused, in the order it returned them. */
  pausedTitles: string[];
  /** Absolute employer-side billing URLs, built by the processor from ALLOWED_ORIGIN. */
  englishBillingUrl: string;
  spanishBillingUrl: string;
}

export interface RenderedBillingPause {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

function textBlock(intro: string, titles: string[], more: string | null, link: string): string[] {
  const bullets = titles.map((title) => `- ${title}`);
  if (more) bullets.push(more);
  return [intro, bullets.join('\n'), link];
}

function buildBodyText(model: BillingPauseModel, shown: string[], hidden: number): string {
  return [
    ...textBlock(
      EN_INTRO,
      shown,
      hidden > 0 ? enMore(hidden) : null,
      `${EN_BUTTON}: ${model.englishBillingUrl}`,
    ),
    '',
    ...textBlock(
      ES_INTRO,
      shown,
      hidden > 0 ? esMore(hidden) : null,
      `${ES_BUTTON}: ${model.spanishBillingUrl}`,
    ),
    '',
    EN_WHY,
    ES_WHY,
  ].join('\n\n');
}

function htmlBlock(
  intro: string,
  titleRows: string,
  more: string | null,
  href: string,
  label: string,
): string {
  return (
    `<p style="margin:0 0 12px;font-size:15px;line-height:24px;color:${C.ink};">${intro}</p>`
    + titleRows
    + (more
      ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${C.ink2};">${more}</p>`
      : '')
    + `<div style="margin-top:16px;">${emailButtonHtml(href, label)}</div>`
  );
}

function buildBodyHtml(model: BillingPauseModel, shown: string[], hidden: number): string {
  // Escaped once and reused by both language blocks: escaping per block would
  // be identical work, and re-escaping an escaped string yields &amp;amp;.
  const titleRows = shown
    .map(
      (title) =>
        `<div style="padding:8px 0;border-top:1px solid ${C.divider};font-size:15px;`
        + `line-height:22px;font-weight:600;color:${C.ink};">${escapeHtml(title)}</div>`,
    )
    .join('');
  const cardHtml =
    htmlBlock(EN_INTRO, titleRows, hidden > 0 ? enMore(hidden) : null,
      model.englishBillingUrl, EN_BUTTON)
    + emailDividerHtml(24)
    + htmlBlock(ES_INTRO, titleRows, hidden > 0 ? esMore(hidden) : null,
      model.spanishBillingUrl, ES_BUTTON);
  const footerHtml =
    `<p style="margin:0 0 8px;">${EN_WHY}</p>`
    + `<p style="margin:0 0 8px;">${ES_WHY}</p>`
    + `<p style="margin:0;">${emailLegalLinksHtml('bilingual')}</p>`;
  return renderEmailShell({
    lang: 'en',
    title: BILLING_PAUSE_SUBJECT,
    preheader: clipPreheader(preheaderText(model.pausedTitles.length)),
    eyebrow: EYEBROW,
    cardHtml,
    footerHtml,
  });
}

/**
 * Render the notice. The "+N more" counts are always measured against the full
 * `pausedTitles` length, so a shrunken list still reports the true overflow.
 */
export function renderBillingPauseEmail(model: BillingPauseModel): RenderedBillingPause {
  const total = model.pausedTitles.length;
  let listed = Math.min(total, BILLING_PAUSE_MAX_TITLES);

  for (;;) {
    const shown = model.pausedTitles.slice(0, listed);
    const hidden = total - shown.length;
    const bodyText = buildBodyText(model, shown, hidden);
    const bodyHtml = buildBodyHtml(model, shown, hidden);
    const fits =
      bodyText.length <= BILLING_PAUSE_BODY_TEXT_MAX
      && bodyHtml.length <= BILLING_PAUSE_BODY_HTML_MAX;
    if (fits || listed <= 1) {
      return { subject: BILLING_PAUSE_SUBJECT, bodyText, bodyHtml };
    }
    listed = Math.floor(listed / 2);
  }
}
