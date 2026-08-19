#!/usr/bin/env bash
#
# Operator-run 3-way transcription-provider comparison harness. NEVER run
# this unattended and NEVER run it without explicit, task-specific approval
# from Luis for THIS run — it downloads and transcribes REAL customer
# WhatsApp voice-note audio already staged in S3 and sends real transcript
# text to two third-party APIs (Deepgram, OpenAI) plus Bedrock. That is
# customer PII/audio, not test fixtures. See Jale's CLAUDE.md
# production/sensitive-data boundaries: provider reads/mutations require
# explicit approval every time, not a one-time blanket OK.
#
# What this compares, for a fixed set of REAL voice-note recordings the
# operator points at via S3 keys already sitting in the media bucket (no
# download/staging step needed here, unlike ab-compare.sh's Twilio-URL
# flow):
#
#   (a) AWS Transcribe, current production config — IdentifyMultipleLanguages
#       with LanguageOptions ['es-US','en-US'] and the jale-es-us-trades
#       custom vocabulary attached via LanguageIdSettings. Same flags as
#       ab-compare.sh's NEW-config branch.
#   (b) Deepgram nova-3, multi-language, with keyterm hints generated at
#       runtime from vocabulary-es-us.txt's DisplayAs column (single source
#       of truth — never hand-maintain a second copy of this term list).
#   (c) OpenAI gpt-4o-transcribe, with the same DisplayAs term list folded
#       into the transcription prompt instead of a keyterm API.
#
# Optional extraction pass (JALE_PROVIDER_COMPARE_RUN_EXTRACTION=1): each of
# the three transcript texts is run through `aws bedrock-runtime converse`
# with us.anthropic.claude-haiku-4-5-20251001-v1:0, reproducing (verbatim,
# as of this script's authoring) the extraction prompt
# infra/lambda/whatsapp/ai-profile-writer.ts's extractProfileFromTranscript
# builds — see the EXTRACTION_SYSTEM_PROMPT/EXTRACTION_USER_PROMPT_PREFIX
# heredocs below. If that function's prompt text changes, update the copy
# here to match; this script must reproduce the CURRENT production prompt,
# not drift into its own dialect.
#
# Output: one directory per run (${OUTPUT_DIR}/${RUN_ID}/), one
# subdirectory per sample holding that sample's three raw provider
# responses (transcribe.json / deepgram.json / openai.json, plus
# *-extraction.json when the extraction pass ran), and a single
# comparison.md side-by-side table for human review.
#
# ── This script decides nothing. A HUMAN reads comparison.md. ──
#
# Decision criteria for that human review, in priority order:
#   1. Garbled trade-term count (PRIMARY) — for each provider, how many of
#      vocabulary-es-us.txt's DisplayAs terms (troca, rufero, tablaroca,
#      banqueta, colado, cimbra, retroexcavadora, ...) came out garbled,
#      mistranscribed, or dropped entirely.
#   2. Field yield — how many of ai-profile-writer.ts's extracted_fields
#      came back non-null with confidence >= 0.75 (only measured when
#      JALE_PROVIDER_COMPARE_RUN_EXTRACTION=1; see the *-extraction.json
#      files and the field-count columns in comparison.md).
#   3. Code-switch fidelity — how well each provider handles Spanish/English
#      code-switching mid-sentence, typical of these voice notes.
#   4. Failure rate, latency, and cost per provider (not measured by this
#      script — read the timestamps/HTTP status this script logs, and each
#      provider's own dashboard, for that).
#
# Usage:
#   JALE_PROVIDER_COMPARE_S3_KEYS_FILE=./my-samples.txt \
#   JALE_MEDIA_BUCKET=<media bucket> \
#   DEEPGRAM_API_KEY=... \
#   OPENAI_API_KEY=... \
#     ./provider-compare.sh
#
# Required env:
#   JALE_PROVIDER_COMPARE_S3_KEYS_FILE   file, one media-bucket S3 key per
#                                         line (e.g. <userId>/voice-messages/
#                                         <mediaId> — no s3:// prefix, no
#                                         other PII in the file)
#   JALE_MEDIA_BUCKET                    S3 bucket holding those objects
#                                         (fail-closed if unset)
#   DEEPGRAM_API_KEY                     Deepgram API key — never written to
#                                         a file, never echoed
#   OPENAI_API_KEY                       OpenAI API key — never written to a
#                                         file, never echoed
#
# Optional env:
#   JALE_PROVIDER_COMPARE_REGION            default us-east-2
#   JALE_PROVIDER_COMPARE_ES_VOCABULARY_NAME default jale-es-us-trades
#   JALE_PROVIDER_COMPARE_RUN_EXTRACTION     set to "1" to also run the
#                                             Bedrock extraction pass
#                                             against each transcript
#   OUTPUT_DIR                               default ./provider-compare-out
#   JALE_PROVIDER_COMPARE_RUN_TS             run timestamp used in every S3
#                                             key / job name / output path
#                                             (default: current epoch). Every
#                                             per-sample, per-provider step
#                                             below skips instead of re-doing
#                                             work when its output file
#                                             already exists, so re-running
#                                             with the SAME
#                                             JALE_PROVIDER_COMPARE_RUN_TS
#                                             after a mid-run failure resumes
#                                             rather than re-billing already-
#                                             completed steps.
#
# Never add -v/--trace* to any curl call in this script — that would print
# the Authorization header (containing DEEPGRAM_API_KEY/OPENAI_API_KEY) to
# stdout/logs. This script never enables `set -x` for the same reason. A
# third vector: a key passed as a literal `-H "Authorization: ..."` curl
# argv entry is visible to any process on the host via `ps`/
# `/proc/<pid>/cmdline` for the full duration of that curl invocation — so
# both API keys are instead injected via `curl --config <(printf 'header =
# "Authorization: ..." ...')`, a curl config read from a file descriptor
# rather than passed as a command-line argument.
set -euo pipefail

cd "$(dirname "$0")"

: "${JALE_PROVIDER_COMPARE_S3_KEYS_FILE:?set to a file of media-bucket S3 keys, one per line}"
: "${JALE_MEDIA_BUCKET:?set to the S3 bucket holding the WhatsApp voice-note media objects}"
: "${DEEPGRAM_API_KEY:?set to a Deepgram API key}"
: "${OPENAI_API_KEY:?set to an OpenAI API key}"

REGION="${JALE_PROVIDER_COMPARE_REGION:-us-east-2}"
ES_VOCABULARY_NAME="${JALE_PROVIDER_COMPARE_ES_VOCABULARY_NAME:-jale-es-us-trades}"
OUTPUT_DIR="${OUTPUT_DIR:-./provider-compare-out}"
RUN_EXTRACTION="${JALE_PROVIDER_COMPARE_RUN_EXTRACTION:-0}"

BEDROCK_MODEL_ID="us.anthropic.claude-haiku-4-5-20251001-v1:0"
VOCAB_FILE="vocabulary-es-us.txt"
TRANSCRIBE_POLL_INTERVAL_SECONDS=15

if [ ! -f "$VOCAB_FILE" ]; then
  echo "provider-compare: $VOCAB_FILE not found next to this script." >&2
  exit 1
fi

# One timestamp for the whole run, overridable so a re-run after a mid-run
# failure (rate limit, transient network error, etc.) resumes against the
# same job names / output paths instead of minting fresh ones and re-billing
# every already-completed step. Mirrors ab-compare.sh's RUN_TS contract.
RUN_TS="${JALE_PROVIDER_COMPARE_RUN_TS:-$(date +%s)}"
RUN_ID="pc-${RUN_TS}"
RUN_DIR="${OUTPUT_DIR}/${RUN_ID}"
mkdir -p "$RUN_DIR"

echo "provider-compare: run id is ${RUN_ID} — to re-run/resume against the"
echo "  same output paths and job names, export JALE_PROVIDER_COMPARE_RUN_TS=${RUN_TS}"

echo "provider-compare: this touches REAL customer audio from"
echo "  s3://${JALE_MEDIA_BUCKET}/<key> for every key in"
echo "  $JALE_PROVIDER_COMPARE_S3_KEYS_FILE and sends real transcript text to"
echo "  Deepgram, OpenAI, and (if extraction is enabled) Bedrock. Confirm"
echo "  explicit approval was given for THIS run before continuing."
read -r -p "Type 'yes-i-have-approval' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes-i-have-approval" ]; then
  echo "provider-compare: confirmation not given, aborting." >&2
  exit 1
fi

if [ "$RUN_EXTRACTION" = "1" ]; then
  echo "provider-compare: extraction pass ENABLED (JALE_PROVIDER_COMPARE_RUN_EXTRACTION=1)"
else
  echo "provider-compare: extraction pass disabled (set JALE_PROVIDER_COMPARE_RUN_EXTRACTION=1 to enable)"
fi

# ── Temp-file hygiene: every downloaded audio object goes through mktemp and
#    is removed on exit, success or failure, via this single trap. ──
TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && rm -f "$f"
  done
}
trap cleanup EXIT

# ── vocabulary-es-us.txt's DisplayAs column is the single source of truth
#    for both Deepgram's keyterm hints and OpenAI's prompt term list —
#    generated once, at runtime, from the file itself, never hand-copied. ──
DISPLAY_TERMS="$(awk -F'\t' 'NR>1 && $2 != "" {print $2}' "$VOCAB_FILE")"
DISPLAY_TERMS_CSV="$(printf '%s\n' "$DISPLAY_TERMS" | paste -sd, -)"
DEEPGRAM_KEYTERM_QS="$(printf '%s\n' "$DISPLAY_TERMS" | jq -R -r '@uri' | sed 's/^/keyterm=/' | paste -sd'&' -)"
DEEPGRAM_URL="https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&${DEEPGRAM_KEYTERM_QS}"

# ── Extraction prompt, pinned to infra/lambda/whatsapp/ai-profile-writer.ts.
#    Copied VERBATIM from that file's extractProfileFromTranscript() (read
#    on 2026-08-19 for this script's authoring). INDUSTRY_KEYWORDS is
#    omitted here since it's env-driven (AI_INDUSTRY_KEYWORDS) there and
#    empty by default in the real system prompt too — the keywordsText
#    interpolation collapses to "" in that case, which is what's reproduced
#    below. run_extraction()'s `aws bedrock-runtime converse` call also
#    passes `--inference-config '{"maxTokens":1024}'` for parity with that
#    same function's `inferenceConfig: { maxTokens: 1024 }`. If
#    ai-profile-writer.ts's prompt text or inferenceConfig changes, update
#    this copy to match.
#
#    DELIBERATE DEVIATION — user-prompt ASR-metadata block: production's
#    extractProfileFromTranscript() appends a conditional "ASR metadata
#    (calibration only, ...)" block after the transcript, built from
#    Transcribe's per-word confidences and language codes. This harness
#    EXCLUDES that block for all three providers ON PURPOSE: only the
#    Transcribe branch could supply it, and giving one provider a different
#    prompt than the other two would confound transcript quality with
#    prompt shape — the whole point here is field yield under IDENTICAL
#    prompts. The system prompt's ASR-metadata sentence IS included below
#    (production sends it unconditionally, block or no block). ──
EXTRACTION_SYSTEM_PROMPT=$(cat <<'EOF'
You are a profile extraction assistant for Jale, a bilingual job platform for blue-collar workers in the US.
Extract structured profile information from voice message transcripts. Workers may speak English or Spanish.
Return ONLY valid JSON — no additional text, no markdown fences.
You may be given ASR metadata about transcription quality. Use it only to calibrate confidence_scores (lower confidence for fields supported by low-confidence words); never copy it into extracted fields.
EOF
)

EXTRACTION_USER_PROMPT_PREFIX=$(cat <<'EOF'
Extract profile information from this transcript. Return JSON with exactly these keys:
{
  "extracted_fields": {
    "full_name": string or null,
    "city": string or null,
    "main_trade": one of ["electrician","plumber","carpenter","concrete","painting","other"] or null,
    "main_trade_other": string or null (only if main_trade is "other"),
    "years_experience": one of ["0-1","2-4","5-9","10+"] or null,
    "has_transportation": boolean or null,
    "availability": one of ["full_time","part_time","weekends","flexible"] or null
  },
  "confidence_scores": { same keys, values 0.0-1.0 indicating extraction confidence },
  "summary_en": "1-2 sentence profile summary in English",
  "summary_es": "1-2 sentence profile summary in Spanish"
}

Transcript:
EOF
)

# A fixed RUN_TS means a re-run revisits job names it already created;
# Transcribe rejects duplicate job names, so skip any job that already
# exists instead of dying mid-batch. Never re-bill a recording that was
# already submitted. Mirrors ab-compare.sh's job_exists().
transcribe_job_exists() {
  aws transcribe get-transcription-job \
    --transcription-job-name "$1" \
    --region "$REGION" >/dev/null 2>&1
}

# Job-polling pattern mirrors create-vocabulary.sh's vocabulary-state poll
# loop (ab-compare.sh leaves polling as an operator follow-up step; this
# script automates it since it needs the finished transcript to produce
# transcribe.json). Polls until COMPLETED/FAILED — never polls unboundedly
# in the sense of ignoring FAILED, but does not itself impose a timeout;
# ctrl-C and re-run with the same RUN_TS if a job hangs.
wait_for_transcription_job() {
  local job_name="$1"
  local status
  while true; do
    status=$(aws transcribe get-transcription-job \
      --transcription-job-name "$job_name" \
      --region "$REGION" \
      --query 'TranscriptionJob.TranscriptionJobStatus' \
      --output text)
    echo "    provider-compare: transcribe job $job_name status=$status"
    if [ "$status" = "COMPLETED" ]; then
      return 0
    fi
    if [ "$status" = "FAILED" ]; then
      aws transcribe get-transcription-job \
        --transcription-job-name "$job_name" \
        --region "$REGION" \
        --query 'TranscriptionJob.FailureReason' \
        --output text >&2
      return 1
    fi
    sleep "$TRANSCRIBE_POLL_INTERVAL_SECONDS"
  done
}

# Extract a provider's plain transcript text out of its raw response JSON.
# Returns "" (not an error) for a missing/empty file so a failed provider
# step doesn't take down comparison.md generation for the other providers.
extract_text() {
  local file="$1" filter="$2"
  if [ -s "$file" ]; then
    jq -r "$filter" "$file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Mirrors ai-profile-writer.ts's parseBedrockJsonResponse() exactly (same
# ```json fence-stripping regex) so the count below reflects what the real
# lambda would actually parse, not a looser approximation. Counts fields
# whose extracted value is non-null AND whose confidence clears 0.75 —
# same gate buildUserUpdateSql() applies before writing to `users`.
count_high_confidence_fields() {
  local extraction_file="$1"
  if [ ! -s "$extraction_file" ]; then
    echo 0
    return
  fi
  node -e '
    const fs = require("fs");
    const CONFIDENCE_THRESHOLD = 0.75;
    try {
      const resp = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
      const raw = resp?.output?.message?.content?.[0]?.text ?? "";
      const trimmed = raw.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      const jsonText = fenced ? fenced[1].trim() : trimmed;
      const parsed = JSON.parse(jsonText);
      const fields = parsed.extracted_fields ?? {};
      const scores = parsed.confidence_scores ?? {};
      let count = 0;
      for (const key of Object.keys(fields)) {
        if (fields[key] != null && (scores[key] ?? 0) >= CONFIDENCE_THRESHOLD) count++;
      }
      process.stdout.write(String(count));
    } catch {
      process.stdout.write("0");
    }
  ' "$extraction_file" 2>/dev/null || echo 0
}

# Runs the pinned extraction prompt against one transcript's text and writes
# the raw `aws bedrock-runtime converse` response to $3. Skips (does not
# re-call Bedrock) if $3 already exists from a prior run with this RUN_TS.
run_extraction() {
  local provider_label="$1" transcript_text="$2" out_file="$3"
  if [ -s "$out_file" ]; then
    echo "    provider-compare: ${out_file} already exists — skipping (already extracted on a prior run)"
    return 0
  fi
  if [ -z "$transcript_text" ]; then
    echo "    provider-compare: ${provider_label} transcript is empty — skipping extraction" >&2
    return 0
  fi
  local user_prompt system_json messages_json
  # Space between the heredoc-sourced prefix and the transcript is added
  # explicitly here (not as invisible trailing whitespace in the heredoc
  # above) to exactly reproduce ai-profile-writer.ts's
  # `Transcript: ${transcript}` — a space, then the transcript text
  # directly, no newline.
  user_prompt="${EXTRACTION_USER_PROMPT_PREFIX} ${transcript_text}"
  system_json=$(jq -n --arg t "$EXTRACTION_SYSTEM_PROMPT" '[{"text":$t}]')
  messages_json=$(jq -n --arg t "$user_prompt" '[{"role":"user","content":[{"text":$t}]}]')
  aws bedrock-runtime converse \
    --model-id "$BEDROCK_MODEL_ID" \
    --system "$system_json" \
    --messages "$messages_json" \
    --inference-config '{"maxTokens":1024}' \
    --region "$REGION" \
    --output json > "$out_file"
}

# ── Markdown table setup ──
COMPARISON_MD="${RUN_DIR}/comparison.md"
{
  echo "# provider-compare run ${RUN_ID}"
  echo
  echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). A HUMAN must review this table before"
  echo "any decision is made — see this script's header comment for the full"
  echo "decision criteria (garbled trade-term count first, then field yield,"
  echo "code-switch fidelity, then failure/latency/cost). This script does"
  echo "not decide anything."
  echo
  if [ "$RUN_EXTRACTION" = "1" ]; then
    echo "| Sample | Transcribe text | Deepgram text | OpenAI text | Transcribe fields≥0.75 | Deepgram fields≥0.75 | OpenAI fields≥0.75 |"
    echo "|---|---|---|---|---|---|---|"
  else
    echo "| Sample | Transcribe text | Deepgram text | OpenAI text |"
    echo "|---|---|---|---|"
  fi
} > "$COMPARISON_MD"

md_cell() {
  # Collapse newlines and escape pipes so a transcript can't corrupt the
  # markdown table structure.
  printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'
}

# ── Main per-sample loop ──
i=0
while IFS= read -r S3_KEY; do
  [ -z "$S3_KEY" ] && continue
  i=$((i + 1))
  echo "provider-compare: [$i] processing $S3_KEY"

  SAMPLE_DIR="${RUN_DIR}/${i}"
  mkdir -p "$SAMPLE_DIR"

  # Fail closed: never start a billed provider call against a key that
  # doesn't exist, and never GUESS a content-type for the Deepgram/OpenAI
  # calls below — a wrong content-type silently garbles the transcript,
  # corrupting the garbled-trade-term count, this script's PRIMARY decision
  # metric (see header comment). So this captures ContentType instead of
  # discarding head-object's output (same ethos as ab-compare.sh's staging
  # guard, extended to cover the content-type). Media objects are one of
  # audio/ogg, audio/mpeg, or audio/mp4 (infra/lambda/whatsapp/lib/media.ts's
  # ALLOWED_VOICE_TYPES) — CONTENT_TYPE/AUDIO_EXT below drive (a) Deepgram's
  # Content-Type header verbatim and (b) an explicit filename+type on
  # OpenAI's multipart upload, since OpenAI's /v1/audio/transcriptions
  # detects the container from the multipart FILENAME extension, not by
  # sniffing bytes — a bare extensionless mktemp path 400s on every sample.
  CONTENT_TYPE="$(aws s3api head-object \
    --bucket "$JALE_MEDIA_BUCKET" \
    --key "$S3_KEY" \
    --region "$REGION" \
    --query 'ContentType' \
    --output text 2>/dev/null)" || CONTENT_TYPE=""

  if [ -z "$CONTENT_TYPE" ] || [ "$CONTENT_TYPE" = "None" ]; then
    echo "provider-compare: [$i] SOURCE NOT FOUND — s3://${JALE_MEDIA_BUCKET}/${S3_KEY} does not exist (or has no ContentType)." >&2
    echo "  Refusing to start any provider call against a missing/untyped object." >&2
    exit 1
  fi

  case "$CONTENT_TYPE" in
    audio/ogg) AUDIO_EXT="ogg" ;;
    audio/mpeg) AUDIO_EXT="mp3" ;;
    audio/mp4) AUDIO_EXT="m4a" ;;
    *)
      echo "provider-compare: [$i] UNSUPPORTED ContentType '${CONTENT_TYPE}' for s3://${JALE_MEDIA_BUCKET}/${S3_KEY}" >&2
      echo "  Only audio/ogg, audio/mpeg, audio/mp4 are supported (see" >&2
      echo "  infra/lambda/whatsapp/lib/media.ts's ALLOWED_VOICE_TYPES)." >&2
      echo "  Refusing to guess a container/extension — that would silently" >&2
      echo "  garble the transcript." >&2
      exit 1
      ;;
  esac

  # ── (a) AWS Transcribe — current production flags ──
  TRANSCRIBE_JSON="${SAMPLE_DIR}/transcribe.json"
  if [ -s "$TRANSCRIBE_JSON" ]; then
    echo "  [$i] transcribe.json already exists — skipping (already fetched on a prior run)"
  else
    JOB_NAME="jale-provider-compare-${RUN_ID}-${i}"
    JOB_OUTPUT_KEY="provider-compare/${RUN_ID}/${i}/transcribe-output.json"
    if transcribe_job_exists "$JOB_NAME"; then
      echo "  [$i] $JOB_NAME already exists — skipping start (already submitted on a prior run)"
    else
      aws transcribe start-transcription-job \
        --transcription-job-name "$JOB_NAME" \
        --identify-multiple-languages \
        --language-options "es-US" "en-US" \
        --language-id-settings "{\"es-US\":{\"VocabularyName\":\"${ES_VOCABULARY_NAME}\"}}" \
        --media "MediaFileUri=s3://${JALE_MEDIA_BUCKET}/${S3_KEY}" \
        --output-bucket-name "$JALE_MEDIA_BUCKET" \
        --output-key "$JOB_OUTPUT_KEY" \
        --region "$REGION"
    fi

    if ! wait_for_transcription_job "$JOB_NAME"; then
      echo "provider-compare: [$i] Transcribe job $JOB_NAME FAILED (reason printed above)." >&2
      exit 1
    fi

    aws s3 cp "s3://${JALE_MEDIA_BUCKET}/${JOB_OUTPUT_KEY}" "$TRANSCRIBE_JSON" --region "$REGION"
  fi

  # ── (b) Deepgram + (c) OpenAI — both need the raw audio bytes locally ──
  DEEPGRAM_JSON="${SAMPLE_DIR}/deepgram.json"
  OPENAI_JSON="${SAMPLE_DIR}/openai.json"
  if [ -s "$DEEPGRAM_JSON" ] && [ -s "$OPENAI_JSON" ]; then
    echo "  [$i] deepgram.json and openai.json already exist — skipping audio download"
  else
    AUDIO_TMP=$(mktemp)
    TMP_FILES+=("$AUDIO_TMP")
    aws s3 cp "s3://${JALE_MEDIA_BUCKET}/${S3_KEY}" "$AUDIO_TMP" --region "$REGION"

    if [ -s "$DEEPGRAM_JSON" ]; then
      echo "  [$i] deepgram.json already exists — skipping (already fetched on a prior run)"
    else
      echo "  [$i] calling Deepgram nova-3"
      if ! curl -sf --data-binary "@${AUDIO_TMP}" \
        --config <(printf 'header = "Authorization: Token %s"\n' "$DEEPGRAM_API_KEY") \
        -H "Content-Type: $CONTENT_TYPE" \
        "$DEEPGRAM_URL" \
        -o "$DEEPGRAM_JSON"; then
        echo "provider-compare: [$i] Deepgram call FAILED." >&2
        exit 1
      fi
    fi

    if [ -s "$OPENAI_JSON" ]; then
      echo "  [$i] openai.json already exists — skipping (already fetched on a prior run)"
    else
      echo "  [$i] calling OpenAI gpt-4o-transcribe"
      # The prompt field uses --form-string, not -F: curl's -F/--form splits
      # a plain (non-@) value on `;` to look for type=/filename=/headers=
      # sub-parameters, REGARDLESS of whether the field is a file upload —
      # so with -F, this prompt's own "...worker; expect terms: ..." would
      # silently truncate at the semicolon, dropping the entire vocabulary
      # hint list. --form-string treats the value as fully literal. (The
      # file= field below deliberately keeps -F, since it relies on exactly
      # that semicolon-splitting to attach filename=/type=.)
      if ! curl -sf https://api.openai.com/v1/audio/transcriptions \
        --config <(printf 'header = "Authorization: Bearer %s"\n' "$OPENAI_API_KEY") \
        -F model=gpt-4o-transcribe \
        -F "file=@${AUDIO_TMP};filename=audio.${AUDIO_EXT};type=${CONTENT_TYPE}" \
        --form-string "prompt=Spanglish construction-trade voice note from a Texas blue-collar worker; expect terms: ${DISPLAY_TERMS_CSV}" \
        -o "$OPENAI_JSON"; then
        echo "provider-compare: [$i] OpenAI call FAILED." >&2
        exit 1
      fi
    fi
  fi

  # ── Extract plain transcript text per provider for the comparison table ──
  TRANSCRIBE_TEXT=$(extract_text "$TRANSCRIBE_JSON" '.results.transcripts[0].transcript // ""')
  DEEPGRAM_TEXT=$(extract_text "$DEEPGRAM_JSON" '.results.channels[0].alternatives[0].transcript // ""')
  OPENAI_TEXT=$(extract_text "$OPENAI_JSON" '.text // ""')

  ROW="| $(md_cell "$i — $S3_KEY") | $(md_cell "$TRANSCRIBE_TEXT") | $(md_cell "$DEEPGRAM_TEXT") | $(md_cell "$OPENAI_TEXT") |"

  # ── Optional extraction pass ──
  if [ "$RUN_EXTRACTION" = "1" ]; then
    echo "  [$i] running extraction pass (JALE_PROVIDER_COMPARE_RUN_EXTRACTION=1)"
    run_extraction "transcribe" "$TRANSCRIBE_TEXT" "${SAMPLE_DIR}/transcribe-extraction.json"
    run_extraction "deepgram" "$DEEPGRAM_TEXT" "${SAMPLE_DIR}/deepgram-extraction.json"
    run_extraction "openai" "$OPENAI_TEXT" "${SAMPLE_DIR}/openai-extraction.json"

    TRANSCRIBE_FIELD_COUNT=$(count_high_confidence_fields "${SAMPLE_DIR}/transcribe-extraction.json")
    DEEPGRAM_FIELD_COUNT=$(count_high_confidence_fields "${SAMPLE_DIR}/deepgram-extraction.json")
    OPENAI_FIELD_COUNT=$(count_high_confidence_fields "${SAMPLE_DIR}/openai-extraction.json")

    ROW="${ROW} ${TRANSCRIBE_FIELD_COUNT} | ${DEEPGRAM_FIELD_COUNT} | ${OPENAI_FIELD_COUNT} |"
  fi

  echo "$ROW" >> "$COMPARISON_MD"
done < "$JALE_PROVIDER_COMPARE_S3_KEYS_FILE"

echo "provider-compare: processed $i sample(s). Review ${COMPARISON_MD} — a"
echo "  human decides, this script does not. Run directory: ${RUN_DIR}"
