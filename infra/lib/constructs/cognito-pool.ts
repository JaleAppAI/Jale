import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface CognitoPoolProps {
  /** Name for the user pool */
  poolName: string;
  /** Sign-in aliases */
  signInAliases: {
    phone?: boolean;
    email?: boolean;
  };
  /** MFA enforcement level */
  mfa: cognito.Mfa;
  /** MFA second factor configuration (SMS, TOTP) */
  mfaSecondFactor?: cognito.MfaSecondFactor;
  /** Password policy overrides */
  passwordPolicy?: cognito.PasswordPolicy;
  /** Whether users can self-register */
  selfSignUp: boolean;
  /** Auto-verified attributes */
  autoVerify?: {
    email?: boolean;
    phone?: boolean;
  };
  /** Custom attributes to add to the pool */
  customAttributes?: Record<string, cognito.ICustomAttribute>;
  /** Lambda triggers */
  lambdaTriggers?: {
    postConfirmation?: lambda.IFunction;
    defineAuthChallenge?: lambda.IFunction;
    createAuthChallenge?: lambda.IFunction;
    /**
     * Note: the CDK property key is `verifyAuthChallengeResponse` (NOT
     * `verifyAuthChallenge`). Using the wrong key silently fails to wire
     * the trigger, so OTP verification would never fire. Keep the prop
     * name matching CDK's expected key.
     */
    verifyAuthChallengeResponse?: lambda.IFunction;
    /**
     * Rewrites the subject/body of the sign-up, resend-code, forgot-password and
     * attribute-verification emails Cognito sends for this pool (MFA and
     * admin-create-user messages are left to Cognito). The handler must fail open:
     * Cognito rejects the whole SignUp/ForgotPassword call if this trigger
     * throws or returns a malformed message.
     */
    customMessage?: lambda.IFunction;
  };
  /** IAM role for SMS sending */
  smsRole?: iam.IRole;
  /** External ID for SMS role */
  smsExternalId?: string;
  /** Enable ADMIN_USER_PASSWORD_AUTH flow — for integration tests only, must NOT be true in prod */
  adminUserPassword?: boolean;
  /**
   * Email sending configuration. Use `cognito.UserPoolEmail.withSES(...)` to
   * enable SES developer sending from an authenticated domain. Omit (or leave
   * undefined) to use Cognito's default shared email service.
   *
   * Operator pre-requisites before deploy (not enforced by CDK). Authoritative
   * checklist is in AuthStack where the context vars are read and validated:
   *   1. SES domain identity verified for the sender domain.
   *   2. SES identity resource policy grants cognito-idp.amazonaws.com
   *      ses:SendEmail / ses:SendRawEmail, scoped to the user pool ARN.
   *   3. SES account out of sandbox (or destination addresses sandbox-verified).
   */
  email?: cognito.UserPoolEmail;
  /**
   * Cognito-side DeletionProtection. ACTIVE makes DeleteUserPool (and any
   * CloudFormation replace/delete of the pool) fail until an operator turns it
   * off explicitly, which is the only thing standing between a mis-scoped
   * `cdk destroy` and the loss of every registered user. Resolve with
   * `resolveCognitoDeletionProtection(this)` rather than hardcoding.
   *
   * Omitting it defaults to PROTECTED. Disarming a live pool has to be a thing
   * someone typed, not a thing they forgot.
   */
  deletionProtection?: boolean;
}

/**
 * Reads the app-wide `deletionProtection` CDK context flag, FAIL-SAFE: anything
 * other than an explicit false disarms nothing.
 *
 * Same `!== false` shape as database-stack.ts:30, and for the same reason: a
 * property whose whole job is to stop an accidental delete must not be switched
 * off by an omission. The production deploy workflow passes
 * `-c deletionProtection=true` on synth, both diffs and deploy
 * (.github/workflows/_reusable-deploy.yml; the four occurrences are pinned by
 * scripts/validate-github-workflows.mjs), and `-c` context is app-global, so
 * every stack sees it. Any synth that does not — a stack built straight from a
 * unit test, a scratch app, a future entrypoint that forgets the flag — now
 * plans ACTIVE instead of quietly planning INACTIVE over live pools.
 *
 * What this does NOT cover, and the reason the two runbooks were amended: `-c`
 * is not the only source. cdk.json pins `deletionProtection: false` for dev and
 * is read by every `cdk` invocation from `infra/`, so a hand-run
 * `cdk deploy JaleAuthStack` (which scripts/run-migrations.ps1 and
 * scripts/run-migration-022.ps1 both print as the next step) still resolves to
 * false unless it passes `-c deletionProtection=true`. Fail-safe closes the
 * absent-context case, not the wrong-context one — deploy through the workflow.
 *
 * The `'false'` arm exists because the CDK CLI hands `-c` values through as
 * STRINGS: `-c deletionProtection=false` arrives as `'false'`, not `false`.
 */
export function resolveCognitoDeletionProtection(scope: Construct): boolean {
  const value = scope.node.tryGetContext('deletionProtection');
  return value !== false && value !== 'false';
}

export { CognitoPool as JaleCognitoPool };

export class CognitoPool extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolId: string;
  public readonly userPoolArn: string;
  public readonly clientId: string;

  constructor(scope: Construct, id: string, props: CognitoPoolProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: props.poolName,
      signInAliases: props.signInAliases,
      selfSignUpEnabled: props.selfSignUp,
      autoVerify: props.autoVerify,
      mfa: props.mfa,
      mfaSecondFactor: props.mfaSecondFactor,
      passwordPolicy: props.passwordPolicy,
      customAttributes: props.customAttributes,
      lambdaTriggers: props.lambdaTriggers
        ? {
            postConfirmation: props.lambdaTriggers.postConfirmation,
            defineAuthChallenge: props.lambdaTriggers.defineAuthChallenge,
            createAuthChallenge: props.lambdaTriggers.createAuthChallenge,
            // CDK key is `verifyAuthChallengeResponse`, NOT `verifyAuthChallenge`
            verifyAuthChallengeResponse: props.lambdaTriggers.verifyAuthChallengeResponse,
            customMessage: props.lambdaTriggers.customMessage,
          }
        : undefined,
      smsRole: props.smsRole,
      smsRoleExternalId: props.smsExternalId,
      email: props.email,
      deletionProtection: props.deletionProtection ?? true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Note: CDK automatically includes ALLOW_REFRESH_TOKEN_AUTH when any auth flow is enabled.
    // adminUserPassword is enabled only when explicitly requested (non-prod integration tests).
    const authFlows: cognito.AuthFlow = {
      userSrp: true,
      custom: props.signInAliases.phone ? true : false,
      adminUserPassword: props.adminUserPassword ?? false,
    };

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      authFlows,
      preventUserExistenceErrors: true,
    });

    this.userPoolId = this.userPool.userPoolId;
    this.userPoolArn = this.userPool.userPoolArn;
    this.clientId = this.userPoolClient.userPoolClientId;
  }
}
