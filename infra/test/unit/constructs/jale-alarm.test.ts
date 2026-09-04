import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { jaleAlarm } from '../../../lib/constructs/jale-alarm';

/**
 * `jaleAlarm` exists for ONE reason: `treatMissingData` defaults to `missing`
 * in CloudWatch, which makes every alarm on a normally-idle metric (a DLQ
 * depth, a Lambda throttle count) flap OK -> INSUFFICIENT_DATA -> OK forever.
 * 64 of 87 state transitions in one week came from that flapping, which is how
 * an operator learns to ignore the alarm channel.
 *
 * So the default asserted here is not a style preference — it is the whole
 * point of the helper, and `test('treatMissingData defaults to notBreaching')`
 * is the test that must never be relaxed.
 */
function metric(): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'Jale/Test',
    metricName: 'Widgets',
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
  });
}

describe('jaleAlarm', () => {
  test('treatMissingData defaults to notBreaching', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'DefaultsAlarm', { metric: metric(), threshold: 1 });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      TreatMissingData: 'notBreaching',
    });
  });

  test('defaults evaluationPeriods to 1 and the operator to >= threshold', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'DefaultsAlarm', { metric: metric(), threshold: 3 });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 3,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  test('emits neither AlarmName nor DatapointsToAlarm when they are not asked for', () => {
    // Both matter for the migration of the eight pre-existing inline alarms:
    // three of them have no `alarmName` (CloudFormation generates the physical
    // name) and none set `datapointsToAlarm`. A helper that quietly filled
    // either in would be a template diff on a live alarm — and an AlarmName
    // diff REPLACES the alarm.
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'NamelessAlarm', { metric: metric(), threshold: 1 });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.absent(),
      DatapointsToAlarm: Match.absent(),
    });
  });

  test('caller overrides win over every default', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'OverriddenAlarm', {
      metric: metric(),
      threshold: 5,
      alarmName: 'ExplicitName',
      alarmDescription: 'because',
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'ExplicitName',
      AlarmDescription: 'because',
      Threshold: 5,
      EvaluationPeriods: 3,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'breaching',
    });
  });

  test('attaches every action in `actions` as an alarm action', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const topic = new sns.Topic(stack, 'Topic');
    jaleAlarm(stack, 'ActionedAlarm', {
      metric: metric(),
      threshold: 1,
      actions: [new cloudwatchActions.SnsAction(topic)],
    });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^Topic') }],
    });
  });

  test('omits AlarmActions entirely when no actions are passed', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'SilentAlarm', { metric: metric(), threshold: 1 });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: Match.absent(),
      OKActions: Match.absent(),
    });
  });

  test('returns the Alarm so the caller can add OK/insufficient-data actions', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const topic = new sns.Topic(stack, 'Topic');
    const alarm = jaleAlarm(stack, 'ReturnedAlarm', { metric: metric(), threshold: 1 });
    alarm.addOkAction(new cloudwatchActions.SnsAction(topic));

    expect(alarm).toBeInstanceOf(cloudwatch.Alarm);
    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      OKActions: [{ Ref: Match.stringLikeRegexp('^Topic') }],
    });
  });

  test('creates the alarm as a direct child of the given scope (logical id is preserved)', () => {
    // The migration's hard constraint: the eight live alarms keep their
    // CloudFormation logical ids. That only holds if the helper is a plain
    // function that constructs the Alarm under the CALLER's scope — a helper
    // that wrapped it in its own Construct would insert a path segment and
    // rename (i.e. replace) every alarm in production.
    const stack = new cdk.Stack(new cdk.App(), 'S');
    jaleAlarm(stack, 'PathPinnedAlarm', { metric: metric(), threshold: 1 });

    expect(stack.node.tryFindChild('PathPinnedAlarm')).toBeInstanceOf(cloudwatch.Alarm);
    const ids = Object.keys(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^PathPinnedAlarm[0-9A-F]{8}$/);
  });
});
