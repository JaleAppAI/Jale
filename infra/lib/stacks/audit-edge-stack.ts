import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { edgeDeadLetterQueue, edgeRoutes, ruleState, type EventPatternJson, type RouteNames } from '../../lambda/ops/audit-sentinel-routes';
import { AUDIT_NAMES } from './audit-archive-stack';

/**
 * The regions, besides the main one, where AWS records events the audit
 * alerts need: IAM changes and global-endpoint sign-ins and role assumptions
 * (us-east-1), and root sign-ins (us-east-1, us-east-2 or us-west-2). A role
 * serves every region, so each also forwards the functions given one.
 */
export const EDGE_REGIONS = ['us-east-1', 'us-west-2'] as const;
export type EdgeRegion = (typeof EDGE_REGIONS)[number];

/** Each edge region's stack, by a fixed name. */
export const EDGE_STACK_IDS: Readonly<Record<EdgeRegion, string>> = {
  'us-east-1': 'JaleAuditEdgeStack',
  'us-west-2': 'JaleAuditEdgeUsWest2Stack',
};

/**
 * Whether the app needs an edge stack in `region`: every edge region but the
 * main one, whose own audit rules receive its events directly. A rule
 * forwarding to the bus it listens on would loop.
 */
export function needsAuditEdgeStack(mainRegion: string, region: EdgeRegion = 'us-east-1'): boolean {
  return mainRegion !== region;
}

/** The edge regions an app with this main region forwards from. */
export function auditEdgeRegions(mainRegion: string): EdgeRegion[] {
  return EDGE_REGIONS.filter((region) => needsAuditEdgeStack(mainRegion, region));
}

/**
 * The names the audit rules' patterns are built from. The sentinel gets the
 * same names in its settings, and builds the same patterns to check against.
 */
export const AUDIT_ROUTE_NAMES: RouteNames = {
  rulePrefix: AUDIT_NAMES.rulePrefix,
  roleNames: [AUDIT_NAMES.readerRole, AUDIT_NAMES.adminRole],
  bucketPrefix: AUDIT_NAMES.bucketPrefix,
};

/** The forwarding rules every edge region carries (`lambda/ops/audit-sentinel-routes.ts`). */
export const EDGE_RULES = edgeRoutes(AUDIT_ROUTE_NAMES);

/**
 * A route's pattern as the CDK takes it, `detailType` for `detail-type`, in
 * the same order and as a copy of its own: the CDK keeps the objects it is
 * given, and adds to them when a rule gains a pattern.
 */
export function cdkEventPattern(pattern: EventPatternJson): events.EventPattern {
  const copy = JSON.parse(JSON.stringify(pattern)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(copy).map(([field, value]) => [field === 'detail-type' ? 'detailType' : field, value])) as events.EventPattern;
}

/** The queue that keeps what an edge region could not forward. */
export const EDGE_DEAD_LETTER_QUEUE = edgeDeadLetterQueue(AUDIT_ROUTE_NAMES);

export interface AuditEdgeStackProps extends cdk.StackProps {
  /** The main region, whose default event bus JaleAuditStack's rules listen on. */
  readonly mainRegion: string;
}

/**
 * An edge stack: rules forwarding the audit-relevant events AWS
 * records in this region, unchanged, to the main region's default bus, where
 * JaleAuditStack routes them to the sentinel like every other event.
 *
 * Root use and audit-role assumptions are read-only management events, so
 * those two rules match all management events. What a forward cannot deliver
 * waits in this region's dead-letter queue, alarmed here; the sentinel's
 * daily edge check reads the queue and each rule's state, pattern and
 * target, and alerts on the main region's topic, which a CloudWatch alarm
 * here cannot reach.
 */
export class AuditEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuditEdgeStackProps) {
    super(scope, id, props);
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(props.mainRegion)) {
      throw new Error('AUDIT_EDGE_MAIN_REGION: the main region must be a concrete region name');
    }
    if (cdk.Token.isUnresolved(this.region) || this.region === props.mainRegion) {
      throw new Error('AUDIT_EDGE_MAIN_REGION: an edge stack forwards to another region; forwarding to its own would loop');
    }

    const mainBus = events.EventBus.fromEventBusArn(
      this,
      'MainRegionBus',
      `arn:${cdk.Aws.PARTITION}:events:${props.mainRegion}:${cdk.Aws.ACCOUNT_ID}:event-bus/default`,
    );
    const deadLetters = new sqs.Queue(this, 'DeadLetters', {
      queueName: EDGE_DEAD_LETTER_QUEUE,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const toMainRegion = new eventTargets.EventBus(mainBus, { deadLetterQueue: deadLetters });

    for (const spec of edgeRoutes(AUDIT_ROUTE_NAMES)) {
      const rule = new events.Rule(this, spec.id, {
        ruleName: spec.name,
        description: spec.description,
        eventPattern: cdkEventPattern(spec.pattern),
        targets: [toMainRegion],
      });
      if (spec.allManagementEvents) (rule.node.defaultChild as events.CfnRule).state = ruleState(true);
      new cloudwatch.Alarm(this, `${spec.id}FailedInvocations`, {
        alarmName: `JaleAuditEdgeFailedInvocations-${spec.name}`,
        alarmDescription: 'An audit event recorded in this region could not be forwarded to the main region.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Events',
          metricName: 'FailedInvocations',
          dimensionsMap: { RuleName: spec.name },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
    new cloudwatch.Alarm(this, 'DeadLettersAlarm', {
      alarmName: 'JaleAuditEdgeDeadLetters',
      alarmDescription: 'Audit events this region could not forward are waiting in its dead-letter queue.',
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
