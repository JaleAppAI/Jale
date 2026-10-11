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

export interface EmfOptions {
  /**
   * Also declare the dimensionless set, so the same line publishes the
   * per-dimension series AND a rollup with no dimensions. An alarm with no
   * `Dimensions` property reads only the rollup; without it, a metric emitted
   * with dimensions is a different metric and that alarm never sees it.
   */
  rollup?: boolean;
}

/**
 * Emits one EMF line carrying every metric in `metrics` under `namespace`.
 *
 * `dimensions` become BOTH the declared dimension set and top-level fields,
 * which is the pairing CloudWatch requires -- a declared dimension with no
 * matching field is silently dropped. Passing none declares `[[]]`: the
 * metric has no dimensions, which is what an alarm with no `Dimensions`
 * property matches. `options.rollup` adds that dimensionless set alongside
 * the dimensioned one.
 *
 * `fields` are extra top-level properties that are not dimensions: context
 * for whoever reads the line, never declared to CloudWatch. They are written
 * first, so the envelope, a dimension or a metric value of the same name
 * always wins over a field.
 */
export function emitEmfMetrics(
  namespace: string,
  metrics: EmfMetric[],
  dimensions: Record<string, string> = {},
  options: EmfOptions = {},
  fields: Record<string, unknown> = {},
): void {
  const keys = Object.keys(dimensions);
  const dimensionSets = options.rollup && keys.length > 0 ? [keys, []] : [keys];
  const payload: Record<string, unknown> = {
    ...fields,
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: dimensionSets,
        Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit ?? 'Count' })),
      }],
    },
    ...dimensions,
  };
  for (const { name, value } of metrics) payload[name] = value;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}
