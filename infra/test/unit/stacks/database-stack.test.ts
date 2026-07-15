import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';

describe('DatabaseStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    });
    template = Template.fromStack(database);
  });

  test('RDS instance exists with PostgreSQL engine', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
    });
  });

  test('RDS instance class is db.t4g.micro', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  test('Secrets Manager secrets exist for admin, matching, AI, admin-console, and billing DB credentials', () => {
    // RDS-generated jale_admin secret + matching + ai + admin-console + billing = 5.
    template.resourceCountIs('AWS::SecretsManager::Secret', 5);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/matching/db',
      Description: 'jale_matching role DB credentials for matching engine reads/writes',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/ai/db',
      Description: 'jale_ai role DB credentials for AI trust assessment service writes',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/admin-console/db',
      Description: 'jale_admin_console role DB credentials for the admin Next.js Lambda',
      // SecretStringTemplate is an Fn::Join (it embeds the RDS endpoint token),
      // so assert the stable generation settings here and the embedded
      // jale_admin_console username via the serialized template below.
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'password',
        ExcludePunctuation: true,
      }),
    });

    // The generated secret must declare the jale_admin_console username so the
    // admin Lambda's db.ts role guard (EXPECTED_ADMIN_DB_USER) is satisfied.
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const adminConsole = Object.values(secrets).find(
      (r) => r.Properties?.Name === 'jale/admin-console/db',
    );
    expect(JSON.stringify(adminConsole?.Properties?.GenerateSecretString?.SecretStringTemplate))
      .toContain('jale_admin_console');
  });

  test('Billing DB secret has connection-complete template (host/port/dbname/username)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/billing/db',
      Description: 'jale_billing service role credentials',
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'password',
        ExcludePunctuation: true,
      }),
    });

    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const billing = Object.values(secrets).find(
      (r) => r.Properties?.Name === 'jale/billing/db',
    );
    const secretTemplate = billing?.Properties?.GenerateSecretString?.SecretStringTemplate;
    expect(secretTemplate).toEqual({
      'Fn::Join': [
        '',
        [
          '{"username":"jale_billing","host":"',
          expect.objectContaining({
            'Fn::GetAtt': expect.arrayContaining(['Endpoint.Address']),
          }),
          '","port":5432,"dbname":"jale"}',
        ],
      ],
    });
  });

  test('Backup retention is 7 days', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 7,
    });
  });

  test('Storage encryption is enabled', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
    });
  });
});
