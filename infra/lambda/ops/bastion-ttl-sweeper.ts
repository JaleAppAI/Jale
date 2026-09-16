import { DescribeInstancesCommand, EC2Client, StopInstancesCommand } from '@aws-sdk/client-ec2';

/**
 * F23 (Luis ruling, sprint 26): the migration bastion tears itself down.
 *
 * `JaleBastionStack` is documented as "deploy on demand, destroy when done",
 * and the memory note that goes with it is blunt about the failure mode: the
 * bastion has no TTL, so it has to be destroyed in the same session it was
 * created, and more than once it was not. A forgotten bastion is a t4g.micro
 * plus an SSM-reachable host inside the VPC with `secretsmanager:GetSecretValue`
 * on every internal database credential -- the cost is the least of it.
 *
 * WHY STOP, NOT TERMINATE. The bastion is a CloudFormation-managed
 * `AWS::EC2::Instance` (`ec2.BastionHostLinux`), not an ASG member and not an
 * ephemeral instance this lambda created. Terminating it would leave the stack
 * pointing at a dead physical id: `cdk destroy` would then have to reconcile a
 * resource that no longer exists, and any later `deploy-bastion.sh` would be
 * operating on drifted state. Stopping ends both the bill and the reachability
 * -- a stopped instance answers no SSM session and holds no credentials in
 * memory -- while leaving `bash scripts/deploy-bastion.sh --destroy` as the
 * one real teardown. Restarting a stopped bastion is a deliberate act that
 * re-arms the TTL from the new launch time.
 *
 * WHY A RATE RULE AND NOT A ONE-SHOT SCHEDULE. An EventBridge `at()` schedule
 * would have to be computed at SYNTH time, which is not "TTL hours after the
 * bastion was created" -- it is TTL hours after somebody ran `cdk synth`, and
 * every redeploy would re-arm a stale timestamp. The age is therefore measured
 * here, from the instance's own `LaunchTime`, on a fixed sweep interval.
 *
 * METRICS are emitted as EMF (a structured log line CloudWatch parses into a
 * metric) rather than `PutMetricData`, so this function needs no CloudWatch
 * write permission at all -- its entire IAM surface stays `ec2:DescribeInstances`
 * plus `ec2:StopInstances` on the one instance.
 *
 * `BastionOverTtl` is 1 only while the instance is STILL RUNNING and past its
 * TTL. A sweep that successfully stops it reports 1 once and 0 from then on,
 * so the alarm in `bastion-stack.ts` (two consecutive breaching periods) fires
 * only when the stop is not taking effect -- it is a backstop for this
 * function, not an echo of it.
 */

const ec2 = new EC2Client({});

/** Namespace the stack's alarm reads. Kept in sync by that alarm's own test. */
const METRIC_NAMESPACE = 'Jale/Bastion';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * One EMF line. `Dimensions: [[]]` publishes the metrics with NO dimensions,
 * which is what the alarm matches on -- there is exactly one bastion per
 * account, so a dimension would only be a way for the alarm and the emitter to
 * disagree.
 */
function emitMetrics(ageHours: number, overTtl: boolean): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [[]],
        Metrics: [
          { Name: 'BastionAgeHours', Unit: 'None' },
          { Name: 'BastionOverTtl', Unit: 'Count' },
        ],
      }],
    },
    BastionAgeHours: ageHours,
    BastionOverTtl: overTtl ? 1 : 0,
  }));
}

export const handler = async (): Promise<void> => {
  const instanceId = process.env.BASTION_INSTANCE_ID;
  const ttlHours = Number(process.env.BASTION_TTL_HOURS);

  // Misconfiguration must be loud and must NOT look like a healthy sweep: no
  // metric is emitted, so the alarm's NOT_BREACHING default cannot quietly
  // absolve a sweeper that is not actually measuring anything.
  if (!instanceId || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    console.error(JSON.stringify({ event: 'BastionTtlSweepMisconfigured', hasInstanceId: Boolean(instanceId) }));
    return;
  }

  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = described.Reservations?.[0]?.Instances?.[0];

  // The stack was destroyed properly, or the instance was replaced. Nothing to
  // sweep and nothing wrong -- report a clean zero so the alarm clears.
  if (!instance || !instance.LaunchTime) {
    console.log(JSON.stringify({ event: 'BastionTtlSweepNoInstance', instanceId }));
    emitMetrics(0, false);
    return;
  }

  const state = instance.State?.Name ?? 'unknown';
  const ageHours = (Date.now() - instance.LaunchTime.getTime()) / MS_PER_HOUR;
  // 'pending' counts as running: an instance still booting is already billing
  // and will be reachable, and a TTL that only starts once it finishes booting
  // is a TTL that a stuck boot defeats.
  const running = state === 'running' || state === 'pending';
  const overTtl = running && ageHours >= ttlHours;

  if (overTtl) {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(JSON.stringify({
      event: 'BastionStoppedOnTtl', instanceId, ageHours: Number(ageHours.toFixed(2)), ttlHours,
    }));
  } else {
    console.log(JSON.stringify({
      event: 'BastionTtlSweep', instanceId, state, ageHours: Number(ageHours.toFixed(2)), ttlHours,
    }));
  }

  emitMetrics(ageHours, overTtl);
};
