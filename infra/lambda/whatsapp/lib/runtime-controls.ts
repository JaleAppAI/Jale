import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

export interface RuntimeControls {
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

// Shape check for voice_intake_enabled rows: an allowlist-and-global-flag
// control keyed by phone hash.
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
      'deferred_delivery_enabled',
      'voice_intake_enabled',
    ]],
  );

  const deferredRow = result.rows.find(
    (row) => row.control_key === 'deferred_delivery_enabled',
  );
  const voiceIntakeRow = result.rows.find(
    (row) => row.control_key === 'voice_intake_enabled',
  );

  if (!deferredRow && !voiceIntakeRow) {
    return DISABLED_CONTROLS;
  }

  const validVoiceIntakeRow = isValidPhoneScopedControlRow(voiceIntakeRow);

  return {
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
