import {
  CODE_EMAIL_MAX_CHARS,
  CODE_EMAIL_SOFT_MAX_CHARS,
  CODE_EMAIL_SUBJECT_MAX,
  codeEmailTriggerFor,
  renderEmployerCodeEmail,
  type CodeEmailTrigger,
} from '../../../../lambda/lib/employer-code-email-template';
import { EMAIL_FONT_STACK } from '../../../../lambda/lib/email-shell';

/**
 * The Cognito CustomMessage body is bilingual EN/ES in one document, so every
 * copy assertion here is verbatim: a "fix" that quietly reworded a heading or
 * dropped an accent would otherwise sail through.
 *
 * Deviation from the task spec (subject test): the spec asked every subject to
 * contain 'ó'. Only two of the four actually do — 'Confirme su cuenta de Jale'
 * and 'Restablezca su contraseña de Jale' carry no 'ó' (the latter carries
 * 'ñ'). The intent is "non-ASCII survives the render", so the shared assertion
 * is the '·' separator (U+00B7, present in all four) plus the per-subject
 * accent each one genuinely has.
 */

const TRIGGERS: CodeEmailTrigger[] = [
  'SignUp',
  'ResendCode',
  'ForgotPassword',
  'AttributeVerification',
];

const SUBJECTS: Record<CodeEmailTrigger, string> = {
  SignUp: 'Your Jale code: confirm your account · Confirme su cuenta de Jale',
  ResendCode: 'Your new Jale code · Su nuevo código de Jale',
  ForgotPassword: 'Your Jale code: reset your password · Restablezca su contraseña de Jale',
  AttributeVerification: 'Your Jale code · Su código de Jale',
};

interface CopyBlock {
  enHeading: string;
  enBody: string;
  esHeading: string;
  esBody: string;
}

const COPY: Record<CodeEmailTrigger, CopyBlock> = {
  SignUp: {
    enHeading: 'Confirm your Jale employer account',
    enBody: 'Enter this code on the Jale sign-up screen to finish creating your account.',
    esHeading: 'Confirme su cuenta de empleador de Jale',
    esBody:
      'Ingrese este código en la pantalla de registro de Jale para terminar de crear su cuenta.',
  },
  ResendCode: {
    enHeading: 'Here is your new code',
    enBody: 'Enter this code on the Jale sign-up screen. Any earlier code no longer works.',
    esHeading: 'Este es su nuevo código',
    esBody:
      'Ingrese este código en la pantalla de registro de Jale. Los códigos anteriores ya no funcionan.',
  },
  ForgotPassword: {
    enHeading: 'Reset your Jale password',
    enBody: 'Enter this code on the password reset screen, then choose a new password.',
    esHeading: 'Restablezca su contraseña de Jale',
    esBody:
      'Ingrese este código en la pantalla de restablecimiento y luego elija una contraseña nueva.',
  },
  AttributeVerification: {
    enHeading: 'Your Jale verification code',
    enBody: 'Enter this code in Jale to verify your email address.',
    esHeading: 'Su código de verificación de Jale',
    esBody: 'Ingrese este código en Jale para verificar su correo electrónico.',
  },
};

const SAFETY_EN =
  "If you didn't request this, you can ignore this email. " +
  'Jale will never ask you for this code by phone, text, or WhatsApp.';
const SAFETY_ES =
  'Si usted no solicitó este código, puede ignorar este correo. ' +
  'Jale nunca le pedirá este código por teléfono, mensaje de texto ni WhatsApp.';

const EXPIRY_24H = 'Expires in 24 hours · Vence en 24 horas';
const EXPIRY_1H = 'Expires in 1 hour · Vence en 1 hora';

const PREHEADER =
  'Enter this code in Jale to continue. · Ingrese este código en Jale para continuar.';

/** Cognito hands the trigger the literal placeholder, not the real digits. */
const PLACEHOLDER = '{####}';

const render = (trigger: CodeEmailTrigger, code: string = PLACEHOLDER) =>
  renderEmployerCodeEmail(trigger, code);

describe('codeEmailTriggerFor', () => {
  it('maps the four code-bearing CustomMessage sources', () => {
    expect(codeEmailTriggerFor('CustomMessage_SignUp')).toBe('SignUp');
    expect(codeEmailTriggerFor('CustomMessage_ResendCode')).toBe('ResendCode');
    expect(codeEmailTriggerFor('CustomMessage_ForgotPassword')).toBe('ForgotPassword');
    expect(codeEmailTriggerFor('CustomMessage_UpdateUserAttribute')).toBe('AttributeVerification');
    expect(codeEmailTriggerFor('CustomMessage_VerifyUserAttribute')).toBe('AttributeVerification');
  });

  it('returns null for the sources this template does not own', () => {
    // AdminCreateUser carries a temporary password + username placeholder, and
    // Authentication is the MFA path on a pool with no SMS channel.
    expect(codeEmailTriggerFor('CustomMessage_AdminCreateUser')).toBeNull();
    expect(codeEmailTriggerFor('CustomMessage_Authentication')).toBeNull();
    expect(codeEmailTriggerFor('garbage')).toBeNull();
    expect(codeEmailTriggerFor('')).toBeNull();
  });
});

describe('renderEmployerCodeEmail — subjects', () => {
  it.each(TRIGGERS)('%s renders the exact locked subject', (trigger) => {
    expect(render(trigger).subject).toBe(SUBJECTS[trigger]);
  });

  it.each(TRIGGERS)('%s subject fits the Cognito cap and is single-line', (trigger) => {
    const { subject } = render(trigger);
    expect(CODE_EMAIL_SUBJECT_MAX).toBe(140);
    expect(subject.length).toBeLessThanOrEqual(CODE_EMAIL_SUBJECT_MAX);
    expect(subject).not.toContain('\n');
    expect(subject).not.toContain('\r');
  });

  it.each(TRIGGERS)('%s subject keeps its non-ASCII separator', (trigger) => {
    // '·' U+00B7 joins the two languages in all four subjects.
    expect(render(trigger).subject).toContain('·');
  });

  it('keeps the accents each subject actually carries', () => {
    expect(render('ResendCode').subject).toContain('ó');
    expect(render('AttributeVerification').subject).toContain('ó');
    expect(render('ForgotPassword').subject).toContain('ñ');
  });

  it.each(TRIGGERS)('%s subject survives the shell <title> path verbatim', (trigger) => {
    // No subject contains & < > " ', so escapeHtml() is a no-op on the title.
    const { subject, html } = render(trigger);
    expect(subject).not.toMatch(/[&<>"']/);
    expect(html).toContain(`<title>${subject}</title>`);
  });
});

describe('renderEmployerCodeEmail — the code placeholder', () => {
  it.each(TRIGGERS)('%s emits the placeholder exactly once', (trigger) => {
    expect(render(trigger).html.split(PLACEHOLDER)).toHaveLength(2);
  });

  it.each(TRIGGERS)('%s puts the placeholder in a bare text node', (trigger) => {
    const { html } = render(trigger);
    // Cognito substitutes the real code after the trigger returns; inside an
    // attribute the value would be quoted away and never reach the reader.
    expect(html).toMatch(/>\{####\}</);
    expect(html).not.toMatch(/=["'][^"'>]*\{####\}/);
  });

  it('passes an arbitrary code token through untouched', () => {
    const { html } = render('SignUp', 'CODE_TOKEN');
    expect(html.split('CODE_TOKEN')).toHaveLength(2);
    expect(html).not.toContain(PLACEHOLDER);
  });
});

describe('renderEmployerCodeEmail — size budget', () => {
  // Measured rendered lengths: SignUp 4957, ResendCode 4916, ForgotPassword
  // 4943, AttributeVerification 4868 — roughly 60% of the 8192 soft cap and a
  // quarter of Cognito's 20000 hard cap, so there is room for a future line of
  // copy without redesigning the card.
  it.each(TRIGGERS)('%s stays under the Cognito hard cap and our soft cap', (trigger) => {
    const { html } = render(trigger);
    expect(CODE_EMAIL_MAX_CHARS).toBe(20000);
    expect(CODE_EMAIL_SOFT_MAX_CHARS).toBe(8192);
    expect(html.length).toBeLessThan(CODE_EMAIL_MAX_CHARS);
    expect(html.length).toBeLessThanOrEqual(CODE_EMAIL_SOFT_MAX_CHARS);
  });
});

describe('renderEmployerCodeEmail — shell wiring', () => {
  it.each(TRIGGERS)('%s renders the branded shell document', (trigger) => {
    const { html, subject } = render(trigger);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('color-scheme');
    expect(html).toContain(
      '<img src="https://jaleapp.ai/brand/email/wordmark-white-2x.png" ' +
        'width="78" height="40" alt="Jale"',
    );
    expect(html).toContain('Verification code · Código de verificación');
    expect(html).toContain('Your code · Su código');
    expect(html).toContain(PREHEADER);
    expect(html).toContain(subject);
  });

  it('uses the shared font stack on the code cell', () => {
    expect(render('SignUp').html).toContain(`font-family:${EMAIL_FONT_STACK};font-size:36px`);
  });
});

describe('renderEmployerCodeEmail — bilingual copy', () => {
  it.each(TRIGGERS)('%s carries both language blocks verbatim', (trigger) => {
    const { html } = render(trigger);
    const copy = COPY[trigger];
    expect(html).toContain(copy.enHeading);
    expect(html).toContain(copy.enBody);
    expect(html).toContain(copy.esHeading);
    expect(html).toContain(copy.esBody);
  });

  it.each(TRIGGERS)('%s carries both safety lines', (trigger) => {
    const { html } = render(trigger);
    expect(html).toContain(SAFETY_EN);
    expect(html).toContain(SAFETY_ES);
  });

  it.each(TRIGGERS)('%s marks the Spanish block with lang="es"', (trigger) => {
    expect(render(trigger).html).toContain('<div lang="es"');
  });

  it('addresses the reader as usted, never tú', () => {
    const all = TRIGGERS.map((t) => render(t).html).join('\n');
    // Sanity: a substring check on accented text is easy to write so that it
    // can never fail, so each needle is proven against a planted violation.
    const planted = `${all} tú tienes tu perfil y tus datos`;
    for (const banned of [' tú', ' tu ', ' tus ', ' tienes ']) {
      expect(planted).toContain(banned);
      expect(all).not.toContain(banned);
    }
  });
});

describe('renderEmployerCodeEmail — expiry line', () => {
  it.each<CodeEmailTrigger>(['SignUp', 'ResendCode', 'AttributeVerification'])(
    '%s says 24 hours',
    (trigger) => {
      const { html } = render(trigger);
      expect(html).toContain(EXPIRY_24H);
      expect(html).not.toContain(EXPIRY_1H);
    },
  );

  it('ForgotPassword says 1 hour', () => {
    const { html } = render('ForgotPassword');
    expect(html).toContain(EXPIRY_1H);
    expect(html).not.toContain(EXPIRY_24H);
  });
});

describe('renderEmployerCodeEmail — what must NOT be in a code email', () => {
  it.each(TRIGGERS)('%s carries no username, phone, unsubscribe or button', (trigger) => {
    const { html } = render(trigger);
    expect(html).not.toContain('{username}');
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('+1 ');
    expect(html).not.toContain('unsubscribe');
    expect(html).not.toContain('Unsubscribe');
    expect(html).not.toContain('suscripción');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Hello');
    expect(html).not.toContain('Hola');
  });

  it.each(TRIGGERS)('%s links only to the wordmark, terms and privacy', (trigger) => {
    // 3 = the shell's wordmark link to https://jaleapp.ai plus the two
    // emailLegalLinksHtml('bilingual') links. Counted rather than hardcoded
    // blind: if the shell ever grows a link, this fails loudly.
    const links = render(trigger).html.match(/<a href/g) ?? [];
    expect(links).toHaveLength(3);
  });

  it('renders the no-reply footer with the bilingual legal line', () => {
    const { html } = render('SignUp');
    expect(html).toContain('no-reply@jaleapp.ai');
    expect(html).toContain('Las respuestas no se leen');
    expect(html).toContain('© 2026 Jale');
  });
});

describe('renderEmployerCodeEmail — inline styling', () => {
  it.each(TRIGGERS)('%s styles the card inline, not from <head>', (trigger) => {
    // Gmail strips <head>; every visual rule has to survive that.
    const body = render(trigger).html.replace(/<head>[\s\S]*?<\/head>/, '');
    expect(body).toContain('font-size:36px');
    expect(body).toContain('font-size:22px');
  });
});

describe('renderEmployerCodeEmail — purity', () => {
  it.each(TRIGGERS)('%s is deterministic across calls', (trigger) => {
    expect(render(trigger)).toEqual(render(trigger));
    expect(render(trigger).html).toBe(render(trigger).html);
  });
});
