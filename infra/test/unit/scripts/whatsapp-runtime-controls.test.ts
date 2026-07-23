import { createHash } from 'node:crypto';

import {
  parseControlsArgs,
  runControlsAction,
  type Queryable,
} from '../../../scripts/whatsapp-runtime-controls';

const PHONE = '+19152272188';

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.trim()).digest('hex');
}

function makeFakeClient(): {
  client: Queryable;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/^\s*SELECT control_key/.test(text)) {
        return {
          rows: [
            {
              control_key: 'deferred_delivery_enabled',
              enabled: false,
              global_enabled: false,
              phone_hashes: [],
            },
            {
              control_key: 'onboarding_v2_enabled',
              enabled: true,
              global_enabled: false,
              phone_hashes: [hashPhone(PHONE)],
            },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

describe('parseControlsArgs', () => {
  it('accepts --show', () => {
    expect(parseControlsArgs(['--show'])).toEqual({ ok: true, value: { kind: 'show' } });
  });

  it('accepts --enable onboarding_v2', () => {
    expect(parseControlsArgs(['--enable', 'onboarding_v2'])).toEqual({
      ok: true,
      value: { kind: 'enable', controlKey: 'onboarding_v2_enabled' },
    });
  });

  it('accepts --disable deferred_delivery', () => {
    expect(parseControlsArgs(['--disable', 'deferred_delivery'])).toEqual({
      ok: true,
      value: { kind: 'disable', controlKey: 'deferred_delivery_enabled' },
    });
  });

  it('accepts --allow-phone <e164>', () => {
    const result = parseControlsArgs(['--allow-phone', PHONE]);
    expect(result).toEqual({ ok: true, value: { kind: 'allow-phone', phone: PHONE } });
  });

  it('accepts --deny-phone <e164>', () => {
    const result = parseControlsArgs(['--deny-phone', PHONE]);
    expect(result).toEqual({ ok: true, value: { kind: 'deny-phone', phone: PHONE } });
  });

  it('accepts --go-global', () => {
    expect(parseControlsArgs(['--go-global'])).toEqual({ ok: true, value: { kind: 'go-global' } });
  });

  it('rejects an unknown control name for --enable', () => {
    const result = parseControlsArgs(['--enable', 'not_a_real_control']);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown control name for --disable', () => {
    const result = parseControlsArgs(['--disable', 'bogus']);
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    const result = parseControlsArgs(['--nuke-everything']);
    expect(result.ok).toBe(false);
  });

  it('never echoes a misplaced bare (non `--`) value in the error message, even if it is phone-shaped', () => {
    const result = parseControlsArgs([PHONE]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(PHONE);
      expect(result.error).toBe('Unrecognized argument (redacted)');
    }
  });

  it('never echoes a phone-shaped value passed as an unknown control name', () => {
    const result = parseControlsArgs(['--enable', PHONE]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(PHONE);
      expect(result.error).toBe('Unknown control name (must be onboarding_v2 or deferred_delivery)');
    }
  });

  it('rejects no flags at all', () => {
    const result = parseControlsArgs([]);
    expect(result.ok).toBe(false);
  });

  it('rejects --enable with no value', () => {
    const result = parseControlsArgs(['--enable']);
    expect(result.ok).toBe(false);
  });
});

describe('runControlsAction', () => {
  it('--show prints hashes only (no raw phone) and prints no other table', async () => {
    const { client } = makeFakeClient();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const rows = await runControlsAction(client, { kind: 'show' }, 'test-operator');
      expect(Array.isArray(rows)).toBe(true);
      const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).not.toContain(PHONE);
      expect(printed).toContain(hashPhone(PHONE));
      // No other table name should appear in --show output.
      expect(printed).not.toMatch(/\busers\b/);
      expect(printed).not.toMatch(/\bworker_profiles\b/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('--show issues only a SELECT (no mutation)', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'show' }, 'test-operator');
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
  });

  it('--allow-phone writes only the SHA-256 hash via hashNormalizedPhone into phone_hashes, scoped to onboarding_v2_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'allow-phone', phone: PHONE }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('phone_hashes');
    expect(update!.text).toContain("control_key = 'onboarding_v2_enabled'");
    expect(update!.values).toContain(hashPhone(PHONE));
    expect(update!.values).not.toContain(PHONE);
  });

  it('--deny-phone removes only the SHA-256 hash from phone_hashes, scoped to onboarding_v2_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'deny-phone', phone: PHONE }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('array_remove');
    expect(update!.text).toContain("control_key = 'onboarding_v2_enabled'");
    expect(update!.values).toContain(hashPhone(PHONE));
    expect(update!.values).not.toContain(PHONE);
  });

  it('--enable deferred_delivery touches only that row (deferred_delivery_enabled)', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain('deferred_delivery_enabled');
    expect(update!.values).not.toContain('onboarding_v2_enabled');
  });

  it('--go-global sets global_enabled = true scoped to onboarding_v2_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'go-global' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('global_enabled = true');
    expect(update!.text).toContain("control_key = 'onboarding_v2_enabled'");
  });

  it('sets updated_by to the operator identity on any mutation', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'go-global' }, 'operator-luis');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update!.values).toContain('operator-luis');
  });
});
