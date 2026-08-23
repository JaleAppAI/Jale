/**
 * Pure rendering for the employer daily-digest email. No DB, no AWS, no env
 * reads — the producer assembles a typed model and this module turns it into
 * (subject, bodyText, bodyHtml).
 *
 * Every constraint enforced here comes from email_outbox (migration 037):
 *   subject   length BETWEEN 1 AND 200
 *   body_text length BETWEEN 1 AND 100000
 *   body_html NULL OR length BETWEEN 1 AND 200000
 * A violation is a 23514 at INSERT time, which would abort the producer's
 * per-employer transaction. So the limits are enforced BEFORE the insert:
 * job blocks are accumulated only while they fit, and a "some postings are
 * not shown" line plus the dashboard link covers whatever was dropped.
 *
 * Job titles, candidate names and locations are employer/worker-supplied free
 * text and are HTML-escaped on every interpolation into bodyHtml. bodyText is
 * not HTML and deliberately carries the raw characters.
 *
 * Bilingual en/es, matching the platform contract and
 * employer_digest_settings.language. Spanish copy is formal (usted).
 */

export const DIGEST_SUBJECT_MAX = 200;
export const DIGEST_BODY_TEXT_MAX = 100000;
export const DIGEST_BODY_HTML_MAX = 200000;
/** Candidates rendered per job before the "+N more" line takes over. */
export const DIGEST_MAX_CANDIDATES_PER_JOB = 10;

export type DigestLanguage = 'en' | 'es';
export type DigestScoreBand = 'strong' | 'good' | 'fair';

export interface DigestCandidate {
  displayName: string;
  matchScore: number;
  scoreBand: DigestScoreBand;
  location: string | null;
}

export interface DigestJob {
  jobId: string;
  title: string;
  /** Absolute employer-side job URL, built by the producer from PUBLIC_SITE_BASE_URL. */
  jobUrl: string;
  /** Total NEW applicants for this job in the digest window (may exceed candidates.length). */
  newApplicantCount: number;
  /** Already capped to DIGEST_MAX_CANDIDATES_PER_JOB, ranked best → lowest. */
  candidates: DigestCandidate[];
}

export interface EmployerDigestModel {
  language: DigestLanguage;
  jobs: DigestJob[];
  dashboardUrl: string;
  unsubscribeUrl: string;
}

export interface RenderedDigest {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Copy {
  htmlLang: string;
  greeting: string;
  subject(count: number): string;
  intro(applicants: number, jobs: number): string;
  jobHeading(count: number): string;
  band(band: DigestScoreBand): string;
  matchLabel: string;
  moreLine(count: number): string;
  reviewJob: string;
  dashboard: string;
  truncated: string;
  unsubscribeWhy: string;
  unsubscribeHow: string;
  nothingNew: string;
}

const EN: Copy = {
  htmlLang: 'en',
  greeting: 'Hello,',
  subject: (count) => (count === 1 ? '1 new applicant — Jale' : `${count} new applicants — Jale`),
  intro: (applicants, jobs) =>
    `You have ${applicants} ${applicants === 1 ? 'new applicant' : 'new applicants'} on `
    + `${jobs} ${jobs === 1 ? 'active job posting' : 'active job postings'} since your last digest.`,
  jobHeading: (count) => (count === 1 ? '1 new applicant' : `${count} new applicants`),
  band: (band) => ({ strong: 'strong', good: 'good', fair: 'fair' })[band],
  matchLabel: 'match',
  moreLine: (count) => `+ ${count} more new ${count === 1 ? 'applicant' : 'applicants'}`,
  reviewJob: 'Review this job',
  dashboard: 'View your dashboard',
  truncated: 'Some job postings are not shown in this email. Open your dashboard for the full list.',
  unsubscribeWhy: 'You are receiving this because the daily digest is on for your Jale employer account.',
  unsubscribeHow: 'To stop these emails, open',
  nothingNew: 'No new applicants to report.',
};

const ES: Copy = {
  htmlLang: 'es',
  greeting: 'Hola:',
  subject: (count) => (count === 1 ? '1 nuevo postulante — Jale' : `${count} nuevos postulantes — Jale`),
  intro: (applicants, jobs) =>
    `Tiene ${applicants} ${applicants === 1 ? 'postulante nuevo' : 'postulantes nuevos'} en `
    + `${jobs} ${jobs === 1 ? 'puesto activo' : 'puestos activos'} desde su resumen anterior.`,
  jobHeading: (count) => (count === 1 ? '1 postulante nuevo' : `${count} postulantes nuevos`),
  band: (band) => ({ strong: 'excelente', good: 'bueno', fair: 'aceptable' })[band],
  matchLabel: 'coincidencia',
  moreLine: (count) => `+ ${count} más ${count === 1 ? 'postulante nuevo' : 'postulantes nuevos'}`,
  reviewJob: 'Revise este puesto',
  dashboard: 'Vea su panel',
  truncated: 'Algunos puestos no se muestran en este correo. Abra su panel para ver la lista completa.',
  unsubscribeWhy: 'Está recibiendo este correo porque el resumen diario está activado en su cuenta de empleador de Jale.',
  unsubscribeHow: 'Para dejar de recibirlo, abra',
  nothingNew: 'No hay postulantes nuevos por informar.',
};

function copyFor(language: DigestLanguage): Copy {
  return language === 'es' ? ES : EN;
}

function candidateLine(copy: Copy, index: number, candidate: DigestCandidate): string {
  const parts = [
    `${index + 1}. ${candidate.displayName}`,
    `${copy.matchLabel} ${candidate.matchScore} (${copy.band(candidate.scoreBand)})`,
  ];
  if (candidate.location) parts.push(candidate.location);
  return `  ${parts.join(' — ')}`;
}

function jobBlockText(copy: Copy, job: DigestJob): string {
  const lines: string[] = [`${job.title} — ${copy.jobHeading(job.newApplicantCount)}`];
  job.candidates.forEach((candidate, index) => lines.push(candidateLine(copy, index, candidate)));
  const remaining = job.newApplicantCount - job.candidates.length;
  if (remaining > 0) lines.push(`  ${copy.moreLine(remaining)} — ${job.jobUrl}`);
  lines.push(`  ${copy.reviewJob}: ${job.jobUrl}`);
  return `${lines.join('\n')}\n\n`;
}

function jobBlockHtml(copy: Copy, job: DigestJob): string {
  const rows = job.candidates.map((candidate, index) => {
    const bits = [
      `${index + 1}. ${escapeHtml(candidate.displayName)}`,
      `${escapeHtml(copy.matchLabel)} ${candidate.matchScore} (${escapeHtml(copy.band(candidate.scoreBand))})`,
    ];
    if (candidate.location) bits.push(escapeHtml(candidate.location));
    return `<li>${bits.join(' — ')}</li>`;
  }).join('');
  const remaining = job.newApplicantCount - job.candidates.length;
  const moreHtml = remaining > 0
    ? `<p><a href="${escapeHtml(job.jobUrl)}">${escapeHtml(copy.moreLine(remaining))}</a></p>`
    : '';
  return `<h2>${escapeHtml(job.title)} — ${escapeHtml(copy.jobHeading(job.newApplicantCount))}</h2>`
    + `<ol>${rows}</ol>`
    + moreHtml
    + `<p><a href="${escapeHtml(job.jobUrl)}">${escapeHtml(copy.reviewJob)}</a></p>`;
}

function headerText(copy: Copy, model: EmployerDigestModel, totalNew: number): string {
  const intro = model.jobs.length === 0 ? copy.nothingNew : copy.intro(totalNew, model.jobs.length);
  return `${copy.greeting}\n\n${intro}\n\n`;
}

function headerHtml(copy: Copy, model: EmployerDigestModel, totalNew: number): string {
  const intro = model.jobs.length === 0 ? copy.nothingNew : copy.intro(totalNew, model.jobs.length);
  return `<!DOCTYPE html><html lang="${copy.htmlLang}"><body>`
    + `<p>${escapeHtml(copy.greeting)}</p><p>${escapeHtml(intro)}</p>`;
}

function footerText(copy: Copy, model: EmployerDigestModel, truncated: boolean): string {
  const lines: string[] = [];
  if (truncated) lines.push(copy.truncated, '');
  lines.push(`${copy.dashboard}: ${model.dashboardUrl}`, '');
  lines.push(copy.unsubscribeWhy);
  lines.push(`${copy.unsubscribeHow}: ${model.unsubscribeUrl}`);
  return `${lines.join('\n')}\n`;
}

function footerHtml(copy: Copy, model: EmployerDigestModel, truncated: boolean): string {
  const truncatedHtml = truncated ? `<p>${escapeHtml(copy.truncated)}</p>` : '';
  return truncatedHtml
    + `<p><a href="${escapeHtml(model.dashboardUrl)}">${escapeHtml(copy.dashboard)}</a></p>`
    + `<hr /><p>${escapeHtml(copy.unsubscribeWhy)}</p>`
    + `<p>${escapeHtml(copy.unsubscribeHow)}: `
    + `<a href="${escapeHtml(model.unsubscribeUrl)}">${escapeHtml(model.unsubscribeUrl)}</a></p>`
    + '</body></html>';
}

/**
 * Renders subject + both bodies. Job blocks are accumulated only while they
 * fit inside the email_outbox limits, reserving room for the LONGER of the two
 * possible footers first, so appending the truncation notice can never push
 * the finished body back over the cap.
 */
export function renderEmployerDigest(model: EmployerDigestModel): RenderedDigest {
  const copy = copyFor(model.language);
  const totalNew = model.jobs.reduce((sum, job) => sum + job.newApplicantCount, 0);

  const head = { text: headerText(copy, model, totalNew), html: headerHtml(copy, model, totalNew) };
  const footers = {
    plainText: footerText(copy, model, false),
    truncatedText: footerText(copy, model, true),
    plainHtml: footerHtml(copy, model, false),
    truncatedHtml: footerHtml(copy, model, true),
  };
  const textReserve = Math.max(footers.plainText.length, footers.truncatedText.length);
  const htmlReserve = Math.max(footers.plainHtml.length, footers.truncatedHtml.length);

  let usedText = head.text.length + textReserve;
  let usedHtml = head.html.length + htmlReserve;
  const includedText: string[] = [];
  const includedHtml: string[] = [];

  for (const job of model.jobs) {
    const blockText = jobBlockText(copy, job);
    const blockHtml = jobBlockHtml(copy, job);
    if (usedText + blockText.length > DIGEST_BODY_TEXT_MAX
      || usedHtml + blockHtml.length > DIGEST_BODY_HTML_MAX) {
      break;
    }
    usedText += blockText.length;
    usedHtml += blockHtml.length;
    includedText.push(blockText);
    includedHtml.push(blockHtml);
  }

  const truncated = includedText.length < model.jobs.length;
  const bodyText = head.text + includedText.join('')
    + (truncated ? footers.truncatedText : footers.plainText);
  const bodyHtml = head.html + includedHtml.join('')
    + (truncated ? footers.truncatedHtml : footers.plainHtml);

  return {
    subject: copy.subject(totalNew).slice(0, DIGEST_SUBJECT_MAX),
    bodyText,
    bodyHtml,
  };
}
