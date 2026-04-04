import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestUser, deleteTestUser } from '../helpers/cognito-admin';

// Test usernames: phone format for workers, email format for employers.
const WORKER_A = '+19999000001';
const WORKER_B = '+19999000002';
const EMPLOYER = 'test-integration-employer@jale.test';
const PROFILE_WORKER = '+19999000003';
const PROFILE_EMPLOYER = 'test-integration-profile-employer@jale.test';

module.exports = async () => {
  dotenv.config({ path: path.join(__dirname, '../../../.env.integration'), override: true });

  const {
    WORKER_POOL_ID,
    WORKER_CLIENT_ID,
    EMPLOYER_POOL_ID,
    EMPLOYER_CLIENT_ID,
    POST_CONFIRMATION_LAMBDA_ARN,
  } = process.env;

  if (!WORKER_POOL_ID || !WORKER_CLIENT_ID || !EMPLOYER_POOL_ID || !EMPLOYER_CLIENT_ID || !POST_CONFIRMATION_LAMBDA_ARN) {
    throw new Error(
      'Missing required env vars. Check infra/.env.integration - ' +
      'WORKER_POOL_ID, WORKER_CLIENT_ID, EMPLOYER_POOL_ID, EMPLOYER_CLIENT_ID, and POST_CONFIRMATION_LAMBDA_ARN must all be set.',
    );
  }

  if (POST_CONFIRMATION_LAMBDA_ARN.includes('FILL_ME_IN')) {
    throw new Error('POST_CONFIRMATION_LAMBDA_ARN still has placeholder value. Fill it in from the AWS Console.');
  }

  // Clean up any leftover users from a previous crashed run.
  await Promise.all([
    deleteTestUser(WORKER_POOL_ID, WORKER_A),
    deleteTestUser(WORKER_POOL_ID, WORKER_B),
    deleteTestUser(WORKER_POOL_ID, PROFILE_WORKER),
    deleteTestUser(EMPLOYER_POOL_ID, EMPLOYER),
    deleteTestUser(EMPLOYER_POOL_ID, PROFILE_EMPLOYER),
  ]);

  const password = 'TestPass123!';

  const [workerA, workerB, employer, profileWorker, profileEmployer] = await Promise.all([
    createTestUser(WORKER_POOL_ID, WORKER_CLIENT_ID, WORKER_A, password, 'worker', POST_CONFIRMATION_LAMBDA_ARN),
    createTestUser(WORKER_POOL_ID, WORKER_CLIENT_ID, WORKER_B, password, 'worker', POST_CONFIRMATION_LAMBDA_ARN),
    createTestUser(EMPLOYER_POOL_ID, EMPLOYER_CLIENT_ID, EMPLOYER, password, 'employer', POST_CONFIRMATION_LAMBDA_ARN),
    createTestUser(WORKER_POOL_ID, WORKER_CLIENT_ID, PROFILE_WORKER, password, 'worker', POST_CONFIRMATION_LAMBDA_ARN),
    createTestUser(EMPLOYER_POOL_ID, EMPLOYER_CLIENT_ID, PROFILE_EMPLOYER, password, 'employer', POST_CONFIRMATION_LAMBDA_ARN),
  ]);

  const tokens = {
    workerA: { username: WORKER_A, ...workerA },
    workerB: { username: WORKER_B, ...workerB },
    employer: { username: EMPLOYER, ...employer },
    profileWorker: { username: PROFILE_WORKER, ...profileWorker },
    profileEmployer: { username: PROFILE_EMPLOYER, ...profileEmployer },
  };

  fs.writeFileSync(
    path.join(os.tmpdir(), 'jale-integration-tokens.json'),
    JSON.stringify(tokens, null, 2),
  );

  console.log('\n[global-setup] Test users created and tokens written to temp file.');
};
