#!/usr/bin/env bash
#
# Operator-run only. Never executed by an agent — this creates/overwrites a
# real AWS resource against a live account.
#
# MUST run BEFORE the whatsapp-stack deploy that wires
# `esVocabularyName: 'jale-es-us-trades'` into both voice-transcription
# pipelines (see infra/lib/stacks/whatsapp-stack.ts). The construct omits
# LanguageIdSettings entirely when the vocabulary name prop is unset, but
# once the prop IS set, every StartTranscriptionJob call references this
# name — if the vocabulary doesn't exist yet in this account/region,
# EVERY voice-note transcription job fails at StartTranscriptionJob time
# until it does. Deploy order: run this script, wait for READY, THEN deploy.
#
# Usage:
#   ./create-vocabulary.sh [vocabulary-name]
#
# Defaults to `jale-es-us-trades` (the name wired into whatsapp-stack.ts) if
# no argument is given. Region is fixed at us-east-2 — the vocabulary must
# live in the same region as the Transcribe jobs that reference it
# (voice-transcription-pipeline.ts's StartTranscribeJob task runs in this
# stack's home region).
#
# ── update-vocabulary semantics (read before re-running this for edits) ──
#
# `aws transcribe update-vocabulary` performs a FULL OVERWRITE of the
# vocabulary's contents — it is not a merge/append. Re-running this script
# with a MODIFIED vocabulary-es-us.txt against an EXISTING vocabulary name
# replaces every row, not just the new ones; any term removed from the file
# is gone from the vocabulary too. There is no versioned/incremental update
# path for a Transcribe custom vocabulary — same name, in place, full
# replace, cycling PENDING -> READY (or FAILED) again just like a fresh
# create. If a diff needs reviewing before an overwrite, diff
# vocabulary-es-us.txt against what's already deployed (there is no GET-the-
# table-back API — the operator is the source of truth for what's live).
set -euo pipefail

cd "$(dirname "$0")"

VOCABULARY_NAME="${1:-jale-es-us-trades}"
LANGUAGE_CODE="es-US"
REGION="us-east-2"
VOCAB_FILE="vocabulary-es-us.txt"
POLL_INTERVAL_SECONDS=15

if [ ! -f "$VOCAB_FILE" ]; then
  echo "create-vocabulary: $VOCAB_FILE not found next to this script." >&2
  exit 1
fi

# VocabularyFileUri must point at an S3 object, not a local path — upload
# first. Bucket/prefix are operator-supplied via env so this script never
# hardcodes an account-specific bucket name.
if [ -z "${JALE_TRANSCRIBE_VOCAB_S3_BUCKET:-}" ]; then
  echo "create-vocabulary: set JALE_TRANSCRIBE_VOCAB_S3_BUCKET to an S3 bucket" >&2
  echo "  in $REGION that this AWS identity can write to and Transcribe can read from." >&2
  exit 1
fi

S3_KEY="transcribe-vocabularies/${VOCABULARY_NAME}.txt"
S3_URI="s3://${JALE_TRANSCRIBE_VOCAB_S3_BUCKET}/${S3_KEY}"

echo "create-vocabulary: uploading $VOCAB_FILE to $S3_URI"
aws s3 cp "$VOCAB_FILE" "$S3_URI" --region "$REGION"

echo "create-vocabulary: creating vocabulary '$VOCABULARY_NAME' ($LANGUAGE_CODE, $REGION)"
aws transcribe create-vocabulary \
  --vocabulary-name "$VOCABULARY_NAME" \
  --language-code "$LANGUAGE_CODE" \
  --vocabulary-file-uri "$S3_URI" \
  --region "$REGION"

echo "create-vocabulary: polling every ${POLL_INTERVAL_SECONDS}s for READY/FAILED..."
while true; do
  STATE=$(aws transcribe get-vocabulary \
    --vocabulary-name "$VOCABULARY_NAME" \
    --region "$REGION" \
    --query 'VocabularyState' \
    --output text)

  echo "create-vocabulary: state=$STATE"

  if [ "$STATE" = "READY" ]; then
    echo "create-vocabulary: '$VOCABULARY_NAME' is READY. Safe to deploy whatsapp-stack now."
    exit 0
  fi

  if [ "$STATE" = "FAILED" ]; then
    aws transcribe get-vocabulary \
      --vocabulary-name "$VOCABULARY_NAME" \
      --region "$REGION" \
      --query 'FailureReason' \
      --output text >&2
    echo "create-vocabulary: vocabulary creation FAILED (reason printed above)." >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
