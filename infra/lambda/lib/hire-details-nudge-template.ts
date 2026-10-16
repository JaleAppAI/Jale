/**
 * Pure rendering for the hire-details nudge -- F19 (sprint 28, contract
 * K4.4): the email an employer gets when a hire still has no start details,
 * once 24 hours after the hire and once each time the worker presses "Remind
 * my employer". The digest producer's sweep claims the hire
 * (`jale_cap.claim_hire_details_nudges`) and queues this.
 *
 * Bilingual in one body (English first, then Spanish), like the billing
 * notices: the claim carries no language preference for the employer.
 * Spanish copy is formal (usted). The worker's first name and the job title
 * are user-supplied text: escaped in bodyHtml, raw in bodyText, both clipped
 * so the email_outbox limits (subject 1..200) always hold.
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

export type HireDetailsNudgeKind = 'auto' | 'remind';

export interface HireDetailsNudgeModel {
  kind: HireDetailsNudgeKind;
  /** The worker's name as stored; only the first word is used. Null when unknown. */
  workerName: string | null;
  jobTitle: string;
  /** Absolute applicants-page URLs, one per language. */
  englishUrl: string;
  spanishUrl: string;
}

export interface RenderedHireDetailsNudge {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

const MAX_NAME_CHARS = 40;
const MAX_TITLE_CHARS = 120;
const EYEBROW = 'New hire · Nueva contratación';
const EN_BUTTON = 'Add start details';
const ES_BUTTON = 'Agregar detalles de inicio';
const EN_ASK = 'Add a start date and where to report.';
const ES_ASK = 'Agregue una fecha de inicio y el lugar donde debe presentarse.';
const EN_WHY = 'You are receiving this because you hired a worker on Jale.';
const ES_WHY = 'Está recibiendo este correo porque contrató a un trabajador en Jale.';
const C = EMAIL_COLORS;

function clip(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** The first word of the stored name, clipped; null when there is none. */
export function nudgeFirstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? null : clip(first, MAX_NAME_CHARS);
}

/** The English and Spanish lines, the only copy that differs by kind. */
export function hireDetailsNudgeLines(model: HireDetailsNudgeModel): { en: string; es: string } {
  const first = nudgeFirstName(model.workerName);
  const job = clip(model.jobTitle, MAX_TITLE_CHARS);
  if (model.kind === 'remind') {
    return {
      en: `${first ?? 'Your new hire'} asked for their start details for ${job}. ${EN_ASK}`,
      es: `${first ?? 'Su nuevo trabajador'} pidió sus detalles de inicio para ${job}. ${ES_ASK}`,
    };
  }
  return {
    en: first ? `${first} is hired for ${job}. ${EN_ASK}` : `You hired a worker for ${job}. ${EN_ASK}`,
    es: first ? `Contrató a ${first} para ${job}. ${ES_ASK}` : `Contrató a un trabajador para ${job}. ${ES_ASK}`,
  };
}

export function hireDetailsNudgeSubject(model: HireDetailsNudgeModel): string {
  const first = nudgeFirstName(model.workerName);
  return first
    ? `Add start details for ${first} · Agregue los detalles de inicio para ${first}`
    : 'Add start details for your new hire · Agregue los detalles de inicio para su nuevo trabajador';
}

export function renderHireDetailsNudgeEmail(model: HireDetailsNudgeModel): RenderedHireDetailsNudge {
  const subject = hireDetailsNudgeSubject(model);
  const lines = hireDetailsNudgeLines(model);
  const bodyText = [
    lines.en,
    `${EN_BUTTON}: ${model.englishUrl}`,
    '',
    lines.es,
    `${ES_BUTTON}: ${model.spanishUrl}`,
    '',
    EN_WHY,
    ES_WHY,
  ].join('\n\n');

  const block = (line: string, href: string, label: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${C.ink};">${escapeHtml(line)}</p>`
    + `<div>${emailButtonHtml(href, label)}</div>`;
  const cardHtml =
    block(lines.en, model.englishUrl, EN_BUTTON)
    + emailDividerHtml(24)
    + block(lines.es, model.spanishUrl, ES_BUTTON);
  const footerHtml =
    `<p style="margin:0 0 8px;">${EN_WHY}</p>`
    + `<p style="margin:0 0 8px;">${ES_WHY}</p>`
    + `<p style="margin:0;">${emailLegalLinksHtml('bilingual')}</p>`;
  const bodyHtml = renderEmailShell({
    lang: 'en',
    title: subject,
    preheader: clipPreheader(lines.en),
    eyebrow: EYEBROW,
    cardHtml,
    footerHtml,
  });
  return { subject, bodyText, bodyHtml };
}
