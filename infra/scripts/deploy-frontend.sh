#!/usr/bin/env bash
#
# deploy-frontend.sh - Build, push, and deploy the Jale frontend through CDK.
#
# CDK does the heavy lifting: it builds frontend/Dockerfile, pushes the image
# to ECR, and updates the Lambda function. After that, this script optionally
# invalidates CloudFront so users see the new build immediately.
#
# Usage:
#   ./deploy-frontend.sh
#   PROFILE=YourProfileName DISTRIBUTION_ID=E1A2B3C4D5 ./deploy-frontend.sh
#   SURVEY_ORIGIN_DOMAIN=d1a2b3.amplifyapp.com ./deploy-frontend.sh

set -euo pipefail

PROFILE="${PROFILE:-}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
SURVEY_ORIGIN_DOMAIN="${SURVEY_ORIGIN_DOMAIN:-}"
SKIP_INVALIDATION="${SKIP_INVALIDATION:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

aws_cli() {
    if [[ -n "$PROFILE" ]]; then
        aws "$@" --profile "$PROFILE"
    else
        aws "$@"
    fi
}

auth_label() {
    if [[ -n "$PROFILE" ]]; then
        echo "profile '$PROFILE'"
    elif [[ -n "${AWS_PROFILE:-}" ]]; then
        echo "AWS_PROFILE '$AWS_PROFILE'"
    else
        echo "default AWS credentials"
    fi
}

echo "Deploying Jale frontend through CDK (Lambda + CloudFront)"
echo "Auth:     $(auth_label)"

if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    echo "Docker is not running. Start Docker and try again."
    exit 1
fi

ctx_args=()
if [[ -n "$SURVEY_ORIGIN_DOMAIN" ]]; then
    ctx_args+=( -c "surveyOriginDomain=$SURVEY_ORIGIN_DOMAIN" )
fi

profile_args=()
if [[ -n "$PROFILE" ]]; then
    profile_args+=( --profile "$PROFILE" )
fi

cd "$REPO_ROOT/infra"

echo ""
echo "Running cdk deploy JaleFrontendStack..."
echo "CDK builds Docker image, pushes to ECR, and updates Lambda."
npx cdk deploy JaleFrontendStack \
    "${profile_args[@]}" \
    --require-approval=never \
    "${ctx_args[@]}"

if [[ "$SKIP_INVALIDATION" != "1" && -n "$DISTRIBUTION_ID" ]]; then
    echo ""
    echo "Invalidating CloudFront cache for $DISTRIBUTION_ID..."
    aws_cli cloudfront create-invalidation \
        --distribution-id "$DISTRIBUTION_ID" \
        --paths "/*"
    echo "CloudFront cache invalidated"
fi

PROFILE_ARG=""
if [[ -n "$PROFILE" ]]; then
    PROFILE_ARG=" --profile $PROFILE"
fi

echo ""
echo "Deployment complete"
echo "Verify: https://jaleapp.ai"
echo "Tail logs: aws logs tail /aws/lambda/jale-frontend-nextjs$PROFILE_ARG --follow"
