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

  test('Secrets Manager secrets exist for admin and matching DB credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/matching/db',
      Description: 'jale_matching role DB credentials for matching engine reads/writes',
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
