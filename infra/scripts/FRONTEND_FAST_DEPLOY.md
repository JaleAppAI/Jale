# Frontend Fast Deploy and Rollback Guide

This workflow is for the shared MVP/dev frontend environment, not production.

Use it when you want to quickly deploy frontend changes to the shared dev site:

```text
https://jaleapp.ai
```

The fast deploy script updates only the frontend Lambda container image. It does not run CDK and does not change infrastructure.

## What Fast Deploy Does

When you run the script, it:

```text
checks your git checkout is not behind origin
reads frontend/.env.local
builds the frontend Docker image
pushes the image to ECR
updates the jale-frontend-nextjs Lambda
waits for Lambda to activate
invalidates CloudFront
saves local rollback info
```

The most important safety rule is:

```text
The script refuses to deploy if your local branch is behind origin.
```

That prevents someone from deploying stale code and accidentally wiping out another teammate's latest frontend work.

## When To Use It

Use fast deploy for:

```text
frontend pages
frontend components
styles
translations
client-side logic
small MVP UI fixes
shared dev frontend testing
```

Do not use fast deploy for:

```text
CDK changes
Lambda memory/timeout changes
CloudFront behavior changes
IAM changes
new env vars
Cognito/API infrastructure changes
backend changes
```

For those, use the normal CDK/backend deploy process.

## Windows Deploy Steps

From the repo root:

```powershell
git pull --ff-only
```

Make your frontend changes.

Optionally test locally:

```powershell
cd frontend
npm run dev
```

Go back to repo root:

```powershell
cd ..
```

Run the safety check:

```powershell
.\infra\scripts\fast-deploy-frontend.ps1 -CheckOnly
```

If that passes, deploy:

```powershell
.\infra\scripts\fast-deploy-frontend.ps1
```

After deploy, open:

```text
https://jaleapp.ai
```

Verify the frontend works.

## Mac/Linux Deploy Steps

From the repo root:

```bash
git pull --ff-only
```

Make your frontend changes.

Optionally test locally:

```bash
cd frontend
npm run dev
```

Go back to repo root:

```bash
cd ..
```

Run the safety check:

```bash
CHECK_ONLY=1 ./infra/scripts/fast-deploy-frontend.sh
```

If that passes, deploy:

```bash
./infra/scripts/fast-deploy-frontend.sh
```

After deploy, open:

```text
https://jaleapp.ai
```

Verify the frontend works.

## What The Deploy Output Means

At the end, the script prints:

```text
New image: ...
Previous image for rollback: ...
Rollback state saved: ...
```

`New image` is the frontend image that was just deployed.

`Previous image for rollback` is the image Lambda was using before your deploy.

`Rollback state saved` means the script saved local rollback info so you can usually roll back with one command.

## Rollback: Windows

If your frontend deploy breaks the shared dev site, run:

```powershell
.\infra\scripts\rollback-frontend.ps1
```

The script will show:

```text
current Lambda image
rollback target image
AWS auth/profile being used
CloudFront distribution
```

Then it asks you to type:

```text
ROLLBACK
```

Type exactly that to confirm.

The rollback script then:

```text
updates Lambda back to the previous image
waits for Lambda to activate
invalidates CloudFront
saves updated rollback state
```

## Rollback: Mac/Linux

If your frontend deploy breaks the shared dev site, run:

```bash
./infra/scripts/rollback-frontend.sh
```

Type this when prompted:

```text
ROLLBACK
```

## Safe Rollback Check

Before actually rolling back, you can run a no-change check.

Windows:

```powershell
.\infra\scripts\rollback-frontend.ps1 -CheckOnly
```

Mac/Linux:

```bash
CHECK_ONLY=1 ./infra/scripts/rollback-frontend.sh
```

This checks what would be rolled back without changing Lambda or CloudFront.

## Profiles And AWS Credentials

The scripts do not require everyone to use the same AWS profile name.

By default, they use the developer's current AWS setup:

```text
AWS_PROFILE if set
otherwise default AWS credentials
```

If you need to force a profile, you can.

Windows:

```powershell
.\infra\scripts\fast-deploy-frontend.ps1 -Profile YourProfileName
.\infra\scripts\rollback-frontend.ps1 -Profile YourProfileName
```

Mac/Linux:

```bash
PROFILE=YourProfileName ./infra/scripts/fast-deploy-frontend.sh
PROFILE=YourProfileName ./infra/scripts/rollback-frontend.sh
```

## Important Safety Rules

Do:

```text
pull latest before deploying
run CheckOnly before deploying
use fast deploy only for frontend code
verify https://jaleapp.ai after deploy
rollback quickly if the shared dev frontend breaks
tell the team when you deploy something risky
```

Do not:

```text
deploy from a branch that is behind origin
use this for infra/backend changes
run cdk deploy --all from an old checkout
ignore rollback warnings about stale local state
treat this like production CI/CD
```

## Common Scenarios

If the script says your branch is behind:

```text
Refusing to deploy: local branch is behind origin/main
```

Run:

```powershell
git pull --ff-only
```

Then try again.

If the script says your working tree is dirty:

```text
working tree has uncommitted changes
```

That is allowed for MVP/dev iteration. It means you are deploying local changes that may not exist in git yet.

If rollback says local state is stale, it means someone else may have deployed after you. The script refuses to blindly roll back over their newer deploy.

In that case, coordinate with the team or explicitly pass the image URI you want to roll back to.

Windows:

```powershell
.\infra\scripts\rollback-frontend.ps1 -ImageUri "<previous-image-uri>"
```

Mac/Linux:

```bash
IMAGE_URI="<previous-image-uri>" ./infra/scripts/rollback-frontend.sh
```

## Golden Rule

Fast deploy is for speed.

Rollback is for safety.

Before deploying, make sure you have everyone else's latest committed code:

```text
git pull --ff-only
```

After deploying, verify the shared dev site.

If it breaks, roll back immediately.
