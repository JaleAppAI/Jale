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

function makeFakeClient(opts: { eligibleSweepWorkerIds?: string[] } = {}): {
  client: Queryable;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const remainingSweepWorkerIds = [...(opts.eligibleSweepWorkerIds ?? [])];
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
              control_key: 'voice_intake_enabled',
              enabled: true,
              global_enabled: false,
              phone_hashes: [hashPhone(PHONE)],
            },
          ],
          rowCount: 2,
        };
      }
      // The sweep's eligible-workers SELECT (delivery-retrigger-sweep.ts).
      // Once "inserted" for a worker (mirrored below), stop returning it —
      // same convergence contract as the real NOT EXISTS guard.
      if (/SELECT DISTINCT s\.user_id/.test(text)) {
        const rows = remainingSweepWorkerIds.map((id) => ({ user_id: id }));
        return { rows, rowCount: rows.length };
      }
      if (/INSERT INTO worker_domain_outbox/.test(text)) {
        const workerId = values[0] as string;
        const idx = remainingSweepWorkerIds.indexOf(workerId);
        if (idx >= 0) remainingSweepWorkerIds.splice(idx, 1);
        return { rows: [], rowCount: 1 };
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

  it('accepts --disable deferred_delivery', () => {
    expect(parseControlsArgs(['--disable', 'deferred_delivery'])).toEqual({
      ok: true,
      value: { kind: 'disable', controlKey: 'deferred_delivery_enabled' },
    });
  });

  it('accepts --allow-phone <e164>', () => {
    const result = parseControlsArgs(['--allow-phone', PHONE]);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --deny-phone <e164>', () => {
    const result = parseControlsArgs(['--deny-phone', PHONE]);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'deny-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --go-global', () => {
    expect(parseControlsArgs(['--go-global'])).toEqual({
      ok: true,
      value: { kind: 'go-global', controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --enable voice_intake', () => {
    expect(parseControlsArgs(['--enable', 'voice_intake'])).toEqual({
      ok: true,
      value: { kind: 'enable', controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --disable voice_intake', () => {
    expect(parseControlsArgs(['--disable', 'voice_intake'])).toEqual({
      ok: true,
      value: { kind: 'disable', controlKey: 'voice_intake_enabled' },
    });
  });

  it('defaults --allow-phone to voice_intake_enabled when no --control is given', () => {
    expect(parseControlsArgs(['--allow-phone', PHONE])).toEqual({
      ok: true,
      value: { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --allow-phone <e164> --control voice_intake', () => {
    expect(parseControlsArgs(['--allow-phone', PHONE, '--control', 'voice_intake'])).toEqual({
      ok: true,
      value: { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --deny-phone <e164> --control voice_intake', () => {
    expect(parseControlsArgs(['--deny-phone', PHONE, '--control', 'voice_intake'])).toEqual({
      ok: true,
      value: { kind: 'deny-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
    });
  });

  it('accepts --go-global --control voice_intake', () => {
    expect(parseControlsArgs(['--go-global', '--control', 'voice_intake'])).toEqual({
      ok: true,
      value: { kind: 'go-global', controlKey: 'voice_intake_enabled' },
    });
  });

  it('rejects an unknown --control value without echoing it', () => {
    const result = parseControlsArgs(['--go-global', '--control', PHONE]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(PHONE);
      expect(result.error).toBe('Unknown --control value (must be voice_intake)');
    }
  });

  it('rejects --control deferred_delivery for --go-global (not phone-scoped)', () => {
    const result = parseControlsArgs(['--go-global', '--control', 'deferred_delivery']);
    expect(result.ok).toBe(false);
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
      expect(result.error).toBe(
        'Unknown control name (must be deferred_delivery or voice_intake)',
      );
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

  it('--allow-phone writes only the SHA-256 hash via hashNormalizedPhone into phone_hashes, scoped to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(
      client,
      { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
      'test-operator',
    );

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('phone_hashes');
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).toContain(hashPhone(PHONE));
    expect(update!.values).not.toContain(PHONE);
  });

  it('--allow-phone --control voice_intake scopes the write to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(
      client,
      { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
      'test-operator',
    );

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).not.toContain('deferred_delivery_enabled');
    expect(update!.values).toContain(hashPhone(PHONE));
    expect(update!.values).not.toContain(PHONE);
  });

  it('--deny-phone removes only the SHA-256 hash from phone_hashes, scoped to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(
      client,
      { kind: 'deny-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
      'test-operator',
    );

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('array_remove');
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).toContain(hashPhone(PHONE));
    expect(update!.values).not.toContain(PHONE);
  });

  it('--deny-phone --control voice_intake scopes the removal to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(
      client,
      { kind: 'deny-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
      'test-operator',
    );

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('array_remove');
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).not.toContain('deferred_delivery_enabled');
  });

  it('--enable deferred_delivery touches only that row (deferred_delivery_enabled)', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain('deferred_delivery_enabled');
    expect(update!.values).not.toContain('voice_intake_enabled');
  });

  it('--enable voice_intake touches only that row (voice_intake_enabled) and does not run the deferred-delivery sweep', async () => {
    const { client, calls } = makeFakeClient({ eligibleSweepWorkerIds: ['worker-1'] });
    await runControlsAction(client, { kind: 'enable', controlKey: 'voice_intake_enabled' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).not.toContain('deferred_delivery_enabled');

    const sweepSelect = calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.text));
    expect(sweepSelect).toBeUndefined();
  });

  it('--go-global sets global_enabled = true scoped to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'go-global', controlKey: 'voice_intake_enabled' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('global_enabled = true');
    expect(update!.values).toContain('voice_intake_enabled');
  });

  it('--go-global --control voice_intake scopes the global flag to voice_intake_enabled', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'go-global', controlKey: 'voice_intake_enabled' }, 'test-operator');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toContain('global_enabled = true');
    expect(update!.values).toContain('voice_intake_enabled');
    expect(update!.values).not.toContain('deferred_delivery_enabled');
  });

  it('sets updated_by to the operator identity on any mutation', async () => {
    const { client, calls } = makeFakeClient();
    await runControlsAction(client, { kind: 'go-global', controlKey: 'voice_intake_enabled' }, 'operator-luis');

    const update = calls.find((c) => /^\s*UPDATE whatsapp_runtime_controls/.test(c.text));
    expect(update!.values).toContain('operator-luis');
  });

  // ── O1: --enable deferred_delivery must retrigger the deferred-intent sweep ──
  describe('--enable deferred_delivery retrigger sweep (O1)', () => {
    it('runs the sweep (issues its eligible-workers SELECT and enqueues fresh worker.ready events) after enabling', async () => {
      const { client, calls } = makeFakeClient({ eligibleSweepWorkerIds: ['worker-1', 'worker-2'] });

      await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

      const sweepSelect = calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.text));
      expect(sweepSelect).toBeDefined();

      const sweepInserts = calls.filter((c) => /INSERT INTO worker_domain_outbox/.test(c.text));
      expect(sweepInserts).toHaveLength(2);
      expect(sweepInserts.map((c) => c.values[1])).toEqual([
        expect.stringMatching(/^worker\.ready:sweep:worker-1:/),
        expect.stringMatching(/^worker\.ready:sweep:worker-2:/),
      ]);
    });

    it('wraps the enable UPDATE and the sweep in one transaction (BEGIN ... COMMIT)', async () => {
      const { client, calls } = makeFakeClient({ eligibleSweepWorkerIds: ['worker-1'] });

      await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

      const texts = calls.map((c) => c.text.trim());
      expect(texts[0]).toBe('BEGIN');
      expect(texts[texts.length - 1]).toBe('COMMIT');
      expect(texts).not.toContain('ROLLBACK');
    });

    it('runs no sweep query when there is nothing eligible (still commits the enable)', async () => {
      const { client, calls } = makeFakeClient({ eligibleSweepWorkerIds: [] });

      await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

      const sweepSelect = calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.text));
      expect(sweepSelect).toBeDefined(); // the sweep still issues its one empty-result probe
      const sweepInserts = calls.filter((c) => /INSERT INTO worker_domain_outbox/.test(c.text));
      expect(sweepInserts).toHaveLength(0);
      const texts = calls.map((c) => c.text.trim());
      expect(texts[texts.length - 1]).toBe('COMMIT');
    });

    it('--disable deferred_delivery does NOT run the sweep', async () => {
      const { client, calls } = makeFakeClient({ eligibleSweepWorkerIds: ['worker-1'] });

      await runControlsAction(client, { kind: 'disable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');

      const sweepSelect = calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.text));
      expect(sweepSelect).toBeUndefined();
      const texts = calls.map((c) => c.text.trim());
      expect(texts).not.toContain('BEGIN');
      expect(texts).not.toContain('COMMIT');
    });

  });

  // ── control row missing (rowCount guard) ──
  // If the seeding migration (042 or 051) has not been applied, the row
  // these UPDATEs target does not exist. Without checking rowCount, that
  // reports success having changed nothing.
  describe('missing control row', () => {
    function makeMissingRowClient(): Queryable {
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
      };
    }

    it('--allow-phone throws naming the missing control_key', async () => {
      const client = makeMissingRowClient();
      await expect(
        runControlsAction(
          client,
          { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
          'test-operator',
        ),
      ).rejects.toThrow(/voice_intake_enabled/);
    });

    it('--deny-phone throws naming the missing control_key', async () => {
      const client = makeMissingRowClient();
      await expect(
        runControlsAction(
          client,
          { kind: 'deny-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
          'test-operator',
        ),
      ).rejects.toThrow(/voice_intake_enabled/);
    });

    it('--go-global throws naming the missing control_key', async () => {
      const client = makeMissingRowClient();
      await expect(
        runControlsAction(
          client,
          { kind: 'go-global', controlKey: 'voice_intake_enabled' },
          'test-operator',
        ),
      ).rejects.toThrow(/voice_intake_enabled/);
    });

    it('never echoes the raw phone number in the missing-row error', async () => {
      const client = makeMissingRowClient();
      let caught: unknown;
      try {
        await runControlsAction(
          client,
          { kind: 'allow-phone', phone: PHONE, controlKey: 'voice_intake_enabled' },
          'test-operator',
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(PHONE);
    });
  });

  describe('--enable deferred_delivery retrigger sweep (O1) — logging', () => {
    it('never logs a raw phone number regardless of which action ran', async () => {
      const { client } = makeFakeClient({ eligibleSweepWorkerIds: ['worker-1'] });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runControlsAction(client, { kind: 'enable', controlKey: 'deferred_delivery_enabled' }, 'test-operator');
        const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(printed).not.toContain(PHONE);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
