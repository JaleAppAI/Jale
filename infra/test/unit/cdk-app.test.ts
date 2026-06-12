import * as fs from 'node:fs';
import * as path from 'node:path';

describe('cdk app entrypoint', () => {
  const readApp = () => fs.readFileSync(path.join(__dirname, '../../bin/jale-app.ts'), 'utf8');

  it('can skip the frontend stack for backend-only deploys', () => {
    const app = readApp();

    expect(app).toContain("tryGetContext('skipFrontend')");
    expect(app).toContain('if (!skipFrontend)');
    expect(app).toContain("new FrontendStack(app, 'JaleFrontendStack'");
    expect(app).toContain("new AdminStack(app, 'JaleAdminStack'");
  });
});