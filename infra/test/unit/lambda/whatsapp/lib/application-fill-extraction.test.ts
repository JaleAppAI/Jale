import {
  extractFieldAnswer,
  makeBedrockExtractionClient,
  MAX_FREETEXT_CHARS,
  type ExtractionClient,
} from '../../../../../lambda/whatsapp/lib/application-fill-extraction';

const fake = (json: unknown): ExtractionClient => ({ invoke: async () => JSON.stringify(json) });

describe('application-fill-extraction.ts', () => {
  describe('MAX_FREETEXT_CHARS', () => {
    it('is the per-key input cap', () => {
      expect(MAX_FREETEXT_CHARS).toBe(1000);
    });
  });

  describe('extractFieldAnswer', () => {
    // ── Brief's given tests (near-verbatim) ────────────────────────────

    it('extracts and validates a home_address', async () => {
      const out = await extractFieldAnswer(fake({
        value: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
        confidence: { street: 0.9, city: 0.95, state: 0.9, zip: 0.9 },
      }), 'home_address', 'vivo en 1 Main St Kyle TX 78640', 'es');
      expect(out).toMatchObject({ ok: true, value: { city: 'Kyle', state: 'TX' } });
    });

    it('rejects when any required subfield is below threshold', async () => {
      const out = await extractFieldAnswer(fake({
        value: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
        confidence: { street: 0.9, city: 0.4, state: 0.9, zip: 0.9 },
      }), 'home_address', 'texto', 'es');
      expect(out).toEqual({ ok: false, reason: 'low_confidence' });
    });

    it('validator is the gate: malformed extraction is invalid', async () => {
      const out = await extractFieldAnswer(fake({ value: { zip: 'not-a-zip' }, confidence: {} }), 'home_address', 'x', 'es');
      expect(out).toEqual({ ok: false, reason: 'invalid' });
    });

    it('caps input length before calling Bedrock', async () => {
      const spy = jest.fn(); const client = { invoke: spy as any };
      const out = await extractFieldAnswer(client, 'work_history', 'x'.repeat(2000), 'es');
      expect(out).toEqual({ ok: false, reason: 'too_long' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('bedrock throw maps to bedrock_error', async () => {
      const out = await extractFieldAnswer({ invoke: async () => { throw new Error('timeout'); } }, 'education', 'hs', 'es');
      expect(out).toEqual({ ok: false, reason: 'bedrock_error' });
    });

    // ── Per-key happy path coverage (all 7 extraction keys) ─────────────

    it('extracts and validates emergency_contact', async () => {
      const out = await extractFieldAnswer(fake({
        value: { name: 'Maria Lopez', phone: '555-123-4567' },
        confidence: { name: 0.9, phone: 0.95 },
      }), 'emergency_contact', 'mi contacto es Maria Lopez 555-123-4567', 'es');
      expect(out).toMatchObject({
        ok: true,
        value: { name: 'Maria Lopez', phone: '555-123-4567' },
        summaryVars: { contact: 'Maria Lopez (555-123-4567)' },
      });
    });

    it('extracts and validates worked_here_before', async () => {
      const out = await extractFieldAnswer(fake({
        value: { answer: true, when: '2019' },
        confidence: { answer: 0.9 },
      }), 'worked_here_before', 'si, en 2019', 'es');
      expect(out).toMatchObject({ ok: true, value: { answer: true, when: '2019' } });
    });

    it('extracts and validates education', async () => {
      const out = await extractFieldAnswer(fake({
        value: { level: 'high_school' },
        confidence: { level: 0.9 },
      }), 'education', 'high school', 'en');
      expect(out).toMatchObject({ ok: true, value: { level: 'high_school' } });
    });

    it('extracts and validates military_service', async () => {
      const out = await extractFieldAnswer(fake({
        value: { served: false },
        confidence: { served: 0.95 },
      }), 'military_service', 'no', 'en');
      expect(out).toMatchObject({ ok: true, value: { served: false } });
    });

    it('extracts one references entry and unwraps it from the single-entry array', async () => {
      const out = await extractFieldAnswer(fake({
        value: { name: 'Juan Perez', relationship: 'supervisor', phone: '555-000-1111' },
        confidence: { name: 0.9, relationship: 0.9, phone: 0.9 },
      }), 'references', 'Juan Perez, supervisor, 555-000-1111', 'es');
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error('expected ok');
      expect(Array.isArray(out.value)).toBe(false);
      expect(out.value).toMatchObject({ name: 'Juan Perez', relationship: 'supervisor', phone: '555-000-1111' });
      expect(out.summaryVars).toMatchObject({ reference: 'Juan Perez (555-000-1111)' });
    });

    it('extracts one work_history entry and unwraps it from the single-entry array', async () => {
      const out = await extractFieldAnswer(fake({
        value: { company: 'ABC Construction', title: 'Carpenter' },
        confidence: { company: 0.9, title: 0.9 },
      }), 'work_history', 'ABC Construction, Carpenter', 'en');
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error('expected ok');
      expect(Array.isArray(out.value)).toBe(false);
      expect(out.value).toMatchObject({ company: 'ABC Construction', title: 'Carpenter' });
      expect(out.summaryVars).toMatchObject({ job: 'Carpenter, ABC Construction' });
    });

    it('rejects a references entry missing a required subfield (array validator still gates)', async () => {
      const out = await extractFieldAnswer(fake({
        value: { name: 'Juan Perez' },
        confidence: { name: 0.9 },
      }), 'references', 'Juan Perez', 'es');
      expect(out).toEqual({ ok: false, reason: 'invalid' });
    });

    it('returns invalid JSON from Bedrock as invalid', async () => {
      const out = await extractFieldAnswer({ invoke: async () => 'not json' }, 'home_address', 'x', 'en');
      expect(out).toEqual({ ok: false, reason: 'invalid' });
    });

    it('strips a ```json fence the model added despite the no-fences instruction', async () => {
      const fenced = '```json\n' + JSON.stringify({
        value: { served: false },
        confidence: { served: 0.95 },
      }) + '\n```';
      const out = await extractFieldAnswer(
        { invoke: async () => fenced },
        'military_service',
        'no',
        'en',
      );
      expect(out).toMatchObject({ ok: true, value: { served: false } });
    });

    describe('AI_EXTRACTION_CONFIDENCE_THRESHOLD env var', () => {
      const ENV_KEY = 'AI_EXTRACTION_CONFIDENCE_THRESHOLD';
      const original = process.env[ENV_KEY];

      afterEach(() => {
        if (original === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = original;
      });

      it('falls back to the 0.75 default instead of failing open when the env var is not a number', async () => {
        process.env[ENV_KEY] = 'banana';
        const out = await extractFieldAnswer(fake({
          value: { served: true },
          confidence: { served: 0.5 }, // below the 0.75 default -- must still be rejected
        }), 'military_service', 'si', 'es');
        expect(out).toEqual({ ok: false, reason: 'low_confidence' });
      });
    });
  });

  describe('makeBedrockExtractionClient', () => {
    it('returns an ExtractionClient without requiring network access', () => {
      const client = makeBedrockExtractionClient();
      expect(typeof client.invoke).toBe('function');
    });
  });
});
