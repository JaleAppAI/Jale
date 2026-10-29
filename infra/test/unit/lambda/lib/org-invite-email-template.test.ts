/**
 * The foreman invite email (employer organizations, Phase 3, Task 7): the
 * pinned en / es copy, the inviter line, the fallback link, escaping, the
 * bare greeting, the link, and the email_outbox subject limit (1..200) for
 * a company name of any length.
 */
import { renderOrgInviteEmail } from '../../../../lambda/lib/org-invite-email-template';
import { EMPLOYER_DISPLAY_NAME_FALLBACK } from '../../../../lambda/lib/application-hire-view';
import { EMAIL_LEGAL_PRIVACY_URL, EMAIL_LEGAL_TERMS_URL } from '../../../../lambda/lib/email-shell';

const URL = 'https://app.example.test/en/auth/employer/invite?token=AbC_-123abc123abc123abc123abc123abc123abc12';
const EXPIRES = new Date('2026-10-30T15:00:00Z');

const base = {
  companyName: 'Acme Builders',
  contactName: 'Ana Ruiz',
  inviterName: 'Luis Owner',
  inviteUrl: URL,
  expiresAt: EXPIRES,
};

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('renderOrgInviteEmail', () => {
  it('en and es subject, body and button copy exactly as pinned', () => {
    const en = renderOrgInviteEmail({ ...base, language: 'en' });
    expect(en.subject).toBe('Acme Builders invited you to Jale');
    expect(en.bodyText).toBe([
      'Hi Ana Ruiz,',
      'Acme Builders invited you to join their team on Jale as a foreman. You\'ll post jobs, review applicants and message workers for your company.',
      'Invited by Luis Owner.',
      `Accept the invite: ${URL}`,
      'This invite expires on October 30, 2026. If you weren\'t expecting it, you can ignore this email.',
      'Automated message from Jale. Replies are not read.',
    ].join('\n\n'));
    expect(en.bodyHtml).toContain('Hi Ana Ruiz,');
    expect(en.bodyHtml).toContain('Acme Builders invited you to join their team on Jale as a foreman. You&#39;ll post jobs, review applicants and message workers for your company.');
    expect(en.bodyHtml).toContain('>Invited by Luis Owner.</p>');
    expect(en.bodyHtml).toContain('>Accept the invite</a>');
    expect(en.bodyHtml).toContain('If the button doesn&#39;t work, copy this link:');
    expect(en.bodyHtml).toContain('This invite expires on October 30, 2026. If you weren&#39;t expecting it, you can ignore this email.');
    expect(en.bodyHtml).toContain('Automated message from Jale. Replies are not read.');
    expect(en.bodyHtml).toContain('<html lang="en">');

    const es = renderOrgInviteEmail({ ...base, language: 'es' });
    expect(es.subject).toBe('Acme Builders lo invitó a Jale');
    expect(es.bodyText).toBe([
      'Hola, Ana Ruiz:',
      'Acme Builders lo invitó a unirse a su equipo en Jale como capataz. Podrá publicar empleos, revisar postulantes y enviar mensajes a trabajadores en nombre de su empresa.',
      'Invitación enviada por Luis Owner.',
      `Aceptar la invitación: ${URL}`,
      'Esta invitación vence el 30 de octubre de 2026. Si no la esperaba, puede ignorar este correo.',
      'Mensaje automático de Jale. Las respuestas no se leen.',
    ].join('\n\n'));
    expect(es.bodyHtml).toContain('Hola, Ana Ruiz:');
    expect(es.bodyHtml).toContain('Acme Builders lo invitó a unirse a su equipo en Jale como capataz.');
    expect(es.bodyHtml).toContain('>Invitación enviada por Luis Owner.</p>');
    expect(es.bodyHtml).toContain('>Aceptar la invitación</a>');
    expect(es.bodyHtml).toContain('Si el botón no funciona, copie este enlace:');
    expect(es.bodyHtml).toContain('Esta invitación vence el 30 de octubre de 2026. Si no la esperaba, puede ignorar este correo.');
    expect(es.bodyHtml).toContain('Mensaje automático de Jale. Las respuestas no se leen.');
    expect(es.bodyHtml).toContain('<html lang="es">');
  });

  it('no inviter name: no inviter line', () => {
    for (const inviterName of [null, '  ']) {
      const r = renderOrgInviteEmail({ ...base, language: 'en', inviterName });
      expect(r.bodyText).not.toContain('Invited by');
      expect(r.bodyHtml).not.toContain('Invited by');
    }
  });

  it('formats the expiry date in UTC', () => {
    // 23:30 UTC on the 30th is already the 31st east of UTC and still the 30th in UTC.
    const late = renderOrgInviteEmail({ ...base, language: 'en', expiresAt: new Date('2026-10-30T23:30:00Z') });
    expect(late.bodyText).toContain('expires on October 30, 2026.');
  });

  it('interpolations are escaped in HTML', () => {
    const hostile = renderOrgInviteEmail({
      ...base,
      language: 'en',
      companyName: '<script>alert(1)</script> & "Co"',
      contactName: '<img src=x onerror=alert(1)>',
      inviterName: '<a href="https://evil.test">Bank</a>',
    });
    expect(hostile.bodyHtml).not.toContain('<script>');
    expect(hostile.bodyHtml).not.toContain('<img src=x');
    expect(hostile.bodyHtml).not.toContain('evil.test">');
    expect(hostile.bodyHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;');
    expect(hostile.bodyHtml).toContain('Hi &lt;img src=x onerror=alert(1)&gt;,');
    expect(hostile.bodyHtml).toContain('Invited by &lt;a href=&quot;https://evil.test&quot;&gt;Bank&lt;/a&gt;.');
    // The text body stays plain: no entities.
    expect(hostile.bodyText).toContain('Hi <img src=x onerror=alert(1)>,');
    expect(hostile.bodyText).toContain('<script>alert(1)</script> & "Co" invited you');
    expect(hostile.bodyText).not.toContain('&lt;');
  });

  it('no contact name gives the bare greeting', () => {
    expect(renderOrgInviteEmail({ ...base, language: 'en', contactName: null }).bodyText.split('\n\n')[0]).toBe('Hi,');
    expect(renderOrgInviteEmail({ ...base, language: 'es', contactName: null }).bodyText.split('\n\n')[0]).toBe('Hola:');
    expect(renderOrgInviteEmail({ ...base, language: 'en', contactName: '   ' }).bodyText.split('\n\n')[0]).toBe('Hi,');
    const html = renderOrgInviteEmail({ ...base, language: 'es', contactName: null }).bodyHtml;
    expect(html).toContain('>Hola:</p>');
  });

  it('the link is the invite URL verbatim', () => {
    const r = renderOrgInviteEmail({ ...base, language: 'en' });
    expect(r.bodyText).toContain(`Accept the invite: ${URL}`);
    expect(r.bodyHtml).toContain(`href="${URL}"`);
    // A URL with an ampersand is escaped only as HTML.
    const amp = 'https://app.example.test/en/auth/employer/invite?token=x&y=1';
    const r2 = renderOrgInviteEmail({ ...base, language: 'en', inviteUrl: amp });
    expect(r2.bodyText).toContain(amp);
    expect(r2.bodyHtml).toContain('href="https://app.example.test/en/auth/employer/invite?token=x&amp;y=1"');
  });

  it('the text body carries the URL once; the HTML carries the button, the copyable fallback URL and the legal links', () => {
    for (const language of ['en', 'es'] as const) {
      const r = renderOrgInviteEmail({ ...base, language });
      expect(occurrences(r.bodyText, URL)).toBe(1);
      expect(occurrences(r.bodyHtml, `href="${URL}"`)).toBe(1);
      expect(r.bodyHtml).toContain(`word-break:break-all;color:#0050ad;">${URL}</span>`);
      expect(r.bodyHtml).toContain(EMAIL_LEGAL_TERMS_URL);
      expect(r.bodyHtml).toContain(EMAIL_LEGAL_PRIVACY_URL);
    }
  });

  it('a 300-character company name keeps the subject inside the outbox limit', () => {
    const long = 'Constructora '.repeat(25).slice(0, 300);
    expect(long).toHaveLength(300);
    for (const language of ['en', 'es'] as const) {
      const r = renderOrgInviteEmail({ ...base, language, companyName: long });
      expect(Array.from(r.subject).length).toBeGreaterThanOrEqual(1);
      expect(Array.from(r.subject).length).toBeLessThanOrEqual(200);
      expect(r.subject).toContain('…');
      expect(r.bodyText).not.toContain(long);
    }
  });

  it('counts characters as PostgreSQL does: an emoji name is clipped by code point, never split', () => {
    const emoji = '🏗️'.repeat(150);
    const r = renderOrgInviteEmail({ ...base, language: 'en', companyName: emoji });
    expect(Array.from(r.subject).length).toBeLessThanOrEqual(200);
    expect(r.subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('a CR/LF in any name cannot inject a header or a line: the subject is one line, every name one line', () => {
    const r = renderOrgInviteEmail({
      ...base,
      language: 'en',
      companyName: 'Acme\r\nBcc: x@y.z',
      contactName: 'Ana\r\nX-Evil: 1',
      inviterName: 'Luis\nReply-To: a@b.c',
    });
    expect(r.subject).toBe('Acme Bcc: x@y.z invited you to Jale');
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.bodyText).not.toContain('\r');
    const lines = r.bodyText.split('\n');
    expect(lines).toContain('Hi Ana X-Evil: 1,');
    expect(lines).toContain('Invited by Luis Reply-To: a@b.c.');
    expect(lines.some((l) => /^(Bcc|X-Evil|Reply-To):/.test(l))).toBe(false);
    expect(r.bodyHtml).not.toMatch(/[\r\n]/);
  });

  it(`the fallback name (${EMPLOYER_DISPLAY_NAME_FALLBACK}) reads "A company" / "Un empleador"`, () => {
    const en = renderOrgInviteEmail({ ...base, language: 'en', companyName: EMPLOYER_DISPLAY_NAME_FALLBACK });
    expect(en.subject).toBe('A company invited you to Jale');
    expect(en.bodyText).toContain('A company invited you to join their team on Jale as a foreman.');
    expect(en.bodyText).not.toContain(EMPLOYER_DISPLAY_NAME_FALLBACK);
    const es = renderOrgInviteEmail({ ...base, language: 'es', companyName: EMPLOYER_DISPLAY_NAME_FALLBACK });
    expect(es.subject).toBe('Un empleador lo invitó a Jale');
    expect(es.bodyText).toContain('Un empleador lo invitó a unirse a su equipo en Jale como capataz.');
    expect(renderOrgInviteEmail({ ...base, language: 'en', companyName: '  ' }).subject).toBe('A company invited you to Jale');
    expect(renderOrgInviteEmail({ ...base, language: 'es', companyName: '' }).subject).toBe('Un empleador lo invitó a Jale');
  });
});
