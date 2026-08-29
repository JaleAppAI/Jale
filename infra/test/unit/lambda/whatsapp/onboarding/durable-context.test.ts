/**
 * The durable half of `session.state_context` (R2-C23).
 *
 * These are the pure-function guarantees the cross-door resume rests on; the
 * real-PostgreSQL proof that a web-seeded bag is what WhatsApp then reads
 * lives in `test/unit/db/web-onboarding-door.integration.test.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  V2_DURABLE_CONTEXT_KEYS,
  durableContextPatch,
  hydrateStateContextFromRunContext,
  loadRunContext,
  persistDurableStateContext,
} from '../../../../../lambda/whatsapp/onboarding/durable-context';
import { WHATSAPP_V2_WORKFLOW_VERSION } from '../../../../../lambda/whatsapp/onboarding/constants';

type QueryCall = { sql: string; params: unknown[] };

function fakeClient(rows: unknown[] = []): { client: any; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { client, calls };
}

describe('V2_DURABLE_CONTEXT_KEYS', () => {
  test('carries the run-scoped keys and NOT the channel-scoped ones', () => {
    expect([...V2_DURABLE_CONTEXT_KEYS].sort()).toEqual([
      'v2CustomTradeText',
      'v2LocationPendingConfirm',
      'v2PreferredLanguageOverride',
      'v2ProfileTrade',
      'v2QuestionSetVersion',
      'v2RubricVersion',
      'v2TrustQuestions',
      'v2TrustSource',
    ]);
  });

  test('excludes reprompt cooldowns and the voice staleness anchors', () => {
    // Regression guard, not a restatement of the list above: each of these
    // has a concrete failure mode if it ever becomes durable (a suppressed
    // WhatsApp reprompt; a resurrected pre-BACK transcript).
    for (const forbidden of [
      'v2LastPromptAt:profile.name',
      'v2VoiceExecutionArn',
      'v2TrustVoiceExecutionArn',
      'v2VoiceStartedAt',
    ]) {
      expect(V2_DURABLE_CONTEXT_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('durableContextPatch', () => {
  test('writes every durable key, using null for the ones the session dropped', () => {
    const patch = durableContextPatch({
      v2ProfileTrade: 'carpenter',
      v2TrustSource: 'generated',
      // A reprompt timestamp and a voice ARN are present but must not travel.
      'v2LastPromptAt:profile.name': '2026-08-28T00:00:00.000Z',
      v2TrustVoiceExecutionArn: 'arn:aws:states:us-east-2:1:execution:x',
    });

    expect(patch).toEqual({
      v2TrustQuestions: null,
      v2TrustSource: 'generated',
      v2QuestionSetVersion: null,
      v2RubricVersion: null,
      v2ProfileTrade: 'carpenter',
      v2CustomTradeText: null,
      v2LocationPendingConfirm: null,
      v2PreferredLanguageOverride: null,
    });
  });

  test('the explicit nulls are what make RESTART observable through `context || patch`', () => {
    // RESTART deletes keys from state_context. jsonb concatenation cannot
    // remove a key, so a patch that simply omitted them would leave the
    // abandoned trade's questions in the run forever — and the next web
    // request would hydrate them straight back.
    const beforeRestart = durableContextPatch({
      v2TrustQuestions: [{ en: 'a', es: 'b' }],
      v2ProfileTrade: 'welder',
    });
    expect(beforeRestart.v2TrustQuestions).not.toBeNull();

    const afterRestart = durableContextPatch({});
    expect(afterRestart.v2TrustQuestions).toBeNull();
    expect(afterRestart.v2ProfileTrade).toBeNull();
    expect(Object.keys(afterRestart).sort()).toEqual([...V2_DURABLE_CONTEXT_KEYS].sort());
  });
});

describe('hydrateStateContextFromRunContext', () => {
  test('run.context WINS over the session, and only changed keys are reported', () => {
    const stateContext: Record<string, unknown> = { v2ProfileTrade: 'plumber' };
    const hydrated = hydrateStateContextFromRunContext(stateContext, {
      v2ProfileTrade: 'carpenter',
      v2TrustSource: 'generated',
      v2TrustQuestions: [{ en: 'Q1', es: 'P1' }],
    });

    // THE DIRECTION IS THE FEATURE. `session.state_context` is the WhatsApp
    // conversation row, which the web door never writes; `run.context` is
    // per-run and both doors write it. If the session won here, a worker who
    // changed their trade on the web would have their next WhatsApp message
    // silently revert it -- and then persist that revert back over
    // `run.context`.
    expect(stateContext.v2ProfileTrade).toBe('carpenter');
    expect(stateContext.v2TrustSource).toBe('generated');
    expect(hydrated.sort()).toEqual(['v2ProfileTrade', 'v2TrustQuestions', 'v2TrustSource']);
  });

  test('an unchanged bag reports nothing — deep-equal objects included', () => {
    // Otherwise every WhatsApp turn would log a hydration for the two
    // object-valued keys, which are re-read as fresh instances each time.
    const questions = [{ en: 'Q1', es: 'P1' }];
    const stateContext: Record<string, unknown> = {
      v2ProfileTrade: 'carpenter',
      v2TrustQuestions: [{ en: 'Q1', es: 'P1' }],
    };
    const hydrated = hydrateStateContextFromRunContext(stateContext, {
      v2ProfileTrade: 'carpenter',
      v2TrustQuestions: questions,
    });
    expect(hydrated).toEqual([]);
  });

  test('a stored null NEVER erases the value the session is mid-turn on', () => {
    // `durableContextPatch` writes an explicit null for every key the last
    // writer's session lacked, because `context || patch` cannot delete. If
    // that null overwrote, a RESTART on one door would wipe keys the other
    // door is actively using.
    const stateContext: Record<string, unknown> = {
      v2ProfileTrade: 'carpenter',
      v2TrustQuestions: [{ en: 'Q1', es: 'P1' }],
    };
    const hydrated = hydrateStateContextFromRunContext(stateContext, {
      v2ProfileTrade: null,
      v2TrustQuestions: null,
    });
    expect(hydrated).toEqual([]);
    expect(stateContext.v2ProfileTrade).toBe('carpenter');
    expect(stateContext.v2TrustQuestions).toEqual([{ en: 'Q1', es: 'P1' }]);
  });

  test('treats a stored null as absent (the RESTART round trip)', () => {
    const stateContext: Record<string, unknown> = {};
    const hydrated = hydrateStateContextFromRunContext(stateContext, {
      v2TrustQuestions: null,
      v2ProfileTrade: null,
    });
    expect(hydrated).toEqual([]);
    expect(stateContext).toEqual({});
  });

  test('never copies a non-durable key, even when the run context holds one', () => {
    const stateContext: Record<string, unknown> = {};
    hydrateStateContextFromRunContext(stateContext, {
      v2TrustVoiceExecutionArn: 'arn:stale',
      'v2LastPromptAt:trust.question.1': '2026-08-28T00:00:00.000Z',
      locationSource: 'city_state',
      trade: 'carpenter',
    });
    expect(stateContext).toEqual({});
  });

  test('a missing/!object run context is a no-op, not a throw', () => {
    const stateContext: Record<string, unknown> = { v2ProfileTrade: 'carpenter' };
    expect(hydrateStateContextFromRunContext(stateContext, null)).toEqual([]);
    expect(hydrateStateContextFromRunContext(stateContext, undefined)).toEqual([]);
    expect(stateContext).toEqual({ v2ProfileTrade: 'carpenter' });
  });
});

describe('loadRunContext / persistDurableStateContext', () => {
  test('reads the context column by name — SELECT * is a hard 42501 for jale_whatsapp', async () => {
    const { client, calls } = fakeClient([{ context: { v2ProfileTrade: 'carpenter' } }]);
    await expect(loadRunContext(client, 'run-1')).resolves.toEqual({ v2ProfileTrade: 'carpenter' });
    expect(calls[0].sql).toContain('SELECT context FROM worker_workflow_runs');
    expect(calls[0].sql).not.toContain('SELECT *');
    expect(calls[0].params).toEqual(['run-1']);
  });

  test('a run with no row, or a null context, reads as an empty bag', async () => {
    await expect(loadRunContext(fakeClient([]).client, 'run-1')).resolves.toEqual({});
    await expect(loadRunContext(fakeClient([{ context: null }]).client, 'run-1')).resolves.toEqual({});
  });

  test('the write merges with `||` and never touches lock_version', async () => {
    const { client, calls } = fakeClient();
    await persistDurableStateContext(client, 'run-1', { v2ProfileTrade: 'carpenter' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('context = context || $2::jsonb');
    // lock_version is the browser's optimistic-concurrency token: it must only
    // move when the RUN moves, never when the engine re-saves its own bag.
    expect(calls[0].sql).not.toContain('lock_version');
    expect(calls[0].params[0]).toBe('run-1');
    expect(JSON.parse(calls[0].params[1] as string)).toEqual(
      durableContextPatch({ v2ProfileTrade: 'carpenter' }),
    );
  });
});

describe('WHATSAPP_V2_WORKFLOW_VERSION', () => {
  test('agrees with processor.ts, whose copy is module-private', () => {
    // The two doors must mint runs at the same workflow_version or neither
    // recognises the other's. processor.ts is off-limits to this lane, so the
    // constant is duplicated and pinned here rather than imported.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'lambda', 'whatsapp', 'processor.ts'),
      'utf8',
    );
    const match = /const WHATSAPP_V2_WORKFLOW_VERSION = (\d+);/.exec(source);
    expect(match).not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBe(WHATSAPP_V2_WORKFLOW_VERSION);
  });
});
