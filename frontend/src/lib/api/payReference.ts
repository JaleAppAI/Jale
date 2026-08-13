import { apiFetch } from '../api';
import { parseApiError } from './errors';

/** `GET /pay-reference`'s 200 response shape. Numbers are real numbers (the
 *  seed data carries cents); `pay-reference-format.ts` rounds them for
 *  display. */
export interface PayReferenceResponse {
  trade_category: string;
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
  area_kind: 'metro' | 'nonmetro' | 'state';
  area_label: string;
  source_tier: string;
  data_vintage: string;
}

/**
 * `GET /pay-reference?trade=<trade_category>&city_key=<slug>` -- a
 * DUAL-AUDIENCE endpoint: both worker and employer JWTs are accepted, same
 * as every other authenticated call (`apiFetch(path, init, token)`).
 *
 * Deliberately its OWN module rather than folded into `worker.ts` or
 * `employer.ts`: those two are each scoped to one audience's surfaces, and
 * either would be an equally arbitrary home for a helper called from both
 * (`PayReferenceHint` mounts on employer job forms AND worker pages). A
 * third top-level module is the least surprising place for a reader from
 * either side to find it.
 *
 * A 400 comes back as `invalid_trade` or `invalid_city_key`; a 404 comes
 * back as `no_reference` (including for `trade_category: 'other'`, which
 * never has a reference row). Every one of those, plus any other failure,
 * is a typed `ApiError` -- same as every other read helper -- and it is the
 * CALLER's job to swallow it: a missing/failed reference means the hint
 * simply does not render, never an error state.
 */
export async function getPayReference(
  token: string,
  tradeCategory: string,
  cityKey: string,
  signal?: AbortSignal,
): Promise<PayReferenceResponse> {
  const qs = new URLSearchParams({ trade: tradeCategory, city_key: cityKey });
  const res = await apiFetch(`/pay-reference?${qs.toString()}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'pay_reference_failed');
  return res.json();
}
