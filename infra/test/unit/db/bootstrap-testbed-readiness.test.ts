/**
 * bootstrap-testbed-readiness.test.ts -- the test bed is ready only when the
 * final server answers.
 *
 * On a new data directory the postgres image's entrypoint starts a temporary
 * server to create the database, then stops it and starts the final one. The
 * temporary server listens on the Unix socket only (listen_addresses=''), and it
 * reports ready like the final one does. A readiness probe over the socket can
 * therefore pass against the temporary server, and the next command then meets
 * "the database system is shutting down". Over TCP only the final server
 * answers, so every readiness probe for the bed asks over TCP.
 *
 * The checks read the script's and the compose file's own text.
 */
import * as fs from 'fs';
import * as path from 'path';

const localDir = path.join(__dirname, '..', '..', '..', 'db', 'local');
const script = fs.readFileSync(path.join(localDir, 'bootstrap-testbed.sh'), 'utf8');
const compose = fs.readFileSync(path.join(localDir, 'docker-compose.wa-v2.yml'), 'utf8');

/** The lines that run pg_isready, comments excluded. */
function probes(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .filter((line) => /\bpg_isready\b/.test(line));
}

describe('test bed readiness', () => {
  it('waits for the bed with pg_isready in the bootstrap script and the compose healthcheck', () => {
    expect(probes(script).length).toBeGreaterThanOrEqual(2);
    expect(probes(compose)).toHaveLength(1);
  });

  it('asks over TCP in every bootstrap probe, so the temporary init server never counts as ready', () => {
    for (const line of probes(script)) {
      expect(line).toMatch(/\bpg_isready -h 127\.0\.0\.1 -p 5432 /);
    }
  });

  it('asks over TCP in the compose healthcheck', () => {
    for (const line of probes(compose)) {
      expect(line).toMatch(/\bpg_isready -h 127\.0\.0\.1 -p 5432 /);
    }
  });
});
