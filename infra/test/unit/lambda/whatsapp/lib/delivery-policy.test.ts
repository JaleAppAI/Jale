import type { DeliveryEvaluationInput } from '../../../../../lambda/whatsapp/lib/delivery-policy';
import { evaluateDelivery } from '../../../../../lambda/whatsapp/lib/delivery-policy';
import type { DeliveryDecision } from '../../../../../lambda/whatsapp/lib/onboarding-types';
import type { RuntimeControls } from '../../../../../lambda/whatsapp/lib/runtime-controls';

const NOW = new Date('2026-07-21T12:00:00.000Z');

const enabledControls: RuntimeControls = {
  onboardingV2Enabled: true,
  onboardingV2GlobalEnabled: false,
  onboardingV2PhoneHashes: new Set(),
  deferredDeliveryEnabled: true,
  voiceIntakeEnabled: false,
  voiceIntakeGlobalEnabled: false,
  voiceIntakePhoneHashes: new Set(),
};

const baseInput: DeliveryEvaluationInput = {
  lifecycle: 'ready',
  category: 'job_alert',
  ownerService: 'job-alert',
  controls: enabledControls,
  expiresAt: null,
};

describe('WhatsApp worker delivery policy', () => {
  it.each<{
    name: string;
    input: Partial<DeliveryEvaluationInput>;
    expected: DeliveryDecision;
  }>([
    {
      name: 'expires an intent before evaluating lifecycle',
      input: { expiresAt: new Date(NOW) },
      expected: { action: 'expire', reason: 'intent_expired' },
    },
    {
      name: 'rejects an onboarding message from the wrong owner',
      input: { category: 'onboarding', ownerService: 'job-alert' },
      expected: { action: 'reject', reason: 'invalid_owner' },
    },
    {
      name: 'rejects a security message from the wrong owner',
      input: { category: 'security', ownerService: 'account' },
      expected: { action: 'reject', reason: 'invalid_owner' },
    },
    {
      name: 'allows an onboarding message from the workflow owner',
      input: {
        lifecycle: 'suspended',
        category: 'onboarding',
        ownerService: 'onboarding-v2',
        controls: { ...enabledControls, deferredDeliveryEnabled: false },
      },
      expected: { action: 'allow', reason: 'workflow_message' },
    },
    {
      name: 'allows a security message from the identity owner',
      input: {
        lifecycle: 'suspended',
        category: 'security',
        ownerService: 'identity',
        controls: { ...enabledControls, deferredDeliveryEnabled: false },
      },
      expected: { action: 'allow', reason: 'security_message' },
    },
    {
      name: 'rejects business delivery for a suspended worker',
      input: { lifecycle: 'suspended' },
      expected: { action: 'reject', reason: 'worker_suspended' },
    },
    {
      name: 'defers business delivery during onboarding',
      input: { lifecycle: 'onboarding' },
      expected: { action: 'defer', reason: 'worker_onboarding' },
    },
    {
      name: 'defers ready-worker delivery while the delivery control is disabled',
      input: {
        controls: { ...enabledControls, deferredDeliveryEnabled: false },
      },
      expected: { action: 'defer', reason: 'delivery_disabled' },
    },
    {
      name: 'allows ready-worker delivery while the delivery control is enabled',
      input: {},
      expected: { action: 'allow', reason: 'worker_ready' },
    },
  ])('$name', ({ input, expected }) => {
    expect(evaluateDelivery({ ...baseInput, ...input }, NOW)).toEqual(expected);
  });

  it('expires a ready job alert even when business delivery is enabled', () => {
    expect(evaluateDelivery({
      ...baseInput,
      expiresAt: new Date(NOW.getTime() - 1),
    }, NOW)).toEqual({ action: 'expire', reason: 'intent_expired' });
  });

  it('does not let a focused employer conversation bypass onboarding', () => {
    expect(evaluateDelivery({
      ...baseInput,
      lifecycle: 'onboarding',
      category: 'employer_chat',
      ownerService: 'job-messaging',
      hasFocusedConversation: true,
    }, NOW)).toEqual({ action: 'defer', reason: 'worker_onboarding' });
  });
});
