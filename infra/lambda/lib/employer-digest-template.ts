/**
 * Pure rendering for the employer daily-digest email. No DB, no AWS, no env
 * reads — the producer assembles a typed model and this module turns it into
 * (subject, bodyText, bodyHtml).
 *
 * The HTML body is the branded shell from ./email-shell with a digest-specific
 * card inside it; this module owns the card and the footer fragment and never
 * emits a document skeleton of its own. The PLAIN-TEXT body is deliberately
 * unchanged by that restyle — it is byte-identical to the pre-shell renderer
 * apart from the first-digest intro variant — because it is the part that
 * lands in a text-only client and had no styling to gain.
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

import { base64EncodedLength } from './email-mime';
import {
  clipPreheader,
  emailButtonHtml,
  emailDividerHtml,
  emailLegalLinksHtml,
  escapeHtml,
  renderEmailShell,
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
} from './email-shell';

export const DIGEST_SUBJECT_MAX = 200;
export const DIGEST_BODY_TEXT_MAX = 100000;
export const DIGEST_BODY_HTML_MAX = 200000;
/**
 * The INBOX limit, and the budget the job loop actually spends against.
 * DIGEST_BODY_HTML_MAX above is the database CHECK; this pair is about Gmail,
 * which clips a message at roughly 102 kB of the transfer-ENCODED bytes and
 * hides everything after the cut — the unsubscribe footer included — behind a
 * "[Message clipped]" link.
 *
 * ── Why this is measured in BYTES and not characters ──────────────
 * Until sprint 22 R3-E the budget was `bodyHtml.length` against 70,000
 * CHARACTERS. That was wrong in exactly the case the product is built for: a
 * Spanish digest. Job titles, worker names and city names are accented free
 * text, every accented character is two UTF-8 bytes, and the clip is on bytes.
 * Measured against the real MIME builder, a six-job Spanish digest at the old
 * cap encoded to 115,874 bytes — clipped, with the unsubscribe footer on the
 * wrong side of the cut. The identical English digest encoded to 98,428 and
 * looked fine, which is why the character budget survived review.
 *
 * ── What the two numbers mean ─────────────────────────────────────
 * DIGEST_ENCODED_BODY_SOFT_MAX is the real constraint: the maximum size of the
 * two base64 body parts AFTER encoding, already net of the message envelope.
 * 102,400 minus ~1.4 kB of our own headers and boundaries, minus a reserve for
 * the headers SES adds downstream (Message-ID, DKIM-Signature, Feedback-ID),
 * leaves this. DIGEST_BODY_HTML_SOFT_MAX is a secondary rail on the HTML part
 * alone, in UTF-8 bytes, that binds only if a digest ever has a near-empty
 * text body.
 *
 * At these values a realistic ASCII digest still fits SIX ten-candidate jobs
 * (unchanged), and the accented Spanish equivalent fits FOUR. The tripwire in
 * employer-digest-template.test.ts asserts both against the real builder.
 */
export const DIGEST_ENCODED_BODY_SOFT_MAX = 96_000;
export const DIGEST_BODY_HTML_SOFT_MAX = 65_000;
/** Candidates rendered per job before the "+N more" line takes over. */
export const DIGEST_MAX_CANDIDATES_PER_JOB = 10;

export type DigestLanguage = 'en' | 'es';
export type DigestScoreBand = 'strong' | 'good' | 'fair';

const C = EMAIL_COLORS;
const FONT = EMAIL_FONT_STACK;

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
  /** Absolute employer profile URL; the HTML footer's "Notification settings" link. */
  settingsUrl: string;
  /**
   * True on the very first digest an employer receives, where "since your last
   * digest" would name a digest that never happened. The producer sets it from
   * the SAME null watermark the candidate filter uses, so the sentence always
   * describes the window that was actually queried.
   */
  firstDigest?: boolean;
}

export interface RenderedDigest {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

interface Copy {
  greeting: string;
  subject(count: number): string;
  intro(applicants: number, jobs: number, first: boolean): string;
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
  // ── HTML only ─────────────────────────────────────────────────────────────
  /** Uppercase kicker in the shell's navy header band. */
  eyebrow: string;
  /** Per-job count in the off-screen inbox preview; shorter than jobHeading. */
  previewCount(count: number): string;
  /** Spelled-out band next to the coloured dot, where `band` is bare. */
  bandLabel(band: DigestScoreBand): string;
  settingsLink: string;
  unsubscribeLink: string;
}

const EN: Copy = {
  greeting: 'Hello,',
  subject: (count) => {
    if (count === 0) return 'No new applicants — Jale';
    return count === 1 ? '1 new applicant — Jale' : `${count} new applicants — Jale`;
  },
  intro: (applicants, jobs, first) =>
    `You have ${applicants} ${applicants === 1 ? 'new applicant' : 'new applicants'} on `
    + `${jobs} ${jobs === 1 ? 'active job posting' : 'active job postings'} `
    + (first ? 'since you turned on the daily digest.' : 'since your last digest.'),
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
  eyebrow: 'Daily digest',
  previewCount: (count) => `${count} new`,
  bandLabel: (band) => ({ strong: 'strong match', good: 'good match', fair: 'fair match' })[band],
  settingsLink: 'Notification settings',
  unsubscribeLink: 'Turn off the daily digest',
};

const ES: Copy = {
  greeting: 'Hola:',
  subject: (count) => {
    if (count === 0) return 'Sin postulantes nuevos — Jale';
    return count === 1 ? '1 nuevo postulante — Jale' : `${count} nuevos postulantes — Jale`;
  },
  intro: (applicants, jobs, first) =>
    `Tiene ${applicants} ${applicants === 1 ? 'postulante nuevo' : 'postulantes nuevos'} en `
    + `${jobs} ${jobs === 1 ? 'puesto activo' : 'puestos activos'} `
    + (first ? 'desde que activó el resumen diario.' : 'desde su resumen anterior.'),
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
  eyebrow: 'Resumen diario',
  previewCount: (count) => `${count} ${count === 1 ? 'nuevo' : 'nuevos'}`,
  bandLabel: (band) => ({
    strong: 'coincidencia excelente',
    good: 'coincidencia buena',
    fair: 'coincidencia aceptable',
  })[band],
  settingsLink: 'Configuración de notificaciones',
  unsubscribeLink: 'Desactivar el resumen diario',
};

function copyFor(language: DigestLanguage): Copy {
  return language === 'es' ? ES : EN;
}

const BAND_DOT: Record<DigestScoreBand, string> = {
  strong: C.dotStrong,
  good: C.dotGood,
  fair: C.dotFair,
};

/** The intro sentence, or the quiet-day line when the model carries no jobs. */
function introSentence(copy: Copy, model: EmployerDigestModel, totalNew: number): string {
  return model.jobs.length === 0
    ? copy.nothingNew
    : copy.intro(totalNew, model.jobs.length, model.firstDigest === true);
}

// ── Plain text ──────────────────────────────────────────────────────────────
// Unchanged from the pre-shell renderer, intro variant aside. Do not restyle.

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

function headerText(copy: Copy, model: EmployerDigestModel, totalNew: number): string {
  return `${copy.greeting}\n\n${introSentence(copy, model, totalNew)}\n\n`;
}

function footerText(copy: Copy, model: EmployerDigestModel, truncated: boolean): string {
  const lines: string[] = [];
  if (truncated) lines.push(copy.truncated, '');
  lines.push(`${copy.dashboard}: ${model.dashboardUrl}`, '');
  lines.push(copy.unsubscribeWhy);
  lines.push(`${copy.unsubscribeHow}: ${model.unsubscribeUrl}`);
  return `${lines.join('\n')}\n`;
}

// ── HTML card ───────────────────────────────────────────────────────────────
// Presentation tables and inline styles only; see the email-shell header for
// why. Colours come from EMAIL_COLORS so no hex is retyped by hand.

/**
 * The count in a fixed 72px gutter with the intro sentence beside it. The
 * quiet-day variant drops the gutter: a giant "0" is not a headline.
 */
function introHtml(copy: Copy, model: EmployerDigestModel, totalNew: number): string {
  const intro = escapeHtml(introSentence(copy, model, totalNew));
  if (model.jobs.length === 0) {
    return `<p style="margin:0;font-size:15px;line-height:24px;color:${C.ink};">${intro}</p>`;
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + `<td valign="top" style="width:72px;padding:0 16px 0 0;font-family:${FONT};">`
    + '<div style="font-size:44px;line-height:48px;font-weight:800;letter-spacing:-0.03em;'
    + `color:${C.ink};font-variant-numeric:tabular-nums;">${totalNew}</div></td>`
    + `<td valign="middle" style="font-size:15px;line-height:24px;color:${C.ink};`
    + `font-family:${FONT};">${intro}</td>`
    + '</tr></table>';
}

/** One candidate: name and location on the left, score and band dot on the right. */
function candidateRowHtml(copy: Copy, candidate: DigestCandidate): string {
  const rule = `border-top:1px solid ${C.divider};`;
  // An empty <div> would still draw its line-height, so a candidate with no
  // location gets no element at all rather than a blank second line.
  const location = candidate.location
    ? `<div style="font-size:13px;line-height:18px;color:${C.ink2};">`
      + `${escapeHtml(candidate.location)}</div>`
    : '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + `<td valign="top" style="${rule}padding:12px 0;font-family:${FONT};">`
    + `<div style="font-size:15px;line-height:22px;font-weight:600;color:${C.ink};">`
    + `${escapeHtml(candidate.displayName)}</div>${location}</td>`
    + `<td align="right" valign="top" style="${rule}padding:12px 0 12px 12px;`
    + `white-space:nowrap;font-family:${FONT};">`
    + `<div style="font-size:16px;line-height:22px;font-weight:800;color:${C.ink};`
    + `font-variant-numeric:tabular-nums;">${candidate.matchScore}</div>`
    + `<div style="font-size:12px;line-height:18px;font-weight:600;color:${C.ink2};">`
    + `<span style="color:${BAND_DOT[candidate.scoreBand]};">●</span> `
    + `${escapeHtml(copy.bandLabel(candidate.scoreBand))}</div></td>`
    + '</tr></table>';
}

function jobBlockHtml(copy: Copy, job: DigestJob): string {
  const jobUrl = escapeHtml(job.jobUrl);
  const remaining = job.newApplicantCount - job.candidates.length;
  const moreHtml = remaining > 0
    ? '<p style="margin:8px 0 0;font-size:13px;line-height:20px;">'
      + `<a href="${jobUrl}" style="color:${C.link};font-weight:600;">`
      + `${escapeHtml(copy.moreLine(remaining))}</a></p>`
    : '';
  return emailDividerHtml(24)
    + '<div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;'
    + `text-transform:uppercase;color:${C.link};">`
    + `${escapeHtml(copy.jobHeading(job.newApplicantCount))}</div>`
    + '<h2 style="margin:4px 0 8px;font-size:20px;line-height:26px;font-weight:700;'
    + 'letter-spacing:-0.02em;">'
    + `<a href="${jobUrl}" style="color:${C.ink};text-decoration:none;">`
    + `${escapeHtml(job.title)}</a></h2>`
    + job.candidates.map((candidate) => candidateRowHtml(copy, candidate)).join('')
    + moreHtml
    + emailButtonHtml(job.jobUrl, copy.reviewJob, { fullWidth: true });
}

/** Closes the card: the truncation notice when jobs were dropped, then the dashboard link. */
function cardTailHtml(copy: Copy, model: EmployerDigestModel, truncated: boolean): string {
  const notice = truncated
    ? `<div style="margin-top:24px;background:${C.noticeBg};border-radius:10px;padding:12px 16px;`
      + `font-size:13px;line-height:20px;color:${C.link};">${escapeHtml(copy.truncated)}</div>`
    : '';
  return notice
    + emailDividerHtml(24)
    + '<p style="margin:0;font-size:15px;line-height:24px;">'
    + `<a href="${escapeHtml(model.dashboardUrl)}" style="color:${C.link};font-weight:600;">`
    + `${escapeHtml(copy.dashboard)} →</a></p>`;
}

/**
 * Fine print under the card. Unlike the plain-text footer this never varies
 * with truncation — the notice lives in the card — so it is a constant the
 * byte budget can fold into the shell measurement.
 */
function shellFooterHtml(copy: Copy, model: EmployerDigestModel): string {
  return `<p style="margin:0 0 8px;">${escapeHtml(copy.unsubscribeWhy)}</p>`
    + '<p style="margin:0 0 8px;">'
    + `<a href="${escapeHtml(model.settingsUrl)}" style="color:${C.link};font-weight:600;">`
    + `${escapeHtml(copy.settingsLink)}</a> &nbsp;·&nbsp; `
    + `<a href="${escapeHtml(model.unsubscribeUrl)}" style="color:${C.link};font-weight:600;">`
    + `${escapeHtml(copy.unsubscribeLink)}</a></p>`
    + `<p style="margin:0;">${emailLegalLinksHtml(model.language)}</p>`;
}

/**
 * Off-screen inbox preview. Built from EVERY job, not just the ones that
 * survive the byte budget: it is what the employer reads in the inbox list
 * before deciding to open, so it should describe the whole day.
 */
function preheaderFor(copy: Copy, model: EmployerDigestModel): string {
  if (model.jobs.length === 0) return copy.nothingNew;
  return clipPreheader(
    model.jobs.map((job) => `${job.title} · ${copy.previewCount(job.newApplicantCount)}`).join(' · '),
  );
}

/**
 * Renders subject + both bodies. Job blocks are accumulated only while they
 * fit inside the budget, reserving room for the LONGER of the two possible
 * tails/footers first, so appending the truncation notice can never push the
 * finished body back over the cap. Both bodies advance in lockstep — a job is
 * either in the email twice or in it not at all.
 */
export function renderEmployerDigest(model: EmployerDigestModel): RenderedDigest {
  const copy = copyFor(model.language);
  const totalNew = model.jobs.reduce((sum, job) => sum + job.newApplicantCount, 0);
  const subject = copy.subject(totalNew).slice(0, DIGEST_SUBJECT_MAX);

  const footerHtml = shellFooterHtml(copy, model);
  // Everything outside the card is fixed before the budget loop runs, which is
  // what lets an empty-card render stand in for the shell's own cost.
  const preheader = preheaderFor(copy, model);
  const shell = (cardHtml: string): string => renderEmailShell({
    lang: model.language,
    title: subject,
    preheader,
    eyebrow: copy.eyebrow,
    cardHtml,
    footerHtml,
  });

  const headText = headerText(copy, model, totalNew);
  const card = {
    intro: introHtml(copy, model, totalNew),
    tailPlain: cardTailHtml(copy, model, false),
    tailTruncated: cardTailHtml(copy, model, true),
  };
  const footers = {
    plainText: footerText(copy, model, false),
    truncatedText: footerText(copy, model, true),
  };

  // renderEmailShell inserts both fragments verbatim and exactly once, so an
  // empty-card render measures every byte the shell and footer contribute and
  // the finished length is that plus the card's.
  const shellFixed = Buffer.byteLength(shell(''), 'utf8');
  // Bytes for the two byte budgets, characters for DIGEST_BODY_TEXT_MAX --
  // which mirrors email_outbox's CHECK, and PostgreSQL's length() counts
  // characters, not bytes.
  let usedTextChars = headText.length
    + Math.max(footers.plainText.length, footers.truncatedText.length);
  let usedTextBytes = Buffer.byteLength(headText, 'utf8')
    + Math.max(
      Buffer.byteLength(footers.plainText, 'utf8'),
      Buffer.byteLength(footers.truncatedText, 'utf8'),
    );
  let usedHtmlBytes = shellFixed
    + Buffer.byteLength(card.intro, 'utf8')
    + Math.max(
      Buffer.byteLength(card.tailPlain, 'utf8'),
      Buffer.byteLength(card.tailTruncated, 'utf8'),
    );

  const includedText: string[] = [];
  const includedHtml: string[] = [];

  for (const job of model.jobs) {
    const blockText = jobBlockText(copy, job);
    const blockHtml = jobBlockHtml(copy, job);
    const nextTextBytes = usedTextBytes + Buffer.byteLength(blockText, 'utf8');
    const nextHtmlBytes = usedHtmlBytes + Buffer.byteLength(blockHtml, 'utf8');
    const nextEncoded = base64EncodedLength(nextTextBytes) + base64EncodedLength(nextHtmlBytes);
    if (nextEncoded > DIGEST_ENCODED_BODY_SOFT_MAX
      || nextHtmlBytes > DIGEST_BODY_HTML_SOFT_MAX
      || usedTextChars + blockText.length > DIGEST_BODY_TEXT_MAX) {
      break;
    }
    usedTextChars += blockText.length;
    usedTextBytes = nextTextBytes;
    usedHtmlBytes = nextHtmlBytes;
    includedText.push(blockText);
    includedHtml.push(blockHtml);
  }

  const truncated = includedText.length < model.jobs.length;
  const bodyText = headText + includedText.join('')
    + (truncated ? footers.truncatedText : footers.plainText);
  const bodyHtml = shell(
    card.intro + includedHtml.join('') + (truncated ? card.tailTruncated : card.tailPlain),
  );

  return { subject, bodyText, bodyHtml };
}
