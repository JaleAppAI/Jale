import {
  BILLING_PAUSE_MAX_TITLES,
  BILLING_PAUSE_SUBJECT,
  renderBillingPauseEmail,
  type BillingPauseModel,
} from '../../../../lambda/lib/billing-pause-template';

const EN_BILLING_URL = 'https://jaleapp.ai/en/employer/billing';
const ES_BILLING_URL = 'https://jaleapp.ai/es/employer/billing';

function model(overrides: Partial<BillingPauseModel> = {}): BillingPauseModel {
  return {
    pausedTitles: ['Older overflow', 'Tile & Grout Installer'],
    englishBillingUrl: EN_BILLING_URL,
    spanishBillingUrl: ES_BILLING_URL,
    ...overrides,
  };
}

/** 200-character titles with no standalone `tu`/`tus`/`tienes` token. */
function longTitles(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Job-${i}-`.padEnd(200, 'x'));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('billing pause template', () => {
  // ── Subject ───────────────────────────────────────────────────────────────

  it('uses the locked bilingual subject within the email_outbox 200-char cap', () => {
    expect(BILLING_PAUSE_SUBJECT).toBe('Job postings paused · Empleos pausados');
    expect(BILLING_PAUSE_SUBJECT.length).toBeLessThanOrEqual(200);
    expect(renderBillingPauseEmail(model()).subject).toBe(BILLING_PAUSE_SUBJECT);
  });

  // ── bodyText ──────────────────────────────────────────────────────────────

  it('keeps the English block, its link, the Spanish block and its link in that order', () => {
    const { bodyText } = renderBillingPauseEmail(model());
    expect(bodyText).toMatch(
      /Older overflow[\s\S]*https:\/\/jaleapp\.ai\/en\/employer\/billing[\s\S]*Su suscripción[\s\S]*https:\/\/jaleapp\.ai\/es\/employer\/billing/,
    );
    expect(bodyText).toContain(
      'Your subscription changed and these job postings were paused to match your active-job limit:',
    );
    expect(bodyText).toContain(
      'Su suscripción cambió y estas ofertas de trabajo se pausaron para respetar su límite de empleos activos:',
    );
    expect(bodyText).toContain(`Manage billing: ${EN_BILLING_URL}`);
    expect(bodyText).toContain(`Administrar facturación: ${ES_BILLING_URL}`);
  });

  it('lists every paused title as a bullet in both language blocks', () => {
    const { bodyText } = renderBillingPauseEmail(model());
    expect(occurrences(bodyText, '- Older overflow')).toBe(2);
    expect(occurrences(bodyText, '- Tile & Grout Installer')).toBe(2);
  });

  it('addresses the employer as usted, never tú', () => {
    const { bodyText } = renderBillingPauseEmail(model());
    expect(bodyText).toContain('Su suscripción');
    expect(bodyText).not.toMatch(/\btus?\b|\btienes\b/i);
  });

  it('closes both language blocks with the transactional why-line', () => {
    const { bodyText } = renderBillingPauseEmail(model());
    expect(bodyText).toContain(
      'You are receiving this because your Jale employer account has a subscription.',
    );
    expect(bodyText).toContain(
      'Está recibiendo este correo porque su cuenta de empleador de Jale tiene una suscripción.',
    );
  });

  // ── bodyHtml ──────────────────────────────────────────────────────────────

  it('renders inside the shared branded shell', () => {
    const { bodyHtml } = renderBillingPauseEmail(model());
    expect(bodyHtml).toContain('<html');
    expect(bodyHtml).toContain('lang="en"');
    expect(bodyHtml).toContain('<title>Job postings paused · Empleos pausados</title>');
    expect(bodyHtml).toContain('Billing · Facturación');
  });

  it('carries both language blocks and exactly two billing buttons', () => {
    const { bodyHtml } = renderBillingPauseEmail(model());
    expect(bodyHtml).toContain('Su suscripción cambió');
    expect(bodyHtml).toContain(`href="${EN_BILLING_URL}"`);
    expect(bodyHtml).toContain('Manage billing');
    expect(bodyHtml).toContain(`href="${ES_BILLING_URL}"`);
    expect(bodyHtml).toContain('Administrar facturación');
    expect((bodyHtml.match(/bgcolor="#0064d6"/g) ?? []).length).toBe(2);
  });

  it('is transactional: legal links only, no unsubscribe or digest settings', () => {
    const { bodyHtml } = renderBillingPauseEmail(model());
    expect(bodyHtml).toContain('Terms / Términos');
    expect(bodyHtml).toContain('Privacy / Privacidad');
    expect(bodyHtml).toContain('© 2026 Jale');
    expect(bodyHtml).not.toContain('digest-unsubscribe');
    expect(bodyHtml).not.toContain('Turn off');
    expect(bodyHtml).not.toContain('Desactivar');
  });

  it('previews the paused count bilingually in the preheader, singular for one job', () => {
    expect(renderBillingPauseEmail(model()).bodyHtml)
      .toContain('2 job postings paused · 2 empleos pausados');
    expect(renderBillingPauseEmail(model({ pausedTitles: ['Older overflow'] })).bodyHtml)
      .toContain('1 job posting paused · 1 empleo pausado');
  });

  // ── Escaping ──────────────────────────────────────────────────────────────

  it('escapes a hostile job title in HTML and leaves it raw in the text body', () => {
    const hostile = '<script>alert(1)</script>';
    const { bodyHtml, bodyText } = renderBillingPauseEmail(model({ pausedTitles: [hostile] }));
    expect(bodyHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(bodyHtml).not.toContain('<script');
    expect(bodyText).toContain(`- ${hostile}`);
  });

  it('escapes an ampersand exactly once', () => {
    const { bodyHtml, bodyText } = renderBillingPauseEmail(model());
    expect(bodyHtml).toContain('Tile &amp; Grout Installer');
    expect(bodyHtml).not.toContain('&amp;amp;');
    expect(bodyText).toContain('- Tile & Grout Installer');
  });

  // ── Caps ──────────────────────────────────────────────────────────────────

  it('caps a pathological list at 50 titles per block and stays inside the outbox limits', () => {
    const { bodyText, bodyHtml } = renderBillingPauseEmail(model({ pausedTitles: longTitles(1000) }));
    expect(BILLING_PAUSE_MAX_TITLES).toBe(50);
    expect(bodyText.length).toBeLessThanOrEqual(100_000);
    expect(bodyHtml.length).toBeLessThanOrEqual(70_000);
    expect((bodyHtml.match(/border-top:1px solid #d1d1d1/g) ?? []).length).toBe(100);
    expect(bodyText).toContain('+ 950 more job postings');
    expect(bodyText).toContain('+ 950 empleos más');
    expect(bodyHtml).toContain('+ 950 more job postings');
    expect(bodyHtml).toContain('+ 950 empleos más');
  });

  it('omits the overflow line when every paused job is listed', () => {
    const { bodyText, bodyHtml } = renderBillingPauseEmail(model());
    expect(bodyText).not.toMatch(/\+ \d+ more job posting/);
    expect(bodyText).not.toMatch(/\+ \d+ empleos? más/);
    expect(bodyHtml).not.toMatch(/\+ \d+ more job posting/);
  });

  it('uses the singular overflow forms for exactly one hidden job', () => {
    const { bodyText } = renderBillingPauseEmail(model({ pausedTitles: longTitles(51) }));
    expect(bodyText).toContain('+ 1 more job posting');
    expect(bodyText).not.toContain('+ 1 more job postings');
    expect(bodyText).toContain('+ 1 empleo más');
    expect(bodyText).not.toContain('+ 1 empleos más');
  });

  it('is deterministic for the same model', () => {
    const input = model({ pausedTitles: longTitles(120) });
    expect(renderBillingPauseEmail(input)).toEqual(renderBillingPauseEmail(input));
  });
});
