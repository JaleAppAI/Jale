import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Template } from 'aws-cdk-lib/assertions';
import {
  BOUNCE_FLOOR,
  BOUNCE_SHARE,
  BOUNCE_SHARE_EXPRESSION,
  evaluateSesExpression,
  sesBounceAlarmBreaches,
  sesBounceShareMetric,
} from '../../../../lib/constructs/ses-bounce-alarm';

describe('the SES bounce-share alarm', () => {
  describe('the hours it pages on', () => {
    it.each([
      ['one bounce in 50 sends', { bounces: 1, sends: 50 }, false],
      ['6 bounces in 6 sends (the 2026-08-28 burst)', { bounces: 6, sends: 6 }, true],
      ['2 bounces in 4 sends', { bounces: 2, sends: 4 }, true],
      ['3 bounces in an hour with no Send datapoint', { bounces: 3 }, true],
      ['an hour with no datapoint at all', {}, false],
      ['sends and no bounce', { sends: 40 }, false],
      ['2 bounces in 100 sends', { bounces: 2, sends: 100 }, false],
      ['one bounce in one send, under the floor', { bounces: 1, sends: 1 }, false],
    ])('%s: %s', (_label, hour, breaches) => {
      expect(sesBounceAlarmBreaches(hour)).toBe(breaches);
    });

    it('builds its expression from the floor, and pages at the share', () => {
      expect([BOUNCE_FLOOR, BOUNCE_SHARE]).toEqual([2, 0.25]);
      expect(BOUNCE_SHARE_EXPRESSION).toBe('IF(FILL(m1,0) >= 2, FILL(m1,0) / MAX([FILL(m1,0), FILL(m2,0)]), 0)');
      expect(evaluateSesExpression(BOUNCE_SHARE_EXPRESSION, { bounces: 3, sends: 12 })).toBe(0.25);
      expect(sesBounceAlarmBreaches({ bounces: 3, sends: 12 })).toBe(true);
      expect(sesBounceAlarmBreaches({ bounces: 3, sends: 13 })).toBe(false);
    });
  });

  describe('the expression reader', () => {
    it.each([
      ['m1 / m2', { bounces: 3, sends: 6 }, 0.5],
      ['m1 / m2', { bounces: 3 }, undefined],
      ['m1 / m2', { bounces: 3, sends: 0 }, undefined],
      ['FILL(m2,0)', { bounces: 3 }, 0],
      ['MAX([m1, m2])', { bounces: 3 }, 3],
      ['IF(m1 >= 2, 1, 0)', { bounces: 1, sends: 1 }, 0],
      ['(m1)', { bounces: 4 }, 4],
    ])('%s over %j is %s', (expression, hour, value) => {
      expect(evaluateSesExpression(expression, hour)).toBe(value);
    });

    it('refuses what it does not read, rather than guess', () => {
      for (const expression of ['m1 * 2', 'SUM([m1, m2])', 'm3', 'IF(m1', 'm1 m2']) {
        expect(() => evaluateSesExpression(expression, { bounces: 1, sends: 1 })).toThrow(/^SES_EXPRESSION/);
      }
    });
  });

  describe('the metric', () => {
    it('is the hourly Bounce and Send sums, with no dimensions, under the expression', () => {
      const stack = new cdk.Stack(new cdk.App(), 'BounceShare', { env: { region: 'us-east-2' } });
      new cloudwatch.Alarm(stack, 'Alarm', { metric: sesBounceShareMetric(), threshold: BOUNCE_SHARE, evaluationPeriods: 1 });
      const [alarm] = Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm')) as any[];
      expect(alarm.Properties.Metrics).toEqual([
        expect.objectContaining({ Expression: BOUNCE_SHARE_EXPRESSION, ReturnData: true }),
        { Id: 'm1', MetricStat: { Metric: { MetricName: 'Bounce', Namespace: 'AWS/SES' }, Period: 3600, Stat: 'Sum' }, ReturnData: false },
        { Id: 'm2', MetricStat: { Metric: { MetricName: 'Send', Namespace: 'AWS/SES' }, Period: 3600, Stat: 'Sum' }, ReturnData: false },
      ]);
    });
  });
});
