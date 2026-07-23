import type { PoolClient } from 'pg';

import {
  hashNormalizedPhone,
  isDeferredDeliveryEnabled,
  isV2Enabled,
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
    });
    expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(false);
    expect(isDeferredDeliveryEnabled(controls)).toBe(false);
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
      ]));

      expect(isV2Enabled(controls, 'a'.repeat(64))).toBe(false);
      expect(isDeferredDeliveryEnabled(controls)).toBe(false);
    },
  );

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
