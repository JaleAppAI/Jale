# WhatsApp V2 Claude Lane — Unblocked Subset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

## Context

The canonical lane plan (`docs/superpowers/plans/2026-07-21-whatsapp-v2-claude-lane.md`) placed a
single Bootstrap Barrier in front of all seven tasks, so nothing in the Claude lane could start
until Codex merged C2–C4. Verified on `feat/wa-v2-workflow` @ `e9f7e47`: none of
`onboarding-types.ts`, `runtime-controls.ts`, `delivery-policy.ts`, `onboarding-repository.ts`,
`worker-delivery-gateway.ts` exist, migrations stop at `041`, and `feat/wa-v2-integration` is ahead
by exactly one docs commit. The lane is fully idle.

That barrier was drawn too broadly. It was split by *code ownership*, but the real dependency is
narrower: only work that **imports a C2/C4 symbol** needs the bootstrap. Three lane surfaces import
nothing from Codex and compile against types that already exist today.

This plan carves out that unblocked subset so the Claude lane produces reviewed, merged, tested work
while Codex builds C1–C4 in parallel. It deliberately **does not** invent temporary shared
interfaces — no local `WorkflowStepKey`, `MessageCategory`, `PreAuthState`, or gateway stub appears
anywhere. The gated work resumes unchanged from the canonical plan once the bootstrap lands.

Outcome: the Manuel identity-binding defect is fixed and regression-locked, and the pure language
policy plus the complete bilingual v2 copy surface are in place — so when C2/C4 arrive, the router
task (canonical Task 4) has its language layer and every string it needs already merged and green.

**Goal:** Land the three C2/C4-independent surfaces of the WhatsApp v2 Claude lane — pre-OTP relay
prevention, pure language/cooldown policy, and additive bilingual v2 copy — on
`feat/wa-v2-workflow` while the Codex bootstrap is still in flight.

**Architecture:** Three file-disjoint tasks dispatched in parallel to Sonnet subagents in disposable
worktrees. Task 1 adds an unbound-session guard to the existing relay router. Task 2 creates a new
pure module with no I/O. Task 3 extends two existing template modules additively. No task creates
`onboarding-v2.ts`, `onboarding-renderers.ts`, `onboarding-adapters.ts`, or touches `processor.ts`
routing beyond one picker call site.

**Tech Stack:** TypeScript 5.9, Node.js Lambda, Jest 30 + ts-jest, `pg` `PoolClient`.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` and the canonical
  lane plan. Read both before editing.
- **Never declare a type or function signature that C2/C4 will own.** If a task appears to need
  `WorkerLifecycle`, `WorkflowStepKey`, `MessageCategory`, `DeliveryDecision`, `PreAuthState`,
  `CategoryRenderer`, `ReleaseRenderer`, `enqueueWorkerMessage`, `advanceWorkflow`, or any
  repository/gateway symbol — **stop and report**. That work belongs to the gated phase.
- Successful OTP verification is the only identity-binding operation.
- This lane never calls `queueOutboxText`, `queueText`, or `queueInteractivePrompt` from new v2
  modules. Tasks 2 and 3 are pure — they return values, they do not send.
- Do not drop or rename legacy WhatsApp columns; do not switch non-allowlisted workers to v2.
- Additive only in `templates.ts` and `interactive-templates.ts`: no existing `TemplateKey` or
  builder is renamed, reworded, or deleted. Ten existing test files depend on them.
- `lib/flows.ts`, `lib/profile-flow.ts`, `handlers/custom-trust.ts`, `lambda/ai/trust-scorer.ts`,
  `lib/twilio.ts`, `lib/outbox.ts`, `status-callback.ts`, `webhook.ts`, `lib/stacks/**` are not
  modified by any task here.
- Keep `resolveWorkerIdForWhatsappNumber` exported. Its own tests at
  `conversation-router.test.ts:36-62` must stay green; only its use as an identity fallback in relay
  paths is removed.
- Keep untracked `demo-ready-windows/` and `reports/` untouched.
- Task agents work in disposable worktrees branched from `feat/wa-v2-workflow`. They never edit
  `.worktrees/wa-v2-integration` or `.worktrees/wa-v2-claude` directly.
- Stop before push, deployment, RDS migration, worker reset, or merge into the Codex lane.
- All commands run from `infra/`. Timing values are named constants, never inline literals.

---

## Canonical Values (copy verbatim; never re-derive)

| Constant | Value |
| --- | --- |
| OTP expiry | 5 minutes |
| OTP wrong-attempt lock | 3 attempts → 15-minute lock |
| OTP resend cooldown | 60 seconds |
| OTP sends per phone per hour | 3 |
| Start template cooldown | 1 per normalized phone per 10 minutes |
| Start templates per phone / 24h | 5 |
| Invalid-answer reprompt cooldown | 30 seconds |
| Name length | 2–100 characters |
| Standard trades | `electrician`, `plumber`, `carpenter`, `concrete`, `painting`, `other` |

---

## Scope Split

### In scope now (imports nothing from C2/C4)

| Task | Deliverable | Why it is independent |
| --- | --- | --- |
| 1 | Pre-OTP relay prevention + Manuel regression | Uses only existing `ConversationRow` / `IncomingMessage` / `RouterDeps` from `conversation-router.ts` |
| 2 | `lib/onboarding-language.ts` — pure language + cooldown policy | No DB, no I/O, `now` always injected; reuses `flows.ts` helpers only |
| 3 | v2 bilingual copy in `templates.ts` + `interactive-templates.ts` | Additive string/`InteractivePrompt` data; `Lang` is lane-local to `templates.ts` |

### Deferred to the gated phase (blocks on C2–C4)

| Deferred work | Blocking symbol |
| --- | --- |
| `lib/onboarding-renderers.ts` + `registerOnboardingRenderers()` + `createReleaseRenderer()` | C2 `MessageCategory`, `CategoryRenderer`, `ReleaseRenderer`; C4 renderer registry |
| `lib/onboarding-adapters.ts` (identity, profile persistence) | Repository-backed; C4 `PoolClient` persistence contract, C2 OTP constants |
| `onboarding-v2.ts` router — entry, OTP, legal, command gate | C4 `PreAuthState`, `bindVerifiedIdentityAndStartWorkflow`, `advanceWorkflow`, `enqueueWorkerMessage` |
| `onboarding-v2.ts` — profile/trade/trust/readiness | C4 `completeOnboarding` |
| `processor.ts` v2 branch | C2 `loadRuntimeControls`, `hashNormalizedPhone`, `isV2Enabled` |
| `test/helpers/whatsapp-v2-harness.ts` conversation testbed | All of the above |

The deferred tasks resume verbatim from the canonical plan's Tasks 2–7 once the barrier is green.
This plan does not restate or renumber them.

---

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `lambda/whatsapp/lib/conversation-router.ts` (modify) | 1 | Relay gating — unbound sessions cannot relay, focus, pick, or trigger a legal prompt |
| `lambda/whatsapp/processor.ts` (modify, one call site) | 1 | Picker branch guards on `conv.user_id` |
| `lambda/whatsapp/lib/onboarding-language.ts` (create) | 2 | Pure language selection, command classification, cooldown arithmetic |
| `lambda/whatsapp/lib/templates.ts` (modify) | 3 | v2 plain-text bilingual copy |
| `lambda/whatsapp/lib/interactive-templates.ts` (modify) | 3 | v2 interactive prompt builders |

Tasks are **file-disjoint** — all three dispatch in parallel with no sequencing.

---

## Task 1: Pre-OTP Relay Prevention and the Manuel Regression

**Files:**
- Modify: `lambda/whatsapp/lib/conversation-router.ts` — `tryConversationRelay` (:151),
  `handleEmployerConversationButton` (:232), `handleEmployerConversationTextAction` (:332),
  `handlePickerResponse` (:591)
- Modify: `lambda/whatsapp/processor.ts:1052-1057` — picker pre-check
- Test: `test/unit/lambda/whatsapp/lib/conversation-router.test.ts`,
  `test/unit/lambda/whatsapp/processor.test.ts`

**Interfaces:**
- Consumes: existing `ConversationRow`, `IncomingMessage`, `RouterDeps` — all already exported from
  `conversation-router.ts:33-72`. Nothing new is imported.
- Produces: the invariant *an unbound session (`conv.user_id === null`) can never relay, focus,
  pick, or trigger a legal prompt*. No new exported symbol.

**Background:** `tryConversationRelay:171-172` currently falls back to
`resolveWorkerIdForWhatsappNumber(client, msg.from)` when `conv.user_id` is null. A phone number is
not a verified identity, so an unbound session in `awaiting_otp` — Manuel's case — relays into an
employer thread and can be shown a legal prompt before ever completing OTP. The same fallback exists
at `:239` and `:339`, and `processor.ts:1052` re-resolves for the picker branch.

A **bound** session in `awaiting_otp` still relays — that is re-verification, and the existing test
at `conversation-router.test.ts:243` must stay green.

- [ ] **Step 1: Invert the test that encodes the defect.**

Replace the `it` block at `conversation-router.test.ts:217`
(`relays for the 'new' state via phone resolution without binding identity`) with:

```ts
  it('does NOT relay for the `new` state when the session is unbound', async () => {
    // Identity binding requires verified OTP (design §4.2a). A phone match is
    // not an identity — the Manuel incident. The guard returns before the
    // resolver, so no SQL runs at all.
    const conv = { ...baseConv, conversation_state: 'new', user_id: null };
    const routed = await tryConversationRelay(client, conv, msg, deps);

    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    assertNoIdentityBinding();
  });
```

- [ ] **Step 2: Add the Manuel regression describe block.**

Append to the same describe scope:

```ts
  describe('Manuel regression — unbound awaiting_otp session', () => {
    const manuelConv = {
      ...baseConv,
      conversation_state: 'awaiting_otp' as const,
      user_id: null,
      state_context: { cognito_session: 'sess-manuel' },
    };

    function assertNoJobConversationSql() {
      for (const call of mockQuery.mock.calls) {
        expect(String(call[0])).not.toMatch(/job_conversation_messages/i);
      }
    }

    it('does not relay free text', async () => {
      const routed = await tryConversationRelay(client, { ...manuelConv }, msg, deps);
      expect(routed).toBeNull();
      expect(recordWorkerConversationReply).not.toHaveBeenCalled();
      assertNoJobConversationSql();
      assertNoIdentityBinding();
    });

    it('does not present the legal prompt for CHATS', async () => {
      const chatsMsg = { ...msg, body: 'CHATS' };
      const routed = await tryConversationRelay(client, { ...manuelConv }, chatsMsg, deps);
      expect(routed).toBeNull();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
      assertNoJobConversationSql();
      assertNoIdentityBinding();
    });

    it('does not open an employer conversation from a button', async () => {
      const routed = await handleEmployerConversationButton(
        client, { ...manuelConv }, msg,
        { action: 'open', conversationId: CONV_A }, deps,
      );
      expect(routed).toBeNull();
      expect(deps.updateConversation).not.toHaveBeenCalled();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
    });

    it('does not open an employer conversation from typed text', async () => {
      const routed = await handleEmployerConversationTextAction(
        client, { ...manuelConv }, msg, 'open', deps,
      );
      expect(routed).toBeNull();
      expect(deps.updateConversation).not.toHaveBeenCalled();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
    });
  });
```

`handleEmployerConversationTextAction` must be added to the import list at
`conversation-router.test.ts:66-70` if it is not already there.

- [ ] **Step 3: Run red.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/conversation-router.test.ts --runInBand`

Expected **FAIL**, behavioral not missing-module:
- the unbound-`new` case receives the `WORKER` UUID instead of `null` (fallback at `:171-172`)
- the `CHATS` case fails `not.toHaveBeenCalled()` with 1 call (from `:184`)
- both employer-conversation cases fail because `:239` and `:339` phone-resolve

- [ ] **Step 4: Add the unbound guard.**

In `tryConversationRelay`, immediately after `if (!msg.body.trim()) return null;` (`:157`):

```ts
  // Identity-binding rule (design §4.2a): only a verified OTP binds a session.
  // An unbound conversation must never relay into an employer thread — a phone
  // match is not an identity (the Manuel incident).
  if (!conv.user_id) return null;
```

Then at `:171-177`, replace the fallback and the now-unreachable log:

```ts
  const workerId = conv.user_id;
```

(delete the `?? await resolveWorkerIdForWhatsappNumber(...)`, the `if (!workerId) return null;` is
retained only if TypeScript still narrows it — otherwise drop it — and delete the
`ConversationRelayPhoneMatch` log at `:175-177` entirely.)

At `:239` in `handleEmployerConversationButton`:

```ts
  const workerId = conv.user_id;
```

At `:339` in `handleEmployerConversationTextAction`:

```ts
  const workerId = conv.user_id;
```

Both retain their existing `if (!workerId) { ... return null; }` blocks unchanged.

`handlePickerResponse` (`:591`) already takes `workerId` as a parameter — no change inside it; the
caller is fixed below.

In `processor.ts:1052-1057`, replace the picker pre-check:

```ts
  if (conv.state_context?.pending_picker && parseDisambiguationPick(msg.body) !== null) {
    // Unbound sessions cannot pick — identity binding requires verified OTP.
    if (conv.user_id) {
      return await handlePickerResponse(client, conv, msg, conv.user_id, routerDeps);
    }
  }
```

- [ ] **Step 5: Run green.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/conversation-router.test.ts --runInBand`

Expected **PASS**, whole file — including `resolveWorkerIdForWhatsappNumber`'s own three tests at
`:36-62` and the bound-`awaiting_otp` relay test at `:243`.

- [ ] **Step 6: Legacy regression.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/processor.test.ts test/unit/lambda/whatsapp/onboarding-conversation.test.ts --runInBand`

Expected **PASS**. The three processor mock chains referencing the resolver (`:294`, `:1126`,
`:2841`) all model *no match*, so removing the query only leaves a queued `mockResolvedValueOnce`
unconsumed. If a chain shifts, fix the **mock chain**, never an assertion.

- [ ] **Step 7: Build and commit.**

```bash
cd infra && npm run build
git add lambda/whatsapp/lib/conversation-router.ts lambda/whatsapp/processor.ts \
        test/unit/lambda/whatsapp/lib/conversation-router.test.ts \
        test/unit/lambda/whatsapp/processor.test.ts
git commit -m "fix(whatsapp): block relay and legal prompts on unbound sessions"
```

**Review gate — blocking:** any surviving resolver fallback in a relay path; a loosened test; a
touched excluded file; `resolveWorkerIdForWhatsappNumber` no longer exported.

---

## Task 2: Pure Language and Cooldown Policy

**Files:**
- Create: `lambda/whatsapp/lib/onboarding-language.ts`
- Test: `test/unit/lambda/whatsapp/lib/onboarding-language.test.ts`

**Interfaces:**
- Consumes: `Lang` from `./templates`; `normalizeCommandText`, `matchCommandFuzzy`,
  `detectCommandLanguage` from `./flows` (all pure, already exported at `flows.ts:315/350/440`).
- Produces, for the gated router task:
  - `parseLanguageChoice(body: string, payload?: string): Lang | null`
  - `detectCommandLang(body: string): Lang | null`
  - `resolveResponseLanguage(preferred: Lang, body: string, isInteractive: boolean): Lang`
  - `isLanguageCommand(body: string): boolean`
  - `isResendCommand(body: string): boolean`
  - `isReviewTermsCommand(body: string): boolean`
  - `isOnboardingHelpCommand(body: string): boolean`
  - `classifyBlockedCommand(body: string): 'jobs' | 'chats' | 'profile' | null`
  - `evaluateStartCooldown(history: readonly string[], now: Date): StartCooldownResult`
  - `shouldRepeatPrompt(lastIso: string | null | undefined, now: Date): boolean`
  - `appendSendTimestamp(history: readonly string[], now: Date): string[]`
  - `interface StartCooldownResult { allowed: boolean; reason: 'ok' | 'cooldown' | 'daily_cap' }`
  - constants `START_COOLDOWN_MS`, `START_DAILY_CAP`, `START_DAILY_WINDOW_MS`, `REPROMPT_COOLDOWN_MS`

**Purity contract:** no DB handle, no network, no `Date.now()`, no `process.env`. Every
time-dependent function takes `now: Date`. History is an array of ISO-8601 strings.

- [ ] **Step 1: Write the failing tests.**

Create `test/unit/lambda/whatsapp/lib/onboarding-language.test.ts`:

```ts
// infra/test/unit/lambda/whatsapp/lib/onboarding-language.test.ts
//
// Pure module: nothing is mocked, no clock is faked. `now` is injected.

import {
  parseLanguageChoice, detectCommandLang, resolveResponseLanguage,
  isLanguageCommand, isResendCommand, isReviewTermsCommand, isOnboardingHelpCommand,
  classifyBlockedCommand, evaluateStartCooldown, shouldRepeatPrompt, appendSendTimestamp,
  START_COOLDOWN_MS, START_DAILY_CAP, REPROMPT_COOLDOWN_MS,
} from '../../../../../lambda/whatsapp/lib/onboarding-language';

const T0 = new Date('2026-07-21T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('parseLanguageChoice', () => {
  it('maps START to en and EMPEZAR to es', () => {
    expect(parseLanguageChoice('START')).toBe('en');
    expect(parseLanguageChoice('  empezar ')).toBe('es');
  });

  it('maps the interactive payloads', () => {
    expect(parseLanguageChoice('', 'start:lang:en')).toBe('en');
    expect(parseLanguageChoice('', 'start:lang:es')).toBe('es');
  });

  it('returns null for unrelated text', () => {
    expect(parseLanguageChoice('hello there')).toBeNull();
  });
});

describe('resolveResponseLanguage', () => {
  it('answers a command in the command language', () => {
    expect(resolveResponseLanguage('es', 'HELP', false)).toBe('en');
    expect(resolveResponseLanguage('en', 'AYUDA', false)).toBe('es');
  });

  it('always uses the preferred language for interactive taps', () => {
    expect(resolveResponseLanguage('es', 'HELP', true)).toBe('es');
  });

  it('uses the preferred language for non-command free text', () => {
    expect(resolveResponseLanguage('es', 'Juan Perez', false)).toBe('es');
  });
});

describe('command recognizers', () => {
  it.each(['LANGUAGE', 'idioma'])('recognizes %s as the language command', (b) => {
    expect(isLanguageCommand(b)).toBe(true);
  });

  it.each(['RESEND', 'reenviar'])('recognizes %s as resend', (b) => {
    expect(isResendCommand(b)).toBe(true);
  });

  it.each(['REVIEW TERMS', 'revisar terminos', 'REVISAR TÉRMINOS'])(
    'recognizes %s as review-terms', (b) => {
      expect(isReviewTermsCommand(b)).toBe(true);
    });

  it.each(['HELP', 'ayuda'])('recognizes %s as onboarding help', (b) => {
    expect(isOnboardingHelpCommand(b)).toBe(true);
  });

  it('does not recognize a step answer as a command', () => {
    expect(isLanguageCommand('Juan Perez')).toBe(false);
    expect(isResendCommand('78701')).toBe(false);
  });
});

describe('classifyBlockedCommand', () => {
  it.each([
    ['JOBS', 'jobs'], ['trabajos', 'jobs'],
    ['CHATS', 'chats'], ['mensajes', 'chats'],
    ['PROFILE', 'profile'], ['perfil', 'profile'],
  ])('classifies %s as %s', (body, expected) => {
    expect(classifyBlockedCommand(body)).toBe(expected);
  });

  it('returns null for a step answer', () => {
    expect(classifyBlockedCommand('Austin, TX')).toBeNull();
  });
});

describe('evaluateStartCooldown', () => {
  it('allows the first invitation', () => {
    expect(evaluateStartCooldown([], T0)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks a second invitation inside 10 minutes', () => {
    const history = [T0.toISOString()];
    expect(evaluateStartCooldown(history, at(START_COOLDOWN_MS - 1)))
      .toEqual({ allowed: false, reason: 'cooldown' });
  });

  it('allows one after the cooldown', () => {
    const history = [T0.toISOString()];
    expect(evaluateStartCooldown(history, at(START_COOLDOWN_MS)))
      .toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks the sixth in 24 hours', () => {
    const history = Array.from({ length: START_DAILY_CAP },
      (_, i) => at(i * START_COOLDOWN_MS).toISOString());
    const now = at(START_DAILY_CAP * START_COOLDOWN_MS + START_COOLDOWN_MS);
    expect(evaluateStartCooldown(history, now))
      .toEqual({ allowed: false, reason: 'daily_cap' });
  });

  it('does not count sends older than 24 hours', () => {
    const history = Array.from({ length: START_DAILY_CAP },
      (_, i) => at(i * START_COOLDOWN_MS).toISOString());
    const now = at(25 * 60 * 60 * 1000);
    expect(evaluateStartCooldown(history, now)).toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('shouldRepeatPrompt', () => {
  it('is true when never repeated', () => {
    expect(shouldRepeatPrompt(null, T0)).toBe(true);
  });

  it('is false inside 30 seconds', () => {
    expect(shouldRepeatPrompt(T0.toISOString(), at(REPROMPT_COOLDOWN_MS - 1))).toBe(false);
  });

  it('is true after 30 seconds', () => {
    expect(shouldRepeatPrompt(T0.toISOString(), at(REPROMPT_COOLDOWN_MS))).toBe(true);
  });
});

describe('appendSendTimestamp', () => {
  it('appends now and prunes entries older than 24 hours', () => {
    const old = new Date(T0.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const result = appendSendTimestamp([old, T0.toISOString()], at(60_000));
    expect(result).not.toContain(old);
    expect(result).toContain(at(60_000).toISOString());
    expect(result).toHaveLength(2);
  });
});

describe('purity', () => {
  it('detectCommandLang delegates without side effects', () => {
    expect(detectCommandLang('AYUDA')).toBe('es');
    expect(detectCommandLang('Juan Perez')).toBeNull();
  });
});
```

- [ ] **Step 2: Run red.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/onboarding-language.test.ts --runInBand`

Expected **FAIL** at compile time — ts-jest type-checks (`jest.config.js` sets no
`diagnostics: false` and `tsconfig.json` has `strict: true`):
`error TS2307: Cannot find module '../../../../../lambda/whatsapp/lib/onboarding-language' or its
corresponding type declarations.`

- [ ] **Step 3: Implement.**

Create `lambda/whatsapp/lib/onboarding-language.ts`:

```ts
// infra/lambda/whatsapp/lib/onboarding-language.ts
//
// Pure language selection, onboarding command classification, and cooldown
// arithmetic for the WhatsApp v2 workflow. No DB, no network, no clock: every
// time-dependent function takes `now`. Histories are ISO-8601 string arrays.
//
// Owns NO shared type. `Lang` comes from ./templates; command normalization
// comes from ./flows. Nothing here is a canonical C2/C4 symbol.

import { type Lang } from './templates';
import { normalizeCommandText, matchCommandFuzzy, detectCommandLanguage } from './flows';

/** Start template cooldown: 1 per normalized phone per 10 minutes. */
export const START_COOLDOWN_MS = 10 * 60 * 1000;
/** Start templates per phone per 24h. */
export const START_DAILY_CAP = 5;
export const START_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Invalid-answer reprompt cooldown: 30 seconds. */
export const REPROMPT_COOLDOWN_MS = 30 * 1000;

export interface StartCooldownResult {
  allowed: boolean;
  reason: 'ok' | 'cooldown' | 'daily_cap';
}

/**
 * Language choice from the start invitation: the two button payloads, or the
 * typed START / EMPEZAR fallbacks.
 */
export function parseLanguageChoice(body: string, payload?: string): Lang | null {
  if (payload === 'start:lang:en') return 'en';
  if (payload === 'start:lang:es') return 'es';
  const n = normalizeCommandText(body);
  if (n === 'start') return 'en';
  if (n === 'empezar') return 'es';
  return null;
}

/** Language of a recognized command, or null when the text is not a command. */
export function detectCommandLang(body: string): Lang | null {
  return detectCommandLanguage(body);
}

/**
 * A command typed in the non-preferred language is answered in the command
 * language; interactive taps and ordinary step answers stay preferred.
 */
export function resolveResponseLanguage(
  preferred: Lang,
  body: string,
  isInteractive: boolean,
): Lang {
  if (isInteractive) return preferred;
  return detectCommandLang(body) ?? preferred;
}

function matches(body: string, words: ReadonlySet<string>): boolean {
  const n = normalizeCommandText(body);
  if (words.has(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy !== null && words.has(fuzzy);
}

const LANGUAGE_WORDS = new Set(['language', 'idioma']);
const RESEND_WORDS = new Set(['resend', 'reenviar']);
// normalizeCommandText lowercases but does not strip accents.
const REVIEW_TERMS_WORDS = new Set([
  'review terms', 'revisar terminos', 'revisar términos',
]);
const HELP_WORDS = new Set(['help', 'ayuda']);

export function isLanguageCommand(body: string): boolean {
  return matches(body, LANGUAGE_WORDS);
}

export function isResendCommand(body: string): boolean {
  return matches(body, RESEND_WORDS);
}

export function isReviewTermsCommand(body: string): boolean {
  // Multi-word: matchCommandFuzzy rejects anything containing whitespace, so
  // exact normalized comparison only.
  return REVIEW_TERMS_WORDS.has(normalizeCommandText(body));
}

export function isOnboardingHelpCommand(body: string): boolean {
  return matches(body, HELP_WORDS);
}

const BLOCKED_COMMANDS: ReadonlyArray<[ReadonlySet<string>, 'jobs' | 'chats' | 'profile']> = [
  [new Set(['jobs', 'trabajos', 'empleos']), 'jobs'],
  [new Set(['chats', 'mensajes']), 'chats'],
  [new Set(['profile', 'perfil']), 'profile'],
];

/**
 * Commands the onboarding gate refuses to execute. Returns the command family
 * so the caller can log `{ metric: 'OnboardingGateBlocked', command, stepKey }`.
 */
export function classifyBlockedCommand(body: string): 'jobs' | 'chats' | 'profile' | null {
  for (const [words, family] of BLOCKED_COMMANDS) {
    if (matches(body, words)) return family;
  }
  return null;
}

function parseHistory(history: readonly string[], now: Date): number[] {
  const nowMs = now.getTime();
  return history
    .map((iso) => Date.parse(iso))
    .filter((ms) => Number.isFinite(ms) && nowMs - ms < START_DAILY_WINDOW_MS)
    .sort((a, b) => b - a);
}

/** Cooldown is checked before the daily cap: the nearer limit wins. */
export function evaluateStartCooldown(
  history: readonly string[],
  now: Date,
): StartCooldownResult {
  const recent = parseHistory(history, now);
  if (recent.length === 0) return { allowed: true, reason: 'ok' };
  if (now.getTime() - recent[0] < START_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown' };
  }
  if (recent.length >= START_DAILY_CAP) return { allowed: false, reason: 'daily_cap' };
  return { allowed: true, reason: 'ok' };
}

/** True when the current prompt may be repeated (30-second reprompt cooldown). */
export function shouldRepeatPrompt(lastIso: string | null | undefined, now: Date): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= REPROMPT_COOLDOWN_MS;
}

/** Append this send and drop anything outside the 24-hour window. */
export function appendSendTimestamp(history: readonly string[], now: Date): string[] {
  const kept = parseHistory(history, now).map((ms) => new Date(ms).toISOString());
  return [...kept, now.toISOString()];
}
```

- [ ] **Step 4: Run green.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/onboarding-language.test.ts --runInBand`

Expected **PASS**, all cases.

- [ ] **Step 5: Verify purity and no canonical duplication.**

```bash
cd infra
grep -nE "PoolClient|process\.env|Date\.now|require\(|from '\.\./" lambda/whatsapp/lib/onboarding-language.ts
grep -nE "^export (type|interface) (Worker|Message|Delivery|Workflow|PreAuth|Category|Release)" lambda/whatsapp/lib/onboarding-language.ts
```

Expected: **no output** from either. Any hit in the second means a C2/C4-owned type was
re-declared — a blocking defect.

- [ ] **Step 6: Build and commit.**

```bash
cd infra && npm run build
git add lambda/whatsapp/lib/onboarding-language.ts \
        test/unit/lambda/whatsapp/lib/onboarding-language.test.ts
git commit -m "feat(whatsapp): add pure v2 language and cooldown policy"
```

**Review gate — blocking:** any I/O, `Date.now()`, or `process.env`; a timing literal not expressed
as a named constant; a re-declared canonical type; cooldown checked after the daily cap.

---

## Task 3: Bilingual V2 Copy and Interactive Builders

**Files:**
- Modify: `lambda/whatsapp/lib/templates.ts` — extend `TemplateKey` (`:12-60`) and the `templates`
  record (`:62`)
- Modify: `lambda/whatsapp/lib/interactive-templates.ts` — append builders
- Test: `test/unit/lambda/whatsapp/lib/templates.test.ts`,
  `test/unit/lambda/whatsapp/lib/interactive-templates.test.ts`

**Interfaces:**
- Consumes: existing `t(key, lang, vars)` at `templates.ts:236`, existing `InteractivePrompt`
  at `interactive-templates.ts:8-12`. Both already exist.
- Produces, for the gated renderer and router tasks:
  - v2 `TemplateKey` members: `v2_start_invitation`, `v2_start_cooldown_note`, `v2_otp_sent`,
    `v2_otp_invalid`, `v2_otp_expired`, `v2_otp_locked`, `v2_otp_resend_cooldown`,
    `v2_otp_send_cap`, `v2_legal_declined`, `v2_ask_name`, `v2_name_invalid`, `v2_ask_location`,
    `v2_location_invalid`, `v2_ask_custom_trade`, `v2_custom_trade_invalid`, `v2_gate_blocked`,
    `v2_language_changed`, `v2_ready`
  - `buildV2StartInvitationPrompt(lang: Lang): InteractivePrompt`
  - `buildV2OtpPrompt(lang: Lang, minutes: string): InteractivePrompt`
  - `buildV2LegalPrompt(lang: Lang, tosUrl: string, privacyUrl: string): InteractivePrompt`
  - `buildV2NumberedOptionsPrompt(lang: Lang, question: string, options: readonly string[]): InteractivePrompt`
  - `V2_FALLBACK_TRUST_QUESTIONS: ReadonlyArray<{ en: string; es: string }>` (three reviewed
    bilingual questions, used when the generator fails)

**Exclusions:** additive only. No existing `TemplateKey` or builder is renamed, reworded, or
deleted. `flows.ts` is not modified. Nothing here sends, enqueues, reads a clock, or touches the DB.

**Deferred from this task:** `onboarding-renderers.ts`, `registerOnboardingRenderers()`, and
`createReleaseRenderer()` — they require C2's `MessageCategory` / `CategoryRenderer` /
`ReleaseRenderer` and the C4 registry. Do not create that file. The copy this task adds is what
those renderers will consume.

- [ ] **Step 1: Write the failing template tests.**

Append to `test/unit/lambda/whatsapp/lib/templates.test.ts`:

```ts
import { t, type Lang, type TemplateKey } from '../../../../../lambda/whatsapp/lib/templates';

const V2_KEYS: TemplateKey[] = [
  'v2_start_invitation', 'v2_start_cooldown_note',
  'v2_otp_sent', 'v2_otp_invalid', 'v2_otp_expired', 'v2_otp_locked',
  'v2_otp_resend_cooldown', 'v2_otp_send_cap',
  'v2_legal_declined',
  'v2_ask_name', 'v2_name_invalid',
  'v2_ask_location', 'v2_location_invalid',
  'v2_ask_custom_trade', 'v2_custom_trade_invalid',
  'v2_gate_blocked', 'v2_language_changed', 'v2_ready',
];

describe('v2 templates', () => {
  it.each(V2_KEYS)('%s has distinct non-empty EN and ES copy', (key) => {
    const en = t(key, 'en');
    const es = t(key, 'es');
    expect(en.trim().length).toBeGreaterThan(0);
    expect(es.trim().length).toBeGreaterThan(0);
    expect(en).not.toBe(es);
  });

  it('v2_otp_sent interpolates the 5-minute limit', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      expect(t('v2_otp_sent', lang, { minutes: '5' })).toContain('5');
      expect(t('v2_otp_sent', lang, { minutes: '5' })).not.toContain('{{');
    }
  });

  it('v2_otp_invalid interpolates remaining attempts', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_invalid', lang, { attempts: '2' });
      expect(s).toContain('2');
      expect(s).not.toContain('{{');
    }
  });

  it('v2_otp_locked interpolates 15 minutes', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_locked', lang, { minutes: '15' });
      expect(s).toContain('15');
      expect(s).not.toContain('{{');
    }
  });

  it('v2_otp_resend_cooldown interpolates seconds', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_resend_cooldown', lang, { seconds: '60' });
      expect(s).toContain('60');
      expect(s).not.toContain('{{');
    }
  });

  it('the start invitation offers both languages and never reveals account existence', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_start_invitation', lang);
      expect(s).toContain('START');
      expect(s).toContain('EMPEZAR');
      expect(s).not.toMatch(/existing|already|ya tienes|cuenta existente/i);
    }
  });
});
```

- [ ] **Step 2: Write the failing interactive-builder tests.**

Append to `test/unit/lambda/whatsapp/lib/interactive-templates.test.ts`:

```ts
import {
  buildV2StartInvitationPrompt, buildV2OtpPrompt, buildV2LegalPrompt,
  buildV2NumberedOptionsPrompt, V2_FALLBACK_TRUST_QUESTIONS,
} from '../../../../../lambda/whatsapp/lib/interactive-templates';
import type { Lang } from '../../../../../lambda/whatsapp/lib/templates';

const LANGS: Lang[] = ['en', 'es'];

describe('buildV2StartInvitationPrompt', () => {
  it.each(LANGS)('offers both language choices in %s', (lang) => {
    const p = buildV2StartInvitationPrompt(lang);
    expect(p.templateName).toContain('v2');
    expect(p.fallbackBody).toContain('START');
    expect(p.fallbackBody).toContain('EMPEZAR');
    expect(p.fallbackBody).not.toMatch(/existing|already|ya tienes/i);
  });
});

describe('buildV2OtpPrompt', () => {
  it.each(LANGS)('interpolates the expiry and offers resend in %s', (lang) => {
    const p = buildV2OtpPrompt(lang, '5');
    expect(p.fallbackBody).toContain('5');
    expect(p.fallbackBody).not.toContain('{{');
    expect(JSON.stringify(p)).toContain('otp:resend');
  });
});

describe('buildV2LegalPrompt', () => {
  it.each(LANGS)('carries Terms and Privacy in variables and fallback in %s', (lang) => {
    const p = buildV2LegalPrompt(lang, 'https://jale.app/terms', 'https://jale.app/privacy');
    const vars = Object.values(p.variables);
    expect(vars).toContain('https://jale.app/terms');
    expect(vars).toContain('https://jale.app/privacy');
    expect(p.fallbackBody).toContain('https://jale.app/terms');
    expect(p.fallbackBody).toContain('https://jale.app/privacy');
    const serialized = JSON.stringify(p);
    expect(serialized).toContain('legal:accept');
    expect(serialized).toContain('legal:decline');
    expect(serialized).toContain('legal:review');
  });
});

describe('buildV2NumberedOptionsPrompt', () => {
  it.each(LANGS)('numbers each option from 1 in %s', (lang) => {
    const p = buildV2NumberedOptionsPrompt(lang, 'Pick one', ['Alpha', 'Beta', 'Gamma']);
    expect(p.fallbackBody).toContain('1. Alpha');
    expect(p.fallbackBody).toContain('2. Beta');
    expect(p.fallbackBody).toContain('3. Gamma');
  });
});

describe('V2_FALLBACK_TRUST_QUESTIONS', () => {
  it('has exactly three reviewed bilingual questions with EN != ES', () => {
    expect(V2_FALLBACK_TRUST_QUESTIONS).toHaveLength(3);
    for (const q of V2_FALLBACK_TRUST_QUESTIONS) {
      expect(q.en.trim().length).toBeGreaterThan(0);
      expect(q.es.trim().length).toBeGreaterThan(0);
      expect(q.en).not.toBe(q.es);
    }
  });
});
```

- [ ] **Step 3: Run red.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/templates.test.ts test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand`

Expected **FAIL** at compile time in **both** files. ts-jest type-checks here (`jest.config.js`
declares a bare `'ts-jest'` transform with no `diagnostics: false`, and `tsconfig.json` sets
`strict: true`), so neither suite reaches runtime:

- `templates.test.ts` — `error TS2322: Type '"v2_start_invitation"' is not assignable to type
  'TemplateKey'.` (one such error per unknown literal in the `V2_KEYS` array). This is a *compile*
  error, not the runtime `TypeError` from `t()` — the annotated `TemplateKey[]` catches it first.
- `interactive-templates.test.ts` — `error TS2305: Module '.../interactive-templates' has no
  exported member 'buildV2StartInvitationPrompt'.`

- [ ] **Step 4: Implement the templates.**

In `templates.ts`, append to the `TemplateKey` union (after `'support_needs_signup'` at `:60`):

```ts
  // ── V2 workflow (additive; legacy keys above are unchanged) ──
  | 'v2_start_invitation'
  | 'v2_start_cooldown_note'
  | 'v2_otp_sent'
  | 'v2_otp_invalid'
  | 'v2_otp_expired'
  | 'v2_otp_locked'
  | 'v2_otp_resend_cooldown'
  | 'v2_otp_send_cap'
  | 'v2_legal_declined'
  | 'v2_ask_name'
  | 'v2_name_invalid'
  | 'v2_ask_location'
  | 'v2_location_invalid'
  | 'v2_ask_custom_trade'
  | 'v2_custom_trade_invalid'
  | 'v2_gate_blocked'
  | 'v2_language_changed'
  | 'v2_ready';
```

Append the matching entries to the `templates` record, before its closing brace. The start
invitation must name both keywords and must not disclose whether an account exists:

```ts
  v2_start_invitation: {
    es: 'Jale: trabajo en construccion por WhatsApp.\n\nResponde EMPEZAR para continuar en espanol, o START to continue in English.',
    en: 'Jale: construction work over WhatsApp.\n\nReply START to continue in English, o responde EMPEZAR para continuar en espanol.',
  },
  v2_start_cooldown_note: {
    es: 'Ya te enviamos una invitacion hace poco. Espera unos minutos e intenta de nuevo.',
    en: 'We already sent you an invitation recently. Please wait a few minutes and try again.',
  },
  v2_otp_sent: {
    es: 'Te enviamos un codigo por SMS. Responde aqui con el codigo. Vence en {{minutes}} minutos.',
    en: 'We sent you a code by SMS. Reply here with the code. It expires in {{minutes}} minutes.',
  },
  v2_otp_invalid: {
    es: 'Ese codigo no es correcto. Te quedan {{attempts}} intentos.',
    en: 'That code is not correct. You have {{attempts}} attempts left.',
  },
  v2_otp_expired: {
    es: 'Ese codigo ya vencio. Responde REENVIAR para recibir uno nuevo.',
    en: 'That code has expired. Reply RESEND to get a new one.',
  },
  v2_otp_locked: {
    es: 'Demasiados intentos. Intenta de nuevo en {{minutes}} minutos.',
    en: 'Too many attempts. Try again in {{minutes}} minutes.',
  },
  v2_otp_resend_cooldown: {
    es: 'Espera {{seconds}} segundos antes de pedir otro codigo.',
    en: 'Please wait {{seconds}} seconds before requesting another code.',
  },
  v2_otp_send_cap: {
    es: 'Pediste demasiados codigos. Intenta de nuevo mas tarde.',
    en: 'You requested too many codes. Please try again later.',
  },
  v2_legal_declined: {
    es: 'Entendido. No podemos continuar sin tu aceptacion. Responde REVISAR TERMINOS cuando quieras verlos otra vez.',
    en: 'Understood. We cannot continue without your acceptance. Reply REVIEW TERMS whenever you want to see them again.',
  },
  v2_ask_name: {
    es: 'Como te llamas? Escribe tu nombre completo.',
    en: 'What is your name? Send your full name.',
  },
  v2_name_invalid: {
    es: 'Necesitamos un nombre de 2 a 100 caracteres. Intenta de nuevo.',
    en: 'We need a name between 2 and 100 characters. Please try again.',
  },
  v2_ask_location: {
    es: 'En que ciudad trabajas? Envia tu codigo postal o Ciudad, ST.',
    en: 'Where do you work? Send your ZIP code or City, ST.',
  },
  v2_location_invalid: {
    es: 'No reconocimos esa ubicacion. Envia un codigo postal de 5 digitos o Ciudad, ST.',
    en: 'We did not recognize that location. Send a 5-digit ZIP code or City, ST.',
  },
  v2_ask_custom_trade: {
    es: 'Cual es tu oficio? Escribelo en pocas palabras.',
    en: 'What is your trade? Describe it in a few words.',
  },
  v2_custom_trade_invalid: {
    es: 'Necesitamos el nombre de tu oficio. Intenta de nuevo.',
    en: 'We need the name of your trade. Please try again.',
  },
  v2_gate_blocked: {
    es: 'Primero terminemos tu registro. Responde a la pregunta de arriba para continuar.',
    en: 'Let us finish signing you up first. Answer the question above to continue.',
  },
  v2_language_changed: {
    es: 'Listo, seguimos en espanol.',
    en: 'Done, we will continue in English.',
  },
  v2_ready: {
    es: 'Tu perfil esta listo. Te avisaremos cuando haya trabajo para ti.',
    en: 'Your profile is ready. We will let you know when there is work for you.',
  },
```

- [ ] **Step 5: Implement the interactive builders.**

Append to `interactive-templates.ts`:

```ts
// ── V2 workflow builders (additive; legacy builders above are unchanged) ──

/** Reviewed bilingual fallback set used when the question generator fails. */
export const V2_FALLBACK_TRUST_QUESTIONS: ReadonlyArray<{ en: string; es: string }> = [
  {
    en: 'How many years have you worked in this trade?',
    es: 'Cuantos anos has trabajado en este oficio?',
  },
  {
    en: 'What tools or equipment do you bring to a job?',
    es: 'Que herramientas o equipo llevas a un trabajo?',
  },
  {
    en: 'Describe a job you finished that you are proud of.',
    es: 'Describe un trabajo que terminaste y del que estas orgulloso.',
  },
];

export function buildV2StartInvitationPrompt(lang: Lang): InteractivePrompt {
  return {
    templateName: `v2_onboarding_start_${lang}`,
    variables: {},
    fallbackBody: t('v2_start_invitation', lang),
  };
}

export function buildV2OtpPrompt(lang: Lang, minutes: string): InteractivePrompt {
  const resendLabel = lang === 'en' ? 'Resend' : 'Reenviar';
  return {
    templateName: `v2_onboarding_otp_${lang}`,
    variables: { '1': minutes, '2': 'otp:resend', '3': resendLabel },
    fallbackBody: t('v2_otp_sent', lang, { minutes }),
  };
}

export function buildV2LegalPrompt(
  lang: Lang,
  tosUrl: string,
  privacyUrl: string,
): InteractivePrompt {
  const body = lang === 'en'
    ? `Before we continue, please review our Terms (${tosUrl}) and Privacy Policy (${privacyUrl}). Reply ACCEPT to continue, DECLINE to stop, or REVIEW TERMS to see them again.`
    : `Antes de continuar, revisa nuestros Terminos (${tosUrl}) y nuestro Aviso de Privacidad (${privacyUrl}). Responde ACEPTAR para continuar, RECHAZAR para detenerte, o REVISAR TERMINOS para verlos otra vez.`;
  return {
    templateName: `v2_onboarding_legal_${lang}`,
    variables: {
      '1': tosUrl,
      '2': privacyUrl,
      '3': 'legal:accept',
      '4': 'legal:decline',
      '5': 'legal:review',
    },
    fallbackBody: body,
  };
}

export function buildV2NumberedOptionsPrompt(
  lang: Lang,
  question: string,
  options: readonly string[],
): InteractivePrompt {
  const lines = options.map((o, i) => `${i + 1}. ${o}`);
  const footer = lang === 'en' ? 'Reply with the number.' : 'Responde con el numero.';
  return {
    templateName: `v2_onboarding_options_${lang}`,
    variables: {},
    fallbackBody: [question, ...lines, footer].join('\n'),
  };
}
```

- [ ] **Step 6: Run green.**

Run: `cd infra && npx jest test/unit/lambda/whatsapp/lib/templates.test.ts test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand`

Expected **PASS**, including every pre-existing case in both suites.

- [ ] **Step 7: Verify additive-only and no premature renderer.**

```bash
cd infra
git diff -- lambda/whatsapp/lib/templates.ts | grep '^-' | grep -v '^---'
git diff -- lambda/whatsapp/lib/interactive-templates.ts | grep '^-' | grep -v '^---'
ls lambda/whatsapp/lib/onboarding-renderers.ts 2>/dev/null
```

Expected: the two `git diff` greps show **only** the line that previously terminated the
`TemplateKey` union and the record's closing context — no removed or reworded copy. The `ls` must
report **no such file** (renderers are gated on C2).

- [ ] **Step 8: Build and commit.**

```bash
cd infra && npm run build
git add lambda/whatsapp/lib/templates.ts lambda/whatsapp/lib/interactive-templates.ts \
        test/unit/lambda/whatsapp/lib/templates.test.ts \
        test/unit/lambda/whatsapp/lib/interactive-templates.test.ts
git commit -m "feat(whatsapp): add bilingual v2 copy and interactive builders"
```

**Review gate — blocking:** an existing key or builder changed; EN copy in the ES slot; a template
that reveals account existence; a legal prompt missing either link in variables *or* fallback; any
send/enqueue/clock/DB side effect; an `onboarding-renderers.ts` created.

---

## Dev-Cycle Orchestration

**Roles:** Opus orchestrates and reviews. Sonnet implements and fixes. Sonnet reviews independently.

**Phase 1 — Dispatch (one message, three parallel `Agent` calls).**
- `model: "sonnet"`, `isolation: "worktree"`, `run_in_background: true`
- Each worktree branches from `feat/wa-v2-workflow`
- Prompt = the task section verbatim + Global Constraints + Canonical Values + "Write the failing
  test first and paste the red output before implementing. Run the exact green command. End with a
  summary of files touched and decisions made."
- Load `SendMessage` via `ToolSearch` up front; record each agent ID
- Tasks are file-disjoint, so all three run concurrently with no sequencing

**Phase 2 — Review 1 (orchestrator, never delegated).** For each finished task: `git diff` against
`feat/wa-v2-workflow`, read every changed file, and personally re-run that task's green command
plus its verification greps. Never trust a reported pass.

**Phase 3 — Independent reviewer.** Dispatch a fresh Sonnet reviewer per task against the same
diff, with the task's blocking list. Combine the reviewer's findings with your own into **one**
actionable message per task — `file:line`, what is wrong, what fixed looks like.

**Phase 4 — One fix round.** `SendMessage` to the **original implementation agent ID** (context
intact), never a new `Agent` call. Skip agents with zero findings.

**Phase 5 — Review 2.** Re-diff only the changed hunks; re-run the focused tests. Check whether the
issue was fixed or the symptom silenced (test loosened, error swallowed). **Exactly one feedback
round** — remaining small correctness issues the orchestrator patches directly; large ones are
reported to the user. Style nits at Review 2 are non-blocking.

**Phase 6 — Integrate.** Only reviewed commits enter `feat/wa-v2-workflow`. Report per task:
worktree location, diff summary, test output, and anything patched at Review 2. Ask whether
worktrees should be kept or cleaned up. **No push, no merge into the Codex lane, no deploy.**

---

## Verification

Run from `infra/` on the integrated branch after all three tasks merge:

```bash
cd infra
npm run build
npx jest test/unit/lambda/whatsapp/lib/conversation-router.test.ts \
         test/unit/lambda/whatsapp/lib/onboarding-language.test.ts \
         test/unit/lambda/whatsapp/lib/templates.test.ts \
         test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand
npx jest test/unit/lambda/whatsapp --runInBand
```

Expected: build clean; the four focused suites pass; **the entire `test/unit/lambda/whatsapp` tree
passes**, legacy suites included — `processor.test.ts`, `onboarding-conversation.test.ts`,
`job-alert.test.ts`, `webhook.test.ts`, `status-callback.test.ts`, `custom-trust-handler.test.ts`,
`profile-flow.test.ts`, `ai-profile-writer.test.ts`, and all of `lib/`. A legacy failure is a
blocking defect — fix the change, never the legacy test.

Then confirm no C2/C4 symbol leaked into the lane:

```bash
cd infra
grep -rnE "WorkflowStepKey|MessageCategory|DeliveryDecision|PreAuthState|CategoryRenderer|ReleaseRenderer|enqueueWorkerMessage|advanceWorkflow|loadRuntimeControls|isV2Enabled" \
  lambda/whatsapp/lib/onboarding-language.ts \
  lambda/whatsapp/lib/templates.ts \
  lambda/whatsapp/lib/interactive-templates.ts \
  lambda/whatsapp/lib/conversation-router.ts
```

Expected: **no output**. Any hit means a gated symbol was invented locally.

Do **not** run `cdk synth`, `cdk diff`, repo-wide `npm test`, or the PostgreSQL migration testbed —
Codex C10 owns the deployment gate, and migration `042` is not on this branch.

**Manual confirmation of the Manuel fix** (read-only, no deploy): the invariant is unit-level. The
end-to-end conversation confirmation belongs to the gated harness task, which needs C4 fakes.

---

## Resuming the Gated Phase

When Codex reports C2–C4 merged, before dispatching any gated task:

1. Re-verify the barrier: the five canonical files present, migration `042` present, the
   PostgreSQL `042` gate green, `npm run build` clean.
2. Run the canonical plan's **barrier confirmation step** — grep the real exported names and
   signatures out of the merged files and diff them against the canonical plan's "Canonical
   Imports" table. Any mismatch is a cross-lane interface change: stop and get both orchestrators
   to sign off. Do not adapt by re-declaring locally.
3. Resume canonical Tasks 2–7 unchanged, with these three already merged: canonical Task 3's
   language and copy work is **done**, so that task reduces to `onboarding-renderers.ts` +
   `registerOnboardingRenderers()` + `createReleaseRenderer()`. Canonical Task 1 is **done** in
   full.

---

## Self-Review

**Coverage against the agreed split.** The user's "can begin immediately" list has four entries:
pre-OTP relay fix + Manuel regression → Task 1; pure language-selection logic → Task 2; bilingual
templates and interactive copy → Task 3; deterministic tests that do not import the missing
contracts → each task's suite, all of which mock nothing from C2/C4. The four "truly needs C2–C4"
entries — repository-backed adapters, router state transitions, processor integration, renderer
registration — appear only in the Deferred table and are explicitly forbidden in the Global
Constraints.

**Placeholder scan.** No TBD, no "add appropriate error handling", no "similar to Task N". Every
code step carries the actual code. Every command names its expected red or green result including
the failing error text.

**Type consistency.** `Lang` is used identically across Tasks 2 and 3 and imported from
`./templates` in both. `InteractivePrompt` matches `interactive-templates.ts:8-12` exactly
(`templateName` / `variables` / `fallbackBody`). `StartCooldownResult.reason` uses the same three
literals in the test, the implementation, and the Interfaces block. The v2 `TemplateKey` list in
Task 3's test `V2_KEYS` array matches the union additions one-for-one, 18 members each.

**Delegation verified.** Task 2's `detectCommandLang` delegates to `flows.ts:440
detectCommandLanguage`, which resolves through `EN_LANG_WORDS` (`flows.ts:423`) and `ES_LANG_WORDS`
(`flows.ts:427`). Both sets were read during planning: `'help'` is in the EN set and `'ayuda'` in
the ES set, so `resolveResponseLanguage('es','HELP',false) === 'en'` and
`('en','AYUDA',false) === 'es'` hold without any local word list. `'Juan Perez'` returns `null`
(token `juan` is in neither set, and `matchCommandFuzzy` rejects strings containing whitespace), so
free text correctly falls back to the preferred language.

**Red-phase expectations verified.** `jest.config.js` declares a bare `'ts-jest'` transform with no
`diagnostics: false` and no `isolatedModules`, and `tsconfig.json` sets `strict: true` — so ts-jest
type-checks and every red phase in this plan is a **compile** failure (TS2307 / TS2322 / TS2305),
never a runtime `TypeError`. The expected-output strings in Tasks 2 and 3 reflect that.
