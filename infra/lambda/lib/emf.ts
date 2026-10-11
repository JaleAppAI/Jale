/**
 * CloudWatch Embedded Metric Format, in one place.
 *
 * EMF is a structured `console.log` that CloudWatch Logs parses into real
 * metrics: no `PutMetricData` call, and therefore no `cloudwatch:PutMetricData`
 * grant on the emitting Lambda's role, and no MetricFilter to keep in sync
 * with the code that fires it.
 *
 * Extracted (sprint 26 R2) once a third caller appeared. The shape had been
 * hand-rolled in `auth/lib/otp-twilio.ts` and again in
 * `referrals/visibility-outbox-drain.ts`, whose own comment said it was "kept
 * local to this file rather than promoted to a shared lib: nothing else in
 * `infra/lambda/` needs it yet" -- this is that promotion. The envelope is
 * fiddly in exactly the way that does not fail loudly: a misspelled `_aws`
 * key, a `Dimensions` list that does not match the keys actually present, or
 * a metric name absent from the payload all produce a log line that looks
 * fine and a metric that never appears, so the alarm reading it sits silent
 * instead of going red.
 */

/** One metric in an EMF line. `unit` follows the CloudWatch unit vocabulary;
 *  'Count' covers the tallies, 'None' a dimensionless gauge. */
export interface EmfMetric {
  name: string;
  value: number;
  unit?: string;
}

/**
 * Emits one EMF line carrying every metric in `metrics` under `namespace`.
 *
 * `dimensions` become BOTH the declared dimension set and top-level fields,
 * which is the pairing CloudWatch requires -- a declared dimension with no
 * matching field is silently dropped. Passing none declares `[[]]`: the
 * metric has no dimensions, which is what an alarm with no `Dimensions`
 * property matches.
 */
export function emitEmfMetrics(
  namespace: string,
  metrics: EmfMetric[],
  dimensions: Record<string, string> = {},
): void {
  const payload: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [Object.keys(dimensions)],
        Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit ?? 'Count' })),
      }],
    },
    ...dimensions,
  };
  for (const { name, value } of metrics) payload[name] = value;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}
