/**
 * The one thing the app must know about an employer's *name*: whether there
 * actually is one.
 *
 * `employer_display_name()` (migration 031) ends in
 * `COALESCE(v_name, 'Empleador')`, so the `company_name` on every worker-facing
 * payload can be a PLACEHOLDER rather than a name. Interpolated into copy it
 * reads as a company literally called "Empleador" -- and on the English locale
 * it is not even in the reader's language. Production shipped exactly that
 * ("Empleador te contrató para …") before the hire copy started refusing it.
 *
 * The API learned to report the case as `null` on the newer `hire.company`
 * field, but the older `company_name` on `Application` /
 * `ApplicationRequirements` still carries the sentinel verbatim. This is where
 * those call sites turn it back into "there isn't one", so the copy can pick
 * its `_no_company` wording instead.
 */

/**
 * The placeholder itself. Mirrors `EMPLOYER_DISPLAY_NAME_FALLBACK` in
 * `infra/lambda/lib/application-hire-view.ts`; duplicated rather than imported
 * because the frontend and the Lambda bundle share no module graph.
 */
export const EMPLOYER_NAME_PLACEHOLDER = 'Empleador';

/**
 * The company's real name, or `null` when there isn't one.
 *
 * `null` for an absent/blank value and for the placeholder; the trimmed string
 * otherwise.
 *
 * EQUALITY, never a substring or prefix test -- "Empleadora del Norte" and
 * "Grupo Empleador" are real company names, and the API's own unit tests pin
 * that same distinction on the server side.
 */
export function realCompanyName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === EMPLOYER_NAME_PLACEHOLDER) return null;
  return trimmed;
}
