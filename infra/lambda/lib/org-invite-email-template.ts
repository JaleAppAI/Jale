/**
 * The foreman invite email (employer organizations, Phase 3): what an owner's
 * invite and each resend queue through jale_cap.org_team_invite_queue_email
 * (migration 133). One language per email, the owner's UI locale at send
 * time; Spanish is formal (usted), foreman is "capataz".
 *
 * The company name (the owner's employer_profiles.company_name, through
 * employer_display_name) is unbounded TEXT; the contact name is the owner's
 * typing and the inviter name the owner's own (contact name, else full name).
 * All three are collapsed to one line and clipped (by code point, as
 * PostgreSQL's length() counts), escaped in bodyHtml and raw in bodyText. The
 * company name is clipped so email_outbox's subject CHECK (1..200
 * characters, migration 037) always holds, and so no CR/LF reaches the
 * subject. The inviter line is anti-abuse: the recipient sees who sent it.
 *
 * employer_display_name falls back to the Spanish 'Empleador' when the owner
 * has no company name; the copy says "A company" / "Un empleador" instead.
 *
 * The invite link carries the raw token: callers build it with inviteUrl()
 * (org-team.ts) and never log it. The HTML shows it once more as plain text
 * under the button, for clients that break the button. No DB, no AWS, no
 * env reads.
 */
import { EMPLOYER_DISPLAY_NAME_FALLBACK } from './application-hire-view';
import {
  EMAIL_COLORS,
  clipPreheader,
  emailButtonHtml,
  emailLegalLinksHtml,
  escapeHtml,
  renderEmailShell,
} from './email-shell';

export interface OrgInviteEmailInput {
  language: 'en' | 'es';
  companyName: string;
  contactName: string | null;
  /** The inviting owner's name (contact name, else full name); null when they have none. */
  inviterName: string | null;
  inviteUrl: string;
  expiresAt: Date;
}

export interface RenderedOrgInviteEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/** Leaves the longest subject ("… lo invitó a Jale") far inside the 200-character cap. */
const MAX_COMPANY_CHARS = 120;
/** org_team_invite_create refuses a longer contact name; clipped again here for safety. */
const MAX_CONTACT_CHARS = 120;
const MAX_INVITER_CHARS = 120;

const C = EMAIL_COLORS;

interface Copy {
  fallbackCompany: string;
  subject: (company: string) => string;
  greeting: (contact: string | null) => string;
  body: (company: string) => string;
  invitedBy: (inviter: string) => string;
  button: string;
  copyLink: string;
  footer: (date: string) => string;
  automated: string;
  eyebrow: string;
}

const COPY: Record<'en' | 'es', Copy> = {
  en: {
    fallbackCompany: 'A company',
    subject: (company) => `${company} invited you to Jale`,
    greeting: (contact) => (contact ? `Hi ${contact},` : 'Hi,'),
    body: (company) =>
      `${company} invited you to join their team on Jale as a foreman. You'll post jobs, review applicants and message workers for your company.`,
    invitedBy: (inviter) => `Invited by ${inviter}.`,
    button: 'Accept the invite',
    copyLink: 'If the button doesn\'t work, copy this link:',
    footer: (date) => `This invite expires on ${date}. If you weren't expecting it, you can ignore this email.`,
    automated: 'Automated message from Jale. Replies are not read.',
    eyebrow: 'Team invite',
  },
  es: {
    fallbackCompany: 'Un empleador',
    subject: (company) => `${company} lo invitó a Jale`,
    greeting: (contact) => (contact ? `Hola, ${contact}:` : 'Hola:'),
    body: (company) =>
      `${company} lo invitó a unirse a su equipo en Jale como capataz. Podrá publicar empleos, revisar postulantes y enviar mensajes a trabajadores en nombre de su empresa.`,
    invitedBy: (inviter) => `Invitación enviada por ${inviter}.`,
    button: 'Aceptar la invitación',
    copyLink: 'Si el botón no funciona, copie este enlace:',
    footer: (date) => `Esta invitación vence el ${date}. Si no la esperaba, puede ignorar este correo.`,
    automated: 'Mensaje automático de Jale. Las respuestas no se leen.',
    eyebrow: 'Invitación al equipo',
  },
};

/** One line (no CR/LF or other runs of whitespace), trimmed, at most `max` code points. */
function oneLine(value: string | null | undefined, max: number): string {
  const chars = Array.from((value ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

function companyFor(copy: Copy, raw: string): string {
  const name = oneLine(raw, MAX_COMPANY_CHARS);
  return name === '' || name === EMPLOYER_DISPLAY_NAME_FALLBACK ? copy.fallbackCompany : name;
}

export function renderOrgInviteEmail(input: OrgInviteEmailInput): RenderedOrgInviteEmail {
  const copy = COPY[input.language];
  const company = companyFor(copy, input.companyName);
  const contact = oneLine(input.contactName, MAX_CONTACT_CHARS) || null;
  const inviter = oneLine(input.inviterName, MAX_INVITER_CHARS) || null;
  const date = new Intl.DateTimeFormat(input.language, { dateStyle: 'long', timeZone: 'UTC' }).format(input.expiresAt);

  const subject = copy.subject(company);
  const greeting = copy.greeting(contact);
  const body = copy.body(company);
  const invitedBy = inviter ? copy.invitedBy(inviter) : null;
  const footer = copy.footer(date);

  const bodyText = [
    greeting,
    body,
    ...(invitedBy ? [invitedBy] : []),
    `${copy.button}: ${input.inviteUrl}`,
    footer,
    copy.automated,
  ].join('\n\n');

  const para = (text: string, margin = '0 0 16px') =>
    `<p style="margin:${margin};font-size:15px;line-height:24px;color:${C.ink};">${escapeHtml(text)}</p>`;
  const small = (inner: string, margin: string) =>
    `<p style="margin:${margin};font-size:13px;line-height:20px;color:${C.ink2};">${inner}</p>`;
  const cardHtml =
    para(greeting) +
    para(body, invitedBy ? '0 0 16px' : '0 0 24px') +
    (invitedBy ? para(invitedBy, '0 0 24px') : '') +
    `<div>${emailButtonHtml(input.inviteUrl, copy.button)}</div>` +
    small(
      `${escapeHtml(copy.copyLink)}<br>` +
        `<span style="word-break:break-all;color:${C.link};">${escapeHtml(input.inviteUrl)}</span>`,
      '16px 0 0',
    ) +
    small(escapeHtml(footer), '24px 0 0');
  const footerHtml =
    `<p style="margin:0 0 8px;">${escapeHtml(copy.automated)}</p>` +
    `<p style="margin:0;">${emailLegalLinksHtml(input.language)}</p>`;

  const bodyHtml = renderEmailShell({
    lang: input.language,
    title: subject,
    preheader: clipPreheader(body),
    eyebrow: copy.eyebrow,
    cardHtml,
    footerHtml,
  });

  return { subject, bodyText, bodyHtml };
}
