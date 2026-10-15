import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'seed-whatsapp-ranked-jobs.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('seed-whatsapp-ranked-jobs.ps1', () => {
  it('runs the ranked WhatsApp jobs seed through the database bastion', () => {
    const script = readScript();

    expect(script).toContain('JaleBastionStack');
    expect(script).toContain('JaleDatabaseStack');
    expect(script).toContain('aws ssm send-command');
    expect(script).toContain('AWS-RunShellScript');
    expect(script).toContain("contains(LogicalResourceId, 'DatabaseSecret')");
  });

  it('seeds jobs derived from the selected worker current profile', () => {
    const script = readScript();

    expect(script).toContain('[string]$Phone');
    expect(script).toContain('[string]$WorkerId');
    expect(script).toContain('_target_profile');
    expect(script).toContain('profile_profession');
    expect(script).toContain('profile_location');
    expect(script).toContain('Profile Match');
    expect(script).toContain('No worker found for the supplied phone or worker id.');
    expect(script).not.toContain('[switch]$SetWorkerDrywallProfile');
    expect(script).not.toContain("main_trade_other = 'Drywaller'");
  });

  it('keeps job_candidates seeding behind an explicit future-materialization flag', () => {
    const script = readScript();

    expect(script).toContain('[switch]$AlsoSeedJobCandidates');
    expect(script).toContain('$AlsoSeedJobCandidatesSql');
    expect(script).toContain('IF $AlsoSeedJobCandidatesSql THEN');
    expect(script).toContain('job_candidates');
  });

  it('gives the seeded employer a company through the sign-up bootstrap, after the users row', () => {
    const script = readScript();

    expect(script).toContain("PERFORM set_config('app.current_user_id', 'seed-employer-profile-match', true);");
    expect(script).toContain("PERFORM public.employer_ensure_organization('Jale Profile Match Fixtures');");
    expect(script.indexOf('employer_ensure_organization'))
      .toBeGreaterThan(script.indexOf("INSERT INTO _employer(id) VALUES (:'seed_employer_id');"));
  });
});
