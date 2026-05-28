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
JALE_WORKER_POOL_ID="${JALE_WORKER_POOL_ID:-}"
JALE_WORKER_CLIENT_ID="${JALE_WORKER_CLIENT_ID:-}"
JALE_EMPLOYER_POOL_ID="${JALE_EMPLOYER_POOL_ID:-}"
JALE_EMPLOYER_CLIENT_ID="${JALE_EMPLOYER_CLIENT_ID:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

aws_cli() {
    if [[ -n "$PROFILE" ]]; then
        aws "$@" --profile "$PROFILE"
    else
        aws "$@"
    fi
}

cdk_cli() {
    if command -v npx >/dev/null 2>&1; then
        npx cdk "$@"
    elif [[ -x "$REPO_ROOT/infra/node_modules/.bin/cdk" ]]; then
        "$REPO_ROOT/infra/node_modules/.bin/cdk" "$@"
    else
        echo "CDK CLI not found. Install npm/npx or run npm install in infra." >&2
        return 1
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

missing_frontend_config=()
[[ -n "$JALE_WORKER_POOL_ID" ]] || missing_frontend_config+=( "JALE_WORKER_POOL_ID" )
[[ -n "$JALE_WORKER_CLIENT_ID" ]] || missing_frontend_config+=( "JALE_WORKER_CLIENT_ID" )
[[ -n "$JALE_EMPLOYER_POOL_ID" ]] || missing_frontend_config+=( "JALE_EMPLOYER_POOL_ID" )
[[ -n "$JALE_EMPLOYER_CLIENT_ID" ]] || missing_frontend_config+=( "JALE_EMPLOYER_CLIENT_ID" )

if [[ "${#missing_frontend_config[@]}" -gt 0 ]]; then
    echo "Missing frontend Cognito build config:"
    printf '  - %s\n' "${missing_frontend_config[@]}"
    echo ""
    echo "Set these environment variables before running this script."
    exit 1
fi

ctx_args+=(
    -c "workerPoolId=$JALE_WORKER_POOL_ID"
    -c "workerClientId=$JALE_WORKER_CLIENT_ID"
    -c "employerPoolId=$JALE_EMPLOYER_POOL_ID"
    -c "employerClientId=$JALE_EMPLOYER_CLIENT_ID"
)

profile_args=()
if [[ -n "$PROFILE" ]]; then
    profile_args+=( --profile "$PROFILE" )
fi

cd "$REPO_ROOT/infra"
CDK_OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jale-cdk.out.XXXXXX")"
trap 'rm -rf "$CDK_OUTPUT_DIR"' EXIT

echo ""
echo "Running cdk deploy JaleFrontendStack..."
echo "CDK builds Docker image, pushes to ECR, and updates Lambda."
cdk_cli deploy JaleFrontendStack \
    "${profile_args[@]}" \
    --require-approval=never \
    --output "$CDK_OUTPUT_DIR" \
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
