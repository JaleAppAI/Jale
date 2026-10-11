import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import {
  DB_AUDIT_ENGINE_WINDOW,
  DB_AUDIT_PRELOAD_PIN,
  DatabaseStack,
  checkPreloadPin,
  engineDefaultLibraries,
  type AuditEngineWindow,
} from '../../../lib/stacks/database-stack';

/**
 * Engine audit logging: the custom parameter group and the
 * window flag that attaches it and, later, exports the engine log.
 *
 * The release ships the group UNATTACHED. Attaching a group with static
 * parameters reboots the instance, so it happens only in window deploy 1,
 * in a chosen window; the log export follows in window deploy 2, only
 * once the group (and its terse error verbosity) is in force.
 */

/** The preload list window 1 pins in these tests (the documented default). */
const TEST_PIN = 'pg_stat_statements';

function synth(context: Record<string, unknown>, window?: AuditEngineWindow): any {
  // No bundling: these tests read the instance and the parameter group only.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const network = new NetworkStack(app, 'TestNetworkStack');
  // As the composition builds it: the preload default resolved from context.
  // A window given explicitly comes with the test pin; the branch's own
  // window uses the branch's own pin.
  const database = new DatabaseStack(app, 'TestDatabaseStack', {
    network,
    auditPreloadDefault: engineDefaultLibraries(app),
    ...(window === undefined ? {} : { auditEngineWindow: window, auditPreloadPin: TEST_PIN }),
  });
  return Template.fromStack(database).toJSON();
}

function instance(template: any): any {
  const ids = Object.keys(template.Resources).filter((id) => template.Resources[id].Type === 'AWS::RDS::DBInstance');
  expect(ids).toEqual(['DatabaseB269D8BB']);
  return template.Resources[ids[0]];
}

function parameterGroups(template: any): Array<[string, any]> {
  return Object.entries(template.Resources).filter(([, r]: [string, any]) => r.Type === 'AWS::RDS::DBParameterGroup') as Array<[string, any]>;
}

const PRODUCTION = { environment: 'production', dbSharedPreloadLibrariesDefault: 'pg_stat_statements' };

/**
 * The window this branch is at. The release ships 0 (the group unattached);
 * each window branch raises it, here and in database-stack.ts together, so a
 * change to the window is always a visible, reviewed edit of both files.
 */
const BRANCH_WINDOW = 0 as AuditEngineWindow;

/** The preload list this branch pins in code: none before window 1. */
const BRANCH_PIN = undefined as string | undefined;

describe('the engine audit parameter group', () => {
  it('is at the window this branch pins', () => {
    expect(DB_AUDIT_ENGINE_WINDOW).toBe(BRANCH_WINDOW);
    expect(DB_AUDIT_PRELOAD_PIN).toBe(BRANCH_PIN);
  });

  describe('the preload list from window 1', () => {
    it('is not pinned before the group is attached', () => {
      expect(() => checkPreloadPin(0, undefined, 'pg_stat_statements,pg_cron')).not.toThrow();
    });

    it('must be pinned in code once the group is attached', () => {
      for (const window of [1, 2, 3] as AuditEngineWindow[]) {
        expect(() => checkPreloadPin(window, undefined, 'pg_stat_statements')).toThrow('AUDIT_PRELOAD_PIN_REQUIRED');
      }
    });

    it('refuses a pre-check value that differs from the pin, so a routine deploy cannot swap the group', () => {
      expect(() => checkPreloadPin(1, 'pg_stat_statements', 'pg_stat_statements,pg_cron')).toThrow('AUDIT_PRELOAD_PIN_MISMATCH');
      expect(() => checkPreloadPin(2, '', 'pg_stat_statements')).toThrow('AUDIT_PRELOAD_PIN_MISMATCH');
      expect(() => checkPreloadPin(3, 'pg_stat_statements', 'pg_stat_statements')).not.toThrow();
      expect(() => checkPreloadPin(1, '', '')).not.toThrow();
    });

    it('refuses a pin that is not a library list', () => {
      expect(() => checkPreloadPin(1, 'pg_stat_statements;drop', 'pg_stat_statements;drop')).toThrow('AUDIT_PRELOAD_PIN_INVALID');
      expect(() => checkPreloadPin(1, 'pgaudit', 'pgaudit')).toThrow('AUDIT_PRELOAD_PIN_INVALID');
    });

    it('fails the synth of an attached window when the variable differs from the pin', () => {
      expect(() => synth({ ...PRODUCTION, dbSharedPreloadLibrariesDefault: 'pg_stat_statements,pg_cron' }, 1))
        .toThrow('AUDIT_PRELOAD_PIN_MISMATCH');
      expect(() => synth(PRODUCTION, 1)).not.toThrow();
    });
  });

  it('synthesizes the pinned window by default', () => {
    const props = instance(synth(PRODUCTION)).Properties;
    expect(props.DBParameterGroupName === undefined).toBe(BRANCH_WINDOW === 0);
    expect(props.EnableCloudwatchLogsExports === undefined).toBe(BRANCH_WINDOW < 3);
  });

  it('ships unattached in the release (window 0)', () => {
    const template = synth(PRODUCTION, 0);
    expect(instance(template).Properties.DBParameterGroupName).toBeUndefined();
    expect(instance(template).Properties.EnableCloudwatchLogsExports).toBeUndefined();
  });

  it('holds exactly the static audit parameters for postgres16', () => {
    const groups = parameterGroups(synth(PRODUCTION));
    expect(groups).toHaveLength(1);
    const [, group] = groups[0];
    expect(group.Properties.Family).toBe('postgres16');
    expect(group.Properties.Parameters).toEqual({
      shared_preload_libraries: 'pg_stat_statements,pgaudit',
      log_error_verbosity: 'terse',
      log_connections: '1',
      log_disconnections: '1',
      'pgaudit.log': 'role,ddl',
      'pgaudit.log_parameter': '0',
      'pgaudit.log_catalog': '0',
      'pgaudit.log_relation': '0',
    });
    expect(group.Properties.Parameters).not.toHaveProperty('rds.force_ssl');
    expect(group.Properties.Parameters).not.toHaveProperty('log_statement');
  });

  it('appends pgaudit to the engine default the pre-check found', () => {
    const [, group] = parameterGroups(synth({ ...PRODUCTION, dbSharedPreloadLibrariesDefault: 'pg_stat_statements,pg_cron' }, 0))[0];
    expect(group.Properties.Parameters.shared_preload_libraries).toBe('pg_stat_statements,pg_cron,pgaudit');
    const [, alone] = parameterGroups(synth({ ...PRODUCTION, dbSharedPreloadLibrariesDefault: 'none' }, 0))[0];
    expect(alone.Properties.Parameters.shared_preload_libraries).toBe('pgaudit');
  });

  it('requires the pre-check value in production', () => {
    expect(() => synth({ environment: 'production' })).toThrow('AUDIT_PRELOAD_DEFAULT_REQUIRED');
    expect(() => synth({ environment: 'production', dbSharedPreloadLibrariesDefault: '' })).toThrow('AUDIT_PRELOAD_DEFAULT_REQUIRED');
  });

  it.each([['pg_stat_statements;drop'], ['Pg_Stat'], ['a,,b'], ['pg_stat_statements,pgaudit']])('refuses %s', (value) => {
    expect(() => synth({ environment: 'production', dbSharedPreloadLibrariesDefault: value })).toThrow('AUDIT_PRELOAD_DEFAULT_INVALID');
  });

  it('uses the documented default when built alone, without the composition', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], environment: 'production' } });
    const database = new DatabaseStack(app, 'Alone', { network: new NetworkStack(app, 'AloneNetwork'), auditEngineWindow: 0 });
    const [, group] = parameterGroups(Template.fromStack(database).toJSON())[0];
    expect(group.Properties.Parameters.shared_preload_libraries).toBe('pg_stat_statements,pgaudit');
  });

  it("uses the documented default outside production, where nothing deploys", () => {
    const [, group] = parameterGroups(synth({ environment: 'dev' }, 0))[0];
    expect(group.Properties.Parameters.shared_preload_libraries).toBe('pg_stat_statements,pgaudit');
  });

  it('window 1 attaches the group and exports nothing', () => {
    const template = synth(PRODUCTION, 1);
    const [groupId] = parameterGroups(template)[0];
    expect(instance(template).Properties.DBParameterGroupName).toEqual({ Ref: groupId });
    expect(instance(template).Properties.EnableCloudwatchLogsExports).toBeUndefined();
  });

  it('window 2 keeps the instance as window 1 left it: the engine log group comes first, in the audit stack', () => {
    expect(instance(synth(PRODUCTION, 2)).Properties).toEqual(instance(synth(PRODUCTION, 1)).Properties);
  });

  it('window 3 exports the engine log', () => {
    const template = synth(PRODUCTION, 3);
    const [groupId] = parameterGroups(template)[0];
    expect(instance(template).Properties.DBParameterGroupName).toEqual({ Ref: groupId });
    expect(instance(template).Properties.EnableCloudwatchLogsExports).toEqual(['postgresql']);
  });

  it('changes nothing else on the instance in any window', () => {
    const strip = (props: any) => {
      const { DBParameterGroupName: _g, EnableCloudwatchLogsExports: _e, ...rest } = props;
      return rest;
    };
    const release = strip(instance(synth(PRODUCTION, 0)).Properties);
    for (const window of [1, 2, 3] as AuditEngineWindow[]) {
      expect(strip(instance(synth(PRODUCTION, window)).Properties)).toEqual(release);
    }
  });
});
