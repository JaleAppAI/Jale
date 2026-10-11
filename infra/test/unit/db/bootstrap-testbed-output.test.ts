/**
 * bootstrap-testbed-output.test.ts -- the test-bed bootstrap never prints a
 * password.
 *
 * CI runs infra/db/local/bootstrap-testbed.sh on every pull request, and the
 * job's output is public. The bed's passwords are throwaway values, but a
 * credential printed into a log is still a credential in a log, and the habit
 * is what matters. The URL the script exports to its command carries the
 * password; what it prints carries `***` in its place.
 *
 * The checks read the script's own text: every statement that writes to the
 * terminal (echo, printf) is inspected for the variables that hold a password
 * or a URL that contains one.
 */
import * as fs from 'fs';
import * as path from 'path';

const script = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'db', 'local', 'bootstrap-testbed.sh'), 'utf8');

/** The script's lines that write to the terminal, comments excluded. */
function outputLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .filter((line) => /\b(echo|printf)\b/.test(line));
}

/** The variables that hold a password, or a URL with one in it. */
const SECRET_VARIABLES = ['superpass', 'admin_pass', 'url', 'passwords_sql'];

describe('bootstrap-testbed.sh output', () => {
  it('builds the exported URL with the password and a printable copy without it, for both URL users', () => {
    expect(script).toMatch(/url="postgres:\/\/\$\{admin_user\}:\$\{admin_pass\}@/);
    expect(script).toMatch(/url="postgres:\/\/\$\{superuser\}:\$\{superpass\}@/);
    expect(script).toMatch(/display_url="postgres:\/\/\$\{admin_user\}:\*\*\*@127\.0\.0\.1:\$\{port\}\/\$\{db\}"/);
    expect(script).toMatch(/display_url="postgres:\/\/\$\{superuser\}:\*\*\*@127\.0\.0\.1:\$\{port\}\/\$\{db\}"/);
  });

  it('prints the URL only in its masked form', () => {
    expect(script).toContain('echo ">> ${url_var}=$display_url"');
  });

  it('never prints a variable that holds a password', () => {
    const leaks = outputLines(script).filter((line) =>
      SECRET_VARIABLES.some((name) => new RegExp(`\\$(\\{${name}\\}|${name}\\b)`).test(line)));
    expect(leaks).toEqual([]);
  });
});
