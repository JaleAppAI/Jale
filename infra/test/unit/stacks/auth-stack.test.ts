import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';

describe('AuthStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        environment: 'production',
        otpSmsFromNumber: '+15125550123',
        otpSmsRequestTimeoutMs: 3500,
        otpSmsValidityPeriodSeconds: 180,
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    }); 
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    template = Template.fromStack(auth);
  });

  test('Two Cognito UserPools exist', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
  });

  test('Worker pool uses only the custom OTP challenge, with Cognito MFA disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      MfaConfiguration: 'OFF',
    });
  });

  test('UserPoolClients exist with generateSecret false', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  test('UserPoolClients include ALLOW_REFRESH_TOKEN_AUTH', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_REFRESH_TOKEN_AUTH']),
    });
  });

  test('Post-confirmation Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
    });
  });

  test('SQS dead-letter queue exists', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-post-confirmation-dlq',
    });
  });

  // SMS IAM role now lives in NetworkStack (pre-deployed for IAM propagation).
  // See network-stack.test.ts for the cognito-idp trust assertion.

  // Cognito User Groups
  test('Workers group exists in Worker pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Workers',
    });
  });

  test('Employers group exists in Employer pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Employers',
    });
  });

  test('Exactly two user pool groups exist', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
  });

  test('Employer pool has MFA optional', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-employer-pool',
      MfaConfiguration: 'OPTIONAL',
    });
  });

  test('Post-confirmation Lambda has DLQ_URL environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DLQ_URL: Match.anyValue(),
        }),
      }),
    });
  });

  test('Post-confirmation Lambda has scoped AdminAddUserToGroup permission', () => {
    // Policy is scoped to all Cognito pools in this account/region (not '*')
    // to respect least privilege while avoiding CDK circular dependency.
    // CDK serializes a single-element Resource as a Fn::Join, not an array.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cognito-idp:AdminAddUserToGroup',
            Effect: 'Allow',
            Resource: Match.objectLike({
              'Fn::Join': Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  // ── Custom Auth Challenge (Phase 2) ──────────────────────────────
  test('Stack contains 6 Lambda functions (post-confirmation + 3 auth challenge + OTP callback + employer CustomMessage)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test('Worker pool has all 4 Lambda triggers wired', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.anyValue(),
        DefineAuthChallenge: Match.anyValue(),
        CreateAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
      }),
    });
  });

  test('Employer pool has post-confirmation + CustomMessage triggers only (no auth challenge triggers)', () => {
    // CDK emits an undefined key as absent from the CFN template.
    // We assert the employer pool has PostConfirmation and CustomMessage but
    // NOT the three auth challenge triggers.
    const pools = template.findResources('AWS::Cognito::UserPool', {
      Properties: {
        UserPoolName: 'jale-employer-pool',
      },
    });
    const employerPool = Object.values(pools)[0] as any;
    expect(employerPool.Properties.LambdaConfig).toBeDefined();
    expect(employerPool.Properties.LambdaConfig.PostConfirmation).toBeDefined();
    expect(employerPool.Properties.LambdaConfig.CustomMessage).toBeDefined();
    expect(employerPool.Properties.LambdaConfig.DefineAuthChallenge).toBeUndefined();
    expect(employerPool.Properties.LambdaConfig.CreateAuthChallenge).toBeUndefined();
    expect(employerPool.Properties.LambdaConfig.VerifyAuthChallengeResponse).toBeUndefined();
  });

  test('Employer pool CustomMessage trigger is wired through the pool construct', () => {
    // The construct re-maps lambdaTriggers key by key, so a key it does not
    // list is dropped in silence. Pinned to the employer pool by name:
    // hasResourceProperties passes on ANY matching pool otherwise.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-employer-pool',
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.anyValue(),
        CustomMessage: Match.anyValue(),
      }),
    });
  });

  test('Worker pool has NO CustomMessage trigger', () => {
    // Workers verify by SMS OTP through the custom auth challenge; the pool
    // sends no verification email, so a branded email trigger there would be
    // dead code with a live blast radius.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      LambdaConfig: Match.objectLike({
        CustomMessage: Match.absent(),
      }),
    });
  });

  test('Employer CustomMessage Lambda: 5 s timeout, Node 20, no environment', () => {
    // 5 s, not the construct's 30 s default: Cognito abandons a CustomMessage
    // trigger at 5 seconds. A longer timeout cannot rescue a slow render — it
    // only hides the failure mode behind a Lambda still running after Cognito
    // has already given up and sent its own copy.
    //
    // Environment must stay absent. EMPLOYER_CUSTOM_MESSAGE_DISABLED is an
    // emergency lever set by hand on the live function and cleared by the next
    // deploy; declaring it here would let CDK re-assert a stale value.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('CustomMessage'),
      Runtime: 'nodejs20.x',
      Timeout: 5,
      Environment: Match.absent(),
    });
  });

  test('Cognito may invoke exactly six trigger Lambdas across both pools', () => {
    // Five before this change (4 worker triggers + employer post-confirmation);
    // the employer CustomMessage trigger is the sixth. Pinned as an absolute
    // number so an accidental extra invoke grant shows up as a failure.
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      { Principal: 'cognito-idp.amazonaws.com' },
      6,
    );
  });

  test('Employer CustomMessage errors raise a CloudWatch alarm with no actions', () => {
    // The handler fails open, so an error here is invisible to the employer —
    // they just get Cognito's plain default copy. The alarm is the only signal.
    // No AlarmActions: this stack wires none (see the Worker OTP alarms).
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EmployerCustomMessageErrors',
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: Match.absent(),
    });
  });

  test('CreateAuthChallenge Lambda has TWILIO_SECRET_ARN env var pointing at Secrets Manager', () => {
    // Twilio creds are loaded from Secrets Manager at runtime. The only
    // Twilio-related env var is TWILIO_SECRET_ARN; no secret values appear
    // in the synthesized template.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TWILIO_SECRET_ARN: 'jale/whatsapp/otp-twilio',
          TWILIO_FROM_NUMBER: '+15125550123',
          TWILIO_REQUEST_TIMEOUT_MS: '3500',
          TWILIO_VALIDITY_PERIOD_SECONDS: '180',
          OTP_RATE_LIMIT_TABLE_NAME: Match.anyValue(),
          OTP_DELIVERY_STATUS_TABLE_NAME: Match.anyValue(),
          TWILIO_STATUS_CALLBACK_URL: Match.anyValue(),
        }),
      }),
    });
  });

  test('UserPoolClients suppress username-existence errors', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  test('OTP rate limits use a TTL-enabled on-demand DynamoDB table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'subject', KeyType: 'HASH' },
        { AttributeName: 'window', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  test('OTP delivery status uses a TTL-enabled on-demand DynamoDB table keyed by Twilio MessageSid', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'twilioMessageSid', KeyType: 'HASH' },
      ],
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('OTP status callback Lambda has a public function URL and DynamoDB write access', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          OTP_DELIVERY_STATUS_TABLE_NAME: Match.anyValue(),
          TWILIO_SECRET_ARN: 'jale/whatsapp/otp-twilio',
        }),
      }),
    });
  });

  test('CreateAuthChallenge Lambda can perform DynamoDB rate-limit transactions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);

    const transactStatements = statements.filter((statement: any) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('dynamodb:TransactWriteItems');
    });

    expect(transactStatements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Effect: 'Allow',
          Resource: expect.anything(),
        }),
      ]),
    );
  });

  // ── R2-C4: VerifyAuthChallenge is a pure Cognito trigger ───────────────
  //
  // It used to promote a name staged at signup (migration 052's
  // promote_worker_pending_name) into users.full_name on the first correct
  // OTP, which is what the DB_SECRET_ARN, the VPC attachment and the
  // dbSecret.grantRead() were for. R2 made web signup phone-only — the name
  // is collected at `profile.name` inside the onboarding flow — so the
  // handler opens no pool at all and all three are gone. These three tests
  // are the lock: an accidental re-add would put a Cognito trigger back
  // inside the VPC (cold-start cost on every login) and hand it a database
  // credential it has no use for.

  /** The synthesized VerifyAuthChallenge function, by its unique Description. */
  function verifyAuthChallengeFn(): { logicalId: string; resource: any } {
    const fns = template.findResources('AWS::Lambda::Function');
    const entries = Object.entries(fns).filter(([, resource]: [string, any]) =>
      resource.Properties?.Description === 'Worker pool VerifyAuthChallengeResponse — OTP comparison');
    expect(entries).toHaveLength(1);
    const [logicalId, resource] = entries[0];
    return { logicalId, resource };
  }

  test('VerifyAuthChallenge Lambda is NOT attached to the VPC', () => {
    const { resource } = verifyAuthChallengeFn();
    expect(resource.Properties.VpcConfig).toBeUndefined();
  });

  test('VerifyAuthChallenge Lambda has no DB_SECRET_ARN environment variable', () => {
    const { resource } = verifyAuthChallengeFn();
    const variables = resource.Properties.Environment?.Variables ?? {};
    expect(Object.keys(variables)).not.toContain('DB_SECRET_ARN');
  });

  test('VerifyAuthChallenge Lambda role carries no secretsmanager:GetSecretValue', () => {
    // Resolve the function's own role, then scan every IAM policy attached
    // to it. Matching on the Description alone would not catch a grant,
    // because grantRead() writes to the ROLE, not the function.
    const { resource } = verifyAuthChallengeFn();
    const roleLogicalId = resource.Properties.Role['Fn::GetAtt'][0];

    const policies = template.findResources('AWS::IAM::Policy');
    const statementsOnThisRole = Object.values(policies)
      .filter((policy: any) => (policy.Properties.Roles ?? []).some(
        (role: any) => role?.Ref === roleLogicalId))
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);

    // Sanity: the role IS policed (the AdminUpdateUserAttributes grant), so
    // an empty list would make the assertion below vacuous.
    expect(statementsOnThisRole.length).toBeGreaterThan(0);
    expect(statementsOnThisRole.flatMap((statement: any) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action])))
      .not.toContain('secretsmanager:GetSecretValue');

    // ...and the managed policies it does keep are the Lambda basics, never
    // the VPC-access one that a `vpc:` prop would have added.
    const role = template.findResources('AWS::IAM::Role')[roleLogicalId];
    const managed = JSON.stringify(role.Properties.ManagedPolicyArns ?? []);
    expect(managed).not.toContain('AWSLambdaVPCAccessExecutionRole');
  });

  test('CreateAuthChallenge errors raise a CloudWatch alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'WorkerOtpSendErrors',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
    });
  });

  test('CreateAuthChallenge policy keeps partial ARN compatibility allow', () => {
    const secretArnParts = (resourceName: string) => [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':secretsmanager:',
      { Ref: 'AWS::Region' },
      ':',
      { Ref: 'AWS::AccountId' },
      `:secret:${resourceName}`,
    ];

    const policies = template.findResources('AWS::IAM::Policy');
    const secretResources = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('secretsmanager:GetSecretValue');
      })
      .map((statement: any) => JSON.stringify(statement.Resource));

    expect(secretResources).toContain(JSON.stringify({
      'Fn::Join': ['', secretArnParts('jale/whatsapp/otp-twilio')],
    }));
    expect(secretResources).toContain(JSON.stringify({
      'Fn::Join': ['', secretArnParts('jale/whatsapp/otp-twilio-??????')],
    }));
  });

  test('synthesized template contains no plaintext Twilio credentials', () => {
    // Regression guard: stringify the entire CFN template and assert that
    // none of the pre-v3 plaintext env var names appear. If someone adds
    // them back via CDK context or env fallback, this test fires.
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).not.toContain('TWILIO_ACCOUNT_SID');
    expect(templateJson).not.toContain('TWILIO_AUTH_TOKEN');
  });

  test('Employer pool uses Cognito default email (no SES config) when sesEmailFromAddress is absent', () => {
    // Without sesEmailFromAddress context the EmailConfiguration block should
    // be absent (CDK omits it, Cognito defaults to COGNITO_DEFAULT).
    const pools = template.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-employer-pool' },
    });
    const employerPool = Object.values(pools)[0] as any;
    expect(employerPool.Properties.EmailConfiguration).toBeUndefined();
  });

  test('production disables ADMIN_USER_PASSWORD_AUTH on both pool clients', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const flows = Object.values(clients).map(
      (c) => (c.Properties as { ExplicitAuthFlows?: string[] }).ExplicitAuthFlows ?? [],
    );
    expect(flows.length).toBe(2);
    for (const f of flows) {
      expect(f).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });
});

// ── Employer pool: SES developer email configuration ──────────────────────────
describe('AuthStack — employer SES email', () => {
  let sesTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        environment: 'production',
        otpSmsFromNumber: '+15125550123',
        otpSmsRequestTimeoutMs: 3500,
        otpSmsValidityPeriodSeconds: 180,
        sesEmailFromAddress: 'no-reply@jaleapp.ai',
        sesEmailFromName: 'Jale',
        sesEmailRegion: 'us-east-1',
      },
    });
    const network = new NetworkStack(app, 'SesNetworkStack');
    const database = new DatabaseStack(app, 'SesDatabaseStack', { network });
    const auth = new AuthStack(app, 'SesAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    sesTemplate = Template.fromStack(auth);
  });

  test('Employer pool has EmailSendingAccount DEVELOPER', () => {
    const pools = sesTemplate.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-employer-pool' },
    });
    const employerPool = Object.values(pools)[0] as any;
    expect(employerPool.Properties.EmailConfiguration).toBeDefined();
    expect(employerPool.Properties.EmailConfiguration.EmailSendingAccount).toBe('DEVELOPER');
  });

  test('Employer pool From address contains friendly name and no-reply@jaleapp.ai', () => {
    const pools = sesTemplate.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-employer-pool' },
    });
    const employerPool = Object.values(pools)[0] as any;
    const from: string = employerPool.Properties.EmailConfiguration.From ?? '';
    // e.g. "Jale <no-reply@jaleapp.ai>" — both name and address must be present
    expect(from).toContain('Jale <');
    expect(from).toContain('no-reply@jaleapp.ai');
  });

  test('Employer pool SES SourceArn references SES identity for jaleapp.ai in us-east-1', () => {
    // The SourceArn region comes from `sesEmailRegion` context (us-east-1 here),
    // NOT from the stack's deployment region. The SES identity must exist in that
    // same region or Cognito email sends will fail at runtime.
    const pools = sesTemplate.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-employer-pool' },
    });
    const employerPool = Object.values(pools)[0] as any;
    const sourceArn = JSON.stringify(employerPool.Properties.EmailConfiguration.SourceArn);
    expect(sourceArn).toContain('ses');
    expect(sourceArn).toContain('us-east-1');
    expect(sourceArn).toContain('jaleapp.ai');
  });

  test('Worker pool is unaffected — no EmailConfiguration (phone/OTP, no email flow)', () => {
    const pools = sesTemplate.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-worker-pool' },
    });
    const workerPool = Object.values(pools)[0] as any;
    expect(workerPool.Properties.EmailConfiguration).toBeUndefined();
  });

  test('Employer pool keeps its CustomMessage trigger under SES developer sending', () => {
    // The branded template and the SES envelope are independent knobs on the
    // same pool: adding EmailConfiguration must not drop LambdaConfig, and the
    // trigger must not push the pool back onto COGNITO_DEFAULT. Both are
    // asserted together because the failure that matters is losing one.
    const pools = sesTemplate.findResources('AWS::Cognito::UserPool', {
      Properties: { UserPoolName: 'jale-employer-pool' },
    });
    const employerPool = Object.values(pools)[0] as any;
    expect(employerPool.Properties.LambdaConfig.CustomMessage).toBeDefined();
    expect(employerPool.Properties.EmailConfiguration.EmailSendingAccount).toBe('DEVELOPER');
    expect(String(employerPool.Properties.EmailConfiguration.From)).toContain('Jale <');
  });

  test('Synthesized template contains no plaintext SES credentials or API keys', () => {
    // SES DEVELOPER mode uses IAM/resource-policy; no API key or secret
    // should appear in the synthesized template.
    const templateJson = JSON.stringify(sesTemplate.toJSON());
    expect(templateJson).not.toContain('SES_API_KEY');
    expect(templateJson).not.toContain('SES_SECRET');
    expect(templateJson).not.toContain('AWS_ACCESS_KEY_ID');
    expect(templateJson).not.toContain('AWS_SECRET_ACCESS_KEY');
  });
});

// ── Employer pool: SES context validation is fail-closed ──────────────────────
describe('AuthStack — SES context validation', () => {
  const buildAuthStack = (idPrefix: string, sesContext: Record<string, unknown>) => {
    const app = new cdk.App({
      context: {
        environment: 'production',
        otpSmsFromNumber: '+15125550123',
        otpSmsRequestTimeoutMs: 3500,
        otpSmsValidityPeriodSeconds: 180,
        ...sesContext,
      },
    });
    const network = new NetworkStack(app, `${idPrefix}NetworkStack`);
    const database = new DatabaseStack(app, `${idPrefix}DatabaseStack`, { network });
    return new AuthStack(app, `${idPrefix}AuthStack`, {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
  };

  test('an empty sesEmailFromAddress fails the synth instead of silently falling back', () => {
    // '' is not `undefined`. A blank -c flag, or a CI variable that expanded to
    // nothing, must not read as "no SES configured" and quietly downgrade
    // employer mail to Cognito's shared sender — that regression is invisible
    // until someone inspects a received email's headers.
    expect(() => buildAuthStack('SesEmptyFrom', {
      sesEmailFromAddress: '',
      sesEmailRegion: 'us-east-1',
    })).toThrow(/sesEmailFromAddress must be a valid email address/);
  });

  test('an SES region Cognito cannot send from fails the synth', () => {
    // Cognito accepts a SES SourceArn only from us-east-1, us-west-2 or
    // eu-west-1. us-east-2 is where these stacks deploy, which makes it the
    // most tempting wrong answer — and it would surface as a send-time failure
    // on live sign-ups, not as a deploy error.
    expect(() => buildAuthStack('SesBadRegion', {
      sesEmailFromAddress: 'ci-synth@jaleapp.ai',
      sesEmailRegion: 'us-east-2',
    })).toThrow(/sesEmailRegion must be one of/);
  });
});
