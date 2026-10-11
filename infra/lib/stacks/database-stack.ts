import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { AccessManifest } from '../../db/access/access-manifest';
import { defaultAccessManifest } from '../constructs/db-login-secrets';
import { DbPostureCheck } from '../constructs/db-posture-check';
import { NetworkStack } from './network-stack';

export interface DatabaseStackProps extends cdk.StackProps {
  /** Reference to the network stack */
  network: NetworkStack;
  /**
   * The merged access manifest the posture check evaluates against. Defaults
   * to the checked-in one; only tests pass another.
   */
  accessManifest?: AccessManifest;
  /**
   * The existing monitored ops topic for the posture alarms (the shared
   * `whatsappAlarmTopicArn` context). Optional: without it the alarms exist
   * with no action, so harnesses that build this stack alone keep synthesizing.
   */
  alarmTopicArn?: string;
  /**
   * The engine audit window this synth is for. Defaults to
   * DB_AUDIT_ENGINE_WINDOW; only tests pass another.
   */
  auditEngineWindow?: AuditEngineWindow;
  /**
   * The engine's default shared_preload_libraries, as engineDefaultLibraries()
   * resolves it ('' for none). The composition always passes it, and that is
   * where production requires the pre-check value; a harness that builds this
   * stack alone gets the documented default.
   */
  auditPreloadDefault?: string;
  /**
   * The preload list pinned in code for attached windows. Defaults to
   * DB_AUDIT_PRELOAD_PIN; only tests pass another.
   */
  auditPreloadPin?: string;
}

/**
 * Engine audit logging windows. Each value is a deploy, in order:
 *
 *   0  the release: the audit parameter group exists, unattached.
 *   1  window deploy 1: the instance uses the group. The group holds static
 *      parameters, so CloudFormation reboots the instance (snapshot first).
 *   2  window deploy 2, first step: JaleAuditStack creates the engine log
 *      group (audit key, 400 days, kept) and subscribes the sentinel to it.
 *      The instance is as in window 1.
 *   3  window deploy 2, second step: the instance exports its log to that
 *      group. It must be a separate deploy: the group's name holds the
 *      instance identifier, so it cannot be ordered before the instance in
 *      one template, and an export enabled first would make RDS create the
 *      group itself, unencrypted and kept forever.
 *
 * The export never comes before the group is attached: at the default
 * error verbosity, error lines carry row contents.
 */
export type AuditEngineWindow = 0 | 1 | 2 | 3;

/** The window this code is at. The release ships 0; each window branch raises it. */
export const DB_AUDIT_ENGINE_WINDOW: AuditEngineWindow = 0;

/**
 * The engine default preload list, pinned in code once the group is attached
 * (window 1 sets it to the pre-check result; '' stands for none). From then on
 * synth refuses a pre-check variable that differs from it, so a routine deploy
 * can never change the attached group's static parameter, which would reboot
 * the instance or leave it pending a reboot.
 *
 * Planned change, after window 1: in a window chosen for the reboot (snapshot
 * first), one change edits this constant and the
 * AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT variable together, and deploys.
 */
export const DB_AUDIT_PRELOAD_PIN: string | undefined = undefined;

/** The context value carrying the engine's default `shared_preload_libraries` (a pre-check result). */
export const PRELOAD_DEFAULT_CONTEXT = 'dbSharedPreloadLibrariesDefault';

/**
 * Outside production, where nothing deploys, the documented default: RDS for
 * PostgreSQL 11 and later loads pg_stat_statements by default.
 */
export const DEV_PRELOAD_DEFAULT = 'pg_stat_statements';

const PRELOAD_LIST = /^[a-z0-9_]+(,[a-z0-9_]+)*$/;

/**
 * The engine's default library list, from the pre-check (`none` when it is
 * empty). Required in production: a wrong value here would drop a library
 * the engine loads today once the group is attached.
 */
export function engineDefaultLibraries(scope: Construct): string {
  const raw = scope.node.tryGetContext(PRELOAD_DEFAULT_CONTEXT);
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === undefined || value === null || value === '') {
    if (scope.node.tryGetContext('environment') === 'production') {
      throw new Error(
        `AUDIT_PRELOAD_DEFAULT_REQUIRED: pass -c ${PRELOAD_DEFAULT_CONTEXT}=<the engine default shared_preload_libraries, `
        + 'from the pre-check, or none>',
      );
    }
    return DEV_PRELOAD_DEFAULT;
  }
  if (value === 'none') return '';
  if (typeof value !== 'string' || !PRELOAD_LIST.test(value) || value.split(',').includes('pgaudit')) {
    throw new Error(`AUDIT_PRELOAD_DEFAULT_INVALID: ${PRELOAD_DEFAULT_CONTEXT} must be a comma-separated library list without pgaudit, or none`);
  }
  return value;
}

/**
 * Refuses a preload list that differs from the pin once the group is attached
 * (window 1 and later). Before that, nothing is pinned.
 */
export function checkPreloadPin(window: AuditEngineWindow, pin: string | undefined, value: string): void {
  if (window < 1) return;
  if (pin === undefined) {
    throw new Error('AUDIT_PRELOAD_PIN_REQUIRED: an attached audit parameter group needs DB_AUDIT_PRELOAD_PIN set in code');
  }
  if (pin !== '' && (!PRELOAD_LIST.test(pin) || pin.split(',').includes('pgaudit'))) {
    throw new Error('AUDIT_PRELOAD_PIN_INVALID: DB_AUDIT_PRELOAD_PIN must be a comma-separated library list without pgaudit, or empty');
  }
  if (value !== pin) {
    throw new Error(
      `AUDIT_PRELOAD_PIN_MISMATCH: ${PRELOAD_DEFAULT_CONTEXT} differs from the list pinned in code; changing the attached `
      + 'group reboots the instance and is a planned window change (see DB_AUDIT_PRELOAD_PIN)',
    );
  }
}

/** The audit parameter group's parameters: the static floor, nothing else. */
export function auditEngineParameters(defaultLibraries: string): Record<string, string> {
  return {
    shared_preload_libraries: defaultLibraries ? `${defaultLibraries},pgaudit` : 'pgaudit',
    log_error_verbosity: 'terse',
    log_connections: '1',
    log_disconnections: '1',
    'pgaudit.log': 'role,ddl',
    'pgaudit.log_parameter': '0',
    'pgaudit.log_catalog': '0',
    'pgaudit.log_relation': '0',
  };
}

/**
 * Engine-upgrade and maintenance settings, pinned instead of left to AWS.
 *
 * - Minor upgrades are planned and rehearsed, never applied on AWS's schedule.
 * - The maintenance window is a fixed, quiet slot rather than one AWS picks.
 * - The backup window is explicit too: RDS rejects a maintenance window that
 *   overlaps the backup window, and an AWS-picked backup window could. The two
 *   below never meet, on any day of the week.
 *
 * Both windows are UTC. The day is lowercase, the form RDS documents and
 * reports back, so the deployed value and the template stay identical.
 */
export const DB_ENGINE_SETTINGS = {
  autoMinorVersionUpgrade: false,
  preferredMaintenanceWindow: 'sun:08:00-sun:09:00',
  preferredBackupWindow: '06:00-06:30',
} as const;

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly matchingDbSecret: secretsmanager.ISecret;
  public readonly aiDbSecret: secretsmanager.ISecret;
  public readonly adminConsoleDbSecret: secretsmanager.ISecret;
  public readonly billingDbSecret: secretsmanager.ISecret;
  public readonly referralsDbSecret: secretsmanager.ISecret;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;
  /** The application database's name on the instance. */
  public readonly dbName = 'jale';
  /** The database posture check, its schedule, alarms and deploy-role policy. */
  public readonly posture: DbPostureCheck;
  /** The engine audit parameter group (attached from window 1). */
  public readonly auditParameterGroup: rds.CfnDBParameterGroup;
  /** The engine audit window this stack was synthesized for. */
  public readonly auditEngineWindow: AuditEngineWindow;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { vpc, isolatedSubnets, rdsSg } = props.network;

    const env = this.node.tryGetContext('environment') ?? 'dev';
    const deletionProtection = this.node.tryGetContext('deletionProtection') !== false;
    const multiAz = this.node.tryGetContext('multiAz') ?? false;
    const removalPolicy =
      env === 'dev' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // Subnet group for RDS in isolated subnets
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      description: 'Subnet group for Jale RDS instance',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    // Database credentials stored in Secrets Manager
    const credentials = rds.Credentials.fromGeneratedSecret('jale_admin');

    // Engine audit logging (see AuditEngineWindow). The group is a plain
    // CloudFormation resource so it exists while unattached; the L2 group
    // only synthesizes once something binds it.
    this.auditEngineWindow = props.auditEngineWindow ?? DB_AUDIT_ENGINE_WINDOW;
    const preloadDefault = props.auditPreloadDefault ?? DEV_PRELOAD_DEFAULT;
    checkPreloadPin(this.auditEngineWindow, 'auditPreloadPin' in props ? props.auditPreloadPin : DB_AUDIT_PRELOAD_PIN, preloadDefault);
    this.auditParameterGroup = new rds.CfnDBParameterGroup(this, 'AuditParameterGroup', {
      family: 'postgres16',
      description: 'Engine audit logging: pgAudit preloaded, terse errors, connection logging',
      parameters: auditEngineParameters(preloadDefault),
    });
    const auditWindowSettings: Partial<rds.DatabaseInstanceProps> = {
      ...(this.auditEngineWindow >= 1
        ? { parameterGroup: rds.ParameterGroup.fromParameterGroupName(this, 'AuditParameterGroupRef', this.auditParameterGroup.ref) }
        : {}),
      ...(this.auditEngineWindow >= 3 ? { cloudwatchLogsExports: ['postgresql'] } : {}),
    };

    this.dbInstance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      subnetGroup,
      securityGroups: [rdsSg],
      credentials,
      databaseName: this.dbName,
      backupRetention: cdk.Duration.days(7),
      ...DB_ENGINE_SETTINGS,
      deletionProtection,
      multiAz,
      removalPolicy,
      storageEncrypted: true,
      ...auditWindowSettings,
    });

    this.dbSecret = this.dbInstance.secret!;
    this.matchingDbSecret = new secretsmanager.Secret(this, 'MatchingDbSecret', {
      secretName: 'jale/matching/db',
      description: 'jale_matching role DB credentials for matching engine reads/writes',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'jale_matching' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.aiDbSecret = new secretsmanager.Secret(this, 'AiDbSecret', {
      secretName: 'jale/ai/db',
      description: 'jale_ai role DB credentials for AI trust assessment service writes',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_ai',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.adminConsoleDbSecret = new secretsmanager.Secret(this, 'AdminConsoleDbSecret', {
      secretName: 'jale/admin-console/db',
      description: 'jale_admin_console role DB credentials for the admin Next.js Lambda',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_admin_console',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.adminConsoleDbSecret.applyRemovalPolicy(removalPolicy);

    // Generated credential for the jale_billing service role (webhook processor).
    // Password is set on the role during the 034 migration bastion session.
    this.billingDbSecret = new secretsmanager.Secret(this, 'BillingDbSecret', {
      secretName: 'jale/billing/db',
      description: 'jale_billing service role credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_billing',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.billingDbSecret.applyRemovalPolicy(removalPolicy);

    // Generated credential for the jale_public_jobs role (unauthenticated public
    // job read + apply-intent). The role itself is created by migration 056
    // (infra/db/migrations/056_job_referrals.sql) — this secret only provisions
    // the CDK-managed password half. Its password must still be SET on the
    // jale_public_jobs role by the migration runners (same bastion-session
    // pattern used for jale_billing/034), not invented as a new migration here.
    this.referralsDbSecret = new secretsmanager.Secret(this, 'ReferralsDbSecret', {
      secretName: 'jale/referrals/db',
      description: 'jale_public_jobs role DB credentials for the unauthenticated public job/apply-intent Lambdas',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_public_jobs',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.referralsDbSecret.applyRemovalPolicy(removalPolicy);

    this.dbEndpoint = this.dbInstance.dbInstanceEndpointAddress;
    this.dbPort = this.dbInstance.dbInstanceEndpointPort;

    // Reads the catalog through its own login's secret; it references nothing
    // above, so adding it leaves every existing resource as it was.
    this.posture = new DbPostureCheck(this, 'DbPosture', {
      vpc,
      securityGroup: props.network.lambdaSg,
      accessManifest: props.accessManifest ?? defaultAccessManifest(),
      alarmTopicArn: props.alarmTopicArn,
    });
  }
}
