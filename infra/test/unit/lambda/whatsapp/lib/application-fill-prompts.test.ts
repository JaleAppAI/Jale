import { REQUIRED_FIELD_TYPES, DOC_TYPES } from '../../../../../lambda/lib/job-fields';
import * as prompts from '../../../../../lambda/whatsapp/lib/application-fill-prompts';

const FILL_MESSAGE_KEYS = [
  'intro', 'confirm_footer', 'entry_another', 'completion',
  'canceled', 'doc_invalid_type', 'doc_too_large', 'doc_take_first',
  'doc_step_media_pending', 'field_step_media', 'cert_cap', 'extraction_failed',
  'answer_too_long', 'doc_download_failed', 'web_handoff', 'switched_job', 'continue_other',
  'exit_job_inactive', 'exit_application_gone', 'exit_application_closed',
  'guard_error', 'reconfirm',
] as const;

describe('application-fill-prompts.ts', () => {
  test.each(REQUIRED_FIELD_TYPES)('field %s has distinct en/es question and hint', (key) => {
    for (const fn of [prompts.fieldQuestion, prompts.fieldRetryHint]) {
      const en = fn(key, 'en'); const es = fn(key, 'es');
      expect(en.length).toBeGreaterThan(10);
      expect(es.length).toBeGreaterThan(10);
      expect(en).not.toBe(es);
    }
  });

  test.each(DOC_TYPES)('doc %s has distinct en/es prompt naming formats and 10MB', (dt) => {
    const es = prompts.docPrompt(dt, 'es');
    expect(es).toMatch(/PDF/); expect(es).toMatch(/10 ?MB/);
    expect(es).not.toBe(prompts.docPrompt(dt, 'en'));
  });

  test('es copy has no accents or inverted punctuation', () => {
    const all = [
      ...REQUIRED_FIELD_TYPES.flatMap(k => [prompts.fieldQuestion(k, 'es'), prompts.fieldRetryHint(k, 'es')]),
      ...DOC_TYPES.map(d => prompts.docPrompt(d, 'es')),
    ].join(' ');
    expect(all).not.toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡]/);
  });

  // "ano"/"anos" (accent-stripped "ano"/"anos") is a vulgar homograph --
  // the house style drops accents everywhere, so this word must never be
  // used; spell out the year unit differently (AAAA-MM-DD, a concrete
  // year, etc.) instead. Word-boundary match so "manos"/"veterano" etc.
  // (which merely contain the substring) are not flagged.
  test('no es string anywhere in the module contains the "ano/anos" homograph', () => {
    const vars = { n_fields: '3', n_docs: '2', doc: 'resume' };
    const all = [
      ...REQUIRED_FIELD_TYPES.flatMap(k => [prompts.fieldQuestion(k, 'es'), prompts.fieldRetryHint(k, 'es')]),
      ...DOC_TYPES.map(d => prompts.docPrompt(d, 'es')),
      ...FILL_MESSAGE_KEYS.map(k => prompts.fillMessage(k, 'es', vars)),
    ].join(' ');
    expect(all).not.toMatch(/\banos?\b/i);
  });

  test.each(REQUIRED_FIELD_TYPES)('field %s retry hint names the problem before the format (en+es)', (key) => {
    const en = prompts.fieldRetryHint(key, 'en');
    const es = prompts.fieldRetryHint(key, 'es');
    expect(en).toMatch(/^That's not a valid/);
    expect(es).toMatch(/^(Esa|Eso) no es (?:una?|un) .*valid[oa]\./);
  });

  test.each(FILL_MESSAGE_KEYS)('fillMessage %s has distinct en/es text', (key) => {
    const en = prompts.fillMessage(key, 'en');
    const es = prompts.fillMessage(key, 'es');
    expect(en.length).toBeGreaterThan(5);
    expect(es.length).toBeGreaterThan(5);
    expect(en).not.toBe(es);
  });

  test('fillMessage es copy has no accents or inverted punctuation', () => {
    const vars = { n_fields: '3', n_docs: '2', doc: 'resume' };
    const all = FILL_MESSAGE_KEYS.map((k) => prompts.fillMessage(k, 'es', vars)).join(' ');
    expect(all).not.toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡]/);
  });

  test('intro substitutes n_fields and n_docs', () => {
    const s = prompts.fillMessage('intro', 'es', { n_fields: '3', n_docs: '2' });
    expect(s).toContain('3');
    expect(s).toContain('2');
    expect(s).not.toContain('{{n_fields}}');
    expect(s).not.toContain('{{n_docs}}');
  });

  test('web_handoff substitutes doc and does not promise the website in canceled', () => {
    const handoff = prompts.fillMessage('web_handoff', 'es', { doc: 'resume' });
    expect(handoff).toContain('resume');
    expect(handoff).not.toContain('{{doc}}');
    expect(handoff).toMatch(/sitio web/);

    const canceled = prompts.fillMessage('canceled', 'es');
    expect(canceled).not.toMatch(/sitio web/);
    // Sprint 23 re-aimed this line: the fill is armed from the employer's
    // stage-2 request now, not from "N aceptar", so a canceled form is
    // resumed through the aplicaciones menu.
    expect(canceled.toLowerCase()).toContain('aplicaciones');
    // tu-preterite ("cancelaste"), not the usted-imperative ("cancele") --
    // matches completaste/cambiaste elsewhere in this file.
    expect(canceled).toContain('cancelaste');
    expect(canceled).not.toMatch(/\bcancele\b/);
  });

  // Task 11: continue_other names the offered job so the worker knows what
  // "1" refers to -- same substitution contract as intro/web_handoff above.
  test('continue_other substitutes job_title', () => {
    const es = prompts.fillMessage('continue_other', 'es', { job_title: 'Cocinero' });
    expect(es).toContain('Cocinero');
    expect(es).not.toContain('{{job_title}}');

    const en = prompts.fillMessage('continue_other', 'en', { job_title: 'Cook' });
    expect(en).toContain('Cook');
    expect(en).not.toContain('{{job_title}}');
  });

  test('confirm_footer is a numbered 1/2 footer', () => {
    const es = prompts.fillMessage('confirm_footer', 'es');
    const en = prompts.fillMessage('confirm_footer', 'en');
    expect(es).toMatch(/^1\./);
    expect(es).toMatch(/Responde con 1 o 2\./);
    expect(en).toMatch(/^1\./);
    expect(en).toMatch(/Reply with 1 or 2\./);
  });

  test('unknown placeholders in fillMessage are left intact when no vars given', () => {
    const s = prompts.fillMessage('web_handoff', 'es');
    expect(s).toContain('{{doc}}');
  });
});
