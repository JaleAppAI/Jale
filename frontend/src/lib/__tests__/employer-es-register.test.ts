import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Employer copy speaks Spanish in "usted". Worker copy uses "tú", and the two
 * share some namespaces, so this checks the employer-only ones plus the
 * employer half of `job_requirements` (the picker and the apply-time question
 * editor). It looks for forms that only "tú" uses: the pronouns and
 * possessives, the common second-person verbs, and imperatives that open a
 * sentence.
 */

type MessageNode = string | { [key: string]: MessageNode };

function* leaves(node: MessageNode, path: string): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path, node];
    return;
  }
  for (const [key, child] of Object.entries(node)) yield* leaves(child, path ? `${path}.${key}` : key);
}

const EMPLOYER_PREFIXES = [
  'auth.employer.',
  'employer.',
  'employer_applicants.',
  'employer_messages.',
  'employer_dashboard.',
  'employer_worker_profile.',
  'employer_job_listing.',
  'job_requirements.picker.',
  'job_requirements.prompts.',
  'job_requirements.employer.',
  'tutorial.employer_',
];

/**
 * Text the employer sends TO a worker, so it is written in the worker's
 * register. The two tutorial lines draw the WhatsApp messages the worker
 * receives (E3's details request, E4's invitation), so they read as the
 * worker would see them.
 */
const WORKER_FACING = new Set([
  'employer_messages.default_initial_message',
  'tutorial.employer_applicants.scenes.wa_msg',
  'tutorial.employer_messages.scenes.invite',
]);

// Letter lookarounds, not `\b`: in a JavaScript regex `\b` treats accented
// letters as non-word characters, so `\btú\b` and `\bestás\b` never match.
const TU_WORDS = /(?<!\p{L})(tu|tus|tú|ti|te|contigo|puedes|tienes|quieres|necesitas|debes|estás|eres)(?!\p{L})/iu;
const TU_IMPERATIVE_OPENING =
  /(^|[.!?]\s+|\{[^{}]*\{)(Agrega|Ingresa|Usa|Revisa|Actualiza|Elige|Escribe|Toca|Sube|Completa|Selecciona|Intenta|Vuelve)\b/;

describe('the tú pattern itself', () => {
  it('catches the accented forms as whole words', () => {
    for (const sample of ['Si tú quiere', 'Es para ti.', '¿Estás listo?', 'Tú decides']) {
      expect(TU_WORDS.test(sample), sample).toBe(true);
    }
  });

  it('leaves usted forms and words that merely contain the letters alone', () => {
    for (const sample of ['Si usted quiere', 'Título del empleo', 'Está listo', 'su teléfono']) {
      expect(TU_WORDS.test(sample), sample).toBe(false);
    }
  });
});

describe('employer Spanish copy register', () => {
  it('uses usted, never tú, in employer-facing strings', () => {
    const leaks: string[] = [];
    for (const [path, value] of leaves(es as MessageNode, '')) {
      if (!EMPLOYER_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      if (WORKER_FACING.has(path)) continue;
      if (TU_WORDS.test(value) || TU_IMPERATIVE_OPENING.test(value)) leaks.push(`${path}: ${value}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('description helper credit', () => {
  it('says where the samples come from in plain words', () => {
    const credit = (tree: MessageNode) =>
      ((tree as { employer_dashboard: { modal: { description_helper: { source_credit: string } } } })
        .employer_dashboard.modal.description_helper.source_credit);
    expect(credit(en as MessageNode)).toBe('Based on U.S. job data');
    expect(credit(es as MessageNode)).toBe('Basado en datos de empleo de EE. UU.');
  });
});
