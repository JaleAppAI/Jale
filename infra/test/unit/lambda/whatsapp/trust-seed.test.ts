/**
 * L6 — `seedTrustQuestions` keys the per-trade trust-question cache off the
 * CANONICAL trade, so "soldador", "Soldadura" and "welder" share one question
 * set instead of generating three.
 *
 * The fallback-on-failure behaviour is pinned here too: the alias lookup is an
 * extra DB round trip on the trust path and must never be able to fail a run.
 */

import type { PoolClient } from 'pg';

import { seedTrustQuestions } from '../../../../lambda/whatsapp/onboarding/trust-seed';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../../../../lambda/whatsapp/lib/interactive-templates';
import {
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from '../../../../lambda/whatsapp/onboarding/constants';
import type {
  OnboardingV2Deps,
  OnboardingV2Session,
} from '../../../../lambda/whatsapp/onboarding/types';

const ALIAS_ROWS = [
  {
    trade_key: 'welder',
    canonical_en: 'Welder',
    canonical_es: 'Soldador',
    trade_category: null,
    aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
  },
  {
    trade_key: 'painter',
    canonical_en: 'Painter',
    canonical_es: 'Pintor',
    trade_category: 'painting',
    aliases: ['painter', 'painting', 'paint', 'pintor', 'pintura'],
  },
];

function makeClient() {
  const keys: string[] = [];
  return {
    keys,
    query: jest.fn(async (_sql: string, params?: unknown[]) => {
      const key = String(params?.[0] ?? '');
      keys.push(key);
      const hit = ALIAS_ROWS.find((r) => r.trade_key === key || r.aliases.includes(key));
      return { rows: hit ? [hit] : [] };
    }),
  } as any as PoolClient & { keys: string[]; query: jest.Mock };
}

function makeSession(): OnboardingV2Session {
  return { user_id: 'worker-1', state_context: {} } as any as OnboardingV2Session;
}

type GenerateImpl = (client: PoolClient, profession: string) => Promise<unknown>;

function makeDeps(impl?: GenerateImpl) {
  const generate = jest.fn(
    impl ??
      (async (_c: PoolClient, profession: string) => [
        { q_en: `en1 ${profession}`, q_es: `es1 ${profession}` },
        { q_en: `en2 ${profession}`, q_es: `es2 ${profession}` },
        { q_en: `en3 ${profession}`, q_es: `es3 ${profession}` },
      ]),
  );
  const deps = { adapters: { trustQuestions: { generate } } } as any as OnboardingV2Deps;
  return { deps, generate };
}

describe('seedTrustQuestions: one question set per canonical trade', () => {
  it.each(['soldador', 'Soldadura', 'Welder', 'welding'])(
    '"%s" is looked up under the single canonical key "welder"',
    async (raw) => {
      const client = makeClient();
      const session = makeSession();
      const { deps, generate } = makeDeps();

      const source = await seedTrustQuestions(client, session, deps, raw);

      expect(source).toBe('generated');
      expect(generate).toHaveBeenCalledWith(client, 'welder');
      expect(session.state_context.v2TrustQuestions).toHaveLength(3);
      expect(session.state_context.v2QuestionSetVersion).toBe(V2_TRUST_QUESTION_SET_VERSION);
      expect(session.state_context.v2RubricVersion).toBe(V2_TRUST_RUBRIC_VERSION);
    },
  );

  it.each(['electrician', 'plumber', 'carpenter', 'concrete', 'painting'])(
    'a STANDARD trade key ("%s") is passed through untouched, with no alias lookup',
    async (trade) => {
      // Migration 012 seeds trade_questions.profession_key = 'painting'; the
      // 060 alias row for that trade is keyed 'painter'. Re-keying standard
      // trades would orphan the seeded rows 086 asserts still exist.
      const client = makeClient();
      const { deps, generate } = makeDeps();

      await seedTrustQuestions(client, makeSession(), deps, trade);

      expect(generate).toHaveBeenCalledWith(client, trade);
      expect(client.query).not.toHaveBeenCalled();
    },
  );

  it('a custom spelling of a standard trade shares that standard key', async () => {
    const client = makeClient();
    const { deps, generate } = makeDeps();

    await seedTrustQuestions(client, makeSession(), deps, 'pintor');

    expect(generate).toHaveBeenCalledWith(client, 'painting');
  });

  it('an unknown trade keeps the normalized raw key', async () => {
    const client = makeClient();
    const { deps, generate } = makeDeps();

    await seedTrustQuestions(client, makeSession(), deps, '  Pipe-Fitter ');

    expect(generate).toHaveBeenCalledWith(client, 'pipe fitter');
  });
});

describe('seedTrustQuestions: failure behaviour is unchanged', () => {
  it('falls back when the generator returns null', async () => {
    const session = makeSession();
    const { deps } = makeDeps(async () => null);

    expect(await seedTrustQuestions(makeClient(), session, deps, 'soldador')).toBe('fallback');
    expect(session.state_context.v2TrustQuestions).toEqual(
      V2_FALLBACK_TRUST_QUESTIONS.map((q) => ({ ...q })),
    );
    expect(session.state_context.v2QuestionSetVersion).toBe(V2_TRUST_FALLBACK_VERSION);
  });

  it('falls back when the generator throws', async () => {
    const session = makeSession();
    const { deps } = makeDeps(async () => {
      throw new Error('generator_unavailable');
    });

    expect(await seedTrustQuestions(makeClient(), session, deps, 'soldador')).toBe('fallback');
    expect(session.state_context.v2TrustSource).toBe('fallback');
  });

  it('a FAILING alias lookup still generates, under the normalized raw key', async () => {
    const client = {
      query: jest.fn(async () => {
        throw new Error('relation "trade_aliases" does not exist');
      }),
    } as any as PoolClient;
    const session = makeSession();
    const { deps, generate } = makeDeps();

    expect(await seedTrustQuestions(client, session, deps, 'Soldadura')).toBe('generated');
    expect(generate).toHaveBeenCalledWith(client, 'soldadura');
  });
});
