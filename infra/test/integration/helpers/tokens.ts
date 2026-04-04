import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface UserTokens {
  username: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  workerA: UserTokens;
  workerB: UserTokens;
  employer: UserTokens;
  profileWorker: UserTokens;
  profileEmployer: UserTokens;
}

export function loadTokens(): TokenStore {
  return JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'jale-integration-tokens.json'), 'utf-8'),
  );
}
