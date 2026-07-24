import type {
  DeliveryDecision,
  MessageCategory,
  OwnerService,
  WorkerLifecycle,
} from './onboarding-types';
import type { RuntimeControls } from './runtime-controls';

export interface DeliveryEvaluationInput {
  lifecycle: WorkerLifecycle;
  category: MessageCategory;
  ownerService: OwnerService;
  controls: RuntimeControls;
  expiresAt: Date | null;
  /** True when a job conversation is currently focused. Must not change the outcome. */
  hasFocusedConversation?: boolean;
}

export function evaluateDelivery(
  input: DeliveryEvaluationInput,
  now: Date,
): DeliveryDecision {
  if (input.expiresAt !== null && input.expiresAt <= now) {
    return { action: 'expire', reason: 'intent_expired' };
  }

  if (
    (input.category === 'onboarding' &&
      input.ownerService !== 'onboarding-v2') ||
    (input.category === 'security' && input.ownerService !== 'identity')
  ) {
    return { action: 'reject', reason: 'invalid_owner' };
  }

  if (input.category === 'onboarding') {
    return { action: 'allow', reason: 'workflow_message' };
  }

  if (input.category === 'security') {
    return { action: 'allow', reason: 'security_message' };
  }

  if (input.lifecycle === 'suspended') {
    return { action: 'reject', reason: 'worker_suspended' };
  }

  if (input.lifecycle === 'onboarding') {
    return { action: 'defer', reason: 'worker_onboarding' };
  }

  if (!input.controls.deferredDeliveryEnabled) {
    return { action: 'defer', reason: 'delivery_disabled' };
  }

  return { action: 'allow', reason: 'worker_ready' };
}
