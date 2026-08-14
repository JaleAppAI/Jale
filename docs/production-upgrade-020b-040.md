# Production Upgrade: 020b and 035–040

This is the only approved procedure for moving the production database from
the migration-034 baseline to the Sprint 16 schema. Do not run
`scripts/run-migrations.ps1` or `.sh` against production: they replay older
migrations and there is no migration ledger yet.

## 1. Release configuration

Confirm the AWS identity and region, then discover a verified `jaleapp.ai` SES
identity and exactly one monitored SNS alarm topic with confirmed subscribers.
Configure these GitHub Environment variables on `production`:

- `EMAIL_FROM_ADDRESS=billing@jaleapp.ai`
- `SES_VERIFIED_IDENTITY_ARN=<verified jaleapp.ai identity ARN>`
- `WHATSAPP_ALARM_TOPIC_ARN=<monitored SNS topic ARN>`

Stop if AWS resource selection is ambiguous or any subscriber is unconfirmed.

## 2. Bastion and snapshot

Deploy the temporary bastion from the reviewed `main` commit:

```bash
cd infra
mkdir -p ../.tmp/jale-cdk-out-bastion
npx cdk -c bastionOnly=true -c environment=production deploy JaleBastionStack \
  --exclusively -o ../.tmp/jale-cdk-out-bastion --require-approval never
cd ..
```

Resolve the `AWS::RDS::DBInstance` physical ID from `JaleDatabaseStack`, create
a timestamped snapshot, and wait until it is available:

```bash
aws rds create-db-snapshot --db-instance-identifier "$DB_INSTANCE_ID" --db-snapshot-identifier "$SNAPSHOT_ID" --region us-east-2
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAPSHOT_ID" --region us-east-2
```

## 3. Verify and apply

The default mode is read-only. It must report a supported migration-034
baseline, no `PARTIAL_STATE`, and only the reviewed pending files:

```bash
scripts/run-production-upgrade-020b-040.sh --expected-account-id <production-account-id>
```

Apply immediately after preflight. Migration 040 may briefly lock WhatsApp
outbox writers; scheduled senders retry after the transaction commits.

```bash
scripts/run-production-upgrade-020b-040.sh --expected-account-id <production-account-id> --apply
scripts/run-production-upgrade-020b-040.sh --expected-account-id <production-account-id>
```

The final verification must show every file as `VERIFIED` and no pending or
partial state. Destroy the temporary bastion afterward:

```bash
cd infra
npx cdk -c bastionOnly=true -c environment=production destroy JaleBastionStack --force
```

## 4. Promote and deploy

Fast-forward `prod` to the exact reviewed `main` SHA without force. The
automatic push workflow will intentionally stop when it sees migration files;
that guard remains enabled. Once the database postflight is recorded, manually
dispatch `deploy-production` from `prod` with `deploy_scope=all`.

Verify the deployed SHA, stack completion, API health, frontend/admin routes,
billing endpoints, WhatsApp status-callback route, and actionable alarms.

Database changes are forward-only. The snapshot is emergency recovery, not a
routine rollback mechanism.
