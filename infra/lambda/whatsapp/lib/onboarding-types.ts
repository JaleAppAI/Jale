import type { PoolClient } from 'pg';

export type WorkerLifecycle = 'onboarding' | 'ready' | 'suspended';

export type WorkflowStepKey =
  | 'start.choose_language'
  | 'identity.verify_otp'
  | 'legal.review'
  | 'profile.voice_choice'
  | 'profile.voice_processing'
  | 'profile.name'
  | 'profile.location'
  | 'profile.trade'
  | 'profile.custom_trade'
  | 'profile.experience'
  | 'profile.transportation'
  | 'profile.availability'
  | 'trust.question.1'
  | 'trust.question.2'
  | 'trust.question.3'
  | 'profile.photo'
  | 'profile.photo_type';

export type WorkflowRunStatus =
  | 'active'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'failed';

export type MessageCategory =
  | 'onboarding'
  | 'security'
  | 'account'
  | 'job_alert'
  | 'employer_chat';

export type OwnerService =
  | 'onboarding-v2'
  | 'identity'
  | 'job-alert'
  | 'job-messaging'
  | 'account';

export type IntentStatus =
  | 'deferred'
  | 'eligible'
  | 'leased'
  | 'released'
  | 'delivered'
  | 'expired'
  | 'superseded'
  | 'rejected'
  | 'failed';

export type PreferredLanguage = 'en' | 'es';

export const DELIVERY_POLICY_VERSION = 1;

export type DeliveryDecision =
  | {
      action: 'allow';
      reason: 'workflow_message' | 'security_message' | 'worker_ready';
    }
  | {
      action: 'defer';
      reason: 'worker_onboarding' | 'delivery_disabled';
    }
  | {
      action: 'reject';
      reason: 'worker_suspended' | 'invalid_owner';
    }
  | { action: 'expire'; reason: 'intent_expired' };

export interface WorkerMessageIntentInput {
  workerId: string;
  category: MessageCategory;
  ownerService: OwnerService;
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  priority: number;
  expiresAt: Date | null;
  payload: Record<string, unknown>;
}

export type DomainEventType = 'assessment.requested' | 'worker.ready';

/** Shared renderer contracts consumed by both lanes. */
export type ReleaseRenderRequest =
  | {
      kind: 'onboarding_complete';
      workerId: string;
      language: PreferredLanguage;
    }
  | {
      kind: 'account_notice';
      workerId: string;
      language: PreferredLanguage;
      sourceType: string;
      sourceId: string;
      /**
       * The intent's stored payload (sprint 23). Without it a deferred
       * `account` intent released at worker.ready could only ever produce the
       * generic "Account update (<sourceType>)" line -- so an application
       * stage change that arrived while the worker was still onboarding lost
       * its real copy, its buttons, and its link. Optional/nullable: intents
       * queued before this field existed carry no payload and still render
       * the generic notice.
       */
      payload?: Record<string, unknown> | null;
    }
  | {
      /**
       * The job a worker was referred to, sent right after the welcome. Job
       * referrals, migration 056.
       */
      kind: 'referred_job';
      workerId: string;
      language: PreferredLanguage;
      /**
       * False when the claim carries no referrer — the visitor reached the
       * public job page with no share tag and tapped Apply themselves. The copy
       * must not claim a friend referred them when nobody did.
       */
      referred: boolean;
      /**
       * null when the referred job is no longer accepting applications. A
       * worker may take days to finish onboarding, so this is resolved at send
       * time rather than when the referral was claimed.
       */
      job: {
        jobId: string;
        title: string;
        companyName: string;
        location: string | null;
        /** Legacy free-text `jobs.pay`, RAW -- not pre-coalesced to an
         * English placeholder. Used only when payMin/payMax are both null
         * (Task 4, WhatsApp pay localization). */
        pay: string | null;
        payMin?: number | null;
        payMax?: number | null;
        payInterval?: string | null;
      } | null;
    }
  | {
      kind: 'job_alert_digest';
      workerId: string;
      language: PreferredLanguage;
      jobs: ReadonlyArray<{
        jobId: string;
        title: string;
        companyName: string;
        score: number;
        /** Additive (Task 4, WhatsApp pay localization). */
        location?: string | null;
        pay?: string | null;
        payMin?: number | null;
        payMax?: number | null;
        payInterval?: string | null;
      }>;
    }
  | {
      kind: 'employer_chat_single';
      workerId: string;
      language: PreferredLanguage;
      conversationId: string;
      companyName: string;
      jobTitle: string;
    }
  | {
      kind: 'employer_chat_summary';
      workerId: string;
      language: PreferredLanguage;
      conversationCount: number;
    };

export interface ReleaseRenderedMessage {
  body: string | null;
  contentTemplate: string | null;
  contentVariables: Record<string, string> | null;
}

export interface ReleaseRenderer {
  render(request: ReleaseRenderRequest): Promise<ReleaseRenderedMessage>;
}

export interface RenderedOutboxMessage {
  whatsappNumber: string;
  body: string | null;
  contentTemplate: string | null;
  contentVariables: Record<string, string> | null;
}

export type CategoryRenderer = (
  client: PoolClient,
  input: WorkerMessageIntentInput,
) => Promise<RenderedOutboxMessage | null>;
