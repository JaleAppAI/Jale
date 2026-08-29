import * as fs from 'node:fs';
import * as path from 'node:path';

describe('cdk context defaults', () => {
  it('requires local CDK commands to select an environment explicitly', () => {
    const cdkJsonPath = path.join(__dirname, '../../cdk.json');
    const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));
    // The environment guard lives with the composition (lib/app-composition.ts),
    // not the bin entrypoint, since the composition moved out of it.
    const appPath = path.join(__dirname, '../../lib/app-composition.ts');
    const app = fs.readFileSync(appPath, 'utf8');

    expect(cdkJson.context.environment).toBeUndefined();
    expect(app).toContain('CDK_ENVIRONMENT_REQUIRED');
  });

  it('defaults CLI synth/deploy CORS origin to production domain', () => {
    const cdkJsonPath = path.join(__dirname, '../../cdk.json');
    const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));

    expect(cdkJson.context.allowedOrigin).toBe('https://jaleapp.ai');
  });
});
