import * as fs from 'node:fs';
import * as path from 'node:path';

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
