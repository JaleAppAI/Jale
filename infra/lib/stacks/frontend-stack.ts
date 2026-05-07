import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  readonly api: apigateway.RestApi;
  readonly domainName: string;
  readonly hostedZoneId: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly frontendBucket: s3.Bucket;
  public readonly cloudFrontDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // ── S3 bucket for static HTML ──
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `jale-frontend-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // ── Route 53 Hosted Zone (retrieved by ID) ──
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    // ── ACM Certificate for HTTPS ──
    const certificate = new acm.Certificate(this, 'FrontendCertificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ── CloudFront Origin Access Identity ──
    const oai = new cloudfront.OriginAccessIdentity(this, 'FrontendOai', {
      comment: `OAI for ${props.domainName}`,
    });

    // Grant OAI read access to the S3 bucket
    this.frontendBucket.grantRead(oai);

    // ── API Gateway Origin (backend API) ──
    const apiOrigin = new origins.RestApiOrigin(props.api, {
      originPath: `/${props.api.deploymentStage.stageName}`,
    });

    // ── CloudFront Custom Origin for Amplify Survey App ──
    const surveyOrigin = new origins.HttpOrigin('d1a2b3c4d5e6.amplifyapp.com', {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // ── CloudFront Distribution ──
    this.cloudFrontDistribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      certificate,
      domainNames: [props.domainName],
      defaultBehavior: {
        origin: new origins.S3Origin(this.frontendBucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // For client-side routing: 404/403 → index.html
        functionAssociations: [
          {
            function: new cloudfront.Function(this, 'ErrorRewriteFunction', {
              code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // If the request is for a file with an extension, don't rewrite
  if (uri.match(/\\.[a-zA-Z0-9]+$/)) {
    return request;
  }

  // Otherwise, try to serve index.html
  request.uri = '/index.html';
  return request;
}
              `),
            }),
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
        },
        '/survey/*': {
          origin: surveyOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logFilePrefix: 'cloudfront-logs/',
      logIncludesCookies: false,
    });

    // ── Route 53 DNS Records ──
    new route53.ARecord(this, 'FrontendARecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.cloudFrontDistribution),
      ),
    });

    new route53.AaaaRecord(this, 'FrontendAaaaRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.cloudFrontDistribution),
      ),
    });

    // ── Stack Outputs ──
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: 'S3 bucket for frontend static assets',
      exportName: `${this.stackName}-bucket`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.cloudFrontDistribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: `${this.stackName}-distribution-id`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.cloudFrontDistribution.domainName,
      description: 'CloudFront distribution domain name',
      exportName: `${this.stackName}-domain`,
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${props.domainName}`,
      description: 'Frontend URL',
      exportName: `${this.stackName}-url`,
    });
  }
}
