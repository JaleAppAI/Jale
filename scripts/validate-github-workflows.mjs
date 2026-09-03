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
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleDatabaseStack JaleDocumentsStack JaleWhatsAppStack JaleAdminStack');
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
// Cognito employer-pool SES sender: CI synth must exercise the auth-stack SES
// branch (it is dead code unless sesEmailFromAddress is supplied).
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesEmailFromAddress=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesEmailRegion=us-east-1');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappAlarmTopicArn=');
// BillingStack alarms reuse the same monitored ops topic as the WhatsApp/AI/
// referrals alarms; without this context key the stack falls back to creating
// a bare jale-billing-alarms topic that has no subscribers.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c billingAlarmTopicArn=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm audit --omit=dev --audit-level=high');
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
// The flag must ride on ALL FOUR cdk invocations -- plan synth, plan diff,
// deploy diff, deploy. It is app-global context, so it is what arms
// DeletionProtection on the RDS instance and on all three Cognito pools; a
// diff run without it plans INACTIVE and the operator reviews the wrong plan.
const deletionProtectionFlags = reusableDeploy.match(/-c deletionProtection=true/g) ?? [];
if (deletionProtectionFlags.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass -c deletionProtection=true on all four cdk '
    + `invocations (plan synth, plan diff, deploy diff, deploy); found ${deletionProtectionFlags.length}`,
  );
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_EMAIL_FROM_ADDRESS');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_SES_VERIFIED_IDENTITY_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c emailFromAddress=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c sesVerifiedIdentityArn=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'COGNITO_EMAIL_FROM_ADDRESS: ${{ vars.COGNITO_EMAIL_FROM_ADDRESS }}');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'Require Cognito SES sender variable');
// The guard must run in BOTH jobs: the plan job is skipped entirely when no
// plan role is configured, and the deploy job is the one that can break prod.
const cognitoSenderGuards = reusableDeploy.match(/- name: Require Cognito SES sender variable/g) ?? [];
if (cognitoSenderGuards.length !== 2) {
  fail(
    '.github/workflows/_reusable-deploy.yml must guard COGNITO_EMAIL_FROM_ADDRESS in both the plan and deploy jobs',
  );
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'WHATSAPP_ALARM_TOPIC_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'JALE_WHATSAPP_STATUS_CALLBACK_URL');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappAlarmTopicArn=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c billingAlarmTopicArn=');
// Billing alarms are routed to the same monitored ops topic the WhatsApp
// alarms use (vars.WHATSAPP_ALARM_TOPIC_ARN). The paired match also pins the
// flag immediately after whatsappAlarmTopicArn, so a single dropped flag in
// one of the 4 plan/diff/deploy commands fails here instead of silently
// re-creating the unsubscribed jale-billing-alarms topic in production.
const productionBillingAlarmTopicContexts =
  reusableDeploy.match(
    /-c whatsappAlarmTopicArn="\$WHATSAPP_ALARM_TOPIC_ARN" -c billingAlarmTopicArn="\$WHATSAPP_ALARM_TOPIC_ARN"/g,
  ) ?? [];
if (productionBillingAlarmTopicContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must route billing alarms to the ops SNS topic '
      + '(-c billingAlarmTopicArn="$WHATSAPP_ALARM_TOPIC_ARN" immediately after whatsappAlarmTopicArn) '
      + 'in all 4 production CDK plan/diff/deploy commands',
  );
}
const productionFifoTransportContexts =
  reusableDeploy.match(/-c whatsappInboundV2TransportEnabled=true/g) ?? [];
if (productionFifoTransportContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must enable WhatsApp v2 FIFO transport ' +
      'for all 4 production CDK plan/diff/deploy commands',
  );
}
// Cognito + SES is only supported in us-east-1/us-west-2/eu-west-1, so the
// sender region is a literal (the stacks themselves deploy to us-east-2).
const productionCognitoSesContexts =
  reusableDeploy.match(/-c sesEmailFromAddress="\$COGNITO_EMAIL_FROM_ADDRESS" -c sesEmailRegion=us-east-1/g) ?? [];
if (productionCognitoSesContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass the Cognito SES sender ' +
      '(sesEmailFromAddress + sesEmailRegion=us-east-1) to all 4 production CDK plan/diff/deploy commands',
  );
}

// SES configuration set. NotificationsStack creates the set + the SNS event
// destination; BillingStack's sweeper tags outgoing mail with it. If the flag
// reaches only CI synth and not the production commands, every one of those
// resources synthesizes to nothing in prod and the whole bounce/complaint lane
// deploys as a silent no-op -- no error, no alarm, no signal at all. The
// paired match pins the flag immediately after whatsappInboundV2TransportEnabled
// so a single dropped flag in one of the 4 commands fails here.
//
// Deliberately NOT guarded for non-emptiness the way COGNITO_EMAIL_FROM_ADDRESS
// is: the variable is optional by design. An unset GitHub var expands to '',
// which bin/jale-app.ts treats as absent, and that is the supported way to keep
// the feedback lane dark until the cutover.
requireIncludes(
  '.github/workflows/_reusable-deploy.yml',
  reusableDeploy,
  'JALE_SES_CONFIGURATION_SET_NAME: ${{ vars.JALE_SES_CONFIGURATION_SET_NAME }}',
);
const productionSesConfigurationSetContexts =
  reusableDeploy.match(
    /-c whatsappInboundV2TransportEnabled=true -c sesConfigurationSetName="\$JALE_SES_CONFIGURATION_SET_NAME"/g,
  ) ?? [];
if (productionSesConfigurationSetContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass the SES configuration set '
      + '(-c sesConfigurationSetName="$JALE_SES_CONFIGURATION_SET_NAME" immediately after '
      + 'whatsappInboundV2TransportEnabled) in all 4 production CDK plan/diff/deploy commands',
  );
}

// CI synth must exercise the wired path: with no name the configuration set,
// the event destination and the feedback Lambda are all absent from the
// template, so nothing about them would ever be asserted before production.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesConfigurationSetName=');

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
