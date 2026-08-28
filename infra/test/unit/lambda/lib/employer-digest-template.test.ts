import { buildRawEmail } from '../../../../lambda/lib/email-mime';
import {
  DIGEST_BODY_HTML_MAX,
  DIGEST_BODY_HTML_SOFT_MAX,
  DIGEST_BODY_TEXT_MAX,
  DIGEST_ENCODED_BODY_SOFT_MAX,
  DIGEST_SUBJECT_MAX,
  renderEmployerDigest,
  type DigestJob,
  type EmployerDigestModel,
} from '../../../../lambda/lib/employer-digest-template';

/**
 * Gmail's clip threshold, in bytes of the message as RECEIVED. Every budget
 * assertion below measures against the real MIME builder rather than against
 * `bodyHtml.length`, because the source-character count is not the quantity
 * Gmail cuts on -- which is exactly how a Spanish digest at the old 70,000
 * CHARACTER cap shipped encoding to 115,874 bytes.
 */
const GMAIL_CLIP_BYTES = 102_400;

/** A generous allowance for the headers SES adds after we hand the message over. */
const SES_ADDED_HEADER_ALLOWANCE = 2_048;

const ONE_CLICK_URL =
  'https://jaleapp.ai/api/public/employer-digest/unsubscribe?token=abcdefghijklmnop.qrstuvwxyz012345';

function encodedMessageBytes(rendered: { subject: string; bodyText: string; bodyHtml: string }): number {
  return buildRawEmail({
    from: 'Jale <no-reply@jaleapp.ai>',
    to: 'a-fairly-long-employer-address@some-construction-company.example',
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
    unsubscribeUrl: ONE_CLICK_URL,
    configurationSet: 'jale-employer-email',
  }).length;
}

/** A full ten-candidate job block, the shape the producer actually emits. */
function tenCandidateJob(index: number, accented: boolean): DigestJob {
  const id = `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`;
  return {
    jobId: id,
    title: accented
      ? `Instalación eléctrica y climatización — Añadir señalización ${'ó'.repeat(30)}`
      : `Journeyman Electrician - Site ${index}`,
    jobUrl: `https://jaleapp.ai/en/employer/jobs/${id}`,
    newApplicantCount: 14,
    candidates: Array.from({ length: 10 }, (_, position) => ({
      displayName: accented
        ? `Jesús Ángel Muñóz Peña ${'ó'.repeat(20)}`
        : `Candidate Number ${position} Lopez`,
      matchScore: 90 - position * 3,
      scoreBand: (position < 3 ? 'strong' : position < 7 ? 'good' : 'fair') as 'strong' | 'good' | 'fair',
      location: accented ? `Ciudad Juárez, Chihuahua ${'á'.repeat(15)}` : 'San Antonio, TX',
    })),
  };
}

function renderedJobCount(bodyHtml: string): number {
  return (bodyHtml.match(/<h2/g) ?? []).length;
}

const DASHBOARD_URL = 'https://jaleapp.ai/en/employer/dashboard';
const UNSUBSCRIBE_URL = 'https://jaleapp.ai/en/digest-unsubscribe?token=abc.def';
const SETTINGS_URL = 'https://jaleapp.ai/en/employer/profile';
const JOB_URL = 'https://jaleapp.ai/en/employer/jobs/11111111-2222-4333-8444-555555555555';

/**
 * Measured when the branded shell landed (the budget tests at the bottom pin
 * the invariants these numbers imply):
 *   empty-card shell + footer ....... 3,153 chars
 *   intro row (count + sentence) ....   620 chars
 *   card tail (divider + dashboard) .   236 chars
 *   one 10-candidate job block ...... 10,012 chars
 *   whole body, no jobs ............. 3,483 chars
 * So SIX 10-candidate jobs fit under DIGEST_BODY_HTML_SOFT_MAX (70 kB); a
 * 50-job render lands at 64,360 chars. Most of a job block is the candidate
 * rows, which repeat the font stack on every <td> because Outlook inherits it
 * from neither the body nor a parent cell.
 */
function model(overrides: Partial<EmployerDigestModel> = {}): EmployerDigestModel {
  return {
    language: 'en',
    dashboardUrl: DASHBOARD_URL,
    unsubscribeUrl: UNSUBSCRIBE_URL,
    settingsUrl: SETTINGS_URL,
    jobs: [
      {
        jobId: '11111111-2222-4333-8444-555555555555',
        title: 'Journeyman Electrician',
        jobUrl: 'https://jaleapp.ai/en/employer/jobs/11111111-2222-4333-8444-555555555555',
        newApplicantCount: 2,
        candidates: [
          { displayName: 'Maria Lopez', matchScore: 82, scoreBand: 'strong', location: 'Austin, TX' },
          { displayName: 'Juan Perez', matchScore: 51, scoreBand: 'good', location: null },
        ],
      },
    ],
    ...overrides,
  };
}

/** The off-screen inbox-preview text the shell hides at the top of the document. */
function preheaderOf(bodyHtml: string): string {
  const match = /mso-hide:all;">([\s\S]*?)<\/div>/.exec(bodyHtml);
  if (!match) throw new Error('no preheader block in the rendered document');
  return match[1];
}

describe('employer digest template', () => {
  // ── Subject ───────────────────────────────────────────────────────────────

  it('puts the total new-applicant count in the English subject', () => {
    const { subject } = renderEmployerDigest(model());
    expect(subject).toContain('2');
    expect(subject).toMatch(/new applicants/);
    expect(subject).toContain('Jale');
    expect(subject.length).toBeLessThanOrEqual(DIGEST_SUBJECT_MAX);
  });

  it('uses the singular form for exactly one new applicant', () => {
    const one = model({
      jobs: [{ ...model().jobs[0], newApplicantCount: 1, candidates: [model().jobs[0].candidates[0]] }],
    });
    expect(renderEmployerDigest(one).subject).toMatch(/1 new applicant\b/);
    expect(renderEmployerDigest(one).subject).not.toMatch(/applicants/);
  });

  it('renders the Spanish subject with the count', () => {
    const { subject } = renderEmployerDigest(model({ language: 'es' }));
    expect(subject).toContain('2');
    expect(subject).toMatch(/postulantes/);
    expect(subject.length).toBeLessThanOrEqual(DIGEST_SUBJECT_MAX);
  });

  it('never interpolates a job title into the subject, so a long title cannot blow the 200-char cap', () => {
    const longTitle = 'Journeyman Electrician '.repeat(80);
    const { subject } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: longTitle }],
    }));
    expect(subject.length).toBeLessThanOrEqual(DIGEST_SUBJECT_MAX);
    expect(subject).not.toContain('Electrician');
  });

  // ── English body ──────────────────────────────────────────────────────────

  it('renders the English text and HTML bodies with job, candidate and link content', () => {
    const { bodyText, bodyHtml } = renderEmployerDigest(model());
    for (const body of [bodyText, bodyHtml]) {
      expect(body).toContain('Journeyman Electrician');
      expect(body).toContain('Maria Lopez');
      expect(body).toContain('Juan Perez');
      expect(body).toContain('Austin, TX');
      expect(body).toContain(DASHBOARD_URL);
      expect(body).toContain(UNSUBSCRIBE_URL);
    }
    expect(bodyHtml).toContain('<html');
    expect(bodyHtml).toContain(`href="${UNSUBSCRIBE_URL}"`);
  });

  it('renders the Spanish body in formal usted', () => {
    const { bodyText } = renderEmployerDigest(model({ language: 'es' }));
    expect(bodyText).toMatch(/postulante/);
    // Formal register: "su"/"Tiene", never the informal "tu"/"tienes".
    expect(bodyText).toMatch(/\bsu\b/i);
    expect(bodyText).not.toMatch(/\btienes\b/i);
    expect(bodyText).not.toMatch(/\btus?\b/i);
    // Still English-free copy.
    expect(bodyText).not.toMatch(/new applicants/);
  });

  // ── 10-cap and "+N more" ──────────────────────────────────────────────────

  it('adds a "+N more" line with a dashboard-side job link when a job has more new applicants than rendered candidates', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      displayName: `Worker ${i}`,
      matchScore: 90 - i,
      scoreBand: 'strong' as const,
      location: null,
    }));
    const jobUrl = 'https://jaleapp.ai/en/employer/jobs/11111111-2222-4333-8444-555555555555';
    const { bodyText, bodyHtml } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], newApplicantCount: 14, candidates: ten, jobUrl }],
    }));
    expect(bodyText).toMatch(/\+\s*4 more/);
    expect(bodyHtml).toMatch(/\+\s*4 more/);
    expect(bodyText).toContain(jobUrl);
    expect(bodyHtml).toContain(`href="${jobUrl}"`);
  });

  it('omits the "+N more" line when every new applicant is rendered', () => {
    const { bodyText } = renderEmployerDigest(model());
    expect(bodyText).not.toMatch(/more/i);
  });

  it('renders the Spanish "+N more" line', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      displayName: `Trabajador ${i}`,
      matchScore: 90 - i,
      scoreBand: 'good' as const,
      location: null,
    }));
    const { bodyText } = renderEmployerDigest(model({
      language: 'es',
      jobs: [{ ...model().jobs[0], newApplicantCount: 12, candidates: ten }],
    }));
    expect(bodyText).toMatch(/\+\s*2 m[áa]s/);
    expect(bodyText).not.toMatch(/more/);
  });

  // ── HTML escaping of hostile input ───────────────────────────────────────

  it('HTML-escapes hostile job titles, candidate names and locations', () => {
    const { bodyHtml, bodyText } = renderEmployerDigest(model({
      jobs: [{
        ...model().jobs[0],
        title: '<script>alert(1)</script>',
        candidates: [{
          displayName: '<img src=x onerror=alert(2)>',
          matchScore: 10,
          scoreBand: 'fair',
          location: '"><b>Austin</b>',
        }],
        newApplicantCount: 1,
      }],
    }));
    expect(bodyHtml).not.toContain('<script>');
    expect(bodyHtml).not.toContain('<img src=x');
    expect(bodyHtml).not.toContain('<b>Austin</b>');
    expect(bodyHtml).toContain('&lt;script&gt;');
    expect(bodyHtml).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(bodyHtml).toContain('&quot;&gt;&lt;b&gt;Austin&lt;/b&gt;');
    // The plain-text part is not HTML, so it carries the raw characters —
    // asserted so a future change cannot quietly double-escape the text body.
    expect(bodyText).toContain('<script>alert(1)</script>');
  });

  it('escapes ampersands exactly once', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: 'Tile & Grout' }],
    }));
    expect(bodyHtml).toContain('Tile &amp; Grout');
    expect(bodyHtml).not.toContain('&amp;amp;');
  });

  // ── Length limits (email_outbox CHECKs) ──────────────────────────────────

  it('keeps both bodies inside the email_outbox limits and adds a see-dashboard line when jobs are dropped', () => {
    // 2,000 jobs each carrying 10 candidates with long names blows past both
    // the 100k text and 200k html CHECK constraints if rendered whole.
    const jobs = Array.from({ length: 2000 }, (_, j) => ({
      jobId: '11111111-2222-4333-8444-555555555555',
      title: `Very Long Job Title Number ${j} ${'x'.repeat(120)}`,
      jobUrl: `https://jaleapp.ai/en/employer/jobs/11111111-2222-4333-8444-55555555555${j % 10}`,
      newApplicantCount: 12,
      candidates: Array.from({ length: 10 }, (_, i) => ({
        displayName: `Candidate With A Fairly Long Name ${j}-${i}`,
        matchScore: 80 - i,
        scoreBand: 'strong' as const,
        location: 'Somewhere In A Long City Name, TX',
      })),
    }));
    const { subject, bodyText, bodyHtml } = renderEmployerDigest(model({ jobs }));

    expect(bodyText.length).toBeGreaterThan(0);
    expect(bodyText.length).toBeLessThanOrEqual(DIGEST_BODY_TEXT_MAX);
    expect(bodyHtml.length).toBeGreaterThan(0);
    expect(bodyHtml.length).toBeLessThanOrEqual(DIGEST_BODY_HTML_MAX);
    // Gmail clips a message at ~102 kB of the transfer-ENCODED bytes, well
    // before the 200 kB column limit, so the encoded budget is the real one.
    expect(Buffer.byteLength(bodyHtml, 'utf8')).toBeLessThanOrEqual(DIGEST_BODY_HTML_SOFT_MAX);
    expect(encodedMessageBytes({ subject, bodyText, bodyHtml }))
      .toBeLessThan(GMAIL_CLIP_BYTES - SES_ADDED_HEADER_ALLOWANCE);
    // A useful digest, not one job and a "the rest lives elsewhere" note.
    // Deliberate tripwire: this fixture's blocks (150-char titles, 10 long
    // names and locations) measure ~11 kB, so the render lands on EXACTLY 5
    // jobs once the budget is spent in ENCODED bytes rather than source
    // characters. Any card change adding ~400 bytes per block turns this red,
    // which is when the soft caps want re-examining.
    expect((bodyHtml.match(/<h2/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // The reader must be told the list was cut, and where the rest lives.
    expect(bodyText).toMatch(/dashboard/i);
    expect(bodyHtml).toContain(DASHBOARD_URL);
    expect(bodyHtml).toContain('Some job postings are not shown in this email.');
    // The unsubscribe footer survives truncation — it is not optional.
    expect(bodyText).toContain(UNSUBSCRIBE_URL);
    expect(bodyHtml).toContain(UNSUBSCRIBE_URL);
  });

  it('does not claim truncation when nothing was dropped', () => {
    const { bodyText } = renderEmployerDigest(model());
    expect(bodyText).not.toMatch(/not shown|no se muestran/i);
  });

  it('still produces non-empty bodies for a model with no jobs', () => {
    // The producer never sends on a quiet day, but a length-0 body would
    // violate email_outbox's `length(body_text) BETWEEN 1 AND 100000`.
    const { subject, bodyText, bodyHtml } = renderEmployerDigest(model({ jobs: [] }));
    expect(subject.length).toBeGreaterThan(0);
    expect(bodyText.length).toBeGreaterThan(0);
    expect(bodyHtml.length).toBeGreaterThan(0);
  });

  // ── Branded shell ─────────────────────────────────────────────────────────

  it('renders the HTML body inside the shared branded shell', () => {
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toContain('<title>2 new applicants — Jale</title>');
    expect(bodyHtml).toContain('https://jaleapp.ai/brand/email/wordmark-white-2x.png');
    expect(bodyHtml).toContain('alt="Jale"');
    expect(bodyHtml).toContain('Daily digest');
    expect(bodyHtml).toContain('color-scheme');
  });

  it('drops the greeting and the rank numbers from the HTML while the text body keeps both', () => {
    const { bodyText, bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).not.toContain('Hello,');
    expect(bodyHtml).not.toMatch(/>\s*1\.\s/);
    expect(bodyText.startsWith('Hello,')).toBe(true);
    expect(bodyText).toContain('1. Maria Lopez');
  });

  it('leads the card with the total count in a 72px gutter beside the intro sentence', () => {
    const { bodyText, bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toMatch(/width:72px[\s\S]{0,400}?>2</);
    for (const body of [bodyText, bodyHtml]) {
      expect(body).toContain(
        'You have 2 new applicants on 1 active job posting since your last digest.',
      );
    }
  });

  it('links the job title from an h2 under a blue new-applicant eyebrow', () => {
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toContain(
      '<h2 style="margin:4px 0 8px;font-size:20px;line-height:26px;font-weight:700;letter-spacing:-0.02em;">'
      + `<a href="${JOB_URL}" style="color:#181855;text-decoration:none;">Journeyman Electrician</a></h2>`,
    );
    expect(bodyHtml).toMatch(/color:#0050ad;">2 new applicants</);
  });

  it('renders each candidate as a name/location row with a score and a band dot', () => {
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toContain(
      '<div style="font-size:15px;line-height:22px;font-weight:600;color:#181855;">Maria Lopez</div>',
    );
    expect(bodyHtml).toContain(
      '<div style="font-size:13px;line-height:18px;color:#5b6480;">Austin, TX</div>',
    );
    expect(bodyHtml).toContain(
      '<div style="font-size:16px;line-height:22px;font-weight:800;color:#181855;'
      + 'font-variant-numeric:tabular-nums;">82</div>',
    );
    expect(bodyHtml).toContain('<span style="color:#1f7a44;">●</span> strong match');
    expect(bodyHtml).toContain('<span style="color:#0064d6;">●</span> good match');
  });

  it('uses the muted dot for a fair match', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [{
        ...model().jobs[0],
        newApplicantCount: 1,
        candidates: [{ displayName: 'Ana Diaz', matchScore: 31, scoreBand: 'fair', location: null }],
      }],
    }));
    expect(bodyHtml).toContain('<span style="color:#5b6480;">●</span> fair match');
  });

  it('omits the location line entirely when a candidate has no location', () => {
    // Juan Perez has location: null — an empty <div> would draw a phantom
    // second line under his name.
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).not.toContain('<div style="font-size:13px;line-height:18px;color:#5b6480;"></div>');
  });

  it('ends each job block with a full-width Review this job button', () => {
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toContain('bgcolor="#0064d6"');
    expect(bodyHtml).toContain(`href="${JOB_URL}"`);
    expect(bodyHtml).toContain('>Review this job</a>');
  });

  it('closes the card with the dashboard link', () => {
    const { bodyHtml } = renderEmployerDigest(model());
    expect(bodyHtml).toContain(
      `<a href="${DASHBOARD_URL}" style="color:#0050ad;font-weight:600;">View your dashboard →</a>`,
    );
  });

  it('puts the settings link, the unsubscribe link and the legal line in the footer', () => {
    const { bodyHtml, bodyText } = renderEmployerDigest(model());
    expect(bodyHtml).toContain(`href="${SETTINGS_URL}"`);
    expect(bodyHtml).toContain('Notification settings');
    expect(bodyHtml).toContain(`href="${UNSUBSCRIBE_URL}"`);
    expect(bodyHtml).toContain('Turn off the daily digest');
    expect(bodyHtml).toContain(
      'You are receiving this because the daily digest is on for your Jale employer account.',
    );
    expect(bodyHtml).toContain('/legal/terms');
    expect(bodyHtml).toContain('/legal/privacy');
    expect(bodyHtml).toContain('© 2026 Jale');
    // The plain-text body is untouched by the restyle: it never learned about
    // the settings page, and gaining it would change bytes we promised to keep.
    expect(bodyText).not.toContain(SETTINGS_URL);
  });

  it('renders the Spanish HTML in formal usted', () => {
    const { bodyHtml } = renderEmployerDigest(model({ language: 'es' }));
    expect(bodyHtml).toContain('Resumen diario');
    expect(bodyHtml).toContain('Revise este puesto');
    expect(bodyHtml).toContain('Vea su panel →');
    expect(bodyHtml).toContain('Configuración de notificaciones');
    expect(bodyHtml).toContain('Desactivar el resumen diario');
    expect(bodyHtml).toContain('coincidencia excelente');
    expect(bodyHtml).not.toMatch(/\btus?\b|\btienes\b/i);
  });

  // ── Inbox preview (preheader) ─────────────────────────────────────────────

  it('builds the inbox preview from every job in the model', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [
        model().jobs[0],
        { ...model().jobs[0], title: 'Plumber', newApplicantCount: 1, candidates: [] },
      ],
    }));
    expect(preheaderOf(bodyHtml)).toBe('Journeyman Electrician · 2 new · Plumber · 1 new');
  });

  it('counts the Spanish inbox preview in Spanish', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      language: 'es',
      jobs: [
        model().jobs[0],
        { ...model().jobs[0], title: 'Plomero', newApplicantCount: 1, candidates: [] },
      ],
    }));
    expect(preheaderOf(bodyHtml)).toBe('Journeyman Electrician · 2 nuevos · Plomero · 1 nuevo');
  });

  it('clips a runaway job title out of the inbox preview', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: 'T'.repeat(300) }],
    }));
    const preheader = preheaderOf(bodyHtml);
    expect(preheader.length).toBeLessThanOrEqual(92);
    expect(preheader.endsWith('…')).toBe(true);
  });

  it('escapes the inbox preview, so a hostile title cannot open a tag anywhere in the document', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: '<script>alert(1)</script>' }],
    }));
    expect(bodyHtml).toContain('&lt;script&gt;');
    expect(bodyHtml).not.toMatch(/<script/i);
  });

  // ── Degenerate shapes ─────────────────────────────────────────────────────

  it('renders a job whose candidates were all filtered out as a bare "+N more" link', () => {
    const { bodyHtml } = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], newApplicantCount: 5, candidates: [] }],
    }));
    expect(bodyHtml).toContain('>5 new applicants<');
    expect(bodyHtml).toContain('+ 5 more new applicants');
    expect(bodyHtml).not.toContain('border-top:1px solid #d1d1d1');
    expect(bodyHtml).toContain('>Review this job</a>');
  });

  it('tells a first-time recipient the window started when they turned the digest on', () => {
    const first = renderEmployerDigest(model({ firstDigest: true }));
    expect(first.bodyText).toContain('since you turned on the daily digest');
    expect(first.bodyHtml).toContain('since you turned on the daily digest');
    const firstEs = renderEmployerDigest(model({ language: 'es', firstDigest: true }));
    expect(firstEs.bodyText).toContain('desde que activó el resumen diario');
    expect(firstEs.bodyHtml).toContain('desde que activó el resumen diario');
    const repeat = renderEmployerDigest(model());
    expect(repeat.bodyText).toContain('since your last digest');
    expect(repeat.bodyHtml).toContain('since your last digest');
  });

  it('says there is nothing new when the model carries no jobs', () => {
    const en = renderEmployerDigest(model({ jobs: [] }));
    expect(en.subject).toBe('No new applicants — Jale');
    expect(en.bodyHtml).toContain('No new applicants to report.');
    expect(en.bodyHtml).not.toContain('<h2');
    const es = renderEmployerDigest(model({ jobs: [], language: 'es' }));
    expect(es.subject).toBe('Sin postulantes nuevos — Jale');
    expect(es.bodyHtml).toContain('No hay postulantes nuevos por informar.');
  });

  it('escapes an apostrophe in the HTML title and leaves it raw in the text body', () => {
    const rendered = renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: "Plumber's Helper" }],
    }));
    expect(rendered.bodyHtml).toContain('Plumber&#39;s Helper');
    expect(rendered.bodyText).toContain("Plumber's Helper");
  });

  // ── Byte budget ───────────────────────────────────────────────────────────

  it('leaves room under the soft cap for a realistic digest after the shell', () => {
    const empty = Buffer.byteLength(renderEmployerDigest(model({ jobs: [] })).bodyHtml, 'utf8');
    expect(empty).toBeLessThan(8_000);
    // The shell must not eat the budget: ~3,500 bytes spent, and a real
    // 10-candidate block measures ~10 kB, so several of them still land.
    expect(DIGEST_BODY_HTML_SOFT_MAX - empty).toBeGreaterThanOrEqual(5 * 8_000);
  });

  it('keeps the soft cap at or under the hard email_outbox cap', () => {
    expect(DIGEST_BODY_HTML_SOFT_MAX).toBeLessThanOrEqual(DIGEST_BODY_HTML_MAX);
  });

  /**
   * THE TRIPWIRE. The old version of this counted six ten-candidate ENGLISH
   * job blocks and asserted on `bodyHtml.length`; it passed while the Spanish
   * equivalent encoded to 115,874 bytes and was clipped in Gmail with the
   * unsubscribe footer below the cut. It now measures what Gmail measures, in
   * both languages, through the builder that actually produces the bytes.
   *
   * Measured at DIGEST_ENCODED_BODY_SOFT_MAX = 96,000:
   *   English, ten candidates per job .... 5 blocks, 83,238 encoded bytes
   *   Spanish, ten candidates per job .... 4 blocks, 79,724 encoded bytes
   * Both comfortably under the 102,400 clip with room for SES's own headers.
   */
  it.each([
    ['English', false, 5],
    ['Spanish', true, 4],
  ])('fits %s ten-candidate job blocks and stays well under the Gmail clip', (_label, accented, expected) => {
    const jobs = Array.from({ length: 30 }, (_, index) => tenCandidateJob(index, accented as boolean));
    const rendered = renderEmployerDigest(model({ jobs, language: accented ? 'es' : 'en' }));

    expect(renderedJobCount(rendered.bodyHtml)).toBe(expected);
    expect(encodedMessageBytes(rendered)).toBeLessThan(GMAIL_CLIP_BYTES - SES_ADDED_HEADER_ALLOWANCE);
  });

  it('never lets a digest of any size encode past the clip, however many jobs are offered', () => {
    for (const accented of [false, true]) {
      for (const count of [1, 2, 5, 10, 40]) {
        const jobs = Array.from({ length: count }, (_, index) => tenCandidateJob(index, accented));
        const rendered = renderEmployerDigest(model({ jobs, language: accented ? 'es' : 'en' }));
        expect(encodedMessageBytes(rendered)).toBeLessThan(GMAIL_CLIP_BYTES - SES_ADDED_HEADER_ALLOWANCE);
      }
    }
  });

  it('keeps the encoded budget itself under the Gmail clip with room for the envelope', () => {
    expect(DIGEST_ENCODED_BODY_SOFT_MAX).toBeLessThan(GMAIL_CLIP_BYTES - SES_ADDED_HEADER_ALLOWANCE);
  });

  it('includes the last job that fits under the soft cap and drops the first that does not', () => {
    // Titles longer than the 90-char preheader budget all clip to the same
    // preview, so the ONLY thing that varies with the title length is the job
    // block itself, and inclusion is therefore monotonic in it — which is what
    // makes the binary search below valid.
    const render = (titleLength: number) => renderEmployerDigest(model({
      jobs: [{ ...model().jobs[0], title: 'T'.repeat(titleLength) }],
    }));
    let fitting = 100;
    let overflowing = 65_000;
    while (overflowing - fitting > 1) {
      const mid = Math.floor((fitting + overflowing) / 2);
      if (render(mid).bodyHtml.includes('<h2')) fitting = mid;
      else overflowing = mid;
    }
    expect(overflowing).toBe(fitting + 1);

    const fits = render(fitting);
    expect(fits.bodyHtml).toContain('<h2');
    expect(Buffer.byteLength(fits.bodyHtml, 'utf8')).toBeLessThanOrEqual(DIGEST_BODY_HTML_SOFT_MAX);
    expect(fits.bodyHtml).not.toContain('not shown');

    const over = render(overflowing);
    expect(over.bodyHtml).not.toContain('<h2');
    expect(over.bodyHtml).toContain('Some job postings are not shown in this email.');
    expect(over.bodyText).toContain('Some job postings are not shown in this email.');
    expect(over.bodyHtml).toContain(DASHBOARD_URL);
    expect(over.bodyText).toContain(UNSUBSCRIBE_URL);
    expect(Buffer.byteLength(over.bodyHtml, 'utf8')).toBeLessThanOrEqual(DIGEST_BODY_HTML_SOFT_MAX);
  });
});
