/**
 * The branded verification-code email for the employer Cognito pool: sign-up
 * confirmation, resent codes, password reset and email-attribute verification.
 *
 * Pure by construction — no env reads, no AWS clients, no Date, no randomness.
 * A verification email is the one message a user cannot skip, so it has to be
 * reproducible from its two arguments alone and testable without a runtime.
 *
 * Bilingual in ONE body. The employer pool has no language attribute at
 * sign-up time (the account does not exist yet on CustomMessage_SignUp), and
 * `clientMetadata` is not populated by the hosted flows, so there is nothing
 * to branch on. English first, Spanish under a divider, both complete. Spanish
 * is formal *usted* throughout, matching the rest of the product.
 *
 * The `codeParameter` argument is Cognito's literal `{####}` placeholder, not
 * the digits: Cognito substitutes the real code into `emailMessage` AFTER the
 * trigger returns. It is therefore emitted as the sole text node of the code
 * cell and never inside an attribute — quoted into an attribute the reader
 * would never see it, and Cognito rejects the whole API call with
 * InvalidLambdaResponseException if the placeholder is missing entirely.
 *
 * No button, no greeting, no phone number and no unsubscribe link. A code
 * email that offers a link teaches the reader to click one, which is exactly
 * what a phishing clone of this email will ask them to do.
 */

import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  emailDividerHtml,
  emailLegalLinksHtml,
  renderEmailShell,
} from './email-shell';

export type CodeEmailTrigger = 'SignUp' | 'ResendCode' | 'ForgotPassword' | 'AttributeVerification';

export interface RenderedCodeEmail {
  subject: string;
  html: string;
}

/** Cognito rejects an emailMessage longer than this outright. */
export const CODE_EMAIL_MAX_CHARS = 20000;
/** Our own budget: a code email that approaches the hard cap has a bug in it. */
export const CODE_EMAIL_SOFT_MAX_CHARS = 8192;
/** Cognito's cap on emailSubject. */
export const CODE_EMAIL_SUBJECT_MAX = 140;

const C = EMAIL_COLORS;

/** Tint of the code chip's hairline. One shade up from EMAIL_COLORS.noticeBg. */
const CODE_CHIP_BORDER = '#cfe0ff';

/**
 * Which of Cognito's seven CustomMessage sources this template renders.
 *
 * AdminCreateUser is excluded because its message carries a temporary password
 * and a `{username}` placeholder this card has no slot for; Authentication is
 * the MFA path, and the employer pool has no second factor. Both — and any
 * source AWS adds later — fall through to Cognito's default copy.
 */
export function codeEmailTriggerFor(triggerSource: string): CodeEmailTrigger | null {
  switch (triggerSource) {
    case 'CustomMessage_SignUp':
      return 'SignUp';
    case 'CustomMessage_ResendCode':
      return 'ResendCode';
    case 'CustomMessage_ForgotPassword':
      return 'ForgotPassword';
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return 'AttributeVerification';
    default:
      return null;
  }
}

interface TriggerCopy {
  subject: string;
  enHeading: string;
  enBody: string;
  esHeading: string;
  esBody: string;
}

const COPY: Record<CodeEmailTrigger, TriggerCopy> = {
  SignUp: {
    subject: 'Your Jale code: confirm your account · Confirme su cuenta de Jale',
    enHeading: 'Confirm your Jale employer account',
    enBody: 'Enter this code on the Jale sign-up screen to finish creating your account.',
    esHeading: 'Confirme su cuenta de empleador de Jale',
    esBody:
      'Ingrese este código en la pantalla de registro de Jale para terminar de crear su cuenta.',
  },
  ResendCode: {
    subject: 'Your new Jale code · Su nuevo código de Jale',
    enHeading: 'Here is your new code',
    enBody: 'Enter this code on the Jale sign-up screen. Any earlier code no longer works.',
    esHeading: 'Este es su nuevo código',
    esBody:
      'Ingrese este código en la pantalla de registro de Jale. Los códigos anteriores ya no funcionan.',
  },
  ForgotPassword: {
    subject: 'Your Jale code: reset your password · Restablezca su contraseña de Jale',
    enHeading: 'Reset your Jale password',
    enBody: 'Enter this code on the password reset screen, then choose a new password.',
    esHeading: 'Restablezca su contraseña de Jale',
    esBody:
      'Ingrese este código en la pantalla de restablecimiento y luego elija una contraseña nueva.',
  },
  AttributeVerification: {
    subject: 'Your Jale code · Su código de Jale',
    enHeading: 'Your Jale verification code',
    enBody: 'Enter this code in Jale to verify your email address.',
    esHeading: 'Su código de verificación de Jale',
    esBody: 'Ingrese este código en Jale para verificar su correo electrónico.',
  },
};

/**
 * All copy below is a compile-time constant containing no `< > & " '`, so it is
 * inserted verbatim into the TRUSTED cardHtml fragment. Do NOT route it through
 * escapeHtml(): that would turn the apostrophe in "didn't" into `&#39;`.
 */
const SAFETY_EN =
  "If you didn't request this, you can ignore this email. " +
  'Jale will never ask you for this code by phone, text, or WhatsApp.';
const SAFETY_ES =
  'Si usted no solicitó este código, puede ignorar este correo. ' +
  'Jale nunca le pedirá este código por teléfono, mensaje de texto ni WhatsApp.';

/**
 * Cognito's own windows: the forgotten-password code lives one hour, every
 * other code inherits the pool's 24-hour TemporaryPasswordValidity/code TTL.
 */
const EXPIRY: Record<CodeEmailTrigger, string> = {
  SignUp: 'Expires in 24 hours · Vence en 24 horas',
  ResendCode: 'Expires in 24 hours · Vence en 24 horas',
  ForgotPassword: 'Expires in 1 hour · Vence en 1 hora',
  AttributeVerification: 'Expires in 24 hours · Vence en 24 horas',
};

const EYEBROW = 'Verification code · Código de verificación';
const PREHEADER =
  'Enter this code in Jale to continue. · Ingrese este código en Jale para continuar.';
const CODE_LABEL = 'Your code · Su código';

/** Heading + body + safety line for one language. Both blocks share these styles. */
function languageBlock(heading: string, body: string, safety: string): string {
  return (
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;font-weight:800;` +
    `letter-spacing:-0.02em;color:${C.ink};">${heading}</h1>` +
    `<p style="margin:0;font-size:15px;line-height:24px;color:${C.ink};">${body}</p>` +
    `<p style="margin:12px 0 0;font-size:13px;line-height:20px;color:${C.ink2};">${safety}</p>`
  );
}

/**
 * The code chip. `code` lands as the cell's only text node; `tabular-nums` and
 * the wide letter-spacing are what make a six-digit code readable enough to
 * retype from a phone lock screen.
 */
function codeChip(code: string): string {
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="margin-top:8px;"><tr>' +
    `<td align="center" bgcolor="${C.noticeBg}" style="background:${C.noticeBg};` +
    `border:1px solid ${CODE_CHIP_BORDER};border-radius:10px;padding:20px;` +
    `font-family:${EMAIL_FONT_STACK};font-size:36px;line-height:44px;font-weight:800;` +
    `letter-spacing:0.18em;color:${C.ink};font-variant-numeric:tabular-nums;">` +
    `${code}</td></tr></table>`
  );
}

function footer(): string {
  return (
    '<p style="margin:0 0 8px;">' +
    'Automated message from Jale (no-reply@jaleapp.ai). Replies are not read. · ' +
    'Mensaje automático de Jale. Las respuestas no se leen.</p>' +
    `<p style="margin:0;">${emailLegalLinksHtml('bilingual')}</p>`
  );
}

/**
 * Render the subject and complete HTML body for one code email.
 *
 * `codeParameter` is inserted RAW as the sole text node of the code cell — it
 * is Cognito's `{####}` placeholder, and it must never be placed inside an
 * attribute. The caller is responsible for checking that the placeholder
 * survived exactly once before assigning the result to `response.emailMessage`.
 */
export function renderEmployerCodeEmail(
  trigger: CodeEmailTrigger,
  codeParameter: string,
): RenderedCodeEmail {
  const copy = COPY[trigger];
  const cardHtml =
    `<div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;` +
    `text-transform:uppercase;color:${C.link};text-align:center;">${CODE_LABEL}</div>` +
    codeChip(codeParameter) +
    `<div style="margin-top:8px;font-size:13px;line-height:20px;color:${C.ink2};` +
    `text-align:center;">${EXPIRY[trigger]}</div>` +
    '<div style="height:24px;"></div>' +
    languageBlock(copy.enHeading, copy.enBody, SAFETY_EN) +
    emailDividerHtml(24) +
    `<div lang="es">${languageBlock(copy.esHeading, copy.esBody, SAFETY_ES)}</div>`;

  return {
    subject: copy.subject,
    html: renderEmailShell({
      // 'en' on <html>: the document leads in English and marks its Spanish
      // half with lang="es" on that block.
      lang: 'en',
      title: copy.subject,
      preheader: PREHEADER,
      eyebrow: EYEBROW,
      cardHtml,
      footerHtml: footer(),
    }),
  };
}
