#!/usr/bin/env bash
#
# fast-deploy-frontend.sh - Deploy frontend code changes without running CDK.
#
# What it does:
#   1. Refuses to deploy if this git checkout is behind its upstream branch
#   2. Reads NEXT_PUBLIC_* vars from frontend/.env.local
#   3. Builds the Docker image locally (linux/amd64)
#   4. Pushes the image to the existing ECR repository used by the Lambda
#   5. Updates the Lambda function in-place
#   6. Invalidates CloudFront so users see the new build immediately
#
# Use this fast path for React components, pages, styles, translations, or
# client logic. Use deploy-frontend.sh/CDK for infrastructure changes.
#
# Usage:
#   ./fast-deploy-frontend.sh
#   PROFILE=YourProfileName ./fast-deploy-frontend.sh
#   DISTRIBUTION_ID=E1A2B3C4D5 ./fast-deploy-frontend.sh
#   SKIP_INVALIDATION=1 ./fast-deploy-frontend.sh
#   CHECK_ONLY=1 ./fast-deploy-frontend.sh

set -euo pipefail

PROFILE="${PROFILE:-}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
SKIP_INVALIDATION="${SKIP_INVALIDATION:-0}"
CHECK_ONLY="${CHECK_ONLY:-0}"

LAMBDA_REGION="us-east-1"
FUNCTION_NAME="jale-frontend-nextjs"
STACK_NAME="JaleFrontendStack"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
ENV_FILE="$FRONTEND_DIR/.env.local"
DEPLOY_STATE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.frontend-fast-deploy-last.env"

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

echo ""
echo "Fast-deploying Jale frontend (Docker -> ECR -> Lambda)"
echo "Auth:     $(auth_label)"
echo ""

# Safety gate: do not deploy from a checkout that is behind its upstream.
echo "Checking repository freshness..."

BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
if [[ -z "$BRANCH" ]]; then
    echo "Failed to determine current git branch."
    exit 1
fi

if ! UPSTREAM="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    echo "Current branch '$BRANCH' has no upstream branch configured."
    echo "Set one with: git branch --set-upstream-to=origin/$BRANCH $BRANCH"
    exit 1
fi

if ! git -C "$REPO_ROOT" fetch --quiet; then
    echo "Failed to fetch latest remote refs; refusing to deploy without a freshness check."
    exit 1
fi

read -r AHEAD BEHIND < <(git -C "$REPO_ROOT" rev-list --left-right --count 'HEAD...@{u}')

if (( BEHIND > 0 )); then
    echo "Refusing to deploy: local branch '$BRANCH' is behind '$UPSTREAM' by $BEHIND commit(s)."
    echo "Run git pull --ff-only, resolve any issues, then deploy again."
    exit 1
fi

if (( AHEAD > 0 )); then
    echo "Note: local branch is ahead of '$UPSTREAM' by $AHEAD commit(s). Deploying code that is not pushed yet."
fi

DIRTY_WORKTREE=false
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    DIRTY_WORKTREE=true
    echo "Note: working tree has uncommitted changes; deployed image may not match a clean git commit."
fi

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
IMAGE_TAG="deploy-$SHORT_SHA-$(date +%Y%m%d-%H%M%S)"

echo "Branch:   $BRANCH"
echo "Upstream: $UPSTREAM"
echo "Commit:   $SHORT_SHA"
echo "Tag:      $IMAGE_TAG"
echo ""

if [[ "$CHECK_ONLY" == "1" ]]; then
    echo "CheckOnly passed; exiting before Docker, AWS, or CloudFront changes."
    exit 0
fi

# Docker check.
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    echo "Docker is not running. Start Docker and try again."
    exit 1
fi

# Load NEXT_PUBLIC_* from frontend/.env.local.
if [[ ! -f "$ENV_FILE" ]]; then
    echo "frontend/.env.local not found."
    echo "Copy frontend/.env.local.example and fill in your values."
    exit 1
fi

build_args=()
while IFS= read -r raw_line; do
    line="${raw_line%$'\r'}"
    if [[ "$line" =~ ^(NEXT_PUBLIC_[^=]+)=(.+)$ ]]; then
        build_args+=( --build-arg "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}" )
    fi
done < "$ENV_FILE"

if [[ ${#build_args[@]} -eq 0 ]]; then
    echo "No NEXT_PUBLIC_* variables found in frontend/.env.local."
    exit 1
fi

echo "Loaded $(( ${#build_args[@]} / 2 )) NEXT_PUBLIC_* build args from .env.local"

# Get ECR repository URI from the running Lambda.
echo ""
echo "Looking up ECR repository..."

CURRENT_IMAGE_URI="$(aws_cli lambda get-function \
    --function-name "$FUNCTION_NAME" \
    --region "$LAMBDA_REGION" \
    --query 'Code.ImageUri' \
    --output text)"

if [[ -z "$CURRENT_IMAGE_URI" || "$CURRENT_IMAGE_URI" == "None" ]]; then
    echo "Could not retrieve Lambda image URI."
    echo "Is '$FUNCTION_NAME' deployed in $LAMBDA_REGION?"
    exit 1
fi

if [[ "$CURRENT_IMAGE_URI" == *@* ]]; then
    ECR_REPO="${CURRENT_IMAGE_URI%%@*}"
else
    ECR_REPO="${CURRENT_IMAGE_URI%:*}"
fi

ECR_ENDPOINT="${ECR_REPO%%/*}"
NEW_IMAGE_URI="${ECR_REPO}:${IMAGE_TAG}"
LOCAL_TAG="jale-frontend:${IMAGE_TAG}"

echo "ECR repo: $ECR_REPO"
echo "Current Lambda image: $CURRENT_IMAGE_URI"

# ECR login.
echo ""
echo "Logging in to ECR ($ECR_ENDPOINT)..."

aws_cli ecr get-login-password --region "$LAMBDA_REGION" |
    docker login --username AWS --password-stdin "$ECR_ENDPOINT"

# Build Docker image.
echo ""
echo "Building Docker image..."

docker build \
    --platform linux/amd64 \
    "${build_args[@]}" \
    -t "$LOCAL_TAG" \
    "$FRONTEND_DIR"

# Push to ECR.
echo ""
echo "Pushing image to ECR..."

docker tag "$LOCAL_TAG" "$NEW_IMAGE_URI"
docker push "$NEW_IMAGE_URI"

# Update Lambda function code.
echo ""
echo "Updating Lambda function..."

aws_cli lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --image-uri "$NEW_IMAGE_URI" \
    --region "$LAMBDA_REGION" >/dev/null

echo "Waiting for Lambda to activate (image pull + warm-up)..."

if aws_cli lambda wait function-updated-v2 \
    --function-name "$FUNCTION_NAME" \
    --region "$LAMBDA_REGION"; then
    echo "Lambda active"
else
    echo "Wait timed out. Lambda may still be activating. Check the console."
fi

# Invalidate CloudFront cache.
if [[ "$SKIP_INVALIDATION" != "1" ]]; then
    DIST_ID="$DISTRIBUTION_ID"

    if [[ -z "$DIST_ID" ]]; then
        echo ""
        echo "Looking up CloudFront distribution ID from $STACK_NAME..."
        DIST_ID="$(aws_cli cloudformation describe-stacks \
            --stack-name "$STACK_NAME" \
            --region "$LAMBDA_REGION" \
            --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
            --output text)"
    fi

    if [[ -n "$DIST_ID" && "$DIST_ID" != "None" ]]; then
        echo ""
        echo "Invalidating CloudFront cache ($DIST_ID)..."
        if aws_cli cloudfront create-invalidation \
            --distribution-id "$DIST_ID" \
            --paths "/*" >/dev/null; then
            echo "CloudFront cache invalidated"
        else
            echo "Cache invalidation failed. HTML may stay stale for up to 1 hour."
        fi
    else
        echo "No distribution ID found; skipping cache invalidation."
        echo "Set DISTRIBUTION_ID=<id> to force invalidation."
    fi
fi

DEPLOYED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
    echo "DEPLOYED_AT_UTC=$DEPLOYED_AT_UTC"
    echo "FUNCTION_NAME=$FUNCTION_NAME"
    echo "REGION=$LAMBDA_REGION"
    echo "STACK_NAME=$STACK_NAME"
    echo "DISTRIBUTION_ID=${DIST_ID:-}"
    echo "PREVIOUS_IMAGE_URI=$CURRENT_IMAGE_URI"
    echo "NEW_IMAGE_URI=$NEW_IMAGE_URI"
    echo "GIT_BRANCH=$BRANCH"
    echo "GIT_UPSTREAM=$UPSTREAM"
    echo "GIT_COMMIT=$SHORT_SHA"
    echo "DIRTY_WORKTREE=$DIRTY_WORKTREE"
} > "$DEPLOY_STATE_FILE"
echo "Rollback state saved: $DEPLOY_STATE_FILE"

echo ""
echo "Fast deploy complete"
echo "New image: $NEW_IMAGE_URI"
echo "Previous image for rollback: $CURRENT_IMAGE_URI"
echo "Verify:    https://jaleapp.ai"
PROFILE_ARG=""
if [[ -n "$PROFILE" ]]; then
    PROFILE_ARG=" --profile $PROFILE"
fi
echo "Tail logs: aws logs tail /aws/lambda/$FUNCTION_NAME --region $LAMBDA_REGION$PROFILE_ARG --follow"
