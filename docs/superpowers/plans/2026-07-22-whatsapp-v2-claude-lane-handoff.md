# WhatsApp V2 Claude Lane — Work Log and Resume Handoff

**Date:** 2026-07-22
**Branch:** `feat/wa-v2-workflow` @ `52e29dc`
**Worktree:** `.worktrees/wa-v2-claude`
**Status:** Unblocked subset COMPLETE and integrated. Gated subset still blocked — now on Codex **C4 only**.

---

## TL;DR

Three C2/C4-independent surfaces were built, reviewed twice each, and merged into
`feat/wa-v2-workflow`. Nothing was pushed, deployed, migrated, or merged into the Codex lane.

```
19 suites / 519 tests green    npm run build clean    working tree clean
```

The lane executed the plan at
`docs/superpowers/plans/2026-07-21-whatsapp-v2-claude-lane-unblocked.md`, which carved the
C2/C4-independent work out of the canonical plan's all-or-nothing Bootstrap Barrier so this lane
could progress while Codex built C1–C4 in parallel.

---

## Why this plan exists (context for anyone resuming cold)

The canonical lane plan (`2026-07-21-whatsapp-v2-claude-lane.md`) put a single Bootstrap Barrier in
front of all seven tasks — nothing could start until Codex merged C2–C4. That barrier was drawn by
*code ownership*, but the real dependency is narrower: only work that **imports a C2/C4 symbol**
needs the bootstrap. Three surfaces import nothing from Codex, so they were split out and built
first. No temporary shared interfaces were invented — that was an explicit constraint, and it held.

---

## Commits on this branch (oldest → newest)

| SHA | Commit | Task |
| --- | --- | --- |
| `5c138ca` | docs: plan WhatsApp v2 Claude lane unblocked subset | — |
| `97d71fb` | feat(whatsapp): add pure v2 language and cooldown policy | 2 |
| `c002ce0` | fix(whatsapp): local fuzzy match, chronological history, future-date guard | 2 (fix round) |
| `5283efd` | feat(whatsapp): add bilingual v2 copy and interactive builders | 3 |
| `4d7538b` | fix(whatsapp): strengthen v2 copy tests and dedupe legal/footer strings | 3 (fix round) |
| `8e3a2b0` | fix(whatsapp): block relay and legal prompts on unbound sessions | 1 |
| `2cf04f0` | test(whatsapp): strengthen Manuel regression to prove a real phone match | 1 (fix round) |
| `52e29dc` | test(whatsapp): seed a phone match in the unbound-new regression | 1 (Review 2 patch) |

Total surface vs. session base `e9f7e47`: **832 insertions across 11 files.**

---

## What shipped

### Task 1 — Pre-OTP relay prevention (the "Manuel" fix)

**Files:** `lambda/whatsapp/lib/conversation-router.ts`, `lambda/whatsapp/processor.ts`, and their
two test files.

**The defect.** `conv.user_id` is NULL until a worker completes OTP. Four paths fell back to
`resolveWorkerIdForWhatsappNumber(client, msg.from)` — a **phone-number lookup** — when it was null.
A phone number is not a verified identity. Consequence: a worker sitting in `awaiting_otp` with
`user_id === null` could relay into an employer job thread and be shown the legal/ToS prompt with
consent recorded, all before ever verifying.

**The fix.** An unconditional guard in `tryConversationRelay` immediately after the empty-body
check:

```ts
// Identity-binding rule (design §4.2a): only a verified OTP binds a session.
if (!conv.user_id) return null;
```

plus `const workerId = conv.user_id;` replacing the fallback at the three other sites, deletion of
the now-unreachable `ConversationRelayPhoneMatch` log, and gating the `processor.ts` picker branch
on `conv.user_id`.

**Invariant established:** *an unbound session can never relay, focus, pick, or trigger a legal
prompt.*

**Deliberate non-changes — do not "fix" these:**
- `processor.ts:975` (`handleSupportCommand`) still uses the phone fallback. Documented as
  out of scope in the canonical plan: support cases are not worker-directed business messages, and
  `create_admin_support_case` re-checks the relationship server-side.
- `resolveWorkerIdForWhatsappNumber` stays **exported**; its own tests at
  `conversation-router.test.ts:36-62` must stay green. Only its use as an identity fallback in
  relay paths was removed.
- A **bound** session in `awaiting_otp` still relays — that is re-verification, and it is correct.

**Verified separately (this was NOT assumed):** the two non-relay `queueLegalPrompt` sites are also
unreachable by an unbound session. `processor.ts:1385` fires inside the OTP-success branch, in the
same `updateConversation` that sets `user_id` (`:1377`) and `awaiting_legal` (`:1378`), with
`conv.user_id` bound in memory at `:1384` first. `processor.ts:1577` sits in `handleAwaitingLegal`,
reachable only from `case 'awaiting_legal'` (`:1120`), and `:1378` is that state's sole writer.
There is also a pre-existing hard assertion at `:1583`:
`throw new Error('user_id missing on awaiting_legal')`. So the invariant holds on both the relay
path and the state-machine path.

### Task 2 — Pure language and cooldown policy

**File created:** `lambda/whatsapp/lib/onboarding-language.ts` (+ its test).

Pure module — no DB, no network, no `Date.now()`, no `process.env`. Every time-dependent function
takes `now: Date`. Exports `parseLanguageChoice`, `detectCommandLang`, `resolveResponseLanguage`,
`isLanguageCommand`, `isResendCommand`, `isReviewTermsCommand`, `isOnboardingHelpCommand`,
`classifyBlockedCommand`, `evaluateStartCooldown`, `shouldRepeatPrompt`, `appendSendTimestamp`, and
the constants `START_COOLDOWN_MS` (10 min), `START_DAILY_CAP` (5), `START_DAILY_WINDOW_MS` (24 h),
`REPROMPT_COOLDOWN_MS` (30 s).

Cooldown is checked **before** the daily cap — the nearer limit wins.

### Task 3 — Bilingual v2 copy and interactive builders

**Files modified (additive only):** `lambda/whatsapp/lib/templates.ts`,
`lambda/whatsapp/lib/interactive-templates.ts`, their two test files, plus a new
`test/unit/lambda/whatsapp/lib/v2-copy-test-helpers.ts`.

20 `v2_*` `TemplateKey` members, four `buildV2*` builders, and
`V2_FALLBACK_TRUST_QUESTIONS`. No existing key or builder was renamed, reworded, or deleted — ten
existing test files depend on them.

**Convention note:** `templates.ts` is deliberately **ASCII-only** (zero accented characters) and
already ships unaccented Spanish like `'Cuantos anos de experiencia tienes?'` (`:118`). The new v2
copy matches that. Do not "fix" the missing accents in this file without changing the whole file's
convention deliberately.

---

## Review findings that shaped the code

Each task ran Review 1 (orchestrator, diff read + tests re-run personally) → independent Sonnet
reviewer → **exactly one** fix round → Review 2. These three defects were invisible to a green test
run and are the reason several things look the way they do.

**1. Task 1's regression tests passed for the wrong reason.** The four Manuel tests never seeded a
phone-match row, so they proved "when nothing resolves, nothing happens" — not the actual incident
shape, "a phone match exists and the unbound session is blocked anyway." Reverting the guard
produced three `TypeError: Cannot read properties of undefined (reading 'rows')` crashes rather than
clean assertion failures, and one test did not fail at all. A future
`beforeEach(() => mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }))` — an entirely ordinary
addition — would have removed the crash and let all four pass with the vulnerability restored.

Now every one seeds a real phone match plus an unaccepted-ToS row and asserts
`expect(mockQuery).not.toHaveBeenCalled()`. Mutation-verified: **5 clean assertion failures, 0
TypeErrors.** The `afterEach(() => mockQuery.mockReset())` scoped to the Manuel describe block is
load-bearing — `clearAllMocks()` does not purge queued `mockResolvedValueOnce` values, and an
un-consumed seed leaks forward and shifts later tests' mock chains.

**2. Task 2 shipped dead code on the OTP recovery path.** `matches()` delegated to
`flows.ts`'s `matchCommandFuzzy`, which only scores against its own fixed `COMMAND_KEYWORDS` list —
which contains `help`/`ayuda`/`jobs`/`profile`/`chats` but **not** `language`/`idioma`/`resend`/
`reenviar`. So half the command families silently had no typo tolerance. That matters most for
RESEND: it is the recovery path when an OTP expires, and `v2_otp_expired` literally instructs
"Responde REENVIAR".

Fixed with a **local** Damerau-Levenshtein helper scored against the caller-supplied word set,
preserving the original guards (no whitespace, min length 4, same first character, distance ≤ 1).
`flows.ts` is another lane's file and was deliberately **not** modified — the small duplication is
intentional.

**3. Task 3's copy test could not detect its own blocking criterion.** The `it.each(V2_KEYS)` case
asserted only non-empty and `en !== es`, which passes with English text sitting in the Spanish slot.
Replaced with `expectDistinctLanguages()` in `v2-copy-test-helpers.ts`, asserting bidirectionally
against closed-class function-word markers. Mutation-verified on keys the implementer never touched:
EN-in-ES slot → 2 failures, ES-in-EN slot → 1 failure. `v2_start_invitation` is exempt by name — it
is deliberately bilingual in both slots.

---

## Verification — re-run these to confirm state

```bash
cd infra
npm run build
npx jest test/unit/lambda/whatsapp --runInBand          # expect 19 suites / 519 tests
```

Lane-boundary checks (all must stay clean):

```bash
# No C2/C4 symbol may leak into this lane's files
grep -rnE "WorkflowStepKey|MessageCategory|DeliveryDecision|PreAuthState|CategoryRenderer|ReleaseRenderer|enqueueWorkerMessage|advanceWorkflow|loadRuntimeControls|isV2Enabled" \
  infra/lambda/whatsapp/lib/onboarding-language.ts \
  infra/lambda/whatsapp/lib/templates.ts \
  infra/lambda/whatsapp/lib/interactive-templates.ts \
  infra/lambda/whatsapp/lib/conversation-router.ts      # expect: no output

# onboarding-language.ts must stay pure
grep -nE "PoolClient|process\.env|Date\.now|require\(" \
  infra/lambda/whatsapp/lib/onboarding-language.ts      # expect: no output
```

Do **not** run `cdk synth`, `cdk diff`, repo-wide `npm test`, or the PostgreSQL migration testbed
from this lane — Codex C10 owns the deployment gate.

---

## Bootstrap barrier — live status as of 2026-07-22

| Dependency | Status |
| --- | --- |
| Codex **C1** (MM Twilio identifiers) | ✅ on `feat/wa-v2-integration` (`1e22ac6`) |
| Codex **C2** (types, runtime controls, delivery policy) | ✅ `4436ca6` |
| Codex **C3** (migration `042_whatsapp_onboarding_gate.sql`) | ✅ `e5b56e0` + hardening `3b0b543`, `418b70d`, `c02cd28` |
| Codex **C4** (`onboarding-repository.ts`, `worker-delivery-gateway.ts`) | ❌ **still absent — the only remaining blocker** |
| Migration `042` merged into `feat/wa-v2-workflow` | ❌ not yet |
| PostgreSQL `042` gate green on this branch | ❌ not yet run |

### Barrier confirmation for C2 — ALREADY DONE, zero mismatches

The canonical plan requires grepping C2's real exports and diffing them against its "Canonical
Imports" table before starting gated work. That was run against `feat/wa-v2-integration`. **Every
symbol and every union value matches the plan exactly:**

- `WorkflowStepKey` — the 10 step keys, verbatim, in plan order
- `WorkflowRunStatus` — includes `completed` and `declined` as *statuses*, confirming Binding
  Resolution #7 (they are never step keys)
- `OwnerService` — includes both `'onboarding-v2'` and `'identity'`, the two values the router's
  sending rule needs
- `MessageCategory` — 5 members: `onboarding`, `security`, `account`, `job_alert`, `employer_chat`
- `ReleaseRenderRequest` — exactly the 5 kinds the plan specified: `onboarding_complete`,
  `account_notice`, `job_alert_digest`, `employer_chat_single`, `employer_chat_summary`
- `CategoryRenderer = (client, input) => Promise<RenderedOutboxMessage | null>` — matches the
  assumed async `(client, input)` contract
- `ReleaseRenderer.render(request) => Promise<ReleaseRenderedMessage>`

**C4's exports still need the same confirmation when it lands.** The plan's assumed names:
`PreAuthState`, `loadPreAuthStateForUpdate`, `savePreAuthState`,
`bindVerifiedIdentityAndStartWorkflow`, `loadWorkerGate`, `advanceWorkflow`, `appendTransition`,
`completeOnboarding`, and `enqueueWorkerMessage(client, input, now?) → { intentId, decision }`.
Any mismatch is a cross-lane interface change: stop, propose the correction against both canonical
documents, get both orchestrators to sign off. Do **not** adapt by re-declaring locally.

---

## Still blocked — the gated subset

| Deferred work | Blocking symbol |
| --- | --- |
| `lib/onboarding-renderers.ts` + `registerOnboardingRenderers()` + `createReleaseRenderer()` | C4 renderer registry (C2 contracts are ready) |
| `lib/onboarding-adapters.ts` (identity, profile persistence) | C4 persistence contract |
| `onboarding-v2.ts` router — entry, OTP, legal, command gate | C4 `PreAuthState`, `bindVerifiedIdentityAndStartWorkflow`, `advanceWorkflow`, `enqueueWorkerMessage` |
| `onboarding-v2.ts` — profile/trade/trust/readiness | C4 `completeOnboarding` |
| `processor.ts` v2 branch | C2 controls (ready) + all of the above |
| `test/helpers/whatsapp-v2-harness.ts` conversation testbed | everything above |

These resume **verbatim** from canonical Tasks 2–7, with two reductions already banked:
- Canonical **Task 1 is fully DONE**.
- Canonical **Task 3 reduces** to just the renderers — its language module and all bilingual copy
  are merged.

---

## Carried items / known issues

1. **`Chata` → `chats` gate collision.** `classifyBlockedCommand` fuzzy-matches `Chata` (a real
   Mexican nickname) to the `chats` command, and likewise `Mensaje` → `chats`, `Trabajo` → `jobs`
   (the latter two are correct — they're singular forms). The canonical plan runs the command gate
   **before** step dispatch at every step, including `profile.name` — so a worker named Chata would
   have her name swallowed as a command. Pre-existing behavior, unchanged by this lane, but it must
   be handled when the router is built. Suggested approach: skip blocked-command classification, or
   require an exact match, at free-text answer steps.
2. **`buildV2OtpPrompt` Twilio variable positions** (`{'1': minutes, '2': 'otp:resend', '3': label}`)
   cannot be validated until the real `v2_onboarding_otp_*` content template exists. Confirm against
   it at the C6/C10 handoff.
3. **`job_alert_digest` has no cap in the type.** The plan requires ≤10 entries; the renderer must
   truncate.

---

## Process lessons worth keeping

- **Diff parallel worktrees against the merge-base, not the live branch ref.** Once Task 2 was
  integrated, `feat/wa-v2-workflow` advanced underneath Task 3's in-flight worktree and its
  additive-only check began reporting a file it had never touched as deleted.
- **A pathspec that matches nothing prints empty, which looks identical to "clean."** A
  repo-root pathspec run from `infra/` silently verified nothing. Run boundary checks from the repo
  root.
- **Agent worktrees branch from `origin/main`'s tip, not the current branch.** All three branched
  from `6b4dbab`; the delta was docs-only, so reviewed commits were **cherry-picked** rather than
  merged, which would have reverted the plan docs.

---

## Resume checklist

1. `cd .worktrees/wa-v2-claude && git log --oneline -1` → expect `52e29dc`.
2. `cd infra && npm run build && npx jest test/unit/lambda/whatsapp --runInBand` → 19 suites / 519.
3. Check whether C4 has landed:
   `git cat-file -e feat/wa-v2-integration:infra/lambda/whatsapp/lib/onboarding-repository.ts`
4. If C4 is present: merge C2+C3+C4 into `feat/wa-v2-workflow`, confirm migration `042` is on the
   branch, run the PostgreSQL `042` gate, then run the **C4 barrier confirmation** (grep real
   exports vs. the assumed names listed above) before dispatching any gated task.
5. Resume canonical Tasks 2–7 via `dev-cycle`: Sonnet subagents in isolated worktrees, orchestrator
   reads every diff and re-runs every test personally, exactly one fix round per task.

---

## Housekeeping (unresolved at time of writing)

- **Three implementer worktrees still on disk** — `.claude/worktrees/agent-a07fc4ba0d50c4237`,
  `agent-aa15a6f159dc88112`, `agent-aee21c64b9c27f555`. All their commits are cherry-picked into
  `feat/wa-v2-workflow`, so they are redundant copies and safe to `git worktree remove`.
- **Out-of-repo:** a subagent wrote `~/.claude/skills/working-together/SKILL.md` (global, loads in
  every repo). Two concerns were raised and are unresolved: (a) it contains a Jale AWS runbook
  including `secretsmanager get-secret-value` and an SSM port-forward to the production RDS,
  presented as routine steps in an auto-loaded instruction file — recommended for removal or
  project-scoping with per-use approval; (b) lines 47 and 70 license a "loop Fix → Review until
  clean" cycle that contradicts `dev-cycle`'s exactly-one-feedback-round stopping rule.

---

## Freeze status

No push. No merge into the Codex lane. No deployment. No RDS migration. No worker reset. All eight
Codex-owned files remain absent from this branch, and migration `042` has not been pulled in.
