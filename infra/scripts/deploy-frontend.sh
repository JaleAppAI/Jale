#!/usr/bin/env bash
#
# deploy-frontend.sh — Build, push, and deploy the Jale frontend.
#
# CDK does the heavy lifting: it builds frontend/Dockerfile, pushes the image
# to ECR, and updates the Lambda function. After that, we optionally invalidate
# CloudFront so users see the new build immediately.
#
# Usage:
#   ./deploy-frontend.sh
#   PROFILE=IvanJale DISTRIBUTION_ID=E1A2B3C4D5 ./deploy-frontend.sh
#   SURVEY_ORIGIN_DOMAIN=d1a2b3.amplifyapp.com ./deploy-frontend.sh
#

set -euo pipefail

PROFILE="${PROFILE:-IvanJale}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
SURVEY_ORIGIN_DOMAIN="${SURVEY_ORIGIN_DOMAIN:-}"
SKIP_INVALIDATION="${SKIP_INVALIDATION:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "🚀 Deploying Jale frontend (Lambda + CloudFront)"
echo "Profile:  $PROFILE"

# Sanity: Docker daemon must be running
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    echo "❌ Docker is not running. Start Docker and try again."
    exit 1
fi

# Build CDK context arguments
ctx_args=()
if [[ -n "$SURVEY_ORIGIN_DOMAIN" ]]; then
    ctx_args+=( -c "surveyOriginDomain=$SURVEY_ORIGIN_DOMAIN" )
fi

cd "$REPO_ROOT/infra"

echo ""
echo "📦 Running cdk deploy JaleFrontendStack..."
echo "    (CDK builds Docker image, pushes to ECR, updates Lambda)"
npx cdk deploy JaleFrontendStack \
    --profile "$PROFILE" \
    --require-approval=never \
    "${ctx_args[@]}"

# Optional cache invalidation
if [[ "$SKIP_INVALIDATION" != "1" && -n "$DISTRIBUTION_ID" ]]; then
    echo ""
    echo "🔄 Invalidating CloudFront cache for $DISTRIBUTION_ID..."
    aws cloudfront create-invalidation \
        --profile "$PROFILE" \
        --distribution-id "$DISTRIBUTION_ID" \
        --paths "/*"
    echo "✅ CloudFront cache invalidated"
fi

echo ""
echo "✅ Deployment complete"
echo "Verify: https://jaleapp.ai"
echo "Tail logs: aws logs tail /aws/lambda/jale-frontend-nextjs --profile $PROFILE --follow"
