import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'inspect-trust-score.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('inspect-trust-score.ps1', () => {
  it('supports writing the inspection output to a local log file', () => {
    const script = readScript();

    expect(script).toContain('[string]$LogPath');
    expect(script).toContain('Write-InspectionLog');
    expect(script).toContain('[System.IO.File]::WriteAllText');
    expect(script).toContain('get-command-invocation');
    expect(script).toContain('StandardOutputContent');
    expect(script).toContain('>> Full inspection log written to:');
  });

  it('includes custom trust profile data needed to debug WhatsApp profile display', () => {
    const script = readScript();

    expect(script).toContain('=== Trade question cache ===');
    expect(script).toContain('=== WhatsApp conversation ===');
    expect(script).toContain('=== Profile command trust view ===');
    expect(script).toContain('trade_questions');
    expect(script).toContain('worker_trust_assessments');
    expect(script).toContain('trade_competency_score');
  });
});
