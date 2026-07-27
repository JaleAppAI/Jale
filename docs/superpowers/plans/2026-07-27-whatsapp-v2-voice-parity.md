# WhatsApp v2 Voice Full Parity + Audit Ride-Alongs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. On approval, this plan is also saved to `docs/superpowers/plans/2026-07-27-whatsapp-v2-voice-parity.md` (with `git add -f` — docs/ is gitignored, see Task 10).

**Goal:** Wire voice notes into the v2 onboarding lane end to end (trust answers + full voice profile intake), fix answer-integrity gaps (greetings saved as names), add RESTART/BACK, and write the lost rollout runbook.

**Architecture:** Voice audio flows through the existing deployed pipelines (Twilio media → S3 → Step Functions Transcribe → completion lambda). The completion lambda performs **zero DB work** on the v2 path: it re-enters the lane by sending a synthetic inbound event to the existing v2 FIFO queue (`MessageGroupId` = phone hash, sid `<origSid>#vt`/`#vp`), so the processor's claim idempotency, per-phone FIFO serialization, and RLS posture apply unchanged. Stale results (worker typed first / run moved on) are discarded by a `runId + stepKey` match. Everything is gated by a new `voice_intake_enabled` runtime control (same pattern as `onboarding_v2_enabled`, off by default, per-phone allowlist first).

**Tech Stack:** TypeScript, AWS CDK, Lambda, SQS FIFO, Step Functions + Transcribe, Bedrock (ai-profile-writer), PostgreSQL (RLS/SECURITY DEFINER), Twilio WhatsApp, Jest + the deterministic conversation testbed.

## Global Constraints

- Jest ALWAYS capped: `npm test` (= `jest --maxWorkers=2`) or explicit `--maxWorkers=2`; NEVER detached/uncapped (host OOM kills the session — hard rule).
- No Claude/AI attribution in commits or PR text.
- Templates: ASCII no-accent copy, en/es distinct (pinned by expectDistinctLanguages).
- PII log discipline: safe scalars only — never transcript text, message bodies, phone numbers, or OTPs in any log line.
- All profile writes go through ProfilePersistenceAdapter methods — never raw column writes (CHECK-constraint discipline: chk_trade_other atomic pair, location TEXT only).
- Test fakes must be faithful to real dependency contracts (constraints, rotation, staleness) — no always-agreeing fakes.
- `docs/` is GITIGNORED (line 41): any new file under docs/ requires `git add -f`.
- Prod promotion is HELD until this stream lands (owner decision); merge target is main only.

---

## Stream A — Voice core: media plumbing, runtime control, trust voice, re-entry (design locked)

### Task 1: `voice-events.ts` shared primitive
**Files:** Create `infra/lambda/whatsapp/lib/voice-events.ts`; Test `infra/test/unit/lambda/whatsapp/lib/voice-events.test.ts`
**Produces:** `VoiceEventV2` — discriminated union on `kind` (single `voiceEvent` field on the v2 message consumes it): common envelope `{version:'v2', status:'COMPLETED'|'FAILED', phone, runId, stepKey, language, origMessageSid, startedAt}`; `kind:'trust_answer'` adds `{questionIndex, transcript?, transcriptOutputKey?}`; `kind:'profile_intake'` adds `{fields: VoiceExtractionFields|null, confidences, summaryEn, summaryEs, executionArn, extractionId}` (see Stream B reconciliation note); `VoicePipelineExecutionInputV2` (SFN input envelope: transcriptionJobName, languageCode, mediaS3Uri, mediaBucketName, transcriptOutputKey, v2: envelope-sans-status/transcript); `VOICE_EVENT_FIELD='XJaleVoiceEvent'`; `syntheticVoiceSid(origSid, kind)` (`#vt`/`#vp` suffix, ≤50 chars); `buildSyntheticVoiceInboundBody(evt)` (URLSearchParams with From/MessageSid/Body=''/XJaleVoiceEvent=JSON); `parseVoiceTranscriptEvent(params)` (strict: sid-suffix match AND valid JSON AND version==='v2', else null). Also `MAX_VOICE_BYTES = 16*1024*1024` added to `lib/media.ts`.
Tests: encoder/parser round-trip; sid length ≤ VARCHAR(50); rejection of missing suffix / bad JSON / wrong version; '#' never in real Twilio sids (spoof-proofing note).

### Task 2: media fields into the v2 message + processor plumbing
**Files:** Modify `infra/lambda/whatsapp/onboarding/types.ts` (OnboardingV2InboundMessage += numMedia/mediaUrl/mediaSid/mediaContentType/voiceEvent; OnboardingV2Deps += `voiceIntake: {enabled, startTrustTranscription(input), ingestProfileVoiceNote(input)}` — the second starter is implemented in Stream B); Modify `infra/lambda/whatsapp/processor.ts` (~601: `parseVoiceTranscriptEvent(params)` → thread through IncomingMessage; ~1209: populate the new v2Message fields; if voiceEvent set but v2 disabled → log `OnboardingVoiceTranscriptDropped`, return — never reaches the legacy lane).
Tests (processor.test.ts): media fields survive into v2Message; synthetic `#vt` record claims via whatsapp_processed_messages and routes with voiceEvent populated; duplicate synthetic sid no-ops; v2-disabled drop.

### Task 3: `voice_intake_enabled` runtime control
**Files:** Create `infra/db/migrations/051_whatsapp_voice_intake_control.sql` (INSERT ... ON CONFLICT DO NOTHING, enabled=false/global=false); Modify `infra/lambda/whatsapp/lib/runtime-controls.ts` (`isVoiceIntakeEnabled(controls, phoneHash)` mirroring isV2Enabled; fail closed); Modify `infra/scripts/whatsapp-runtime-controls.ts` (control-name arg, default backwards-compatible); register migration in `scripts/run-migrations.sh` MIGRATIONS + `run-migrations.ps1` + `apply-order.test.ts` expectedBaselineMigrations + manifest tests (four places — see running-jale-migrations skill).
**NOTE:** adding a migration file makes deploy-production's guard FIRE on the prod push diff — apply 051 via `scripts/run-migrations.sh` first, then `workflow_dispatch deploy_scope=all` (runbook covers this; also 051 is a harmless single INSERT).
Tests: runtime-controls unit tests (fail-closed row validation); CLI arg tests; migration manifest sync tests.

### Task 4: trust-question voice path (outbound leg)
**Files:** Modify `infra/lambda/whatsapp/onboarding/steps/trust.ts`: refactor lines 92-137 into `recordTrustAnswer(..., answerText, answerSource:'text'|'voice')` (typed path passes 'text'); insert voice branches before option/free-text parse: (i) `msg.voiceEvent?.kind==='trust_answer'` → `applyTrustVoiceTranscript`, (ii) `numMedia>0` → `handleTrustVoiceNote` (control OFF → `v2_voice_not_supported` + reprompt; non-audio → `v2_voice_invalid_type`; valid → `deps.voiceIntake.startTrustTranscription({workerId, phone, runId, stepKey, questionIndex, language, mediaUrl, mediaContentType, inboundMessageSid})` → `v2_voice_ack`; step NOT advanced, no lock — a typed answer wins the race).
Modify `infra/lambda/whatsapp/processor.ts` (v2Deps wiring ~1157): implement `startTrustTranscription` mirroring handleAwaitingMediaVoice (download → MAX_VOICE_BYTES check → buildS3Key/uploadMediaToS3 → worker_profile_media row → StartExecution on TRUST_PIPELINE_STATE_MACHINE_ARN with deterministic `name: vt-<sid>`, catch ExecutionAlreadyExists → started:true). No new env/IAM (grants exist at whatsapp-stack.ts:519-538).

### Task 5: completion re-entry (receiver → FIFO → trust apply)
**Files:** Modify `infra/lambda/ai/voice-trust-receiver.ts`: v2 branch at top of handleVoiceTrustCompletion — no DB; COMPLETED → readTranscript (empty ⇒ FAILED); build VoiceTranscriptEventV2; SendMessage to `WHATSAPP_INBOUND_V2_QUEUE_URL` (group = hashNormalizedPhone, dedup = syntheticVoiceSid); safe-scalar logs. Legacy path byte-identical.
Modify `infra/lib/stacks/whatsapp-stack.ts` (~500): receiver gets queue URL env + `grantSendMessages`, gated on the same transport flag as the webhook wiring (192-201).
`applyTrustVoiceTranscript` in trust.ts: stale (`evt.runId !== gate.runId || evt.stepKey !== stepKey`) → metric `OnboardingVoiceTranscriptStale`, silent discard; FAILED/empty → `v2_voice_failed` + reprompt; success → `recordTrustAnswer(..., transcript.trim(), 'voice')` — third answer flows through the EXISTING completeOnboarding.
Tests: receiver v2 events do zero DB queries + one FIFO send with correct ids; empty transcript ⇒ FAILED; cdk-app pin for env+grant.

### Task 6: graceful voice everywhere + templates
**Files:** Modify `infra/lambda/whatsapp/onboarding-v2.ts` (routeBoundStep pre-gate: media at non-voice-accepting step → `v2_voice_not_supported` + reprompt; media bypasses command classifiers; transcript events skip the gate — transcript text 'AYUDA' must never trip a command); pre-auth entry: media → enqueuePreAuthText same template; Modify `infra/lambda/whatsapp/processor.ts` handleIdle (~2493): media → `voice_note_not_supported` reply. New `isVoiceAcceptingStep(stepKey, enabled)` helper (trust.question.* now; Stream B extends).
Modify `infra/lambda/whatsapp/lib/templates.ts`: `v2_voice_ack`, `v2_voice_failed`, `v2_voice_not_supported`, `v2_voice_invalid_type`, `voice_note_not_supported` (copy per design, ASCII, en/es).
Tests: templates pins (distinct languages, all keys); onboarding-v2 gate/media tests.

### Task 7: harness fidelity + conversation suite for voice
**Files:** Modify `infra/test/helpers/whatsapp-v2-harness.ts` (fake `voiceIntake` recording `pendingTranscriptions`; `setVoiceIntakeEnabled`; `sendVoiceNote(opts)`; `completeTranscription(i, {status, transcript})` — round-trips through the REAL buildSyntheticVoiceInboundBody/parseVoiceTranscriptEvent and replays the claim-cache check). Create `infra/test/unit/lambda/whatsapp/onboarding-v2-voice.test.ts` pinning: ack + pipeline started + no advance; completion → saveTrustAnswer('voice') + advance; third voice answer → completeOnboarding exactly once; FAILED/empty → fallback + unchanged; stale (typed first) → silent discard; duplicate completion no-op; control OFF → honest reply; voice at profile.name/pre-auth → honest reply; non-audio media → invalid-type; transcript 'AYUDA'/'JOBS' saved as answer, never gate-blocked.

## Stream B — Profile voice intake (profile.voice_choice / voice_processing)

**Contract reconciliation (applies to Task 1):** `voice-events.ts` carries a discriminated union on `kind`:
- `kind:'trust_answer'` → payload has `transcript` (receiver reads S3, embeds text; router applies as answer).
- `kind:'profile_intake'` → payload has `fields: VoiceExtractionFields|null, confidences, summaryEn/Es, executionArn, extractionId` (ai-profile-writer runs Bedrock in the pipeline tail — keeps its existing `worker_profile_ai_extractions` INSERT grant — and enqueues the RESULT; all `users`/`worker_profiles` writes happen in the router turn under the run lock via the existing adapters).
One v2Message field for both: `voiceEvent?: VoiceEventV2` (union). One deps surface: `deps.voiceIntake = { enabled, startTrustTranscription(...), ingestProfileVoiceNote(...) }` — both processor-bound, harness-faked.

### Task 8a: legal-accept voice entry + voice_choice handler
**Files:** Create `infra/lambda/whatsapp/onboarding/steps/voice.ts` (`handleVoiceChoiceStep`, `handleVoiceProcessingStep`, `handleVoiceIntakeResult`); Modify `onboarding/steps/legal.ts` (accept branch → new `advanceLegalAcceptToProfileEntry` in transitions.ts: control ON + resolver reports missing fields → advance legal.review→profile.voice_choice + prompt; else exactly today's advanceProfileToNextStep); Modify `onboarding/transitions.ts`; Modify `onboarding-v2.ts` (dispatch: `msg.voiceEvent?.kind==='profile_intake'` → handleVoiceIntakeResult BEFORE applyGate; switch gains the two steps); Modify `onboarding/gate.ts` (remove the two steps from UNIMPLEMENTED_STEPS; keep photo steps; neither joins FREE_TEXT_STEPS); `onboarding/prompts.ts` (voice_choice → reuse v1 `buildMediaInteractivePrompt('voice_choice')` + registered onboarding_voice_choice_* templates + `media:voice:text` payload dialect; voice_processing → `v2_voice_processing_wait` fallback body); `onboarding/constants.ts` (STEP_ROUTING entries, `VOICE_PROCESSING_TIMEOUT_MS = 5*60*1000`, `VOICE_CONFIDENCE_THRESHOLD = 0.75`).
voice_choice branches: audio → ingest → advance to voice_processing + `v2_voice_processing_ack` (state_context: v2VoiceExecutionArn, v2VoiceStartedAt); `media:voice:text` tap or any other text → text flow (v1 parity); "voice/voz/1" → stay + `v2_voice_send_note`; non-voice media → `v2_voice_invalid`; ingest pipeline_unavailable → `v2_voice_fallback` + text flow (never strand).

### Task 8b: voice_processing holding step + timeout escape
`handleVoiceProcessingStep`: inbound before timeout → cooldown-guarded `v2_voice_processing_wait`; after `VOICE_PROCESSING_TIMEOUT_MS` (from state_context.v2VoiceStartedAt) → `v2_voice_fallback` + advanceProfileToNextStep (anti-strand guarantee even if the completion event is lost forever).

### Task 8c: pure extraction planner + adapter ingest
**Files:** Create `infra/lambda/whatsapp/lib/voice-extraction.ts` — pure `planExtractionWrites(dbFilled, fields, confidences, {threshold, resolveLocation})` → `{writes: ExtractionWrite[], appliedFields, skipped[]}`. Rules: NULL-only fill (worker answers win by construction); confidence ≥ threshold; strict enum membership (no fuzzy coercion); location must resolve via the ZIP/City-ST resolver else skipped; `main_trade='other'` emitted ONLY as an atomic `custom_trade` write when other-text present, else both skipped (`chk_trade_other` can never fire — only saveTrade/saveCustomTrade are called). Modify `lib/onboarding-adapters.ts`: `createVoiceIntakeAdapter` (`ingestVoiceNote`: Twilio download → MAX_VOICE_BYTES → S3 → worker_profile_media INSERT → StartExecution on AI_PIPELINE_STATE_MACHINE_ARN with v1-shaped input + `v2:{workflowRunId, expectedStepKey:'profile.voice_processing'}`; never throws for expected failures — returns `{started:false, reason}`).
Tests: `voice-extraction.test.ts` — chk_trade_other safety both directions, strict enums ("3 years" rejected), threshold, NULL-skip precedence, location shapes (ZIP ok / City-ST ok / bare city skipped), boolean type check.

### Task 8d: handleVoiceIntakeResult + ai-profile-writer v2 branch
`handleVoiceIntakeResult`: stale guard (`gate.currentStepKey !== 'profile.voice_processing' || state_context.v2VoiceExecutionArn !== ev.executionArn`) → metric `OnboardingVoiceResultStale`, silent discard; failed/empty/zero-writes → `v2_voice_fallback` + advance; success → apply plan.writes via adapters, seed trust questions when trade landed (standard → standardTrustQuestions; custom → trustQuestions.generate with fallback set — mirrors handleProfileTrade/handleCustomTrade exactly), send `v2_voice_summary {summary}` (language-matched), then advanceProfileToNextStep → resolver asks only missing fields; all filled → existing fail-closed trust handoff.
**Files:** Modify `infra/lambda/whatsapp/ai-profile-writer.ts` (v2 branch: readTranscript → extractProfileFromTranscript → extraction audit row INSERT (unchanged, jale_ai) → enqueue `#vp` synthetic event with fields/confidences/summaries/executionArn/extractionId; NO users UPDATE, NO outbox writes; FAILED → failed-row + failed event; v1 path byte-identical; needs WHATSAPP_INBOUND_V2_QUEUE_URL env + grantSendMessages — same stack wiring as Task 5's receiver). Modify the VoiceTranscriptionPipeline construct/ASL to thread `$$.Execution.Id` as executionArn into the completion input (one-line).
Tests: ai-profile-writer v2-branch pins (event enqueued, extraction row written, zero users UPDATE/outbox); onboarding-v2-voice.test.ts profile cases (staleness by arn mismatch/step, redelivery no-op, trust seeding).

### Task 8e: conversation-testbed end-to-end voice-intake flows
Extend harness (`injectVoiceIntakeResult(event)` — JSON round-trip through the real envelope; fake VoiceIntakeAdapter recording ingests with deterministic arns; `setVoiceIntakeEnabled`). Extend `onboarding-v2-conversation.test.ts`: legal accept (control on) → voice_choice prompt → audio → ack → inject completion {name, trade:'plumber', experience} → summary + resolver asks ONLY location, then transportation, availability → trust handoff; control-off flow byte-identical to today; opt-out-to-text; timeout escape flow.

## Stream C — Audit ride-alongs

### Task 9: answer-integrity + RESTART/BACK
**Files:** Modify `infra/lambda/whatsapp/onboarding/gate.ts` + `lib/onboarding-language.ts`: on FREE_TEXT_STEPS, reject greetings (reuse `isGreetingKeyword`, flows.ts:362-373) and SUPPORT/SOPORTE (`isSupportCommand`) → v2_gate_blocked + reprompt, never persisted as an answer. Add gate commands `RESTART`/`REINICIAR` (any bound profile/trust step: clear the seven profile answer fields via new repo fn `clearProfileAnswers(client, workerId)` mirroring the reset CLI's constraint-safe UPDATE lists — location 5-column group cleared together — then advanceWorkflow to `profile.name`, transition reason 'worker_restart') and `BACK`/`ATRAS` (previous step from last worker_workflow_transitions row where to_step_key = current; only within profile.*/trust.*; at profile.name → blocked reply).
Tests: conversation testbed — 'hola' at profile.name reprompts and is NOT saved; 'Soporte' at trust question not saved; RESTART clears answers and re-asks name (resolver then re-asks everything); BACK re-asks previous, answer overwrites, resolver continues to first missing.

### Task 10: rollout runbook (the C10 deliverable that was lost to .gitignore)
**Files:** Create `docs/runbooks/whatsapp-onboarding-v2-rollout.md` — **committed with `git add -f`** (docs/ is gitignored at .gitignore:41; this is exactly how C10's runbook silently vanished — the runbook itself documents this trap). Contents: runtime controls (onboarding_v2_enabled, deferred_delivery_enabled **black-hole warning**: toggling off defers ALL business messages for ALL v2 workers whose worker.ready already fired — recovery via delivery-retrigger-sweep; voice_intake_enabled), operator CLIs (runtime-controls, reset, repair, replay-whatsapp-inbound, replay-domain-event, inspect-trust-score), alarm inventory + what each means, funnel metrics dashboard how-to, DLQ redrive procedure, migration-051 note (guard fires on migration diffs; apply via run-migrations.sh then dispatch deploy_scope=all — see running-jale-migrations skill).

## Ship plan

1. One branch off main: `feat/whatsapp-v2-voice-parity`. Task order: 1→2→3→4→5→6→7 (Stream A), 8 (Stream B), 9→10 (Stream C). Commit per task.
2. Full capped suite + tsc + ephemeral-PG DB suite (`bootstrap-testbed.sh --ephemeral` — validates migration 051 + adapter paths).
3. PR → main after CI. Then (owner-approved): apply migration 051 to prod via run-migrations.sh, promote main → prod, `workflow_dispatch deploy_scope=all` if the push guard fires on the migration file.
4. Live verify (owner's phone, voice_intake allowlisted): voice answer at a trust question; full voice profile intake on a reset run; 'hola' at name step reprompts; RESTART works; alert with buttons after 24h dormancy (from PR #23).

## Explicitly deferred (owner decision)
- IDIOMA post-ready durability; trust_signals_completed_at; digest real ranking; post-ready photo capture. (Catalogued in the audit; revisit after this stream.)
