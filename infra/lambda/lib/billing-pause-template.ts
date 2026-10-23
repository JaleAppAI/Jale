/**
 * Pure rendering for the billing-pause notice: the email a company's owner
 * receives when a subscription change drops the company's limits below what
 * it uses, and `billing_enforce_org_limits` (migration 128) pauses the excess
 * jobs and suspends the foremen over the seat limit.
 *
 * No DB, no AWS, no env reads — the billing processor hands over a typed model
 * and gets back (subject, bodyText, bodyHtml). The HTML is the shared branded
 * shell (lib/email-shell.ts); only the card differs from the other Jale
 * transactional emails.
 *
 * Limits come from email_outbox (migration 037): subject 1..200, body_text
 * 1..100000, body_html NULL or 1..200000. A violation is a 23514 at INSERT
 * time, which aborts the processor's transaction and hands the Stripe event
 * back to SQS for redelivery — an unbounded title list would therefore loop
 * forever. So every title is clipped to BILLING_PAUSE_MAX_TITLE_CHARS (jobs.title
 * is unbounded TEXT — shrinking the LIST can never rescue one pathological
 * title), the list is capped at BILLING_PAUSE_MAX_TITLES, and the render
 * is re-run against a smaller list on the (unreachable in practice) chance
 * that 50 titles still overflow. Suspended members are email addresses
 * (at most a handful under any seat limit), clipped and capped the same way:
 * at most BILLING_PAUSE_MAX_MEMBERS listed, then a "+N more" line, and the
 * preheader counts every suspended member, listed or not. 128 names a member
 * without an email address BILLING_PAUSE_NO_EMAIL_PLACEHOLDER; the English
 * block shows it as is and the Spanish block shows its Spanish form.
 *
 * The members line says what Phase 2 enforces: a suspended foreman can still
 * sign in, but the API refuses their company actions (the Cognito disable is
 * Phase 3), so the copy must not claim they cannot sign in.
 *
 * Job titles and addresses are employer-supplied free text: escaped on every
 * interpolation into bodyHtml, raw in bodyText, which is not HTML.
 *
 * Bilingual in one body (English first, then Spanish) because the processor
 * has no language preference for the employer at this point in the flow.
 * Spanish copy is formal (usted) throughout.
 */
import {
  EMAIL_COLORS,
  clipPreheader,
  emailButtonHtml,
  emailDividerHtml,
  emailLegalLinksHtml,
  escapeHtml,
  renderEmailShell,
} from './email-shell';

export const BILLING_PAUSE_SUBJECT = 'Job postings paused · Empleos pausados';
/** The subject when a downgrade suspended team members but paused no job. */
export const BILLING_SEATS_SUBJECT = 'Team members suspended · Miembros del equipo suspendidos';
/** Titles listed per language block before the "+N more" line takes over. */
export const BILLING_PAUSE_MAX_TITLES = 50;
/** Per-title clip; longer titles end in '…'. Bounds the body per title, not just per list. */
export const BILLING_PAUSE_MAX_TITLE_CHARS = 200;
/** Members listed per language block; a seat limit is a handful, this only bounds bad input. */
export const BILLING_PAUSE_MAX_MEMBERS = 50;
/** Per-address clip (an email address is at most 320 characters). */
const BILLING_PAUSE_MAX_MEMBER_CHARS = 320;
/** What billing_enforce_org_limits (128) returns for a suspended member with no email address. */
export const BILLING_PAUSE_NO_EMAIL_PLACEHOLDER = '(no email on file)';
/** The placeholder as the Spanish block shows it. */
const ES_NO_EMAIL_PLACEHOLDER = '(sin correo registrado)';
/** Well under the 200000 body_html ceiling: inboxes clip long HTML anyway. */
export const BILLING_PAUSE_BODY_HTML_MAX = 70000;
export const BILLING_PAUSE_BODY_TEXT_MAX = 100000;

const EYEBROW = 'Billing · Facturación';

const EN_INTRO =
  'Your subscription changed and these job postings were paused to match your active-job limit:';
const ES_INTRO =
  'Su suscripción cambió y estas ofertas de trabajo se pausaron para respetar su '
  + 'límite de empleos activos:';
const EN_MEMBERS_INTRO =
  "Your plan now has fewer foreman seats, so these team members were suspended and can't use your "
  + "company's account until you change your plan:";
const ES_MEMBERS_INTRO =
  'Su plan ahora tiene menos puestos de capataz, por lo que estos miembros del equipo fueron suspendidos '
  + 'y no pueden usar la cuenta de su empresa hasta que cambie su plan:';
const EN_BUTTON = 'Manage billing';
const ES_BUTTON = 'Administrar facturación';
const EN_WHY = 'You are receiving this because your Jale employer account has a subscription.';
const ES_WHY =
  'Está recibiendo este correo porque su cuenta de empleador de Jale tiene una suscripción.';

const enMore = (count: number): string =>
  `+ ${count} more job posting${count === 1 ? '' : 's'}`;
const esMore = (count: number): string =>
  `+ ${count} empleo${count === 1 ? '' : 's'} más`;
const preheaderText = (count: number): string =>
  count === 1
    ? '1 job posting paused · 1 empleo pausado'
    : `${count} job postings paused · ${count} empleos pausados`;
const enMoreMembers = (count: number): string =>
  `+ ${count} more team member${count === 1 ? '' : 's'}`;
const esMoreMembers = (count: number): string =>
  `+ ${count} miembro${count === 1 ? '' : 's'} más`;
const esMember = (member: string): string =>
  member === BILLING_PAUSE_NO_EMAIL_PLACEHOLDER ? ES_NO_EMAIL_PLACEHOLDER : member;
const membersPreheaderText = (count: number): string =>
  count === 1
    ? '1 team member suspended · 1 miembro suspendido'
    : `${count} team members suspended · ${count} miembros suspendidos`;

const C = EMAIL_COLORS;

const clipTitle = (title: string): string =>
  title.length > BILLING_PAUSE_MAX_TITLE_CHARS
    ? `${title.slice(0, BILLING_PAUSE_MAX_TITLE_CHARS - 1)}…`
    : title;
const clipMember = (member: string): string =>
  member.length > BILLING_PAUSE_MAX_MEMBER_CHARS
    ? `${member.slice(0, BILLING_PAUSE_MAX_MEMBER_CHARS - 1)}…`
    : member;

export interface BillingPauseModel {
  /** Every job the enforcement function paused, in the order it returned them. */
  pausedTitles: string[];
  /** The suspended members' email addresses, most recently joined first. Absent or empty: no members block. */
  suspendedMembers?: string[];
  /** Absolute employer-side billing URLs, built by the processor from ALLOWED_ORIGIN. */
  englishBillingUrl: string;
  spanishBillingUrl: string;
}

export interface RenderedBillingPause {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

interface MembersText {
  intro: string;
  list: string[];
  more: string | null;
}

function textBlock(intro: string, titles: string[], more: string | null, members: MembersText | null, link: string): string[] {
  const out: string[] = [];
  if (titles.length > 0) {
    const bullets = titles.map((title) => `- ${title}`);
    if (more) bullets.push(more);
    out.push(intro, bullets.join('\n'));
  }
  if (members) {
    const bullets = members.list.map((member) => `- ${member}`);
    if (members.more) bullets.push(members.more);
    out.push(members.intro, bullets.join('\n'));
  }
  out.push(link);
  return out;
}

function buildBodyText(
  model: BillingPauseModel,
  shown: string[],
  hidden: number,
  members: string[],
  hiddenMembers: number,
): string {
  return [
    ...textBlock(
      EN_INTRO,
      shown,
      hidden > 0 ? enMore(hidden) : null,
      members.length > 0
        ? { intro: EN_MEMBERS_INTRO, list: members, more: hiddenMembers > 0 ? enMoreMembers(hiddenMembers) : null }
        : null,
      `${EN_BUTTON}: ${model.englishBillingUrl}`,
    ),
    '',
    ...textBlock(
      ES_INTRO,
      shown,
      hidden > 0 ? esMore(hidden) : null,
      members.length > 0
        ? { intro: ES_MEMBERS_INTRO, list: members.map(esMember), more: hiddenMembers > 0 ? esMoreMembers(hiddenMembers) : null }
        : null,
      `${ES_BUTTON}: ${model.spanishBillingUrl}`,
    ),
    '',
    EN_WHY,
    ES_WHY,
  ].join('\n\n');
}

function rowsHtml(items: string[]): string {
  return items
    .map(
      (item) =>
        `<div style="padding:8px 0;border-top:1px solid ${C.divider};font-size:15px;`
        + `line-height:22px;font-weight:600;color:${C.ink};">${escapeHtml(item)}</div>`,
    )
    .join('');
}

function htmlBlock(
  intro: string,
  titleRows: string,
  more: string | null,
  members: { intro: string; rows: string; more: string | null } | null,
  href: string,
  label: string,
): string {
  return (
    (titleRows
      ? `<p style="margin:0 0 12px;font-size:15px;line-height:24px;color:${C.ink};">${intro}</p>`
        + titleRows
        + (more
          ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${C.ink2};">${more}</p>`
          : '')
      : '')
    + (members
      ? `<p style="margin:${titleRows ? '16px' : '0'} 0 12px;font-size:15px;line-height:24px;color:${C.ink};">${members.intro}</p>`
        + members.rows
        + (members.more
          ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${C.ink2};">${members.more}</p>`
          : '')
      : '')
    + `<div style="margin-top:16px;">${emailButtonHtml(href, label)}</div>`
  );
}

function buildBodyHtml(
  model: BillingPauseModel,
  shown: string[],
  hidden: number,
  members: string[],
  hiddenMembers: number,
): string {
  // Titles are escaped once and reused by both language blocks: escaping per
  // block would be identical work, and re-escaping an escaped string yields
  // &amp;amp;. Members are escaped once per language, from the raw list, since
  // the Spanish block localises the no-email placeholder.
  const titleRows = rowsHtml(shown);
  const enMembers = members.length > 0
    ? { intro: EN_MEMBERS_INTRO, rows: rowsHtml(members), more: hiddenMembers > 0 ? enMoreMembers(hiddenMembers) : null }
    : null;
  const esMembers = members.length > 0
    ? { intro: ES_MEMBERS_INTRO, rows: rowsHtml(members.map(esMember)), more: hiddenMembers > 0 ? esMoreMembers(hiddenMembers) : null }
    : null;
  const cardHtml =
    htmlBlock(EN_INTRO, titleRows, hidden > 0 ? enMore(hidden) : null,
      enMembers, model.englishBillingUrl, EN_BUTTON)
    + emailDividerHtml(24)
    + htmlBlock(ES_INTRO, titleRows, hidden > 0 ? esMore(hidden) : null,
      esMembers, model.spanishBillingUrl, ES_BUTTON);
  const footerHtml =
    `<p style="margin:0 0 8px;">${EN_WHY}</p>`
    + `<p style="margin:0 0 8px;">${ES_WHY}</p>`
    + `<p style="margin:0;">${emailLegalLinksHtml('bilingual')}</p>`;
  const total = model.pausedTitles.length;
  return renderEmailShell({
    lang: 'en',
    title: total > 0 ? BILLING_PAUSE_SUBJECT : BILLING_SEATS_SUBJECT,
    // Every suspended member counts, not only the listed ones.
    preheader: clipPreheader(total > 0 ? preheaderText(total) : membersPreheaderText((model.suspendedMembers ?? []).length)),
    eyebrow: EYEBROW,
    cardHtml,
    footerHtml,
  });
}

/**
 * Render the notice. The "+N more" counts are always measured against the full
 * `pausedTitles` length, so a shrunken list still reports the true overflow.
 */
export function renderBillingPauseEmail(model: BillingPauseModel): RenderedBillingPause {
  const total = model.pausedTitles.length;
  const allMembers = model.suspendedMembers ?? [];
  const members = allMembers.slice(0, BILLING_PAUSE_MAX_MEMBERS).map(clipMember);
  const hiddenMembers = allMembers.length - members.length;
  const subject = total > 0 || members.length === 0 ? BILLING_PAUSE_SUBJECT : BILLING_SEATS_SUBJECT;
  let listed = Math.min(total, BILLING_PAUSE_MAX_TITLES);

  for (;;) {
    const shown = model.pausedTitles.slice(0, listed).map(clipTitle);
    const hidden = total - shown.length;
    const bodyText = buildBodyText(model, shown, hidden, members, hiddenMembers);
    const bodyHtml = buildBodyHtml(model, shown, hidden, members, hiddenMembers);
    const fits =
      bodyText.length <= BILLING_PAUSE_BODY_TEXT_MAX
      && bodyHtml.length <= BILLING_PAUSE_BODY_HTML_MAX;
    if (fits || listed <= 1) {
      return { subject, bodyText, bodyHtml };
    }
    listed = Math.floor(listed / 2);
  }
}
