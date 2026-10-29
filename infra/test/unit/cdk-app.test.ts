import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { resolveTeamManagementEnabled } from '../../lib/app-composition';

describe('the team-management flag', () => {
  const saved = process.env.JALE_TEAM_MANAGEMENT_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.JALE_TEAM_MANAGEMENT_ENABLED;
    else process.env.JALE_TEAM_MANAGEMENT_ENABLED = saved;
  });

  const app = (context: Record<string, unknown> = {}) => new cdk.App({ context });

  it('TEAM_MANAGEMENT_ENABLED is false without context and env, true with -c teamManagementEnabled=true or JALE_TEAM_MANAGEMENT_ENABLED=true', () => {
    delete process.env.JALE_TEAM_MANAGEMENT_ENABLED;
    expect(resolveTeamManagementEnabled(app())).toBe(false);

    expect(resolveTeamManagementEnabled(app({ teamManagementEnabled: 'true' }))).toBe(true);
    // cdk.json context arrives as a boolean.
    expect(resolveTeamManagementEnabled(app({ teamManagementEnabled: true }))).toBe(true);

    process.env.JALE_TEAM_MANAGEMENT_ENABLED = 'true';
    expect(resolveTeamManagementEnabled(app())).toBe(true);
  });

  it('only exactly true turns it on; context wins over the environment', () => {
    // An unset GitHub variable expands to ''.
    for (const value of ['', 'false', 'TRUE', '1', 'yes', ' true ']) {
      process.env.JALE_TEAM_MANAGEMENT_ENABLED = value;
      expect(resolveTeamManagementEnabled(app())).toBe(value.trim() === 'true');
    }
    process.env.JALE_TEAM_MANAGEMENT_ENABLED = 'true';
    expect(resolveTeamManagementEnabled(app({ teamManagementEnabled: 'false' }))).toBe(false);
    delete process.env.JALE_TEAM_MANAGEMENT_ENABLED;
    expect(resolveTeamManagementEnabled(app({ teamManagementEnabled: false }))).toBe(false);
  });
});

describe('cdk app entrypoint', () => {
  // The composition moved out of bin/jale-app.ts into lib/app-composition.ts
  // so tests can synthesize the real app (see
  // test/unit/stacks/api-stack-resource-ceiling.test.ts). The bin file is now
  // just `new cdk.App()` + `buildJaleApp(app)`.
  const readEntrypoint = () => fs.readFileSync(path.join(__dirname, '../../bin/jale-app.ts'), 'utf8');
  const readComposition = () => fs.readFileSync(path.join(__dirname, '../../lib/app-composition.ts'), 'utf8');

  it('delegates the whole composition to lib/app-composition.ts', () => {
    const entry = readEntrypoint();

    expect(entry).toContain("from '../lib/app-composition'");
    expect(entry).toContain('buildJaleApp(app)');
  });

  it('can skip the frontend stack for backend-only deploys', () => {
    const app = readComposition();

    expect(app).toContain("tryGetContext('skipFrontend')");
    expect(app).toContain('if (!skipFrontend)');
    expect(app).toContain("new FrontendStack(app, 'JaleFrontendStack'");
    expect(app).toContain("new AdminStack(app, 'JaleAdminStack'");
  });

  it('composes the reports stack after ApiStack and before AdminStack, which reads its images', () => {
    const app = readComposition();
    const apiAt = app.indexOf("new ApiStack(app, 'JaleApiStack'");
    const reportsAt = app.indexOf("new ReportsStack(app, 'JaleReportsStack'");
    const adminAt = app.indexOf("new AdminStack(app, 'JaleAdminStack'");

    expect(apiAt).toBeGreaterThan(-1);
    expect(reportsAt).toBeGreaterThan(apiAt);
    expect(adminAt).toBeGreaterThan(reportsAt);
    expect(app.slice(adminAt)).toContain('reportImagesBucket: reports.imagesBucket');
    expect(app.slice(adminAt)).toContain('reportImagesKey: reports.imagesKey');
  });

  it('resolves the team-management flag once, before AuthStack, and feeds Auth, Billing and Frontend', () => {
    const app = readComposition();
    const resolvedAt = app.indexOf('const teamManagementEnabled = resolveTeamManagementEnabled(app)');
    const authAt = app.indexOf("new AuthStack(app, 'JaleAuthStack'");
    const billingAt = app.indexOf("new BillingStack(app, 'JaleBillingStack'");
    const frontendAt = app.indexOf("new FrontendStack(app, 'JaleFrontendStack'");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(resolvedAt);
    expect(app.match(/resolveTeamManagementEnabled\(app\)/g)).toHaveLength(1);
    for (const at of [authAt, billingAt, frontendAt]) {
      const block = app.slice(at, app.indexOf('});', at));
      expect(block).toContain('teamManagementEnabled,');
    }
    expect(app.slice(billingAt, app.indexOf('});', billingAt))).toContain('publicSiteBaseUrl:');
  });

  it('composes the audit stacks, the audit stack right after the database stack', () => {
    const app = readComposition();
    const database = app.indexOf("new DatabaseStack(app, 'JaleDatabaseStack'");
    const archive = app.indexOf("new AuditArchiveStack(app, 'JaleAuditArchiveStack'");
    const audit = app.indexOf("new AuditStack(app, 'JaleAuditStack'");
    const bastion = app.indexOf("new BastionStack(app, 'JaleBastionStack'");
    expect(database).toBeGreaterThan(-1);
    expect(archive).toBeGreaterThan(database);
    expect(audit).toBeGreaterThan(archive);
    expect(bastion).toBeGreaterThan(audit);
    expect(app).toContain('new AuditEdgeStack(app, EDGE_STACK_IDS[region]');
    expect(app).toContain('grantAuditFallback(construct)');
  });
});
