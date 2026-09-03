import {
  promptAnswersView,
  remainingCount,
  remainingView,
  snapshotFromRow,
  stageView,
} from '../../../../lambda/lib/application-stage-view';
import { computeRemaining } from '../../../../lambda/lib/application-requirements';

const PROMPTS = [
  { id: 'p1', text: 'Do you own tools?' },
  { id: 'p2', text: '¿Tienes transporte?' },
];

describe('application-stage-view', () => {
  describe('snapshotFromRow', () => {
    it('maps a fully populated row onto the RequirementSnapshot shape', () => {
      const snapshot = snapshotFromRow({
        id: 'app-1',
        worker_id: 'w1',
        job_id: 'j1',
        application_status: 'details_requested',
        job_status: 'active',
        job_title: 'Framer',
        application_answers: { years_experience: 3 },
        prompt_answers: { p1: 'Yes' },
        pre_application_prompts: PROMPTS,
        required_fields: ['years_experience', 'work_authorization'],
        optional_fields: ['tools'],
        required_docs: ['resume'],
        optional_docs: ['certification_doc'],
        certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: false }],
        have_docs: ['resume'],
        details_requested_at: '2026-09-01T00:00:00Z',
        details_completed_at: null,
      });

      expect(snapshot.applicationId).toBe('app-1');
      expect(snapshot.workerId).toBe('w1');
      expect(snapshot.jobId).toBe('j1');
      expect(snapshot.applicationStatus).toBe('details_requested');
      expect(snapshot.jobStatus).toBe('active');
      expect(snapshot.answers).toEqual({ years_experience: 3 });
      expect(snapshot.promptAnswers).toEqual({ p1: 'Yes' });
      expect(snapshot.prompts).toEqual(PROMPTS);
      expect(snapshot.requiredFields).toEqual(['years_experience', 'work_authorization']);
      expect(snapshot.optionalDocs).toEqual(['certification_doc']);
      expect(snapshot.certificationRequirements).toEqual([
        { name: 'OSHA 10', tier: 'required', proof_required: false },
      ]);
      expect(snapshot.haveDocs).toEqual(['resume']);
      // Derived from the TIMESTAMP, never the literal status.
      expect(snapshot.stage).toBe('details');
    });

    it('accepts application_id as the id alias and the remapped status column', () => {
      const snapshot = snapshotFromRow({ application_id: 'app-2', status: 'contacted' });
      expect(snapshot.applicationId).toBe('app-2');
      expect(snapshot.applicationStatus).toBe('contacted');
    });

    it('collapses absent/NULL/malformed columns to their DB defaults instead of throwing', () => {
      const snapshot = snapshotFromRow({
        application_answers: null,
        prompt_answers: 'not-an-object',
        pre_application_prompts: { nope: true },
        required_fields: null,
        certification_requirements: 'garbage',
        have_docs: [1, 'resume'],
      });
      expect(snapshot.answers).toEqual({});
      expect(snapshot.promptAnswers).toEqual({});
      expect(snapshot.prompts).toEqual([]);
      expect(snapshot.requiredFields).toEqual([]);
      expect(snapshot.certificationRequirements).toEqual([]);
      expect(snapshot.haveDocs).toEqual(['resume']);
      expect(snapshot.stage).toBe('apply');
    });

    it('drops non-string prompt answer values rather than shipping them', () => {
      const snapshot = snapshotFromRow({ prompt_answers: { p1: 'Yes', p2: 7 } });
      expect(snapshot.promptAnswers).toEqual({ p1: 'Yes' });
    });

    it('describes a not-yet-applied worker from the job columns alone', () => {
      const remaining = computeRemaining(
        snapshotFromRow({
          pre_application_prompts: PROMPTS,
          required_fields: ['years_experience'],
          required_docs: ['resume'],
        }),
      );
      expect(remaining.prompts).toEqual(['p1', 'p2']);
      expect(remaining.fields).toEqual(['years_experience']);
      expect(remaining.docs).toEqual(['resume']);
      expect(remaining.complete).toBe(false);
    });
  });

  describe('remainingView / remainingCount', () => {
    const remaining = computeRemaining(
      snapshotFromRow({
        pre_application_prompts: PROMPTS,
        prompt_answers: { p1: 'Yes' },
        required_fields: ['years_experience'],
        optional_fields: ['tools'],
        required_docs: ['resume', 'ssn'],
        optional_docs: ['certification_doc'],
      }),
    );

    it('publishes exactly the six shared keys', () => {
      expect(Object.keys(remainingView(remaining)).sort()).toEqual(
        ['certifications', 'complete', 'counts', 'docs', 'fields', 'prompts'],
      );
    });

    it('drops uncollectableDocs/optionalFields/optionalDocs', () => {
      // `ssn` is uncollectable (never blocking) and must not surface as a doc.
      expect(remaining.uncollectableDocs).toEqual(['ssn']);
      const view = remainingView(remaining) as unknown as Record<string, unknown>;
      expect(view.uncollectableDocs).toBeUndefined();
      expect(view.optionalFields).toBeUndefined();
      expect(view.optionalDocs).toBeUndefined();
      expect(view.docs).toEqual(['resume']);
    });

    it('sums the four counts', () => {
      // 1 prompt + 1 field + 0 certs + 1 doc
      expect(remainingCount(remaining)).toBe(3);
      expect(remainingCount(remainingView(remaining))).toBe(3);
    });
  });

  describe('stageView', () => {
    const jobColumns = {
      pre_application_prompts: PROMPTS,
      required_fields: ['years_experience'],
      required_docs: [] as string[],
    };

    it('reports not_requested before the employer asks, even when nothing is outstanding', () => {
      const view = stageView({
        ...jobColumns,
        required_fields: [],
        prompt_answers: { p1: 'a', p2: 'b' },
      });
      expect(view).toEqual({
        details_status: 'not_requested',
        stage: 'apply',
        remaining: expect.objectContaining({ complete: true }),
      });
    });

    it('reports requested while stage-2 items are outstanding', () => {
      const view = stageView({
        ...jobColumns,
        prompt_answers: { p1: 'a', p2: 'b' },
        details_requested_at: '2026-09-01T00:00:00Z',
      });
      expect(view.details_status).toBe('requested');
      expect(view.stage).toBe('details');
      expect(view.remaining.fields).toEqual(['years_experience']);
    });

    it('reports complete once remaining is empty, before the timestamp is flipped', () => {
      const view = stageView({
        ...jobColumns,
        application_answers: { years_experience: 4 },
        prompt_answers: { p1: 'a', p2: 'b' },
        details_requested_at: '2026-09-01T00:00:00Z',
      });
      expect(view.details_status).toBe('complete');
      expect(view.remaining.complete).toBe(true);
    });

    it('reports complete from details_completed_at regardless of remaining', () => {
      const view = stageView({
        ...jobColumns,
        details_requested_at: '2026-09-01T00:00:00Z',
        details_completed_at: '2026-09-02T00:00:00Z',
      });
      expect(view.details_status).toBe('complete');
      expect(view.remaining.complete).toBe(false);
    });
  });

  describe('promptAnswersView', () => {
    it('joins answers to prompts in prompt order, not answer order', () => {
      expect(promptAnswersView(PROMPTS, { p2: 'Sí', p1: 'Yes' })).toEqual([
        { prompt_id: 'p1', question: 'Do you own tools?', text: 'Yes' },
        { prompt_id: 'p2', question: '¿Tienes transporte?', text: 'Sí' },
      ]);
    });

    it('omits unanswered prompts (they are reported by remaining.prompts)', () => {
      expect(promptAnswersView(PROMPTS, { p1: 'Yes' })).toEqual([
        { prompt_id: 'p1', question: 'Do you own tools?', text: 'Yes' },
      ]);
    });

    it('appends an orphaned answer with a null question rather than dropping it', () => {
      expect(promptAnswersView(PROMPTS, { gone: 'Old answer', p1: 'Yes' })).toEqual([
        { prompt_id: 'p1', question: 'Do you own tools?', text: 'Yes' },
        { prompt_id: 'gone', question: null, text: 'Old answer' },
      ]);
    });

    it('returns [] for missing/malformed inputs', () => {
      expect(promptAnswersView(null, null)).toEqual([]);
      expect(promptAnswersView('nope', 'nope')).toEqual([]);
      expect(promptAnswersView(PROMPTS, {})).toEqual([]);
    });
  });
});
