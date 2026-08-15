import { parseOptionalNumber, type JobForm } from './job-form';
import type { GenerateJobDescriptionPayload } from './api/employer';

/**
 * The subset of `JobForm` the description-generation request is built from.
 * A `Pick` (not a hand-rolled duplicate shape) so a future change to
 * `JobForm`'s field types is caught here at compile time instead of silently
 * drifting. `description` is included because `DescriptionHelper` (the
 * component that calls this) needs it for its replace-hint logic, even
 * though the payload builder below never reads it.
 */
export type DescriptionHelperFields = Pick<
  JobForm,
  | 'title' | 'trade_category' | 'city' | 'state'
  | 'pay_min' | 'pay_max' | 'pay_interval'
  | 'expected_duration' | 'shift_schedule' | 'description'
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
 * Builds the `generateJobDescription` request body from whatever the job
 * form currently holds. Every field but `trade_category` is optional and
 * omitted entirely when blank/unset/unparseable, rather than sent as an
 * explicit `null`/`NaN` -- this mirrors how `lib/job-form.ts`'s own
 * `jobFormToCreatePayload`/`jobFormToEditPayload` treat "not provided".
 */
export function buildGenerateDescriptionPayload(form: DescriptionHelperFields): GenerateJobDescriptionPayload {
  const payMin = optionalPayNumber(form.pay_min);
  const payMax = optionalPayNumber(form.pay_max);
  return {
    trade_category: form.trade_category,
    ...(form.title.trim() ? { title: capped(form.title) } : {}),
    ...(form.city ? { city: capped(form.city) } : {}),
    ...(form.state ? { state: capped(form.state) } : {}),
    ...(payMin !== undefined ? { pay_min: payMin } : {}),
    ...(payMax !== undefined ? { pay_max: payMax } : {}),
    ...(form.pay_interval ? { pay_interval: form.pay_interval } : {}),
    ...(form.expected_duration.trim() ? { expected_duration: capped(form.expected_duration) } : {}),
    ...(form.shift_schedule.trim() ? { shift_schedule: capped(form.shift_schedule) } : {}),
  };
}
