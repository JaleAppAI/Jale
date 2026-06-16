import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface AdminCertStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly hostedZoneId: string;
}

/**
 * CloudFront requires its ACM certificate to live in us-east-1. The admin
 * Next.js Lambda must run in the main region so it can join the shared VPC and
 * reach RDS. This stack owns only the certificate and passes its ARN to the
 * main-region AdminStack through a CDK cross-region reference.
 */
export class AdminCertStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: AdminCertStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    this.certificate = new acm.Certificate(this, 'AdminCertificate', {
      domainName: `admin.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const webAcl = new wafv2.CfnWebACL(this, 'AdminWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'jale-admin-web-acl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'jale-admin-common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AdminIpRateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              limit: 2000,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'jale-admin-ip-rate-limit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;
  }
}
