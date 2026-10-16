/**
 * Pure rendering for the billing-resume notice -- sprint 28 (contract K4.5):
 * the email an employer receives when their subscription is active again and
 * `billing_resume_paused_jobs` brings back the job postings billing paused.
 * The twin of `billing-pause-template.ts`, with the same limits and rules:
 * titles clipped and capped (an over-long body would be a 23514 that loops
 * the Stripe event through SQS), escaped in bodyHtml, raw in bodyText,
 * bilingual in one body (English first, formal Spanish second).
 *
 * No DB, no AWS, no env reads.
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
import {
  BILLING_PAUSE_BODY_HTML_MAX,
  BILLING_PAUSE_BODY_TEXT_MAX,
  BILLING_PAUSE_MAX_TITLE_CHARS,
  BILLING_PAUSE_MAX_TITLES,
} from './billing-pause-template';

export const BILLING_RESUME_SUBJECT = 'Your jobs are live again · Sus empleos están activos de nuevo';

const EYEBROW = 'Billing · Facturación';
const EN_INTRO = 'Your subscription is active again, and these job postings are live again:';
const ES_INTRO = 'Su suscripción está activa de nuevo y estas ofertas de trabajo vuelven a estar publicadas:';
const EN_BUTTON = 'View your jobs';
const ES_BUTTON = 'Ver sus empleos';
const EN_WHY = 'You are receiving this because your Jale employer account has a subscription.';
const ES_WHY = 'Está recibiendo este correo porque su cuenta de empleador de Jale tiene una suscripción.';
const C = EMAIL_COLORS;

const enMore = (count: number): string => `+ ${count} more job posting${count === 1 ? '' : 's'}`;
const esMore = (count: number): string => `+ ${count} empleo${count === 1 ? '' : 's'} más`;
const preheaderText = (count: number): string =>
  count === 1 ? '1 job posting is live again · 1 empleo activo de nuevo'
    : `${count} job postings are live again · ${count} empleos activos de nuevo`;

const clipTitle = (title: string): string =>
  title.length > BILLING_PAUSE_MAX_TITLE_CHARS ? `${title.slice(0, BILLING_PAUSE_MAX_TITLE_CHARS - 1)}…` : title;

export interface BillingResumeModel {
  /** Every job the resume function reactivated, in the order it returned them. */
  resumedTitles: string[];
  /** Absolute employer-side jobs URLs, built by the processor from ALLOWED_ORIGIN. */
  englishJobsUrl: string;
  spanishJobsUrl: string;
}

export interface RenderedBillingResume {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

function render(model: BillingResumeModel, shown: string[], hidden: number): RenderedBillingResume {
  const bullets = shown.map((title) => `- ${title}`).join('\n');
  const bodyText = [
    EN_INTRO, hidden > 0 ? `${bullets}\n${enMore(hidden)}` : bullets, `${EN_BUTTON}: ${model.englishJobsUrl}`,
    '',
    ES_INTRO, hidden > 0 ? `${bullets}\n${esMore(hidden)}` : bullets, `${ES_BUTTON}: ${model.spanishJobsUrl}`,
    '',
    EN_WHY,
    ES_WHY,
  ].join('\n\n');

  const titleRows = shown
    .map((title) => `<div style="padding:8px 0;border-top:1px solid ${C.divider};font-size:15px;`
      + `line-height:22px;font-weight:600;color:${C.ink};">${escapeHtml(title)}</div>`)
    .join('');
  const block = (intro: string, more: string | null, href: string, label: string) =>
    `<p style="margin:0 0 12px;font-size:15px;line-height:24px;color:${C.ink};">${intro}</p>`
    + titleRows
    + (more ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${C.ink2};">${more}</p>` : '')
    + `<div style="margin-top:16px;">${emailButtonHtml(href, label)}</div>`;
  const cardHtml =
    block(EN_INTRO, hidden > 0 ? enMore(hidden) : null, model.englishJobsUrl, EN_BUTTON)
    + emailDividerHtml(24)
    + block(ES_INTRO, hidden > 0 ? esMore(hidden) : null, model.spanishJobsUrl, ES_BUTTON);
  const footerHtml =
    `<p style="margin:0 0 8px;">${EN_WHY}</p>`
    + `<p style="margin:0 0 8px;">${ES_WHY}</p>`
    + `<p style="margin:0;">${emailLegalLinksHtml('bilingual')}</p>`;
  const bodyHtml = renderEmailShell({
    lang: 'en',
    title: BILLING_RESUME_SUBJECT,
    preheader: clipPreheader(preheaderText(model.resumedTitles.length)),
    eyebrow: EYEBROW,
    cardHtml,
    footerHtml,
  });
  return { subject: BILLING_RESUME_SUBJECT, bodyText, bodyHtml };
}

/** Render the notice; the "+N more" counts are measured against the full list. */
export function renderBillingResumeEmail(model: BillingResumeModel): RenderedBillingResume {
  const total = model.resumedTitles.length;
  let listed = Math.min(total, BILLING_PAUSE_MAX_TITLES);
  for (;;) {
    const shown = model.resumedTitles.slice(0, listed).map(clipTitle);
    const rendered = render(model, shown, total - shown.length);
    const fits = rendered.bodyText.length <= BILLING_PAUSE_BODY_TEXT_MAX
      && rendered.bodyHtml.length <= BILLING_PAUSE_BODY_HTML_MAX;
    if (fits || listed <= 1) return rendered;
    listed = Math.floor(listed / 2);
  }
}
