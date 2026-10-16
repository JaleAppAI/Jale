import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * The SES sender for a Cognito user pool, from the app-global CDK context the
 * deploy workflow passes on every synth, diff and deploy (`-c
 * sesEmailFromAddress=... -c sesEmailRegion=...`). Used by every pool that
 * sends through SES: the employer pool (AuthStack) and the admin pool
 * (AdminStack). When sesEmailFromAddress is absent the pool keeps Cognito's
 * default shared email service (COGNITO_DEFAULT); a present but malformed
 * value fails the synth instead of falling back.
 *
 * Operator pre-requisites before deploying SES config (NOT done by CDK):
 *   1. Verify SES domain identity for the sender domain (e.g. jaleapp.ai).
 *   2. Enable Easy DKIM in SES; add the 3 CNAME records in Squarespace DNS.
 *   3. Configure SES custom MAIL FROM (e.g. mail.jaleapp.ai); add MX + SPF
 *      TXT records in Squarespace DNS.
 *   4. Add/merge DMARC TXT at _dmarc.jaleapp.ai in Squarespace DNS.
 *   5. Add SES identity resource policy granting cognito-idp.amazonaws.com
 *      ses:SendEmail / ses:SendRawEmail, scoped to the user pool ARN (every
 *      pool that uses this sender).
 *   6. Request SES production access if the account is still sandboxed.
 *   7. Deploy the stack with the context vars.
 *   8. Test delivery to Gmail / Outlook; verify SPF/DKIM/DMARC pass.
 */
export function resolveCognitoSesEmail(scope: Construct): cognito.UserPoolEmail | undefined {
  const sesEmailFromAddress = scope.node.tryGetContext('sesEmailFromAddress') as string | undefined;
  const sesEmailFromName = (scope.node.tryGetContext('sesEmailFromName') as string | undefined) ?? 'Jale';
  const sesEmailRegion = scope.node.tryGetContext('sesEmailRegion') as string | undefined;
  // sesVerifiedDomain controls the SES identity referenced in SourceArn.
  // Defaults to the domain part of sesEmailFromAddress (e.g. 'jaleapp.ai'),
  // which matches domain-level SES identity verification (recommended over
  // email-address verification). Override via context if you use a subdomain
  // identity like 'mail.jaleapp.ai' with a from-address on 'jaleapp.ai'.
  const sesVerifiedDomain = (scope.node.tryGetContext('sesVerifiedDomain') as string | undefined)
    ?? sesEmailFromAddress?.split('@')[1];

  if (sesEmailFromAddress !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sesEmailFromAddress)) {
      throw new Error('sesEmailFromAddress must be a valid email address');
    }
    // SES + Cognito is only supported in specific regions. Require an
    // explicit sesEmailRegion so the SourceArn is unambiguous.
    const COGNITO_SES_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1'];
    if (!sesEmailRegion || !COGNITO_SES_REGIONS.includes(sesEmailRegion)) {
      throw new Error(
        `sesEmailRegion must be one of ${COGNITO_SES_REGIONS.join(', ')} when sesEmailFromAddress is set`,
      );
    }
  }

  return sesEmailFromAddress !== undefined
    ? cognito.UserPoolEmail.withSES({
        fromEmail: sesEmailFromAddress,
        fromName: sesEmailFromName,
        sesRegion: sesEmailRegion!,
        sesVerifiedDomain,
      })
    : undefined;
}
