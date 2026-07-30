import type { PoolClient } from 'pg';

import {
  hashNormalizedPhone,
  isDeferredDeliveryEnabled,
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
      deferredDeliveryEnabled: false,
      voiceIntakeEnabled: false,
      voiceIntakeGlobalEnabled: false,
      voiceIntakePhoneHashes: new Set(),
    });
    expect(isDeferredDeliveryEnabled(controls)).toBe(false);
    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
  });

  it.each([null, 'true', 1])(
    'fails closed when a control enabled value is malformed: %p',
    async (enabled) => {
      const controls = await loadRuntimeControls(clientReturning([
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
        control_key: 'deferred_delivery_enabled',
        enabled: true,
        phone_hashes: [],
        global_enabled: true,
      },
    ]));

    expect(controls.voiceIntakeEnabled).toBe(false);
    expect(controls.voiceIntakeGlobalEnabled).toBe(false);
    expect(controls.voiceIntakePhoneHashes.size).toBe(0);
    expect(isVoiceIntakeEnabled(controls, 'a'.repeat(64))).toBe(false);
    // Sibling control stays unaffected by the missing voice_intake row.
    expect(isDeferredDeliveryEnabled(controls)).toBe(true);
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

  it('keeps voice intake independent from deferred delivery control', async () => {
    const phoneHash = 'a'.repeat(64);
    const controls = await loadRuntimeControls(clientReturning([
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

    expect(isDeferredDeliveryEnabled(controls)).toBe(false);
    expect(isVoiceIntakeEnabled(controls, phoneHash)).toBe(true);
  });

  it.each([
    { voiceEnabled: true, deferredEnabled: false },
    { voiceEnabled: false, deferredEnabled: true },
  ])(
    'keeps deferred delivery independent from voice intake: %p',
    async ({ voiceEnabled, deferredEnabled }) => {
      const phoneHash = 'a'.repeat(64);
      const controls = await loadRuntimeControls(clientReturning([
        {
          control_key: 'voice_intake_enabled',
          enabled: voiceEnabled,
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

      expect(isVoiceIntakeEnabled(controls, phoneHash)).toBe(voiceEnabled);
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

  it('no longer queries for the retired onboarding_v2_enabled control key', async () => {
    const client = clientReturning([]);

    await loadRuntimeControls(client);

    const query = client.query as jest.Mock;
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([
      ['deferred_delivery_enabled', 'voice_intake_enabled'],
    ]);
    expect(params[0]).not.toContain('onboarding_v2_enabled');
  });

  it('ignores a lingering onboarding_v2_enabled row still present in the query result window', async () => {
    // The prod table keeps this row until migration 054 drops it. The
    // control_key = ANY($1) filter means it would never actually be
    // fetched once the key list is trimmed, but this pins that even if a
    // row for it somehow appeared in the result set, loadRuntimeControls
    // ignores it entirely rather than surfacing any onboarding-v2 field.
    const phoneHash = 'a'.repeat(64);
    const controls = await loadRuntimeControls(clientReturning([
      {
        control_key: 'onboarding_v2_enabled',
        enabled: true,
        phone_hashes: [phoneHash],
        global_enabled: true,
      },
      {
        control_key: 'deferred_delivery_enabled',
        enabled: true,
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

    expect(controls).toEqual({
      deferredDeliveryEnabled: true,
      voiceIntakeEnabled: true,
      voiceIntakeGlobalEnabled: false,
      voiceIntakePhoneHashes: new Set([phoneHash]),
    });
    expect(controls).not.toHaveProperty('onboardingV2Enabled');
    expect(controls).not.toHaveProperty('onboardingV2GlobalEnabled');
    expect(controls).not.toHaveProperty('onboardingV2PhoneHashes');
  });
});
