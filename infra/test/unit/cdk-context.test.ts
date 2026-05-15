import * as fs from 'node:fs';
import * as path from 'node:path';

describe('cdk context defaults', () => {
  it('defaults CLI synth/deploy CORS origin to production domain', () => {
    const cdkJsonPath = path.join(__dirname, '../../cdk.json');
    const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));

    expect(cdkJson.context.allowedOrigin).toBe('https://jaleapp.ai');
  });
});
