#!/usr/bin/env bash
#
# rollback-frontend.sh - Roll back the shared dev frontend Lambda image.
#
# By default this reads .frontend-fast-deploy-last.env written by
# fast-deploy-frontend.sh and rolls back to PREVIOUS_IMAGE_URI.
#
# Usage:
#   ./rollback-frontend.sh
#   CHECK_ONLY=1 ./rollback-frontend.sh
#   IMAGE_URI=123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag ./rollback-frontend.sh
#   PROFILE=YourProfileName ./rollback-frontend.sh
#   YES=1 ./rollback-frontend.sh

set -euo pipefail

IMAGE_URI="${IMAGE_URI:-}"
PROFILE="${PROFILE:-}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
SKIP_INVALIDATION="${SKIP_INVALIDATION:-0}"
CHECK_ONLY="${CHECK_ONLY:-0}"
YES="${YES:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.frontend-fast-deploy-last.env"

FUNCTION_NAME="jale-frontend-nextjs"
LAMBDA_REGION="us-east-1"
STACK_NAME="JaleFrontendStack"
STATE_PREVIOUS_IMAGE_URI=""
STATE_NEW_IMAGE_URI=""
USED_STATE_TARGET=0

state_value() {
    local key="$1"
    [[ -f "$STATE_FILE" ]] || return 0
    sed -n "s/^${key}=//p" "$STATE_FILE" | tail -n 1
}

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

if [[ -f "$STATE_FILE" ]]; then
    FUNCTION_NAME="$(state_value FUNCTION_NAME || true)"
    FUNCTION_NAME="${FUNCTION_NAME:-jale-frontend-nextjs}"
    LAMBDA_REGION="$(state_value REGION || true)"
    LAMBDA_REGION="${LAMBDA_REGION:-us-east-1}"
    STACK_NAME="$(state_value STACK_NAME || true)"
    STACK_NAME="${STACK_NAME:-JaleFrontendStack}"
    STATE_PREVIOUS_IMAGE_URI="$(state_value PREVIOUS_IMAGE_URI || true)"
    STATE_NEW_IMAGE_URI="$(state_value NEW_IMAGE_URI || true)"
    if [[ -z "$DISTRIBUTION_ID" ]]; then
        DISTRIBUTION_ID="$(state_value DISTRIBUTION_ID || true)"
    fi
fi

if [[ -z "$IMAGE_URI" ]]; then
    if [[ -z "$STATE_PREVIOUS_IMAGE_URI" ]]; then
        echo "No rollback image provided and no local rollback state exists."
        echo "Set IMAGE_URI=<previous-image-uri>, or run fast-deploy-frontend.sh first."
        exit 1
    fi
    IMAGE_URI="$STATE_PREVIOUS_IMAGE_URI"
    USED_STATE_TARGET=1
fi

if [[ ! "$IMAGE_URI" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/.+(:[^/:@]+|@sha256:[a-fA-F0-9]{64})$ ]]; then
    echo "Image URI does not look like an ECR image URI:"
    echo "$IMAGE_URI"
    exit 1
fi

echo ""
echo "Preparing frontend rollback"
echo "Auth:     $(auth_label)"
echo "Function: $FUNCTION_NAME"
echo "Region:   $LAMBDA_REGION"
echo "Target:   $IMAGE_URI"

CURRENT_IMAGE_URI="$(aws_cli lambda get-function \
    --function-name "$FUNCTION_NAME" \
    --region "$LAMBDA_REGION" \
    --query 'Code.ImageUri' \
    --output text)"

if [[ -z "$CURRENT_IMAGE_URI" || "$CURRENT_IMAGE_URI" == "None" ]]; then
    echo "Could not retrieve current Lambda image URI."
    exit 1
fi

echo "Current:  $CURRENT_IMAGE_URI"

if [[ "$CURRENT_IMAGE_URI" == "$IMAGE_URI" ]]; then
    echo "Current Lambda image already matches the rollback target; nothing to change."
    exit 0
fi

if [[ "$USED_STATE_TARGET" == "1" && -n "$STATE_NEW_IMAGE_URI" && "$CURRENT_IMAGE_URI" != "$STATE_NEW_IMAGE_URI" ]]; then
    echo "Local rollback state is stale: current Lambda image differs from the last fast deploy recorded on this machine."
    echo "Set IMAGE_URI explicitly if you still want to roll back to this target."
    exit 1
fi

if [[ "$SKIP_INVALIDATION" != "1" && -z "$DISTRIBUTION_ID" ]]; then
    echo "Looking up CloudFront distribution ID from $STACK_NAME..."
    DISTRIBUTION_ID="$(aws_cli cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$LAMBDA_REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
        --output text)"
fi

if [[ "$SKIP_INVALIDATION" != "1" ]]; then
    echo "Distribution: $DISTRIBUTION_ID"
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
    echo "CheckOnly passed; exiting before Lambda or CloudFront changes."
    exit 0
fi

if [[ "$YES" != "1" ]]; then
    echo ""
    read -r -p "Type ROLLBACK to update Lambda to the target image: " CONFIRMATION
    if [[ "$CONFIRMATION" != "ROLLBACK" ]]; then
        echo "Rollback cancelled."
        exit 1
    fi
fi

echo ""
echo "Updating Lambda function code..."
aws_cli lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --image-uri "$IMAGE_URI" \
    --region "$LAMBDA_REGION" >/dev/null

echo "Waiting for Lambda to activate..."
if ! aws_cli lambda wait function-updated-v2 \
    --function-name "$FUNCTION_NAME" \
    --region "$LAMBDA_REGION"; then
    echo "Wait timed out. Lambda may still be activating. Check the console."
fi

if [[ "$SKIP_INVALIDATION" != "1" ]]; then
    if [[ -n "$DISTRIBUTION_ID" && "$DISTRIBUTION_ID" != "None" ]]; then
        echo "Invalidating CloudFront cache ($DISTRIBUTION_ID)..."
        aws_cli cloudfront create-invalidation \
            --distribution-id "$DISTRIBUTION_ID" \
            --paths "/*" >/dev/null
    else
        echo "No distribution ID found; skipping cache invalidation."
    fi
fi

ROLLED_BACK_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
    echo "DEPLOYED_AT_UTC=$ROLLED_BACK_AT_UTC"
    echo "FUNCTION_NAME=$FUNCTION_NAME"
    echo "REGION=$LAMBDA_REGION"
    echo "STACK_NAME=$STACK_NAME"
    echo "DISTRIBUTION_ID=$DISTRIBUTION_ID"
    echo "PREVIOUS_IMAGE_URI=$CURRENT_IMAGE_URI"
    echo "NEW_IMAGE_URI=$IMAGE_URI"
    echo "ROLLBACK=true"
} > "$STATE_FILE"

echo ""
echo "Rollback complete"
echo "New current image: $IMAGE_URI"
echo "Previous image before rollback: $CURRENT_IMAGE_URI"
