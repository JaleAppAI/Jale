import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AdminCertStack } from '../../../lib/stacks/admin-cert-stack';

describe('AdminCertStack', () => {
  const app = new cdk.App();
  const stack = new AdminCertStack(app, 'TestAdminCertStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    domainName: 'example.com',
    hostedZoneId: 'Z1234567890ABC',
  });
  const template = Template.fromStack(stack);

  test('creates the admin certificate', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'admin.example.com',
      ValidationMethod: 'DNS',
    });
  });

  test('creates a CloudFront WAF with managed rules and rate limiting', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AdminIpRateLimit' }),
      ]),
    });
  });
});
