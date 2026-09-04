import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

/**
 * Props for {@link jaleAlarm}. A deliberately small subset of
 * `cloudwatch.AlarmProps`: every field the eight migrated alarms actually used,
 * and nothing else. Adding a field here is a decision about what an alarm in
 * this codebase is allowed to vary, not a passthrough.
 */
export interface JaleAlarmProps {
  /** The metric to watch. */
  readonly metric: cloudwatch.IMetric;
  /** Value the comparison operator is applied against. */
  readonly threshold: number;
  /**
   * Physical alarm name. OMITTED means CloudFormation generates one — which is
   * the existing state of the three MatchingStack DLQ alarms, and changing it
   * would REPLACE a live alarm. Only pass a value where one is already set.
   */
  readonly alarmName?: string;
  /** Human-readable description shown in the console and in notifications. */
  readonly alarmDescription?: string;
  /** @default 1 */
  readonly evaluationPeriods?: number;
  /**
   * @default cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
   *
   * Same value CDK itself defaults to (`aws-cdk-lib/aws-cloudwatch/lib/
   * alarm.js`: `props.comparisonOperator || GREATER_THAN_OR_EQUAL_TO_THRESHOLD`),
   * restated explicitly so that a reader of a call site does not have to know
   * CDK's default to know what the alarm fires on. It is NOT
   * `GREATER_THAN_THRESHOLD`: on a `threshold: 1` DLQ-depth alarm the
   * difference is "one dead-lettered message pages someone" versus "one dead-
   * lettered message is invisible".
   */
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
  /**
   * @default cloudwatch.TreatMissingData.NOT_BREACHING
   *
   * THE REASON THIS HELPER EXISTS. CloudWatch's own default is `missing`, which
   * puts an alarm on a normally-idle metric — a DLQ depth, a Lambda throttle
   * count — into INSUFFICIENT_DATA the moment the queue goes quiet, and then
   * back to OK when a datapoint arrives. Eight inline alarms carrying that
   * default produced 64 of 87 alarm state transitions in a single week, all of
   * them noise, which is how an operator learns to ignore the alarm channel and
   * misses the transition that mattered.
   *
   * `notBreaching` says the honest thing: an idle queue is a healthy queue.
   */
  readonly treatMissingData?: cloudwatch.TreatMissingData;
  /**
   * Alarm actions (ALARM state). Attached with `addAlarmAction`, so passing an
   * empty array or omitting it emits no `AlarmActions` at all.
   *
   * OK / INSUFFICIENT_DATA actions are deliberately NOT props: the alarm is
   * returned, so a caller that wants a recovery notification calls
   * `.addOkAction(...)` on it. That keeps this signature from growing a
   * parallel set of action fields for every alarm state.
   */
  readonly actions?: cloudwatch.IAlarmAction[];
}

/**
 * Creates a `cloudwatch.Alarm` with Jale's defaults — above all
 * `treatMissingData: NOT_BREACHING`.
 *
 * A PLAIN FUNCTION, not a `Construct` subclass, and that is load-bearing: the
 * alarm is constructed directly under `scope` with the caller's `id`, so its
 * CloudFormation logical id is byte-for-byte what `new cloudwatch.Alarm(this,
 * id, ...)` produced. Wrapping it in a construct of its own would insert a path
 * segment, rename every logical id, and make CloudFormation replace eight
 * alarms that are live in production.
 *
 * `referralsAlarm` (referrals-stack.ts) and `notificationsAlarm`
 * (notifications-stack.ts) are the local precedents this generalizes; they
 * stay as they are because both also attach an OK action and a shared SNS
 * topic, which is stack policy rather than alarm policy.
 */
export function jaleAlarm(
  scope: Construct,
  id: string,
  props: JaleAlarmProps,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    metric: props.metric,
    threshold: props.threshold,
    alarmName: props.alarmName,
    alarmDescription: props.alarmDescription,
    evaluationPeriods: props.evaluationPeriods ?? 1,
    comparisonOperator:
      props.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: props.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  for (const action of props.actions ?? []) {
    alarm.addAlarmAction(action);
  }

  return alarm;
}
