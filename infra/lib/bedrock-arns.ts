/**
 * The ONE shared Bedrock model id and IAM resource ARN set for every
 * Bedrock-invoking Lambda in this app.
 *
 * ── Why one baseline ──────────────────────────────────────────────────────
 * This module started as AiStack's private `BEDROCK_MODEL_ID` + `bedrockArns()`
 * (see git history) and was extracted so ApiStack's employer-generate-
 * description Lambda could grant an identical, tightly scoped
 * `bedrock:InvokeModel` without copy-pasting the ARN list. The copy-paste it
 * was meant to prevent still happened twice, and both copies drifted:
 * MatchingStack kept its own `const bedrockModelId` plus an inline 4-ARN list,
 * and WhatsAppStack was upgraded to Claude Haiku 4.5 with inline literals. The
 * result was two model families running side by side -- WhatsApp on Haiku,
 * everything else still on the retired Nova Lite. Every caller now imports
 * from here, so a model change is one edit and cannot leave a stack behind.
 *
 * Callers: AiStack (question-generator, alias-generator, trust-scorer,
 * trust-extractor), ApiStack (employer-generate-description), MatchingStack
 * (employer-candidate-rerank), WhatsAppStack (the SQS processor's
 * application-fill extraction, and ai-profile-writer).
 *
 * ── The ARN-shape trap ────────────────────────────────────────────────────
 * The two ARN kinds take DIFFERENT forms of the id, and getting it wrong fails
 * closed at runtime as an AccessDenied that only surfaces under real traffic:
 *
 *   - inference-profile ARNs KEEP the `us.` cross-region routing prefix
 *     (`us.anthropic.claude-haiku-4-5-...`) -- that prefix is the profile.
 *   - foundation-model ARNs must NOT carry it
 *     (`anthropic.claude-haiku-4-5-...`); with a `us.` prefix they match
 *     nothing.
 *
 * A cross-region inference profile fans one InvokeModel call out to any of its
 * member regions, so the caller must also hold the underlying foundation model
 * in each region the profile can route to -- hence three foundation-model
 * entries alongside the single profile entry.
 */
export const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * `BEDROCK_MODEL_ID` minus the `us.` cross-region routing prefix -- the form
 * foundation-model ARNs require. Derived rather than written out a second time
 * so the two can never disagree.
 */
export const BEDROCK_FOUNDATION_MODEL_ID = BEDROCK_MODEL_ID.replace(/^us\./, '');

export function bedrockArns(region: string, account: string): string[] {
  return [
    `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_MODEL_ID}`,
    `arn:aws:bedrock:us-east-1::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
    `arn:aws:bedrock:${region}::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
    `arn:aws:bedrock:us-west-2::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
  ];
}
