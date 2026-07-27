import type { PoolClient } from 'pg';

import {
  hashNormalizedPhone,
  isDeferredDeliveryEnabled,
  isV2Enabled,
  isVoiceIntakeEnabled,
  loadRuntimeControls,
} from '../../../../../lambda/whatsapp/lib/runtime-controls';

function clientReturning(rows: unknown[]): PoolClient {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as PoolClient;
}

describe('WhatsApp v2 runtime controls', () => {
  it('fails closed when control rows are absent', async () => {
    const controls = await loadRuntimeControls(clientReturning([]));

    expect(controls).toEqual({
      onboardingV2Enabled: false,
      onboardingV2GlobalEnabled: false,
      onboardingV2PhoneHashes: new Set(),
      deferredDeliveryEnabled: false,
      voiceIntakeEnabled: false,
      voiceIntakeGlobalEnabled: false,
      voiceIntakePhoneHashes: new Set(),
    });
    expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(false);
    expect(isDeferredDeliveryEnabled(controls)).toBe(false);
    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
  });

  it.each([null, 'true', 1])(
    'fails closed when a control enabled value is malformed: %p',
    async (enabled) => {
      const controls = await loadRuntimeControls(clientReturning([
        {
          control_key: 'onboarding_v2_enabled',
          enabled,
          phone_hashes: ['a'.repeat(64)],
          global_enabled: true,
        },
        {
          control_key: 'deferred_delivery_enabled',
          enabled,
          phone_hashes: [],
          global_enabled: false,
        },
        {
          control_key: 'voice_intake_enabled',
          enabled,
          phone_hashes: ['a'.repeat(64)],
          global_enabled: true,
        },
      ]));

      expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(false);
      expect(isDeferredDeliveryEnabled(controls)).toBe(false);
      expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
    },
  );

  it.each([undefined, 'true', 1, { hashes: [] }])(
    'fails closed for voice_intake_enabled when phone_hashes is malformed: %p',
    async (phoneHashes) => {
      const controls = await loadRuntimeControls(clientReturning([
        {
          control_key: 'voice_intake_enabled',
          enabled: true,
          phone_hashes: phoneHashes,
          global_enabled: false,
        },
      ]));

      expect(controls.voiceIntakeEnabled).toBe(false);
      expect(controls.voiceIntakeGlobalEnabled).toBe(false);
      expect(controls.voiceIntakePhoneHashes.size).toBe(0);
      expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
    },
  );

  it('fails closed for voice_intake_enabled when the row is absent entirely', async () => {
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'onboarding_v2_enabled',
        enabled: true,
        phone_hashes: [],
        global_enabled: true,
      },
    ]));

    expect(controls.voiceIntakeEnabled).toBe(false);
    expect(controls.voiceIntakeGlobalEnabled).toBe(false);
    expect(controls.voiceIntakePhoneHashes.size).toBe(0);
    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
    // Sibling controls stay unaffected by the missing voice_intake row.
    expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(true);
  });

  it('enables voice intake only for an exact hash in the allowlist', async () => {
    const allowedHash = 'a'.repeat(64);
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'voice_intake_enabled',
        enabled: true,
        phone_hashes: [allowedHash],
        global_enabled: false,
      },
    ]));

    expect(isVoiceIntakeEnabled(controls, allowedHash)).toBe(true);
    expect(isVoiceIntakeEnabled(controls, 'b'.repeat(64))).toBe(false);
  });

  it('enables voice intake for any hash when the global flag is enabled', async () => {
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'voice_intake_enabled',
        enabled: true,
        phone_hashes: [],
        global_enabled: true,
      },
    ]));

    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(true);
    expect(isVoiceIntakeEnabled(controls, 'b'.repeat(64))).toBe(true);
  });

  it('does not enable voice intake when enabled=true but neither global nor allowlisted', async () => {
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'voice_intake_enabled',
        enabled: true,
        phone_hashes: ['b'.repeat(64)],
        global_enabled: false,
      },
    ]));

    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
  });

  it('keeps voice intake independent from onboarding v2 and deferred delivery controls', async () => {
    const phoneHash = 'a'.repeat(64);
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'onboarding_v2_enabled',
        enabled: false,
        phone_hashes: [],
        global_enabled: false,
      },
      {
        control_key: 'deferred_delivery_enabled',
        enabled: false,
        phone_hashes: [],
        global_enabled: false,
      },
      {
        control_key: 'voice_intake_enabled',
        enabled: true,
        phone_hashes: [phoneHash],
        global_enabled: false,
      },
    ]));

    expect(isV2Enabled(controls, phoneHash)).toBe(false);
    expect(isDeferredDeliveryEnabled(controls)).toBe(false);
    expect(isVoiceIntakeEnabled(controls, phoneHash)).toBe(true);
  });

  it('enables v2 only for an exact hash in the allowlist', async () => {
    const allowedHash = 'a'.repeat(64);
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'onboarding_v2_enabled',
        enabled: true,
        phone_hashes: [allowedHash],
        global_enabled: false,
      },
    ]));

    expect(isV2Enabled(controls, allowedHash)).toBe(true);
    expect(isV2Enabled(controls, 'b'.repeat(64))).toBe(false);
  });

  it('enables v2 for any hash when the global flag is enabled', async () => {
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'onboarding_v2_enabled',
        enabled: true,
        phone_hashes: [],
        global_enabled: true,
      },
    ]));

    expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(true);
    expect(isV2Enabled(controls, 'b'.repeat(64))).toBe(true);
  });

  it.each([
    { onboardingEnabled: true, deferredEnabled: false },
    { onboardingEnabled: false, deferredEnabled: true },
  ])(
    'keeps deferred delivery independent from onboarding controls: %p',
    async ({ onboardingEnabled, deferredEnabled }) => {
      const phoneHash = 'a'.repeat(64);
      const controls = await loadRuntimeControls(clientReturning([
        {
          control_key: 'onboarding_v2_enabled',
          enabled: onboardingEnabled,
          phone_hashes: [phoneHash],
          global_enabled: false,
        },
        {
          control_key: 'deferred_delivery_enabled',
          enabled: deferredEnabled,
          phone_hashes: [],
          global_enabled: false,
        },
      ]));

      expect(isV2Enabled(controls, phoneHash)).toBe(onboardingEnabled);
      expect(isDeferredDeliveryEnabled(controls)).toBe(deferredEnabled);
    },
  );

  it('hashes normalized phones deterministically without exposing the input', () => {
    const phone = '+15551234567';
    const first = hashNormalizedPhone(phone);
    const second = hashNormalizedPhone(phone);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toBe(hashNormalizedPhone('+15557654321'));
    expect(first).not.toContain('15551234567');
  });

  it('trims the normalized phone before hashing', () => {
    expect(hashNormalizedPhone('  +15551234567  ')).toBe(
      hashNormalizedPhone('+15551234567'),
    );
  });

  it('loads controls without placing a raw phone number in SQL', async () => {
    const client = clientReturning([]);

    await loadRuntimeControls(client);

    const query = client.query as jest.Mock;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain('+15551234567');
    expect(query.mock.calls[0][0]).toContain('whatsapp_runtime_controls');
  });
});
