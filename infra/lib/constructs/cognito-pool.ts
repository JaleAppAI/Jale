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
  };
  /** IAM role for SMS sending */
  smsRole?: iam.IRole;
  /** External ID for SMS role */
  smsExternalId?: string;
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
          }
        : undefined,
      smsRole: props.smsRole,
      smsRoleExternalId: props.smsExternalId,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Note: CDK automatically includes ALLOW_REFRESH_TOKEN_AUTH when any auth flow is enabled.
    const authFlows: cognito.AuthFlow = {
      userSrp: true,
      custom: props.signInAliases.phone ? true : false,
      adminUserPassword: true,
    };

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      authFlows,
    });

    this.userPoolId = this.userPool.userPoolId;
    this.userPoolArn = this.userPool.userPoolArn;
    this.clientId = this.userPoolClient.userPoolClientId;
  }
}
