import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deleteTestUser } from '../helpers/cognito-admin';

module.exports = async () => {
  dotenv.config({ path: path.join(__dirname, '../../../.env.integration'), override: true });

  const { WORKER_POOL_ID, EMPLOYER_POOL_ID } = process.env;

  if (WORKER_POOL_ID && EMPLOYER_POOL_ID) {
    await Promise.all([
      deleteTestUser(WORKER_POOL_ID, '+19999000001'),
      deleteTestUser(WORKER_POOL_ID, '+19999000002'),
      deleteTestUser(WORKER_POOL_ID, '+19999000003'),
      deleteTestUser(EMPLOYER_POOL_ID, 'test-integration-employer@jale.test'),
      deleteTestUser(EMPLOYER_POOL_ID, 'test-integration-profile-employer@jale.test'),
    ]);
    console.log('\n[global-teardown] Test users deleted.');
  }

  const tokenFile = path.join(os.tmpdir(), 'jale-integration-tokens.json');
  if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
};
