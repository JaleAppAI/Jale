import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const requiredFiles = [
  '.github/CODEOWNERS',
  '.github/actions/setup-node-cache/action.yml',
  '.github/actions/aws-oidc-login/action.yml',
  '.github/workflows/pr-validate.yml',
  '.github/workflows/deploy-production.yml',
  '.github/workflows/_reusable-validate.yml',
  '.github/workflows/_reusable-deploy.yml',
];

function fail(message) {
  console.error(`CI workflow validation failed: ${message}`);
  process.exitCode = 1;
}

function readRequired(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    fail(`missing ${path}`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}

function requireIncludes(file, content, expected) {
  if (!content.includes(expected)) {
    fail(`${file} must include ${expected}`);
  }
}

function requireMatches(file, content, pattern, description) {
  if (!pattern.test(content)) {
    fail(`${file} must include ${description}`);
  }
}

for (const file of requiredFiles) {
  readRequired(file);
}

const prValidate = readRequired('.github/workflows/pr-validate.yml');
const deployProduction = readRequired('.github/workflows/deploy-production.yml');
const reusableValidate = readRequired('.github/workflows/_reusable-validate.yml');
const reusableDeploy = readRequired('.github/workflows/_reusable-deploy.yml');
const setupNode = readRequired('.github/actions/setup-node-cache/action.yml');
const awsLogin = readRequired('.github/actions/aws-oidc-login/action.yml');
const codeowners = readRequired('.github/CODEOWNERS');

requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'pull_request:');
requireMatches('.github/workflows/pr-validate.yml', prValidate, /branches:\s*\[[^\]]*prod[^\]]*\]/, 'prod pull request validation');
requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'cancel-in-progress: true');
requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'contents: read');

requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'deploy-production');
requireMatches('.github/workflows/deploy-production.yml', deployProduction, /branches:\s*\[\s*prod\s*\]/, 'push trigger for prod only');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "github.ref == 'refs/heads/prod'");
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'Require prod branch');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'cancel-in-progress: false');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'id-token: write');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, '_reusable-deploy.yml');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "grep -Ev '^infra/package(-lock)?\\.json$'");

requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run build');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm test -- --runInBand');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npx cdk synth');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm audit --audit-level=high');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'node scripts/validate-github-workflows.mjs');

requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'environment: ${{ inputs.github-environment }}');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleFrontendStack');
if (reusableDeploy.includes('JaleBastionStack')) {
  fail('.github/workflows/_reusable-deploy.yml must not deploy JaleBastionStack by default');
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk diff');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk deploy');

requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, 'actions/setup-node');
requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, 'npm ci');
requireIncludes('.github/actions/aws-oidc-login/action.yml', awsLogin, 'aws-actions/configure-aws-credentials');

for (const ownerPath of ['.github/', 'infra/', 'infra/db/migrations/', 'scripts/run-migrations*']) {
  requireIncludes('.github/CODEOWNERS', codeowners, ownerPath);
}

for (const file of [
  '.github/workflows/pr-validate.yml',
  '.github/workflows/deploy-production.yml',
  '.github/workflows/_reusable-validate.yml',
  '.github/workflows/_reusable-deploy.yml',
]) {
  const content = readRequired(file);
  if (content.includes('pull_request_target')) {
    fail(`${file} must not use pull_request_target`);
  }
}

for (const deprecatedFile of ['.github/workflows/deploy-dev.yml', '.github/workflows/deploy-prod.yml']) {
  if (existsSync(join(root, deprecatedFile))) {
    fail(`${deprecatedFile} must not exist; production deploys use deploy-production.yml`);
  }
}
