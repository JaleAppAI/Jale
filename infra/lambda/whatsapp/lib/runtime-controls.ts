import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

export interface RuntimeControls {
  onboardingV2Enabled: boolean;
  onboardingV2GlobalEnabled: boolean;
  onboardingV2PhoneHashes: ReadonlySet<string>;
  deferredDeliveryEnabled: boolean;
  voiceIntakeEnabled: boolean;
  voiceIntakeGlobalEnabled: boolean;
  voiceIntakePhoneHashes: ReadonlySet<string>;
}

interface RuntimeControlRow {
  control_key: unknown;
  enabled: unknown;
  phone_hashes: unknown;
  global_enabled: unknown;
}

const DISABLED_CONTROLS: RuntimeControls = {
  onboardingV2Enabled: false,
  onboardingV2GlobalEnabled: false,
  onboardingV2PhoneHashes: new Set<string>(),
  deferredDeliveryEnabled: false,
  voiceIntakeEnabled: false,
  voiceIntakeGlobalEnabled: false,
  voiceIntakePhoneHashes: new Set<string>(),
};

const PHONE_HASH_PATTERN = /^[0-9a-f]{64}$/;

type ValidPhoneScopedControlRow = RuntimeControlRow & {
  enabled: boolean;
  phone_hashes: string[];
  global_enabled: boolean;
};

// Shared shape check for both onboarding_v2_enabled and voice_intake_enabled
// rows: an allowlist-and-global-flag control keyed by phone hash.
function isValidPhoneScopedControlRow(
  row: RuntimeControlRow | undefined,
): row is ValidPhoneScopedControlRow {
  return (
    row !== undefined &&
    typeof row.enabled === 'boolean' &&
    typeof row.global_enabled === 'boolean' &&
    Array.isArray(row.phone_hashes) &&
    row.phone_hashes.every(
      (hash): hash is string =>
        typeof hash === 'string' && PHONE_HASH_PATTERN.test(hash),
    )
  );
}

/** Lowercase hex SHA-256 of the E.164-normalized phone. Never log the input. */
export function hashNormalizedPhone(phone: string): string {
  return createHash('sha256').update(phone.trim()).digest('hex');
}

/** Reads whatsapp_runtime_controls. Missing or malformed rows fail closed to disabled. */
export async function loadRuntimeControls(
  client: PoolClient,
): Promise<RuntimeControls> {
  const result = await client.query<RuntimeControlRow>(
    `SELECT control_key, enabled, phone_hashes, global_enabled
       FROM whatsapp_runtime_controls
      WHERE control_key = ANY($1::text[])`,
    [[
      'onboarding_v2_enabled',
      'deferred_delivery_enabled',
      'voice_intake_enabled',
    ]],
  );

  const onboardingRow = result.rows.find(
    (row) => row.control_key === 'onboarding_v2_enabled',
  );
  const deferredRow = result.rows.find(
    (row) => row.control_key === 'deferred_delivery_enabled',
  );
  const voiceIntakeRow = result.rows.find(
    (row) => row.control_key === 'voice_intake_enabled',
  );

  if (!onboardingRow && !deferredRow && !voiceIntakeRow) {
    return DISABLED_CONTROLS;
  }

  const validOnboardingRow = isValidPhoneScopedControlRow(onboardingRow);
  const validVoiceIntakeRow = isValidPhoneScopedControlRow(voiceIntakeRow);

  return {
    onboardingV2Enabled: validOnboardingRow
      ? onboardingRow.enabled
      : false,
    onboardingV2GlobalEnabled: validOnboardingRow
      ? onboardingRow.global_enabled
      : false,
    onboardingV2PhoneHashes: validOnboardingRow
      ? new Set(onboardingRow.phone_hashes)
      : new Set<string>(),
    deferredDeliveryEnabled:
      deferredRow !== undefined && typeof deferredRow.enabled === 'boolean'
        ? deferredRow.enabled
        : false,
    voiceIntakeEnabled: validVoiceIntakeRow
      ? voiceIntakeRow.enabled
      : false,
    voiceIntakeGlobalEnabled: validVoiceIntakeRow
      ? voiceIntakeRow.global_enabled
      : false,
    voiceIntakePhoneHashes: validVoiceIntakeRow
      ? new Set(voiceIntakeRow.phone_hashes)
      : new Set<string>(),
  };
}

export function isV2Enabled(
  controls: RuntimeControls,
  phoneHash: string,
): boolean {
  return (
    controls.onboardingV2Enabled &&
    (controls.onboardingV2GlobalEnabled ||
      controls.onboardingV2PhoneHashes.has(phoneHash))
  );
}

export function isDeferredDeliveryEnabled(
  controls: RuntimeControls,
): boolean {
  return controls.deferredDeliveryEnabled;
}

export function isVoiceIntakeEnabled(
  controls: RuntimeControls,
  phoneHash: string,
): boolean {
  return (
    controls.voiceIntakeEnabled &&
    (controls.voiceIntakeGlobalEnabled ||
      controls.voiceIntakePhoneHashes.has(phoneHash))
  );
}
