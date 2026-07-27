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
  'scripts/run-admin-migration.ps1',
  'scripts/bootstrap-admin-user.ps1',
  'scripts/run-production-upgrade-020b-040.sh',
  'docs/production-upgrade-020b-040.md',
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
const adminMigration = readRequired('scripts/run-admin-migration.ps1');
const adminBootstrap = readRequired('scripts/bootstrap-admin-user.ps1');

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
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'admin-prerequisites');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleDatabaseStack JaleAdminCertStack');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleDatabaseStack JaleWhatsAppStack JaleAdminStack');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "vars.CDK_CONTEXT_ENVIRONMENT || 'production'");

requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run build');
// test:ci (plain jest) rather than `npm test`: the default test script
// carries --maxWorkers=2 (dev-host OOM cap) and jest rejects combining
// --maxWorkers with --runInBand in a single invocation.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:ci -- --runInBand');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npx cdk synth');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c emailFromAddress=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesVerifiedIdentityArn=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappAlarmTopicArn=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm audit --audit-level=high');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'node scripts/validate-github-workflows.mjs');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'working-directory: admin');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:session');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:dispatch');

requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'environment: ${{ inputs.github-environment }}');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'plan:\n    name: Production plan\n    runs-on: ubuntu-latest\n    environment: ${{ inputs.github-environment }}');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleFrontendStack');
if (reusableDeploy.includes('JaleBastionStack')) {
  fail('.github/workflows/_reusable-deploy.yml must not deploy JaleBastionStack by default');
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk diff');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '--no-change-set');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk deploy');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c deletionProtection=true');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_EMAIL_FROM_ADDRESS');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_SES_VERIFIED_IDENTITY_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c emailFromAddress=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c sesVerifiedIdentityArn=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'WHATSAPP_ALARM_TOPIC_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'JALE_WHATSAPP_STATUS_CALLBACK_URL');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappAlarmTopicArn=');
const productionFifoTransportContexts =
  reusableDeploy.match(/-c whatsappInboundV2TransportEnabled=true/g) ?? [];
if (productionFifoTransportContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must enable WhatsApp v2 FIFO transport ' +
      'for all 4 production CDK plan/diff/deploy commands',
  );
}

requireIncludes('scripts/run-admin-migration.ps1', adminMigration, '026_admin_panel.sql');
requireIncludes('scripts/run-admin-migration.ps1', adminMigration, 'jale_admin_console');
if (adminMigration.includes('ALTER ROLE jale_whatsapp') || adminMigration.includes('ALTER ROLE jale_matching')) {
  fail('scripts/run-admin-migration.ps1 must not rotate unrelated database roles');
}

requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin-create-user');
requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin-add-user-to-group');
requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin_users');

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
