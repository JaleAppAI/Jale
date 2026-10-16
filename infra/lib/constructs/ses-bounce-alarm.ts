import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/**
 * The account-level SES bounce alarm's metric, shared by the two stacks that
 * watch SES: NotificationsStack (`SesBounceCount`, the main region) and
 * FrontendStack (`SesBounceCountUsEast1`, where Cognito sends from).
 *
 * The alarm pages on the SHARE of an hour's sends that bounced, once the hour
 * has at least BOUNCE_FLOOR bounces. A single stray bounce does not page; a
 * small all-bounce burst (6 of 6 sends on 2026-08-28) still does.
 *
 * The share divides by the larger of the hour's bounces and sends. A bounce
 * can arrive in a later hour than its send, so an hour can carry bounces and
 * no Send datapoint at all: dividing by the larger keeps that hour a full
 * share (it breaches), where bounces over sends alone would come out with no
 * value, which NOT_BREACHING reads as healthy.
 *
 * No dimensions on either input: `AWS/SES` publishes Bounce and Send at the
 * account level, and a dimension would make a metric that never reports.
 */

/** The bounces an hour must reach before its share can page. */
export const BOUNCE_FLOOR = 2;

/** The share of the hour's sends (or of its bounces, when there are more) at or above which the alarm pages. */
export const BOUNCE_SHARE = 0.25;

/** The alarm's expression: m1 is the hour's bounces, m2 its sends, each a sum. */
export const BOUNCE_SHARE_EXPRESSION = `IF(FILL(m1,0) >= ${BOUNCE_FLOOR}, FILL(m1,0) / MAX([FILL(m1,0), FILL(m2,0)]), 0)`;

const HOUR = cdk.Duration.hours(1);

/** The hourly bounce share, as the alarm reads it (threshold BOUNCE_SHARE). */
export function sesBounceShareMetric(): cloudwatch.MathExpression {
  const hourlySum = (metricName: string) => new cloudwatch.Metric({ namespace: 'AWS/SES', metricName, period: HOUR, statistic: 'Sum' });
  return new cloudwatch.MathExpression({
    expression: BOUNCE_SHARE_EXPRESSION,
    usingMetrics: { m1: hourlySum('Bounce'), m2: hourlySum('Send') },
    // A math expression sets its inputs' period: an hour, as the sums are.
    period: HOUR,
    label: 'SES bounce share of the hour',
  });
}

/** One hour of `AWS/SES`: its Bounce and Send sums, undefined for an hour with no datapoint. */
export interface SesHour {
  readonly bounces?: number;
  readonly sends?: number;
}

/**
 * The value a metric-math expression gives for one hour, or undefined when it
 * gives none. It reads the subset the bounce alarm uses: numbers, `m1`
 * (bounces) and `m2` (sends), `FILL(x, v)`, `MAX([a, b, ...])`,
 * `IF(condition, then, else)`, `/` and `>=`, and refuses anything else. An
 * hour with no datapoint in either input has none in the expression either
 * (FILL has no timestamp to fill). A division by zero has no value.
 */
export function evaluateSesExpression(expression: string, hour: SesHour): number | undefined {
  if (hour.bounces === undefined && hour.sends === undefined) return undefined;
  const tokens = expression.match(/>=|[()[\],/]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\S/g) ?? [];
  let at = 0;
  const take = (expected?: string): string => {
    const token = tokens[at];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`SES_EXPRESSION: expected ${expected ?? 'more'} at token ${at}`);
    }
    at += 1;
    return token;
  };
  const list = (open: string, close: string): Array<number | undefined> => {
    take(open);
    const values = [comparison()];
    while (tokens[at] === ',') {
      take(',');
      values.push(comparison());
    }
    take(close);
    return values;
  };
  function primary(): number | undefined {
    const token = take();
    if (/^\d/.test(token)) return Number(token);
    switch (token) {
      case 'm1': return hour.bounces;
      case 'm2': return hour.sends;
      case '(': {
        const value = comparison();
        take(')');
        return value;
      }
      case 'FILL': {
        const [value, fill] = list('(', ')');
        return value ?? fill;
      }
      case 'IF': {
        const [condition, then, otherwise] = list('(', ')');
        if (condition === undefined) return undefined;
        return condition !== 0 ? then : otherwise;
      }
      case 'MAX': {
        take('(');
        const values = list('[', ']').filter((v): v is number => v !== undefined);
        take(')');
        return values.length > 0 ? Math.max(...values) : undefined;
      }
      default:
        throw new Error(`SES_EXPRESSION: unsupported token ${token}`);
    }
  }
  function quotient(): number | undefined {
    let value = primary();
    while (tokens[at] === '/') {
      take('/');
      const divisor = primary();
      value = value === undefined || divisor === undefined || divisor === 0 ? undefined : value / divisor;
    }
    return value;
  }
  function comparison(): number | undefined {
    const left = quotient();
    if (tokens[at] !== '>=') return left;
    take('>=');
    const right = quotient();
    return left === undefined || right === undefined ? undefined : Number(left >= right);
  }
  const value = comparison();
  if (at !== tokens.length) throw new Error(`SES_EXPRESSION: unexpected token ${tokens[at]}`);
  return value;
}

/**
 * Whether an hour puts the alarm in ALARM: the expression's value at or above
 * the threshold. An hour with no value is missing data, which the alarm
 * treats as not breaching.
 */
export function sesBounceAlarmBreaches(
  hour: SesHour,
  expression: string = BOUNCE_SHARE_EXPRESSION,
  threshold: number = BOUNCE_SHARE,
): boolean {
  const value = evaluateSesExpression(expression, hour);
  return value !== undefined && value >= threshold;
}
