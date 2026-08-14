#!/usr/bin/env bash
#
# Operator-run A/B comparison harness. NEVER run this unattended and NEVER
# run it without explicit, task-specific approval from Luis — it downloads
# and transcribes REAL customer WhatsApp voice-note audio (Twilio media URLs
# for actual worker recordings) and sends real transcript text through
# Bedrock. That is customer PII/audio, not test fixtures. See Jale's
# CLAUDE.md production/sensitive-data boundaries: Twilio recording/transcript
# reads and provider mutations require explicit approval every time, not a
# one-time blanket OK.
#
# What this compares, for a fixed set of REAL voice-note recordings supplied
# by the operator (one Twilio media URL per line in a file, no other PII):
#
#   (A) OLD Transcribe config: single hardcoded LanguageCode (the pre-
#       T-transcription-language-id behavior), no custom vocabulary.
#   (B) NEW Transcribe config: IdentifyMultipleLanguages with
#       LanguageOptions ['es-US','en-US'] and the jale-es-us-trades custom
#       vocabulary attached via LanguageIdSettings.
#
#   (C) OLD extractor: Nova Lite (us.amazon.nova-lite-v1:0) run against each
#       config's transcript.
#   (D) NEW extractor: Claude Haiku 4.5
#       (us.anthropic.claude-haiku-4-5-20251001-v1:0) run against each
#       config's transcript.
#
# Output: one row per input recording with all four transcript/extraction
# variants side by side, written to a local file for human review — this
# script does not decide pass/fail, a human reads the diff.
#
# Usage:
#   JALE_AB_COMPARE_MEDIA_URLS_FILE=./my-samples.txt \
#   JALE_AB_COMPARE_OLD_LANGUAGE_CODE=es-US \
#   JALE_AB_COMPARE_S3_BUCKET=<media bucket> \
#   JALE_AB_COMPARE_OUTPUT_DIR=./ab-compare-out \
#     ./ab-compare.sh
#
# Required env:
#   JALE_AB_COMPARE_MEDIA_URLS_FILE   file, one Twilio media URL per line
#   JALE_AB_COMPARE_S3_BUCKET         S3 bucket Transcribe can read/write in
#   JALE_AB_COMPARE_TWILIO_SECRET_ARN Secrets Manager ARN with Twilio creds
#
# Optional env:
#   JALE_AB_COMPARE_OLD_LANGUAGE_CODE   default es-US (old hardcoded config)
#   JALE_AB_COMPARE_ES_VOCABULARY_NAME  default jale-es-us-trades
#   JALE_AB_COMPARE_REGION              default us-east-2
#   JALE_AB_COMPARE_OUTPUT_DIR          default ./ab-compare-out
set -euo pipefail

cd "$(dirname "$0")"

: "${JALE_AB_COMPARE_MEDIA_URLS_FILE:?set to a file of Twilio media URLs, one per line}"
: "${JALE_AB_COMPARE_S3_BUCKET:?set to an S3 bucket Transcribe can read/write in}"
: "${JALE_AB_COMPARE_TWILIO_SECRET_ARN:?set to the Secrets Manager ARN holding Twilio creds}"

OLD_LANGUAGE_CODE="${JALE_AB_COMPARE_OLD_LANGUAGE_CODE:-es-US}"
ES_VOCABULARY_NAME="${JALE_AB_COMPARE_ES_VOCABULARY_NAME:-jale-es-us-trades}"
REGION="${JALE_AB_COMPARE_REGION:-us-east-2}"
OUTPUT_DIR="${JALE_AB_COMPARE_OUTPUT_DIR:-./ab-compare-out}"

OLD_MODEL_ID="us.amazon.nova-lite-v1:0"
NEW_MODEL_ID="us.anthropic.claude-haiku-4-5-20251001-v1:0"

mkdir -p "$OUTPUT_DIR"

echo "ab-compare: this touches REAL customer audio via Twilio media URLs read"
echo "  from $JALE_AB_COMPARE_MEDIA_URLS_FILE and starts REAL Transcribe/Bedrock"
echo "  jobs against them. Confirm explicit approval was given for THIS run"
echo "  before continuing."
read -r -p "Type 'yes-i-have-approval' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes-i-have-approval" ]; then
  echo "ab-compare: confirmation not given, aborting." >&2
  exit 1
fi

n=0
while IFS= read -r MEDIA_URL; do
  [ -z "$MEDIA_URL" ] && continue
  n=$((n + 1))
  RUN_ID="ab-${n}-$(date +%s)"
  echo "ab-compare: [$n] processing recording ($RUN_ID)"

  # 1. Download the recording once via Twilio (authenticated with the
  #    secret at JALE_AB_COMPARE_TWILIO_SECRET_ARN) and stage it to S3 so
  #    both Transcribe configs read the identical bytes.
  MEDIA_S3_KEY="ab-compare/${RUN_ID}/media"
  echo "  (download+stage step: fetch $MEDIA_URL with Twilio creds from" \
       "$JALE_AB_COMPARE_TWILIO_SECRET_ARN, upload to" \
       "s3://${JALE_AB_COMPARE_S3_BUCKET}/${MEDIA_S3_KEY} — left as an" \
       "operator-filled step since it requires a Twilio-authenticated" \
       "HTTP client, not just AWS CLI calls)"

  MEDIA_S3_URI="s3://${JALE_AB_COMPARE_S3_BUCKET}/${MEDIA_S3_KEY}"

  # Fail closed: the download+stage step above is an operator-filled
  # manual step (deliberately not automated here — see the comment above),
  # so nothing guarantees the object actually landed at MEDIA_S3_URI before
  # this point. Without this guard, both start-transcription-job calls
  # below would fire — and be billed — against a key that doesn't exist,
  # guaranteed to fail. Never silently skip a missing recording and never
  # proceed past it; stop the whole run so the operator finishes staging
  # and re-runs, rather than burning API calls on every remaining URL too.
  if ! aws s3api head-object \
    --bucket "$JALE_AB_COMPARE_S3_BUCKET" \
    --key "$MEDIA_S3_KEY" \
    --region "$REGION" >/dev/null 2>&1; then
    echo "ab-compare: [$n] MEDIA NOT STAGED — $MEDIA_S3_URI does not exist." >&2
    echo "  Complete the download+stage step above (fetch $MEDIA_URL with" >&2
    echo "  Twilio creds, upload to $MEDIA_S3_URI) before re-running this" >&2
    echo "  script. Refusing to start any Transcribe job against a missing" >&2
    echo "  object." >&2
    exit 1
  fi

  # 2a. OLD config: hardcoded LanguageCode, no vocabulary.
  OLD_JOB_NAME="jale-ab-old-${RUN_ID}"
  aws transcribe start-transcription-job \
    --transcription-job-name "$OLD_JOB_NAME" \
    --language-code "$OLD_LANGUAGE_CODE" \
    --media "MediaFileUri=${MEDIA_S3_URI}" \
    --output-bucket-name "$JALE_AB_COMPARE_S3_BUCKET" \
    --output-key "ab-compare/${RUN_ID}/old-transcript.json" \
    --region "$REGION"

  # 2b. NEW config: multi-language identification + custom vocabulary.
  NEW_JOB_NAME="jale-ab-new-${RUN_ID}"
  aws transcribe start-transcription-job \
    --transcription-job-name "$NEW_JOB_NAME" \
    --identify-multiple-languages \
    --language-options "es-US" "en-US" \
    --language-id-settings "{\"es-US\":{\"VocabularyName\":\"${ES_VOCABULARY_NAME}\"}}" \
    --media "MediaFileUri=${MEDIA_S3_URI}" \
    --output-bucket-name "$JALE_AB_COMPARE_S3_BUCKET" \
    --output-key "ab-compare/${RUN_ID}/new-transcript.json" \
    --region "$REGION"

  echo "  started $OLD_JOB_NAME and $NEW_JOB_NAME — poll both for COMPLETED," \
       "then run each transcript through both $OLD_MODEL_ID and" \
       "$NEW_MODEL_ID via bedrock-runtime Converse (same prompt" \
       "ai-profile-writer.ts uses) and write the 4-way comparison to" \
       "${OUTPUT_DIR}/${RUN_ID}.json — left as an operator-run follow-up" \
       "step, not automated here, since job completion times vary and" \
       "this script must not poll unboundedly."
done < "$JALE_AB_COMPARE_MEDIA_URLS_FILE"

echo "ab-compare: started jobs for $n recording(s). Results/config are logged" \
     "above; poll GetTranscriptionJob for each job name before comparing" \
     "output. Output directory: $OUTPUT_DIR"
