/**
 * Shared Bedrock (Nova Lite) model id and IAM resource ARNs.
 *
 * Extracted from AiStack, which originally declared `BEDROCK_MODEL_ID` and a
 * private `bedrockArns()` function inline (see git history). ApiStack's
 * employer-generate-description Lambda (T-A1) also needs to grant
 * `bedrock:InvokeModel` scoped to this exact ARN set, and importing the same
 * function/constant from one module -- rather than copy-pasting the ARN
 * list into a second stack -- means the two stacks' grants cannot drift
 * apart if the model or region ARN shape ever changes.
 *
 * AiStack imports both `BEDROCK_MODEL_ID` and `bedrockArns` back from here;
 * its own IAM statements are unchanged byte-for-byte (see ai-stack.test.ts's
 * pinned-ARN assertion and the before/after template diff in the T-A1 PR).
 */
export const BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';

export function bedrockArns(region: string, account: string): string[] {
  return [
    `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_MODEL_ID}`,
    'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
    `arn:aws:bedrock:${region}::foundation-model/amazon.nova-lite-v1:0`,
    'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0',
  ];
}
