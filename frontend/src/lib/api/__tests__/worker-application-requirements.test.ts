import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors';
import {
    applyToJob,
    getApplicationRequirements,
    postApplicationAnswers,
    postApplicationCertifications,
    postApplicationPromptAnswers,
    type ApplicationRequirementsState,
} from '../worker';

/**
 * The sprint-23 stage-2 door (`/worker/applications/{id}*`) and the reshaped
 * apply call, driven through REAL `Response` objects for the same reason
 * `worker-onboarding.test.ts` does: these four helpers return a union instead
 * of throwing, and they decide which member by reading a body `apiFetch` has
 * already `clone()`d and inspected on the way past (the provisioning retry
 * reads every 409, and the legal wall reads every 403). A hand-rolled stub
 * whose `clone()` returns `this` would hide a double-read of one stream; a
 * real `Response` throws the moment we get it wrong.
 *
 * Every status/code pairing below is taken from
 * `infra/lambda/api/worker-application-details.ts`'s `mapFailure`, which is
 * why `payload_too_large` is asserted on BOTH 400 (a merge that would
 * overflow the column) and 413 (the pre-DB body cap): the two are genuinely
 * different events at the door and one union member at the client.
 */

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'id-token';

const STATE = {
    application: {
        id: APPLICATION_ID,
        job_id: 'job-1',
        status: 'details_requested',
        details_status: 'requested',
        stage: 'details',
        details_requested_at: '2026-09-02T00:00:00.000Z',
        details_completed_at: null,
        applied_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-02T00:00:00.000Z',
    },
    job: {
        id: 'job-1',
        title: 'Concrete Finisher',
        company_name: 'RM Construction',
        status: 'active',
        required_fields: ['date_available'],
        optional_fields: [],
        required_docs: [],
        optional_docs: [],
        certification_requirements: [],
        pre_application_prompts: [{ id: 'p1', text: 'Why this job?' }],
    },
    answers: {},
    certifications: [],
    prompt_answers: { p1: 'Because I finish concrete.' },
    documents: [],
    remaining: {
        prompts: [],
        fields: ['date_available'],
        certifications: { unclaimed: [], unproven: [] },
        docs: [],
        uncollectableDocs: [],
        optionalFields: [],
        optionalDocs: [],
        counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
        complete: false,
    },
    next_step: { kind: 'field', key: 'date_available' },
} as unknown as ApplicationRequirementsState;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** The parsed JSON body of the Nth (0-based) fetch call. */
function sentBody(call = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[call][1] as RequestInit;
    return JSON.parse(String(init.body));
}

function sentUrl(call = 0): string {
    return String(fetchMock.mock.calls[call][0]);
}

describe('applyToJob', () => {
    it('sends prompt_answers and nothing else', async () => {
        fetchMock.mockResolvedValue(json(201, { application_id: 'a1', status: 'pending' }));

        await applyToJob(TOKEN, 'job-1', { p1: 'Ten years of it.' });

        expect(sentUrl()).toContain('/worker/jobs/job-1/apply');
        // The legacy `answers` / `certification_claims` fields are gone from
        // the payload entirely -- the backend accepts and IGNORES them for one
        // release, so sending them would be silently discarded noise.
        expect(sentBody()).toEqual({ prompt_answers: { p1: 'Ten years of it.' } });
    });

    it('sends an empty prompt_answers object for a job with no prompts', async () => {
        fetchMock.mockResolvedValue(json(201, { application_id: 'a1', status: 'pending' }));

        await applyToJob(TOKEN, 'job-1', {});

        expect(sentBody()).toEqual({ prompt_answers: {} });
    });

    it('throws the typed 400 for an incomplete prompt set', async () => {
        fetchMock.mockResolvedValue(
            json(400, { error: 'missing_prompt_answers', missing: ['p1', 'p2'] }),
        );

        const err = await applyToJob(TOKEN, 'job-1', {}).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('missing_prompt_answers');
        // Allowlisted onto the payload so the apply UI can name the prompts.
        expect((err as ApiError).payload.missing).toEqual(['p1', 'p2']);
    });
});

describe('getApplicationRequirements', () => {
    it('returns the state document on 200', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));

        const state = await getApplicationRequirements(TOKEN, APPLICATION_ID);

        expect(sentUrl()).toContain(`/worker/applications/${APPLICATION_ID}`);
        expect(state.remaining.counts.fields).toBe(1);
        expect(state.application.details_status).toBe('requested');
    });

    it('throws ApiError for an unknown application', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'not_found' }));

        const err = await getApplicationRequirements(TOKEN, APPLICATION_ID).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('not_found');
    });
});

describe('the three write doors', () => {
    it('posts field answers to /answers as { answers }', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: '2026-10-01' });

        expect(sentUrl()).toContain(`/worker/applications/${APPLICATION_ID}/answers`);
        expect(sentBody()).toEqual({ answers: { date_available: '2026-10-01' } });
        expect(result).toEqual({ kind: 'saved', state: STATE });
    });

    it('posts certification claims to /certifications as { claims }', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));

        const claims = [{ name: 'OSHA 10', has: true, doc_ids: ['d1'] }];
        const result = await postApplicationCertifications(TOKEN, APPLICATION_ID, claims);

        expect(sentUrl()).toContain(`/worker/applications/${APPLICATION_ID}/certifications`);
        expect(sentBody()).toEqual({ claims });
        expect(result.kind).toBe('saved');
    });

    it('posts prompt answers to /prompt-answers as { answers }', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));

        const result = await postApplicationPromptAnswers(TOKEN, APPLICATION_ID, { p1: 'Because.' });

        expect(sentUrl()).toContain(`/worker/applications/${APPLICATION_ID}/prompt-answers`);
        expect(sentBody()).toEqual({ answers: { p1: 'Because.' } });
        expect(result.kind).toBe('saved');
    });
});

describe('ApplicationSaveResult branches', () => {
    it('maps 400 invalid_answers to { kind: invalid } with the per-key map', async () => {
        fetchMock.mockResolvedValue(
            json(400, { error: 'invalid_answers', errors: { desired_pay: 'invalid_desired_pay' } }),
        );

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { desired_pay: 'lots' });

        expect(result).toEqual({ kind: 'invalid', errors: { desired_pay: 'invalid_desired_pay' } });
    });

    it('maps a shape-level invalid_answers (empty errors map) to { kind: invalid }', async () => {
        // The door answers `{ errors: {} }` for a non-object / empty / oversized
        // batch -- there is no offending key to name, but it is still a 400 the
        // form must render rather than an exception.
        fetchMock.mockResolvedValue(json(400, { error: 'invalid_answers', errors: {} }));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, {});

        expect(result).toEqual({ kind: 'invalid', errors: {} });
    });

    it('maps a 400 payload_too_large (post-merge column overflow) to { kind: too_large }', async () => {
        fetchMock.mockResolvedValue(json(400, { error: 'payload_too_large' }));

        const result = await postApplicationPromptAnswers(TOKEN, APPLICATION_ID, { p1: 'x'.repeat(2000) });

        expect(result).toEqual({ kind: 'too_large' });
    });

    it('maps a 413 payload_too_large (pre-DB body cap) to the same member', async () => {
        fetchMock.mockResolvedValue(json(413, { error: 'payload_too_large' }));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { references: 'x'.repeat(30000) });

        expect(result).toEqual({ kind: 'too_large' });
    });

    it('maps 409 stage_locked to { kind: blocked } carrying the fresh state', async () => {
        fetchMock.mockResolvedValue(json(409, { error: 'stage_locked', state: STATE }));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: '2026-10-01' });

        expect(result).toEqual({ kind: 'blocked', reason: 'stage_locked', state: STATE });
    });

    it('maps 409 application_closed to { kind: blocked } carrying the fresh state', async () => {
        fetchMock.mockResolvedValue(json(409, { error: 'application_closed', state: STATE }));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: '2026-10-01' });

        expect(result).toEqual({ kind: 'blocked', reason: 'application_closed', state: STATE });
    });

    it('maps 409 certification_document_limit to its own member (no state)', async () => {
        fetchMock.mockResolvedValue(json(409, { error: 'certification_document_limit' }));

        const result = await postApplicationCertifications(TOKEN, APPLICATION_ID, [
            { name: 'OSHA 10', has: true, doc_ids: ['d1'] },
        ]);

        expect(result).toEqual({ kind: 'certification_document_limit' });
    });

    it('maps 404 not_found to { kind: not_found }', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'not_found' }));

        const result = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: '2026-10-01' });

        expect(result).toEqual({ kind: 'not_found' });
    });

    it('still THROWS for 404 worker_not_found -- only a bare not_found is a union member', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'worker_not_found' }));

        const err = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: 'x' })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('worker_not_found');
    });

    it('throws rather than half-building a member when a 409 body is not JSON', async () => {
        // A proxy/CloudFront 409 with an HTML body must degrade to the generic
        // thrown error, never to `{ kind: 'blocked', state: undefined }`.
        fetchMock.mockResolvedValue(
            new Response('<html>409</html>', { status: 409, headers: { 'Content-Type': 'text/html' } }),
        );

        const err = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: 'x' })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
    });

    it('throws rather than returning `blocked` when a stage_locked 409 carries no state', async () => {
        fetchMock.mockResolvedValue(json(409, { error: 'stage_locked' }));

        const err = await postApplicationAnswers(TOKEN, APPLICATION_ID, { date_available: 'x' })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('stage_locked');
    });

    it('throws for a 500', async () => {
        fetchMock.mockResolvedValue(json(500, { error: 'internal_error' }));

        const err = await postApplicationPromptAnswers(TOKEN, APPLICATION_ID, { p1: 'x' })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(500);
    });
});
