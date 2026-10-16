import {
  ADMIN_INVITE_MAX_CHARS,
  ADMIN_INVITE_SUBJECT,
  ADMIN_INVITE_VALID_DAYS,
  renderAdminInviteEmail,
} from '../../../../lambda/lib/admin-invite-email-template';

/**
 * The admin invitation is rendered once, at synth, into the admin pool's
 * InviteMessageTemplate. Cognito substitutes {username} and the temporary
 * password ({####}) when it sends it, so the template must carry each
 * placeholder exactly once, as the whole text of its own element, never in an
 * attribute, and with nothing after the password: Cognito's default copy put
 * a "." straight after it, and admins pasted the "." into the password field.
 */

const URL = 'https://admin.example.test';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** Every `<...>` tag in the document. */
const tags = (html: string): string[] => html.match(/<[^>]*>/g) ?? [];

describe('renderAdminInviteEmail', () => {
  const { subject, html } = renderAdminInviteEmail(URL);

  test('carries the subject and the 7-day validity the pool is configured with', () => {
    expect(subject).toBe("You're invited to the Jale admin console");
    expect(ADMIN_INVITE_SUBJECT).toBe(subject);
    expect(ADMIN_INVITE_VALID_DAYS).toBe(7);
    expect(html).toContain('valid for 7 days');
  });

  test('has {username} and {####} exactly once each, each the whole text of its own element', () => {
    expect(count(html, '{username}')).toBe(1);
    expect(count(html, '{####}')).toBe(1);
    expect(html).toMatch(/>\{username\}<\/td>/);
    expect(html).toMatch(/>\{####\}<\/td>/);
    for (const tag of tags(html)) {
      expect(tag).not.toContain('{username}');
      expect(tag).not.toContain('{####}');
    }
  });

  test('puts nothing after the temporary password, so it can be copied as it is', () => {
    const after = html.slice(html.indexOf('{####}') + '{####}'.length);
    expect(after.startsWith('</td>')).toBe(true);
    expect(html).not.toMatch(/\{####\}\s*[.,;:!?)\]'"]/);
    // The chip is the password's own cell: no label or copy shares it.
    const chip = html.match(/<td[^>]*>\{####\}<\/td>/)?.[0] ?? '';
    expect(chip).not.toBe('');
  });

  test('links the sign-in button to the admin console it is given', () => {
    expect(html).toContain(`href="${URL}"`);
    expect(html).toContain('Sign in to the admin console');
  });

  test('escapes the link, and refuses anything but an https URL', () => {
    const odd = renderAdminInviteEmail('https://admin.example.test/?a=1&b="x"<y>').html;
    expect(odd).toContain('href="https://admin.example.test/?a=1&amp;b=&quot;x&quot;&lt;y&gt;"');
    expect(odd).not.toContain('"x"<y>');
    for (const bad of ['http://admin.example.test', 'javascript:alert(1)', '//admin.example.test', '']) {
      expect(() => renderAdminInviteEmail(bad)).toThrow(/https/);
    }
  });

  test('stays inside Cognito\'s limits, in English, with literal colours only', () => {
    expect(html.length).toBeLessThanOrEqual(ADMIN_INVITE_MAX_CHARS);
    expect(ADMIN_INVITE_MAX_CHARS).toBe(20000);
    expect(html.length).toBeLessThanOrEqual(8192);
    expect(subject.length).toBeLessThanOrEqual(140);
    expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true);
    expect(html).not.toContain('var(--');
    expect(html).not.toMatch(/lang="es"/);
  });

  test('is pure: the same URL renders the same document', () => {
    expect(renderAdminInviteEmail(URL)).toEqual({ subject, html });
  });
});
