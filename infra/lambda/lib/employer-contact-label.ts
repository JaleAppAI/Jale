import type { PoolClient } from 'pg';

/**
 * The one place a worker-facing employer label is built: "{contact} ({company})".
 *
 * WhatsApp templates put the label in their existing company variable, so the
 * output has to survive Meta's template-variable rules (no newline, no tab, no
 * run of more than four spaces). `collapseWhitespace` already collapses every
 * run of whitespace to one space, and the send-time normaliser in `whatsapp/lib/outbox.ts`
 * is the backstop for everything else.
 */

/** The placeholder `employer_display_name` returns when the owner never set a company name. */
const COMPANY_PLACEHOLDER = 'Empleador';

const CONTACT_MAX = 30;
const COMPANY_MAX = 40;

/**
 * The one whitespace rule for anything that reaches a WhatsApp template
 * variable: every run of whitespace (spaces, tabs, newlines, NBSP, \v, \f,
 * U+2028/U+2029 and the rest of `\s`) becomes a single space and the ends are
 * trimmed. Used by `cleanLabelPart` and by `normalizeTemplateVariable` in
 * `whatsapp/lib/outbox.ts`, so a label that passes one passes the other.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Clips by code points (`Array.from`, never `String.slice`, so an emoji is not
 * split into a lone surrogate). When it actually cut something, it also drops
 * trailing whitespace and a dangling U+200D (ZWJ) or U+FE0F (variation
 * selector), so a cut emoji sequence does not end in a joiner.
 */
function clipCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, max).join('').replace(/[\s\u200D\uFE0F]+$/, '');
}

/** Whitespace-cleans a label part, then clips it by code points. */
export function cleanLabelPart(value: string | null | undefined, max: number): string {
  if (typeof value !== 'string') return '';
  return clipCodePoints(collapseWhitespace(value), max);
}

export function formatEmployerContactLabel(parts: {
  contactName: string | null;
  companyName: string | null;
}): string {
  // Compare the cleaned, UNclipped values: two long names that differ only
  // after the clip point are different names, and two equal ones are one.
  const contactFull = typeof parts.contactName === 'string' ? collapseWhitespace(parts.contactName) : '';
  const companyFull = typeof parts.companyName === 'string' ? collapseWhitespace(parts.companyName) : '';
  const sameName = contactFull !== '' && contactFull.toLowerCase() === companyFull.toLowerCase();
  const contact = sameName ? '' : clipCodePoints(contactFull, CONTACT_MAX);
  const company = clipCodePoints(companyFull, COMPANY_MAX);
  const hasCompany = company !== '' && company !== COMPANY_PLACEHOLDER;
  if (!contact) return company || COMPANY_PLACEHOLDER;
  if (!hasCompany) return contact;
  return `${contact} (${company})`;
}

/**
 * Loads the label for one employer user: their own `contact_name` and the
 * owning company's display name.
 *
 * `employer_display_name` sets a transaction-local flag that only
 * `jale_admin`-owned definers read, so it is harmless for the Lambda roles.
 * Existing comments elsewhere that say "keep it last" refer to code that also
 * runs `jale_admin` definers in the same transaction.
 */
export async function loadEmployerContactLabel(
  client: PoolClient,
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ contact: string | null; company: string | null }>(
    'SELECT jale_cap.employer_contact_name($1) AS contact, employer_display_name($1) AS company',
    [userId],
  );
  return formatEmployerContactLabel({
    contactName: rows[0]?.contact ?? null,
    companyName: rows[0]?.company ?? null,
  });
}

/** Shared by the label tests and by the tasks that reuse the rule. */
export const CONTACT_LABEL_CASES: ReadonlyArray<{
  contactName: string | null;
  companyName: string | null;
  label: string;
}> = [
  { contactName: 'Ana Ruiz', companyName: 'Acme', label: 'Ana Ruiz (Acme)' },
  { contactName: null, companyName: 'Acme', label: 'Acme' },
  { contactName: 'acme ', companyName: 'Acme', label: 'Acme' },
  { contactName: 'Juan', companyName: 'Empleador', label: 'Juan' },
  { contactName: null, companyName: 'Empleador', label: 'Empleador' },
  { contactName: 'Ana\nRuiz', companyName: 'Acme\tCo', label: 'Ana Ruiz (Acme Co)' },
  { contactName: 'Ana     Ruiz', companyName: 'Acme', label: 'Ana Ruiz (Acme)' },
  { contactName: '🚧 Ana', companyName: 'Acme 🏗', label: '🚧 Ana (Acme 🏗)' },
  // 29 letters then an emoji: the emoji is the 30th code point and stays whole.
  { contactName: `${'a'.repeat(29)}🏗`, companyName: 'Acme', label: `${'a'.repeat(29)}🏗 (Acme)` },
  // The 31st code point is dropped; the emoji is not split.
  { contactName: `${'a'.repeat(29)}🏗b`, companyName: 'Acme', label: `${'a'.repeat(29)}🏗 (Acme)` },
  // A 60-character company clips to 40.
  { contactName: 'Ana', companyName: 'c'.repeat(60), label: `Ana (${'c'.repeat(40)})` },
  // Equal 45-character names are one name: the company alone, clipped to 40.
  { contactName: 'z'.repeat(45), companyName: 'Z'.repeat(45), label: 'Z'.repeat(40) },
];
