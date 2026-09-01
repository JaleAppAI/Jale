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
});
