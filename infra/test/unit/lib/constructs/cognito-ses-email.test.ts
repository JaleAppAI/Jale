import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template } from 'aws-cdk-lib/assertions';
import { resolveCognitoSesEmail } from '../../../../lib/constructs/cognito-ses-email';

/**
 * The one reader of the app-global SES sender context (sesEmailFromAddress,
 * sesEmailFromName, sesEmailRegion, sesVerifiedDomain) for every user pool
 * that sends through SES: the employer pool (AuthStack) and the admin pool
 * (AdminStack). Absent context keeps Cognito's default sender; a present but
 * malformed one fails the synth.
 */

function emailConfiguration(context: Record<string, unknown>): Record<string, unknown> | undefined {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'SesEmailStack');
  new cognito.UserPool(stack, 'Pool', { email: resolveCognitoSesEmail(stack) });
  const pools = Object.values(Template.fromStack(stack).findResources('AWS::Cognito::UserPool')) as any[];
  expect(pools).toHaveLength(1);
  return pools[0].Properties.EmailConfiguration;
}

describe('resolveCognitoSesEmail', () => {
  test('without a sender in context the pool keeps Cognito\'s default sender', () => {
    expect(emailConfiguration({})).toBeUndefined();
  });

  test('a sender and region in context send through SES from that domain, as Jale by default', () => {
    const config = emailConfiguration({ sesEmailFromAddress: 'sender@example.test', sesEmailRegion: 'us-east-1' });
    expect(config).toBeDefined();
    expect(config!.EmailSendingAccount).toBe('DEVELOPER');
    expect(config!.From).toBe('Jale <sender@example.test>');
    const sourceArn = JSON.stringify(config!.SourceArn);
    expect(sourceArn).toContain(':ses:us-east-1:');
    expect(sourceArn).toContain(':identity/example.test');
  });

  test('takes the display name, region and verified identity from context', () => {
    const config = emailConfiguration({
      sesEmailFromAddress: 'sender@mail.example.test',
      sesEmailFromName: 'Jale Admin',
      sesEmailRegion: 'eu-west-1',
      sesVerifiedDomain: 'mail.example.test',
    });
    expect(config!.From).toBe('Jale Admin <sender@mail.example.test>');
    const sourceArn = JSON.stringify(config!.SourceArn);
    expect(sourceArn).toContain(':ses:eu-west-1:');
    expect(sourceArn).toContain(':identity/mail.example.test');
    // CDK itself refuses a verified identity on another domain than the sender's.
    expect(() => emailConfiguration({
      sesEmailFromAddress: 'sender@example.test',
      sesEmailRegion: 'us-east-1',
      sesVerifiedDomain: 'other.example.test',
    })).toThrow(/different domain/);
  });

  test('a blank or malformed sender fails the synth instead of falling back', () => {
    for (const address of ['', 'not-an-address', 'a@b']) {
      expect(() => emailConfiguration({ sesEmailFromAddress: address, sesEmailRegion: 'us-east-1' }))
        .toThrow('sesEmailFromAddress must be a valid email address');
    }
  });

  test('a sender without a region Cognito can send from fails the synth', () => {
    for (const region of [undefined, 'us-east-2', '']) {
      const context: Record<string, unknown> = { sesEmailFromAddress: 'sender@example.test' };
      if (region !== undefined) context.sesEmailRegion = region;
      expect(() => emailConfiguration(context))
        .toThrow('sesEmailRegion must be one of us-east-1, us-west-2, eu-west-1 when sesEmailFromAddress is set');
    }
  });
});
