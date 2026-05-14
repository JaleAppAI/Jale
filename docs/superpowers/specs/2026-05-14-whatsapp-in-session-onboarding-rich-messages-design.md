# WhatsApp In-Session Onboarding Rich Messages Design

**Date:** 2026-05-14
**Status:** Approved for planning
**Scope:** Worker WhatsApp sign-on and onboarding UX

## Context

The current WhatsApp onboarding flow asks workers to type many short answers even when the answer space is fixed. The existing state machine already models several prompts as button-like fields and parses numeric replies, but most prompts are sent as plain text. This creates unnecessary typing during sign-on.

Twilio supports richer WhatsApp content inside the 24-hour user-initiated session. Since onboarding starts after the worker sends "Hola" or "Hello", the sign-on flow can use in-session rich messages without submitting every onboarding prompt for WhatsApp approval.

Relevant Twilio constraints:

- `twilio/quick-reply` lets workers tap a reply. Twilio documents up to 10 quick replies generally, but in-session WhatsApp messages that do not require template approval allow only three buttons.
- `twilio/list-picker` supports a menu of up to 10 options, is available only inside the 24-hour session, and cannot be submitted for WhatsApp approval.
- Inbound rich replies may arrive with `ButtonPayload`, `ButtonText`, or `InteractiveData` depending on the rich content type.
- Business-initiated messages outside the 24-hour session still need approved WhatsApp templates.

Sources:

- https://www.twilio.com/docs/content/twilio-quick-reply
- https://www.twilio.com/docs/content/twiliolist-picker
- https://www.twilio.com/docs/content/content-types-overview
- https://www.twilio.com/docs/whatsapp/buttons
- https://www.twilio.com/docs/messaging/guides/webhook-request

## Goals

- Reduce worker typing during WhatsApp sign-on.
- Keep open-ended answers open-ended where they are genuinely needed.
- Preserve the existing typed numeric fallback, so workers can still reply with `1`, `2`, etc.
- Avoid unnecessary Meta approval work for prompts that happen inside an active WhatsApp session.
- Keep approved templates only for out-of-session messages such as job alerts, reminders, and re-engagement.

## Non-Goals

- Do not replace OTP entry with buttons.
- Do not redesign the job-alert template system.
- Do not remove plain-text fallbacks.
- Do not introduce WhatsApp Flows in this iteration.

## Recommended Approach

Use a hybrid of in-session list pickers, in-session quick replies, and existing plain text.

List pickers should be used when a prompt has four or more options. They keep the chat compact and avoid long numbered menus.

Quick replies should be used when a prompt has two or three options. They are faster than opening a list and match the small decision points in onboarding.

Plain text/media prompts should remain where the worker must type or upload something.

## Prompt Mapping

| Current prompt | Current input | New rich content | Rationale |
|---|---:|---|---|
| `legal_prompt` | Accept/decline text | Quick reply: Accept, Decline | High-friction legal step; two clear choices. |
| `ask_name` | Text | Plain text | Full name is open-ended. |
| `ask_city` | Text | Plain text | City or zip is open-ended. |
| `ask_trade` | 6 numbered choices | List picker | Six options fit the list picker well. |
| `ask_trade_freetext` | Text | Plain text | Only used after Other. |
| `ask_experience` | 4 numbered choices | List picker | Four options exceed the safest quick-reply shape. |
| `ask_transportation` | 2 numbered choices | Quick reply: Yes, No | Two clear choices. |
| `ask_availability` | 4 numbered choices | List picker | Four options fit the list picker better than quick replies. |
| `ask_media_photo` | Photo or Skip text | Quick reply for Skip plus media support | Worker can upload a photo or tap Skip. |
| `ask_media_photo_type` | 2 numbered choices | Quick reply: Profile photo, Work sample | Two clear choices. |
| `ask_media_voice` | Voice or text choice | Quick reply: Answer by text, plus voice support | Keep voice upload open while reducing typing for text path. |
| Known-trade trust questions | 3 numbered choices | Quick replies | Each known-trade question has three options. |
| Custom trust questions | Text | Plain text | Open-ended AI-generated questions. |
| `profile_complete` | Command text hints | Quick replies optional: Jobs, Help | Useful follow-up, but not required for sign-on completion. |
| `help_menu` | Commands text | List picker or plain text | Can be upgraded later; not core sign-on. |

## Rich Reply Payloads

Every rich option should use stable payload IDs that map to the existing canonical values.

Examples:

| Field | Visible label | Payload |
|---|---|---|
| Legal | Accept | `legal:accept` |
| Legal | Decline | `legal:decline` |
| Trade | Electrician | `profile:main_trade:electrician` |
| Trade | Other | `profile:main_trade:other` |
| Experience | 2-4 years | `profile:years_experience:2-4` |
| Transportation | Yes | `profile:has_transportation:true` |
| Availability | Flexible | `profile:availability:flexible` |
| Photo type | Work sample | `media:photo_type:work_sample` |
| Voice/text | Answer by text | `media:voice_choice:text` |
| Trust | Option 1 | `trust:0:0` |

The parser should accept both rich payloads and the existing typed values. For example, `profile:main_trade:electrician` and `1` should both resolve to `electrician` when `pending_field` is `main_trade`.

## Message Construction

Add a small WhatsApp rich content helper rather than hand-building Content API payloads in `processor.ts`.

Suggested module:

- `infra/lambda/whatsapp/lib/interactive-templates.ts`

Responsibilities:

- Build in-session quick-reply content names and variables.
- Build in-session list-picker content names and item variables.
- Map each `ProfileField` and trust step to an interactive prompt definition.
- Provide a plain-text fallback body for every prompt.

Suggested outbox extension:

- Reuse the existing `whatsapp_outbox.content_template` and `content_variables` columns.
- Add enough metadata to distinguish approved templates from in-session-only content if needed, such as `content_mode = 'approved_template' | 'in_session_content'`.
- If adding a DB column is too much for the first pass, store in-session content names in the same secret-backed template map but mark them clearly in code as unapproved session templates.

## Inbound Parsing

Extend inbound message parsing to capture:

- `ButtonPayload`
- `ButtonText`
- `InteractiveData`
- optionally `ChannelMetadata` if Twilio list picker responses need fallback extraction

Parsing should be state-aware:

- In `awaiting_legal`, map `legal:accept` and `legal:decline` before falling back to `isAccept` and `isDecline`.
- In `building_profile`, map `profile:<field>:<value>` only when `<field>` matches `state_context.pending_field`.
- In `building_trust_signal`, map `trust:<step>:<optionIndex>` only when `<step>` matches `state_context.trust_step`.
- In media states, map media payloads without blocking actual media uploads.

Invalid or stale payloads should re-prompt the current question using the same rich content where possible.

## Fallback Behavior

Plain text remains first-class:

- Workers can type numbers exactly as they do today.
- Workers can type accepted words like "Acepto", "Accept", "Skip", "Saltar", "Texto", or "Text".
- If Twilio rich content fails to send, the outbox should fall back to the existing plain-text prompt rather than leaving the worker stuck.
- If a WhatsApp client does not render the rich message as expected, the fallback body should still show enough information for typed replies.

## Template Inventory

Approved out-of-session templates remain:

- `job_alert_es`
- `job_alert_en`
- `profile_reminder_es`
- `profile_reminder_en`
- `welcome_es`
- `welcome_en`

New in-session content templates:

- `onboarding_legal_es`, `onboarding_legal_en` - quick reply
- `onboarding_trade_es`, `onboarding_trade_en` - list picker
- `onboarding_experience_es`, `onboarding_experience_en` - list picker
- `onboarding_transportation_es`, `onboarding_transportation_en` - quick reply
- `onboarding_availability_es`, `onboarding_availability_en` - list picker
- `onboarding_photo_skip_es`, `onboarding_photo_skip_en` - quick reply
- `onboarding_photo_type_es`, `onboarding_photo_type_en` - quick reply
- `onboarding_voice_choice_es`, `onboarding_voice_choice_en` - quick reply
- `trust_choice_es`, `trust_choice_en` - quick reply, parameterized by question and option labels

If Twilio requires static list items in a content template, create one content template per static option set. Trust questions can use quick replies because each known-trade trust prompt has three options.

## Testing

Unit tests should cover:

- Prompt selection chooses list picker vs quick reply vs plain text.
- Rich payloads parse to the same canonical values as current numeric replies.
- Stale field payloads are rejected.
- Typed numeric replies still work.
- Invalid answers re-prompt with the rich prompt.
- Media states still accept uploads even when quick replies are present.
- Outbox falls back to plain text on missing in-session content SID or unsupported content type.

Manual smoke test:

1. Start onboarding with `Hola`.
2. Enter OTP.
3. Tap Accept on legal.
4. Use list picker for trade.
5. Type a custom profession after selecting Other.
6. Use list picker for experience.
7. Tap transportation.
8. Use list picker for availability.
9. Skip photo with button.
10. Choose text profile path with button.
11. Complete known-trade trust questions with buttons.
12. Confirm `Jobs` still returns job alert templates with action buttons.

## Rollout

1. Add parsing support for rich payloads while still sending plain text.
2. Create in-session content templates in Twilio.
3. Store their Content SIDs separately from approved out-of-session templates.
4. Switch one low-risk prompt first, preferably transportation.
5. Switch the remaining prompts once inbound payload shape is confirmed in Twilio logs.
6. Keep plain-text fallback permanently.

## Open Decisions

- Whether to add a dedicated `content_mode` column to `whatsapp_outbox` or encode session-only content through naming and configuration.
- Whether `profile_complete` should offer quick replies for Jobs and Help in the first implementation.
- Whether known-trade trust questions should use quick replies only, or list picker for visual consistency.

## Self-Review

- Placeholder scan: no unfinished markers remain.
- Scope check: focused on WhatsApp sign-on and onboarding only.
- Ambiguity check: out-of-session templates and in-session content are explicitly separated.
- Fallback check: every rich prompt keeps typed-answer behavior.
