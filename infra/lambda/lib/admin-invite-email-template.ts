/**
 * The invitation email for the admin console's user pool: the message Cognito
 * sends when a superadmin invites an admin (AdminCreateUser) and when the
 * invitation is resent.
 *
 * Rendered ONCE, at synth, into the pool's InviteMessageTemplate
 * (AdminStack `userInvitation`), so there is no trigger Lambda: the admin pool
 * and the employer pool's CustomMessage Lambda live in different stacks and
 * deploy scopes, and a static template needs neither.
 *
 * Pure by construction: no env reads, no AWS clients, no Date, no randomness.
 *
 * `{username}` and `{####}` are Cognito's own placeholders; it substitutes the
 * username and the temporary password when it sends the message, and refuses
 * a template without both. Each is the whole text of its own table cell, never
 * inside an attribute, and nothing follows the password: Cognito's default
 * copy put a "." straight after it, and that "." was pasted with it.
 *
 * English only: the console and its admins work in English.
 */

import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  emailButtonHtml,
  emailDividerHtml,
  emailLegalLinksHtml,
  renderEmailShell,
} from './email-shell';

/** The subject Cognito sends the invitation with. */
export const ADMIN_INVITE_SUBJECT = "You're invited to the Jale admin console";
/** Cognito refuses an InviteMessageTemplate.EmailMessage longer than this. */
export const ADMIN_INVITE_MAX_CHARS = 20000;
/**
 * How long the temporary password works. The pool's
 * TemporaryPasswordValidityDays is set from this, so the copy and the setting
 * cannot drift apart.
 */
export const ADMIN_INVITE_VALID_DAYS = 7;

export interface RenderedAdminInvite {
  subject: string;
  html: string;
}

const C = EMAIL_COLORS;

/** A password is read character by character: a monospace face keeps l, 1 and I apart. */
const MONO_STACK = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";
/** Tint of the chip's hairline: one shade up from EMAIL_COLORS.noticeBg. */
const CHIP_BORDER = '#cfe0ff';

const EYEBROW = 'Admin console invitation';
const PREHEADER = 'Your username and temporary password for the Jale admin console.';

/** A small uppercase label above a value. */
function label(text: string): string {
  return (
    `<div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;` +
    `text-transform:uppercase;color:${C.link};">${text}</div>`
  );
}

/** The username: the whole text of its own cell. */
function usernameCell(): string {
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="margin-top:6px;"><tr>' +
    `<td style="font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:24px;font-weight:600;` +
    `color:${C.ink};word-break:break-all;">{username}</td></tr></table>`
  );
}

/** The temporary password: the whole text of its own chip, nothing after it. */
function passwordChip(): string {
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="margin-top:8px;"><tr>' +
    `<td align="center" bgcolor="${C.noticeBg}" style="background:${C.noticeBg};` +
    `border:1px solid ${CHIP_BORDER};border-radius:10px;padding:18px 16px;` +
    `font-family:${MONO_STACK};font-size:22px;line-height:30px;font-weight:700;` +
    `letter-spacing:0.06em;color:${C.ink};word-break:break-all;">{####}</td></tr></table>`
  );
}

function footer(): string {
  return (
    '<p style="margin:0 0 8px;">Automated message from Jale. Replies are not read.</p>' +
    `<p style="margin:0;">${emailLegalLinksHtml('en')}</p>`
  );
}

/**
 * Render the invitation's subject and complete HTML body. `signInUrl` is the
 * admin console's address (https only); it is escaped into the button's link.
 */
export function renderAdminInviteEmail(signInUrl: string): RenderedAdminInvite {
  if (!/^https:\/\/[^/\s]/.test(signInUrl)) {
    throw new Error('renderAdminInviteEmail: the sign-in URL must be an https URL');
  }

  // All copy is a compile-time constant with no `< > & "`, so it goes into
  // the trusted card fragment as it is; only the URL is caller input, and
  // emailButtonHtml escapes it.
  const cardHtml =
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;font-weight:800;` +
    `letter-spacing:-0.02em;color:${C.ink};">You're invited to the Jale admin console</h1>` +
    `<p style="margin:0;font-size:15px;line-height:24px;color:${C.ink};">` +
    'A Jale superadmin has given you access to the admin console. Sign in with the ' +
    'username and temporary password below. You will then choose your own password ' +
    'and set up an authenticator app.</p>' +
    '<div style="height:20px;"></div>' +
    label('Username') +
    usernameCell() +
    '<div style="height:16px;"></div>' +
    label('Temporary password') +
    passwordChip() +
    `<div style="margin-top:8px;font-size:13px;line-height:20px;color:${C.ink2};">` +
    `This temporary password is valid for ${ADMIN_INVITE_VALID_DAYS} days.</div>` +
    '<div style="height:24px;"></div>' +
    emailButtonHtml(signInUrl, 'Sign in to the admin console') +
    emailDividerHtml(24) +
    `<p style="margin:0;font-size:13px;line-height:20px;color:${C.ink2};">` +
    "If you weren't expecting this invitation, you can ignore this email. " +
    'Jale will never ask you for this password by phone, text, or WhatsApp.</p>';

  return {
    subject: ADMIN_INVITE_SUBJECT,
    html: renderEmailShell({
      lang: 'en',
      title: ADMIN_INVITE_SUBJECT,
      preheader: PREHEADER,
      eyebrow: EYEBROW,
      cardHtml,
      footerHtml: footer(),
    }),
  };
}
