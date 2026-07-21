# WhatsApp Onboarding Gate and Deferred Delivery Design

**Date:** 2026-07-21  
**Status:** Approved  
**Target:** End-of-week production rollout with local verification and a one-worker production canary

## Objective

Build a reliable WhatsApp onboarding system that accepts a newly assigned phone number, verifies the worker, completes every required onboarding step, prevents business messaging from interrupting onboarding, and releases still-valid messages after the worker becomes ready.

The design must fix the failure Manuel reported while remaining extensible for new workflow steps and outbound message types.

## Incident Summary and Structural Cause

The reported production sequence combined two defects:

1. An existing-phone conversation-relay shortcut resolved a worker while the WhatsApp conversation remained `awaiting_otp`. It queued a legal prompt without performing the corresponding authoritative state transition. A later Accept action was interpreted against stale state, causing the legal interaction to repeat.
2. WhatsApp outbox validation accepted only Twilio identifiers beginning with `SM`, although valid delivery identifiers also begin with `MM`. Delivery could succeed while local validation reported an error, obscuring the real state-machine failure.

The larger architectural issue is that one `conversation_state` value currently carries identity, onboarding progress, chat routing, and messaging eligibility. Employer relay logic can therefore conflict with onboarding logic.

## Scope

### Required this week

- Separate worker lifecycle, identity challenge, workflow run, chat focus, assessment, and delivery state.
- Make successful OTP verification the only identity-binding boundary.
- Add an authoritative onboarding gate for all worker-directed business messages.
- Add a central worker-delivery gateway and durable deferred intents.
- Integrate existing employer chats and job alerts with deferred delivery.
- Group deferred messages by type and release them in an approved order.
- Use FIFO inbound processing per normalized worker phone plus database idempotency.
- Preserve the existing OTP, legal, profile, trade picker, trust-question, AI-scoring, employer-chat, and matching capabilities described below.
- Add runtime activation controls and an exact-target clean-reset utility.
- Add deterministic local conversation tests and disposable PostgreSQL integration tests.
- Deploy additively, verify one worker in production, then reset the other two.

### Deferred after the deadline

- New WhatsApp Profile buttons and web UI for trade changes.
- Full administrative replay or monitoring dashboard; this release uses exact-ID operator commands and existing observability surfaces.
- Cloud sandbox and LocalStack.
- Removal of legacy workflow code and database columns.
- Additional notification categories beyond the employer-chat and job-alert paths needed for this release.

The backend boundaries must permit those additions without redesigning the gate.

## Domain Separation

The redesigned system separates these records:

| Concern | Authoritative state |
| --- | --- |
| Worker access | `onboarding`, `ready`, or `suspended` lifecycle |
| Identity | OTP challenge, expiry, attempts, lock, and verified worker binding |
| Onboarding | Versioned workflow run, current step key, status, and context |
| WhatsApp session | Preferred language, inbound sequencing, and focused employer conversation |
| Trust assessment | `pending`, `processing`, `complete`, or `failed` with provenance |
| Delivery | Typed message intent, policy decision, release group, and outbound status |

The delivery policy reads the worker lifecycle. It never infers business-message eligibility from an OTP step, legal step, chat focus, or assessment status.

## Workflow Entry and Language

Any first inbound message may receive the rate-limited onboarding invitation, but it does not create an account or send an OTP. The invitation contains explicit buttons:

- **Start in English**
- **Empezar en español**

Text fallbacks are `START` and `EMPEZAR`.

The selected language becomes the preferred language. Commands are recognized in English and Spanish. When the worker uses a command in the non-preferred language, the immediate response uses the command language and later workflow prompts return to the preferred language. `LANGUAGE` or `IDIOMA` explicitly changes the persisted preference.

Rate limits before verification are:

- One Start template per normalized phone every 10 minutes.
- No more than five Start templates per phone in 24 hours.
- Repeated inbound messages inside the cooldown are recorded without another response.
- Repeated invalid onboarding answers may repeat the current prompt at most once every 30 seconds.
- Responses do not reveal whether an account already exists.
- Rate-limit keys use a one-way hash of the phone wherever the raw number is unnecessary.

## OTP and Identity Binding

Pressing Start begins one active OTP challenge for the normalized phone. The system may locate an existing account as a candidate, but a phone lookup never binds the WhatsApp session, advances onboarding, exposes chats, or grants access.

Successful OTP verification is the only action that atomically binds the WhatsApp session to the worker and advances the workflow to legal evaluation. This applies to new workers, existing workers, and the three reset workers.

OTP behavior is:

- Five-minute expiry.
- SMS and WhatsApp text explaining the five-minute limit.
- Three incorrect attempts produce a 15-minute verification lock.
- `RESEND` and `REENVIAR`, plus a Resend button, are accepted only at the OTP step.
- Resend cooldown is 60 seconds.
- Maximum three OTP sends per phone per hour.
- A new OTP invalidates the prior OTP.
- No delayed WhatsApp message is scheduled merely to announce resend availability.
- Failed, expired, and locked challenges leave the conversation unbound.
- Start taps and verification results are idempotent and audited.

## Legal Step

Legal evaluation occurs only after OTP binding. Acceptance is immutable and tied to an explicit Terms version and Privacy version.

The legal message includes Terms and Privacy links plus Accept and Decline actions. Decline moves the workflow to `legal_declined` and prevents business messaging. `REVIEW TERMS` or `REVISAR TÉRMINOS` returns to legal review without creating another account or repeating a completed OTP.

For ordinary future workflow runs, a current accepted version may satisfy the step without another prompt. For the three clean-reset rollout accounts, the workflow requires another confirmation so the redesigned legal interaction is exercised while retaining earlier legal records as immutable history.

## Profile, Trade, and Trust Flow

Required onboarding fields are collected in this order:

1. Name, accepting varied naming conventions between 2 and 100 characters.
2. ZIP code, deriving normalized city and state; fallback to `City, State` when ZIP resolution cannot be used.
3. Main trade through the existing WhatsApp list picker.
4. Trade-specific trust questions.

The initial standard trades are electrician, plumber, carpenter, concrete, painting, and Other. Standard trades use the current fixed three-question trust sets. Other requests a free-form profession and generates appropriate questions. If question generation is unavailable, the workflow uses reviewed bilingual generic fallback questions.

All three trust answers are required before readiness. Trade, question-set version, rubric version, model information, answers, and score are retained as assessment provenance.

Trade-change backend boundaries remain compatible with a later WhatsApp Profile button and web UI, but those interfaces are outside this week's scope.

## Atomic Ready Transition and AI Assessment

Saving the final required trust answer performs one database transaction that:

1. Saves the answer.
2. Changes worker lifecycle to `ready`.
3. Completes the workflow run and appends transition history.
4. Inserts an asynchronous assessment request.
5. Inserts a `worker_ready` transactional-outbox event for deferred release.

No external request or WhatsApp send occurs inside that transaction.

Assessment status is independent from worker lifecycle. While assessment is pending or failed, the ready worker may use WhatsApp and receive chats. Matching uses existing non-AI eligibility and ranking signals, then reranks when a completed assessment becomes available. Assessment failure never returns a worker to onboarding.

## Authoritative Onboarding Gate

While lifecycle is `onboarding`, only messages belonging to the current onboarding step, workflow help, or identity/legal controls may be sent. Business-message producers continue to create durable intents but cannot send to the worker.

Worker commands are not deferred:

- `HELP`/`AYUDA` explains and repeats the current step.
- `LANGUAGE`/`IDIOMA` changes the preferred language.
- `RESEND`/`REENVIAR` operates only at the OTP step.
- `REVIEW TERMS`/`REVISAR TÉRMINOS` operates for legal review.
- Valid step answers advance only the current step.
- `JOBS`, `CHATS`, `PROFILE`, and unrelated text do not execute or queue; the response explains that onboarding must finish and repeats the current prompt.

Phone matching and employer-chat focus cannot bypass this policy.

## Worker-Delivery Gateway

The gateway is the only permitted path to worker-directed WhatsApp delivery. Existing job-alert and employer-message producers retain their domain logic but submit typed intents rather than calling Twilio.

Each intent declares:

- Message category and owning service.
- Worker and source-record identifiers.
- Priority and creation time.
- Deduplication key.
- Expiration policy.
- Eligibility policy and policy version.
- Grouping behavior.
- Preferred-language rendering inputs.

The gateway checks eligibility at enqueue time and immediately before send. Only the workflow engine can create privileged onboarding prompts, and only the identity service can create OTP/security messages. The final Twilio sender consumes only gateway-authorized outbox rows.

Every decision records `allowed`, `deferred`, `expired`, `superseded`, `rejected`, or `delivered` with a reason.

## Deferred Intent Policies

Deferred records contain logical intent and source identifiers, not pre-rendered WhatsApp text. Current data is reloaded and eligibility is rechecked at release time.

- Job alert: deduplicate by worker and job; discard when the job is closed, paused, no longer matches, or is older than 72 hours.
- Employer message: retain for seven days; discard if its job, employer, worker, application, or conversation is no longer eligible.
- Repeated reminders: retain only the newest intent of the same type.
- OTP, legal, and onboarding prompts never enter the business deferral queue.
- Every disposition retains an audit reason.

The `worker_ready` consumer obtains a lease and produces a fixed, per-worker outbound sequence. A release cannot be duplicated by concurrent consumers.

## Release Grouping and Ordering

Deferred messages release by type, not raw creation time:

1. Onboarding-complete confirmation.
2. Account/profile notifications.
3. One grouped job-alert digest.
4. Employer conversation notification last.

Up to ten strongest currently valid job matches appear in the digest; other superseded alerts are discarded and the regular Jobs command remains the source for the full current list.

Employer conversations already exist in `job_conversations` and their messages already exist in `job_conversation_messages`. The redesign does not create a second inbox:

- One unread eligible conversation receives the existing single-conversation invitation.
- More than one unread conversation produces one summary stating that multiple employers are trying to talk to the worker, with a View Chats action and `CHATS`/`MENSAJES` fallback.
- `CHATS` uses the existing open-conversation picker.
- The selected employer conversation remains focused until the worker switches chats or closes it.
- No lower-priority notification may interrupt an employer-conversation release block.

## Ordering, Idempotency, and Concurrency

V2 inbound messages use an SQS FIFO queue. `MessageGroupId` is a one-way hash of the normalized phone, and Twilio `MessageSid` is the deduplication ID.

The database additionally enforces unique inbound SIDs. Processing locks the workflow/session row, verifies the expected workflow version and step, and commits state plus outgoing intent together. Outbound records receive a per-worker sequence.

Twilio identifiers beginning with either `SM` or `MM` are valid. Delivery callbacks are idempotent.

Double taps, webhook retries, concurrent Lambda invocations, release retries, and status-callback retries must not duplicate transitions or sends.

## Failure Handling

Failures are classified as retryable or permanent. Temporary database, provider, and AWS failures receive exponential retry. After five unsuccessful inbound attempts, the event moves to a v2 dead-letter queue so one poison event cannot indefinitely block its FIFO message group.

Invalid permanent inputs are marked rejected and acknowledged. Outbound retries remain in the durable outbox with capped attempts and delivery history. A permanently failed required onboarding prompt creates an operator alert and never advances the workflow. A failed business notification does not return a ready worker to onboarding.

Replay accepts one exact event or message ID, displays its current workflow state, and reuses its original idempotency key. Bulk automatic dead-letter replay is prohibited.

## Runtime Controls

Two independent runtime controls are required:

- `onboarding_v2_enabled`: starts with an exact phone allowlist and later becomes global.
- `deferred_delivery_enabled`: starts disabled and is enabled only after the first production release inspection.

Disabling deferred delivery does not stop onboarding. Disabling v2 prevents new v2 sessions while investigation occurs. Existing state remains auditable.

## Clean Reset for Three Workers

The reset keeps core user IDs, Cognito identities, verified phones, and immutable legal audit records. For the exact approved workers it clears onboarding/profile answers, trades, trust data, assessments, matching results, WhatsApp workflow state, inbound-processing state, active chat focus, applications, job conversations/messages, and relevant outboxes/intents.

The reset then creates a v2 workflow at `awaiting_start` and requires OTP plus every onboarding step again, including a new legal confirmation.

The reset utility:

- Requires explicit worker IDs and phone confirmation.
- Rejects wildcards and broad targets.
- Displays a dry-run row-count summary by table.
- Is idempotent for an already-reset target.
- Records operator, timestamp, and reason.

The user's account is reset and verified first. The remaining two accounts are untouched until it passes.

## Local Test Environment

Local verification uses real disposable PostgreSQL and the real application handlers, workflow engine, delivery policy, migrations, transactions, locks, constraints, and queries.

Deterministic adapters replace Twilio WhatsApp/SMS, Cognito, SQS delivery, Bedrock, and clocks. The clock can advance through OTP expiry, lockout, provider reply windows, and deferred expiry instantly. LocalStack and a cloud sandbox are out of scope.

Required scenarios include:

- Complete English and Spanish onboarding.
- Cross-language commands and explicit language changes.
- OTP success, expiry, resend, invalidation, throttling, and lockout.
- Existing-phone candidate that cannot bind before OTP.
- Legal Accept, Decline, and Review Terms.
- Name, ZIP/fallback location, all standard trades, Other, and AI-question fallback.
- Three required trust answers and non-blocking AI success/failure.
- Employer messages and job alerts created at every onboarding phase without delivery.
- Atomic readiness and grouped release.
- Single and multiple employer conversations through existing `CHATS` behavior.
- Duplicate, concurrent, out-of-order, and retry delivery.
- Both `SM` and `MM` Twilio identifiers.
- Manuel's exact stale-state sequence as a permanent regression.
- Failed required prompt, dead-letter isolation, and exact-ID replay.
- Additive migration from an empty database and the current migration set.

The deployment gate requires build, unit tests, PostgreSQL integration tests, complete conversation scenarios, CDK synthesis, and an inspected infrastructure diff.

## Additive Deployment and Production Verification

This release adds structures and indexes without dropping or renaming current tables or columns. Legacy flow remains available temporarily for rollback and non-v2 workers. Cleanup occurs in a later release.

Production sequence:

1. Deploy additive migrations and code with both runtime controls disabled.
2. Enable v2 only for the user's exact verified phone.
3. Dry-run and perform the clean reset for that worker.
4. During onboarding, create a fresh application, employer conversation/message, and job alert.
5. Confirm nothing interrupts onboarding.
6. Complete every required workflow step.
7. Confirm atomic readiness, assessment dispatch, grouped release, chat selection, and correct replies.
8. Inspect logs, outboxes, deferred intents, callbacks, and dead-letter queues.
9. Reset the other two workers only after all go/no-go conditions pass.
10. Enable v2 globally, then enable deferred delivery after queue inspection.

If verification fails, v2 remains allowlisted, deferred delivery remains disabled, the other accounts remain untouched, and the first worker is clean-reset again after the fix.

## Production Go/No-Go Conditions

Production rollout proceeds only when:

- Every onboarding step completes in order.
- OTP is the only identity-binding action.
- Commands and business delivery cannot escape the onboarding gate.
- Test employer and job intents remain deferred until ready.
- Final trust answer creates readiness, assessment, and release events atomically.
- AI processing does not block worker access.
- Grouped notifications release in the approved order.
- Multiple employer conversations produce one Chats summary.
- Chat selection and reply target the correct conversation.
- Retries do not duplicate transitions or outbound messages.
- No unexplained outbox failures, dead-letter entries, or Lambda errors remain.

## Observability

Structured events must identify workflow version, step key, lifecycle, policy version, intent category, decision reason, retry count, and correlation IDs without unnecessarily exposing OTPs or raw message bodies.

Operational alarms cover dead-letter depth, stuck workflows, OTP failure/lock rate, deferred backlog age, release failures, and outbound failure rate.

## Success Definition

A new phone can enter the WhatsApp flow, explicitly choose a language, prove identity, satisfy legal requirements, complete profile/trade/trust questions, become ready without waiting for AI scoring, and then receive current deferred work in readable grouped form. No employer or job message can interrupt onboarding, and adding a future workflow step or message type requires a versioned step or declared policy rather than another state-machine shortcut.
