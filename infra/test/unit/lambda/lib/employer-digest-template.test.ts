import {
  DIGEST_BODY_HTML_MAX,
  DIGEST_BODY_TEXT_MAX,
  DIGEST_SUBJECT_MAX,
  renderEmployerDigest,
  type EmployerDigestModel,
} from '../../../../lambda/lib/employer-digest-template';

const DASHBOARD_URL = 'https://jaleapp.ai/en/employer/dashboard';
const UNSUBSCRIBE_URL = 'https://jaleapp.ai/en/digest-unsubscribe?token=abc.def';

function model(overrides: Partial<EmployerDigestModel> = {}): EmployerDigestModel {
  return {
    language: 'en',
    dashboardUrl: DASHBOARD_URL,
    unsubscribeUrl: UNSUBSCRIBE_URL,
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
    const { bodyText, bodyHtml } = renderEmployerDigest(model({ jobs }));

    expect(bodyText.length).toBeGreaterThan(0);
    expect(bodyText.length).toBeLessThanOrEqual(DIGEST_BODY_TEXT_MAX);
    expect(bodyHtml.length).toBeGreaterThan(0);
    expect(bodyHtml.length).toBeLessThanOrEqual(DIGEST_BODY_HTML_MAX);
    // The reader must be told the list was cut, and where the rest lives.
    expect(bodyText).toMatch(/dashboard/i);
    expect(bodyHtml).toContain(DASHBOARD_URL);
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
});
