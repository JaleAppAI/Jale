import {
  EMAIL_COLORS,
  EMAIL_COPYRIGHT,
  EMAIL_FONT_STACK,
  EMAIL_LEGAL_PRIVACY_URL,
  EMAIL_LEGAL_TERMS_URL,
  EMAIL_WORDMARK_URL,
  clipPreheader,
  emailButtonHtml,
  emailDividerHtml,
  emailLegalLinksHtml,
  escapeHtml,
  renderEmailShell,
  type EmailShellInput,
} from '../../../../lambda/lib/email-shell';

/** Distinct markers so a card/footer mix-up cannot pass a split() count. */
const CARD_MARKER = '<p>CARD_FRAGMENT_MARKER_ZZQ</p>';
const FOOTER_MARKER = '<p>FOOTER_FRAGMENT_MARKER_YYW</p>';

function shell(overrides: Partial<EmailShellInput> = {}): EmailShellInput {
  return {
    lang: 'en',
    title: 'Your daily digest',
    preheader: '2 new applicants across 1 job.',
    eyebrow: 'Daily digest',
    cardHtml: CARD_MARKER,
    footerHtml: FOOTER_MARKER,
    ...overrides,
  };
}

function render(overrides: Partial<EmailShellInput> = {}): string {
  return renderEmailShell(shell(overrides));
}

/** Every <td ...> opening tag in the rendered document. */
function tdTags(html: string): string[] {
  return html.match(/<td[^>]*>/g) ?? [];
}

describe('email shell', () => {
  // ── escapeHtml ────────────────────────────────────────────────────────────

  describe('escapeHtml', () => {
    it('escapes & < > " and the apostrophe', () => {
      expect(escapeHtml('&')).toBe('&amp;');
      expect(escapeHtml('<')).toBe('&lt;');
      expect(escapeHtml('>')).toBe('&gt;');
      expect(escapeHtml('"')).toBe('&quot;');
      expect(escapeHtml("'")).toBe('&#39;');
      expect(escapeHtml(`<a href="x">O'Neil & Sons</a>`)).toBe(
        '&lt;a href=&quot;x&quot;&gt;O&#39;Neil &amp; Sons&lt;/a&gt;',
      );
    });

    it('escapes an ampersand exactly once', () => {
      expect(escapeHtml('Tile & Grout')).toBe('Tile &amp; Grout');
      expect(escapeHtml('Tile & Grout')).not.toContain('&amp;amp;');
    });

    it('leaves text with no special characters untouched', () => {
      expect(escapeHtml('Journeyman Electrician')).toBe('Journeyman Electrician');
      expect(escapeHtml('')).toBe('');
    });
  });

  // ── Document skeleton ─────────────────────────────────────────────────────

  describe('document skeleton', () => {
    it('opens with the doctype and the requested html lang and closes the document', () => {
      expect(render({ lang: 'en' }).startsWith('<!DOCTYPE html><html lang="en"')).toBe(true);
      expect(render({ lang: 'es' }).startsWith('<!DOCTYPE html><html lang="es"')).toBe(true);
      expect(render().endsWith('</html>')).toBe(true);
      expect(render({ lang: 'es' }).endsWith('</html>')).toBe(true);
    });

    it('renders the escaped title in <title> and never emits a raw script tag', () => {
      const html = render({ title: `<script>alert('x')</script> & "quotes"` });
      const title = /<title>(.*?)<\/title>/.exec(html);
      expect(title).not.toBeNull();
      expect(title![1]).toBe(
        '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quotes&quot;',
      );
      expect(html).not.toContain('<script');
    });

    it('carries the email client meta tags and the Lexend web font link', () => {
      const html = render();
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
      expect(html).toContain('<meta name="color-scheme" content="light">');
      expect(html).toContain('<meta name="supported-color-schemes" content="light">');
      expect(html).toContain('<meta name="format-detection" content="telephone=no">');
      expect(html).toContain('https://fonts.googleapis.com/css2?family=Lexend:wght@400;600;700;800');
      expect(html).toContain('&amp;display=swap');
      expect(html).toContain('rel="stylesheet"');
    });

    it('paints the paper background on the body', () => {
      expect(render()).toContain('<body style="margin:0;padding:0;background:#e3eaf2;">');
    });
  });

  // ── Preheader ─────────────────────────────────────────────────────────────

  describe('preheader', () => {
    it('hides the preheader from the rendered body but keeps it for the inbox preview', () => {
      const html = render({ preheader: 'Two new applicants are waiting.' });
      const div = /<div style="(display:none;[^"]*)">([^<]*)<\/div>/.exec(html);
      expect(div).not.toBeNull();
      const style = div![1];
      expect(style).toContain('font-size:1px');
      expect(style).toContain('line-height:1px');
      expect(style).toContain('color:#e3eaf2');
      expect(style).toContain('max-height:0');
      expect(style).toContain('max-width:0');
      expect(style).toContain('opacity:0');
      expect(style).toContain('overflow:hidden');
      expect(style).toContain('mso-hide:all');
      expect(div![2]).toBe('Two new applicants are waiting.');
    });

    it('escapes a hostile preheader instead of emitting markup', () => {
      const html = render({ preheader: '<img src=x onerror=alert(1)>' });
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('onerror=alert(1)>');
      // The wordmark stays the one and only image in the document.
      expect(html.split('<img').length - 1).toBe(1);
    });

    it('passes curly braces through verbatim', () => {
      expect(render({ preheader: '{{braces}} stay {{put}}' })).toContain('{{braces}} stay {{put}}');
    });
  });

  // ── Header band ───────────────────────────────────────────────────────────

  describe('header band', () => {
    it('renders the navy band with the wordmark linked to the site', () => {
      const html = render();
      expect(html).toContain(`<img src="${EMAIL_WORDMARK_URL}" width="78" height="40" alt="Jale"`);
      expect(html).toContain(
        '<img src="https://jaleapp.ai/brand/email/wordmark-white-2x.png" width="78" height="40" alt="Jale"',
      );
      expect(html).toContain('<a href="https://jaleapp.ai" style="text-decoration:none;">');
      expect(html).toContain('bgcolor="#181855"');
      expect(html).toContain('border-radius:16px 16px 0 0');
    });

    it('renders the eyebrow uppercase in the muted navy tint and escapes it', () => {
      const html = render({ eyebrow: 'Verification code · Código & <b>más</b>' });
      expect(html).toContain('Verification code · Código &amp; &lt;b&gt;más&lt;/b&gt;');
      expect(html).not.toContain('<b>más</b>');
      expect(html).toContain('#CCCCDA');
      expect(html).toContain('text-transform:uppercase');
      expect(html).toContain('letter-spacing:0.06em');
    });
  });

  // ── Card and footer slots ─────────────────────────────────────────────────

  describe('card and footer slots', () => {
    it('styles the white card td and inserts cardHtml verbatim exactly once', () => {
      const html = render();
      expect(html).toContain('bgcolor="#ffffff"');
      expect(html).toContain('border-radius:0 0 16px 16px');
      expect(html).toContain('padding:28px 24px');
      expect(html.split(CARD_MARKER).length).toBe(2);
    });

    it('styles the footer td and inserts footerHtml verbatim exactly once', () => {
      const html = render();
      expect(html).toContain('padding:20px 24px 0');
      expect(html).toContain('color:#5b6480');
      expect(html.split(FOOTER_MARKER).length).toBe(2);
    });

    it('does not escape, trim or reorder the trusted fragments', () => {
      const card = '  <div>&amp; already escaped</div>  ';
      const footer = '\n<span>keep\tme</span>\n';
      const html = renderEmailShell(shell({ cardHtml: card, footerHtml: footer }));
      expect(html).toContain(card);
      expect(html).toContain(footer);
      expect(html.indexOf(card)).toBeLessThan(html.indexOf(footer));
    });
  });

  // ── Table-cell typography ─────────────────────────────────────────────────

  it('sets font-family on every td, because Outlook inherits nothing', () => {
    const html = render();
    const tds = tdTags(html);
    // Outer centring cell, header band, wordmark cell, eyebrow cell, card, footer.
    expect(tds.length).toBe(6);
    for (const td of tds) {
      expect(td).toContain("font-family:'Lexend'");
      expect(td).toContain(EMAIL_FONT_STACK);
    }
  });

  // ── Negative guarantees ───────────────────────────────────────────────────

  it('omits everything email clients strip or mangle', () => {
    const html = render();
    expect(html).not.toContain('<style');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).not.toContain('linear-gradient');
    expect(html).not.toContain('<!--');
    expect(html.split('<img').length - 1).toBe(1);
    expect(html).not.toContain('{####}');
    expect(html).not.toContain('{username}');
  });

  // ── Length linearity ──────────────────────────────────────────────────────

  it('inserts each fragment exactly once, so length grows linearly', () => {
    const base = renderEmailShell(shell({ cardHtml: '', footerHtml: '' })).length;
    for (const size of [0, 1, 10000]) {
      const card = 'c'.repeat(size);
      const footer = 'f'.repeat(size);
      const html = renderEmailShell(shell({ cardHtml: card, footerHtml: footer }));
      expect(html.length).toBe(base + card.length + footer.length);
    }
    const mixed = renderEmailShell(shell({ cardHtml: 'c'.repeat(10000), footerHtml: '' }));
    expect(mixed.length).toBe(base + 10000);
  });

  // ── clipPreheader ─────────────────────────────────────────────────────────

  describe('clipPreheader', () => {
    it('returns text that already fits completely unchanged', () => {
      expect(clipPreheader('Two new applicants are waiting.')).toBe(
        'Two new applicants are waiting.',
      );
      const exactly90 = `${'a'.repeat(89)} `;
      expect(exactly90.length).toBe(90);
      expect(clipPreheader(exactly90)).toBe(exactly90);
      expect(clipPreheader('')).toBe('');
    });

    it('clips a long sentence on a word boundary and appends an ellipsis', () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(5).trim();
      expect(text.length).toBeGreaterThan(150);
      const clipped = clipPreheader(text);
      expect(clipped.length).toBeLessThanOrEqual(92);
      expect(clipped.endsWith(' …')).toBe(true);
      expect(clipped).toMatch(/\S …$/);
      const body = clipped.slice(0, -2);
      expect(text.startsWith(body)).toBe(true);
      expect(body.length).toBeLessThanOrEqual(90);
    });

    it('hard-cuts a single word longer than max with no leading space before the ellipsis', () => {
      const clipped = clipPreheader('a'.repeat(200));
      expect(clipped.length).toBe(90);
      expect(clipped.endsWith('…')).toBe(true);
      expect(clipped).not.toMatch(/ …$/);
      expect(clipped).toBe(`${'a'.repeat(89)}…`);
    });

    it('honours an explicit max', () => {
      const clipped = clipPreheader('The quick brown fox jumps over the lazy dog.', 20);
      expect(clipped.length).toBeLessThanOrEqual(22);
      expect(clipped.endsWith(' …')).toBe(true);
      expect(clipPreheader('a'.repeat(50), 20).length).toBe(20);
    });

    it('defaults max to 90', () => {
      const text = 'word '.repeat(60).trim();
      expect(clipPreheader(text)).toBe(clipPreheader(text, 90));
      expect(clipPreheader(text)).not.toBe(clipPreheader(text, 40));
    });

    it('never leaves a dangling entity fragment when clipping runs before escaping', () => {
      const dangling = /&(?!amp;|lt;|gt;|quot;|#39;)/;
      const text = `${'Tile & Grout & Stone '.repeat(20)}end`;
      for (let max = 80; max <= 100; max += 1) {
        const escaped = escapeHtml(clipPreheader(text, max));
        expect(escaped).not.toMatch(dangling);
        expect(render({ preheader: clipPreheader(text, max) })).not.toMatch(dangling);
      }
    });
  });

  // ── emailButtonHtml ───────────────────────────────────────────────────────

  describe('emailButtonHtml', () => {
    it('renders a bulletproof pill button', () => {
      const html = emailButtonHtml('https://jaleapp.ai/en/employer/dashboard', 'Review candidates');
      expect(html).toContain('role="presentation"');
      expect(html).toContain('bgcolor="#0064d6"');
      expect(html).toContain('background:#0064d6');
      expect(html).toContain('border-radius:9999px');
      expect(html).toContain('display:block;padding:13px 24px');
      expect(html).toContain('font-weight:600');
      expect(html).toContain('color:#ffffff');
      expect(html).toContain('text-decoration:none');
      expect(html).toContain(EMAIL_FONT_STACK);
      expect(html).toContain('>Review candidates</a>');
    });

    it('escapes the href and the label', () => {
      const html = emailButtonHtml('https://x.test/?a=1&b=2', '<b>Go</b>');
      expect(html).toContain('href="https://x.test/?a=1&amp;b=2"');
      expect(html).toContain('&lt;b&gt;Go&lt;/b&gt;');
      expect(html).not.toContain('<b>Go</b>');
    });

    it('adds width="100%" only when fullWidth is requested', () => {
      expect(emailButtonHtml('https://x.test', 'Go')).not.toContain('width="100%"');
      expect(emailButtonHtml('https://x.test', 'Go', {})).not.toContain('width="100%"');
      expect(emailButtonHtml('https://x.test', 'Go', { fullWidth: false })).not.toContain(
        'width="100%"',
      );
      expect(emailButtonHtml('https://x.test', 'Go', { fullWidth: true })).toContain('width="100%"');
    });
  });

  // ── emailDividerHtml ──────────────────────────────────────────────────────

  describe('emailDividerHtml', () => {
    it('renders a 1px rule in the divider grey', () => {
      expect(emailDividerHtml(24)).toContain('#d1d1d1');
      expect(emailDividerHtml(24)).toContain('height:1px');
      expect(emailDividerHtml(24)).toContain('24px 0');
    });

    it('defaults the vertical margin to 24px and honours an override', () => {
      expect(emailDividerHtml()).toBe(emailDividerHtml(24));
      expect(emailDividerHtml(12)).toContain('12px 0');
      expect(emailDividerHtml(0)).toContain('0px 0');
    });
  });

  // ── emailLegalLinksHtml ───────────────────────────────────────────────────

  describe('emailLegalLinksHtml', () => {
    it.each(['en', 'es', 'bilingual'] as const)(
      'always links terms, privacy and the copyright (%s)',
      (lang) => {
        const html = emailLegalLinksHtml(lang);
        expect(html).toContain(EMAIL_LEGAL_TERMS_URL);
        expect(html).toContain(EMAIL_LEGAL_PRIVACY_URL);
        expect(html).toContain(EMAIL_COPYRIGHT);
        expect(html).toContain('© 2026 Jale');
        expect(html.split('color:#0050ad;font-weight:600;').length).toBe(3);
      },
    );

    it('uses English labels for en', () => {
      const html = emailLegalLinksHtml('en');
      expect(html).toContain('>Terms</a>');
      expect(html).toContain('>Privacy</a>');
      expect(html).not.toContain('Términos');
    });

    it('uses Spanish labels for es', () => {
      const html = emailLegalLinksHtml('es');
      expect(html).toContain('>Términos</a>');
      expect(html).toContain('>Privacidad</a>');
      expect(html).not.toContain('>Terms</a>');
    });

    it('pairs both languages for bilingual', () => {
      const html = emailLegalLinksHtml('bilingual');
      expect(html).toContain('>Terms / Términos</a>');
      expect(html).toContain('>Privacy / Privacidad</a>');
    });
  });

  // ── Determinism and size ──────────────────────────────────────────────────

  describe('determinism and size', () => {
    it('is a pure function of its input', () => {
      expect(render()).toBe(render());
      expect(renderEmailShell(shell({ lang: 'es' }))).toBe(renderEmailShell(shell({ lang: 'es' })));
      expect(render({ lang: 'en' })).not.toBe(render({ lang: 'es' }));
    });

    it('keeps the empty shell small enough to leave room for the card', () => {
      // Measured 2026-08-26: 2511 characters with this fixture's title (17),
      // preheader (30) and eyebrow (12) — so 2452 characters of pure chrome.
      // That leaves ~197k of the email_outbox body_html cap for the card.
      const empty = renderEmailShell(shell({ cardHtml: '', footerHtml: '' }));
      expect(empty.length).toBe(2511);
      expect(empty.length).toBeLessThan(3500);
    });
  });

  // ── Pinned constants ──────────────────────────────────────────────────────

  it('pins the brand constants the other email templates depend on', () => {
    expect(EMAIL_FONT_STACK).toBe(
      "'Lexend',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
    );
    expect(EMAIL_WORDMARK_URL).toBe('https://jaleapp.ai/brand/email/wordmark-white-2x.png');
    expect(EMAIL_LEGAL_TERMS_URL).toBe('https://jaleapp.ai/legal/terms');
    expect(EMAIL_LEGAL_PRIVACY_URL).toBe('https://jaleapp.ai/legal/privacy');
    expect(EMAIL_COPYRIGHT).toBe('© 2026 Jale');
    expect(EMAIL_COLORS).toEqual({
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
    });
  });
});
