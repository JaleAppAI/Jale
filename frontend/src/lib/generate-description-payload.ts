import { deriveLegacyExpectedDuration, deriveLegacyShiftSchedule, parseOptionalNumber, type JobForm } from './job-form';
import type { GenerateJobDescriptionPayload } from './api/employer';

/**
 * The subset of `JobForm` the description-generation request is built from.
 * A `Pick` (not a hand-rolled duplicate shape) so a future change to
 * `JobForm`'s field types is caught here at compile time instead of silently
 * drifting. `description` is included because `DescriptionHelper` (the
 * component that calls this) needs it for its replace-hint logic and its
 * seeded-notes logic (see `shouldSendAsNotes`/`capEmployerNotes` below), even
 * though the payload builder below never reads it directly.
 * `trade_category_other`/`expected_duration_bucket`/`work_days`/`shift_start`/
 * `shift_end` are the FE-T3 structured fields (job-flow redesign) -- included
 * so this builder can derive the same legacy strings a save would actually
 * write (see `resolveExpectedDuration`/`resolveShiftSchedule`), instead of
 * sending stale/blank free text while an employer's unsaved structured
 * schedule or duration sits in the form.
 */
export type DescriptionHelperFields = Pick<
  JobForm,
  | 'title' | 'trade_category' | 'trade_category_other' | 'city' | 'state'
  | 'pay_min' | 'pay_max' | 'pay_interval'
  | 'expected_duration' | 'expected_duration_bucket'
  | 'shift_schedule' | 'work_days' | 'shift_start' | 'shift_end'
  | 'description'
>;

// `parseOptionalNumber` can return `NaN` for unparseable text; JSON would
// otherwise serialize that as `null`, which is not "the field is unset" as
// far as the backend's optional-number fields are concerned.
function optionalPayNumber(value: string): number | undefined {
  const parsed = parseOptionalNumber(value);
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

// The backend caps every string field at 200 chars (400 `invalid_*` past
// that) -- slicing client-side means a long value truncates into a usable
// generation input instead of round-tripping into a failure.
function capped(value: string): string {
  return value.trim().slice(0, 200);
}

/**
 * `expected_duration` string to send: the structured bucket's legacy label
 * when set, otherwise the free-text field. Mirrors `jobFormToBasePayload`'s
 * precedence (lib/job-form.ts) exactly -- the bucket wins whenever it's
 * present -- so the model sees the same string a save would actually write,
 * including for a bucket picked in this session that hasn't been saved yet.
 */
function resolveExpectedDuration(form: DescriptionHelperFields): string {
  return form.expected_duration_bucket
    ? deriveLegacyExpectedDuration(form.expected_duration_bucket)
    : form.expected_duration;
}

/**
 * `shift_schedule` string to send: derived from the structured
 * work_days/shift_start/shift_end fields when any of them is set, otherwise
 * the free-text field. Mirrors `jobFormToBasePayload`'s `hasShiftStructure`
 * precedence exactly, for the same reason as `resolveExpectedDuration` above.
 */
function resolveShiftSchedule(form: DescriptionHelperFields): string {
  const hasShiftStructure = form.work_days.length > 0 || form.shift_start !== '' || form.shift_end !== '';
  return hasShiftStructure
    ? deriveLegacyShiftSchedule(form.work_days, form.shift_start, form.shift_end)
    : form.shift_schedule;
}

/**
 * Builds the `generateJobDescription` request body from whatever the job
 * form currently holds. Every field but `trade_category` is optional and
 * omitted entirely when blank/unset/unparseable, rather than sent as an
 * explicit `null`/`NaN` -- this mirrors how `lib/job-form.ts`'s own
 * `jobFormToCreatePayload`/`jobFormToEditPayload` treat "not provided".
 */
export function buildGenerateDescriptionPayload(form: DescriptionHelperFields): GenerateJobDescriptionPayload {
  const payMin = optionalPayNumber(form.pay_min);
  const payMax = optionalPayNumber(form.pay_max);
  const expectedDuration = resolveExpectedDuration(form);
  const shiftSchedule = resolveShiftSchedule(form);
  return {
    trade_category: form.trade_category,
    ...(form.title.trim() ? { title: capped(form.title) } : {}),
    // Only meaningful (and only ever accepted by the backend) when
    // trade_category itself is 'other' -- same gate as `jobFormToBasePayload`
    // uses for the saved payload, so stale text left over from a
    // since-abandoned 'other' selection never rides along under a different
    // trade. A blank/whitespace-only value here matches `canGenerate` staying
    // disabled for 'other' until custom trade text exists, so this shape is
    // never actually sent in practice -- but the builder stays correct
    // (omits it) if called directly regardless.
    ...(form.trade_category === 'other' && form.trade_category_other.trim()
      ? { trade_category_other: capped(form.trade_category_other) }
      : {}),
    ...(form.city ? { city: capped(form.city) } : {}),
    ...(form.state ? { state: capped(form.state) } : {}),
    ...(payMin !== undefined ? { pay_min: payMin } : {}),
    ...(payMax !== undefined ? { pay_max: payMax } : {}),
    ...(form.pay_interval ? { pay_interval: form.pay_interval } : {}),
    ...(expectedDuration.trim() ? { expected_duration: capped(expectedDuration) } : {}),
    ...(shiftSchedule.trim() ? { shift_schedule: capped(shiftSchedule) } : {}),
  };
}

/**
 * Client-side cap on the seeded `employer_notes` field (see
 * `capEmployerNotes` below) -- deliberately conservative, NOT the backend's
 * actual 500-char `MAX_EMPLOYER_NOTES_LENGTH`
 * (infra/lambda/api/employer-generate-description.ts). Employer notes are
 * meant to be a brief nudge typed into the description box before
 * generating ("need someone who can start Monday"), not a full draft --
 * staying well under the backend limit keeps the request small and never
 * risks a round trip into the backend's own 400 `invalid_employer_notes`.
 */
export const EMPLOYER_NOTES_MAX_LENGTH = 200;

/**
 * Trims and caps a description-box draft down to `EMPLOYER_NOTES_MAX_LENGTH`
 * for use as the `employer_notes` seed on a generation request.
 */
export function capEmployerNotes(value: string): string {
  return value.trim().slice(0, EMPLOYER_NOTES_MAX_LENGTH);
}

/**
 * Whether the live description-box text (`current`) should be sent as the
 * generation request's `employer_notes` seed: non-blank, AND not simply the
 * untouched output of the last successful generation (`lastGenerated`).
 * Feeding a prior AI generation back to the model as if it were fresh
 * employer input would let the model re-ground itself in its own previous
 * output on every regenerate, drifting further from the actual job details
 * each time -- so an unedited post-generation description must read as "no
 * notes," not as notes equal to the description. (`DescriptionHelper` also
 * treats an inserted sample the same way -- canned O*NET-derived prose is
 * exactly the same self-referential-drift risk, just from the sample source
 * instead of a prior generation -- by recording it through the same ref this
 * function compares against.)
 */
export function shouldSendAsNotes(current: string, lastGenerated: string | null): boolean {
  const trimmed = current.trim();
  if (!trimmed) return false;
  if (lastGenerated === null) return true;
  return trimmed !== lastGenerated.trim();
}
