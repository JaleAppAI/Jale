import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api')>()),
    apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { sendApplicationMessage, remindEmployer } = await import('@/lib/api/worker');
const { updateHireDetails } = await import('@/lib/api/employer');
const { ApiError } = await import('@/lib/api/errors');

function answer(status: number, body: unknown) {
    apiFetch.mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        clone() { return this; },
    });
}

const DETAILS_IN = {
    start_date: '2026-10-20',
    report_location: 'Gate 3',
    contact_name: 'Site lead',
    contact_phone: '+1 (000) 000-0000',
    notes: null,
};

beforeEach(() => vi.clearAllMocks());

describe('sendApplicationMessage (K4.3)', () => {
    it('posts the body to the application and returns what was sent', async () => {
        answer(201, { conversation_id: 'c1', message_id: 'm1', sent_at: '2026-10-14T15:00:00Z' });

        const sent = await sendApplicationMessage('tok', 'app-1', { body: 'On my way' });

        expect(apiFetch).toHaveBeenCalledWith(
            '/worker/applications/app-1/message',
            { method: 'POST', body: JSON.stringify({ body: 'On my way' }) },
            'tok',
        );
        expect(sent).toEqual({ conversation_id: 'c1', message_id: 'm1', sent_at: '2026-10-14T15:00:00Z' });
    });

    it('throws rate_limited with the wait the server names', async () => {
        answer(429, { error: 'rate_limited', retry_after_seconds: 1800 });

        const err = await sendApplicationMessage('tok', 'app-1', { body: 'Hi' }).catch((e) => e);

        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
        expect(err.payload.retry_after_seconds).toBe(1800);
    });

    it('throws not_hired for an application that is not hired', async () => {
        answer(409, { error: 'not_hired' });
        await expect(sendApplicationMessage('tok', 'app-1', { body: 'Hi' })).rejects.toMatchObject({ code: 'not_hired' });
    });
});

describe('remindEmployer (K4.4)', () => {
    it('posts to the remind door and resolves on 202', async () => {
        answer(202, {});
        await expect(remindEmployer('tok', 'app-1')).resolves.toBeUndefined();
        expect(apiFetch).toHaveBeenCalledWith(
            '/worker/applications/app-1/remind-employer',
            { method: 'POST', body: '{}' },
            'tok',
        );
    });

    it('throws rate_limited on 429', async () => {
        answer(429, { error: 'rate_limited' });
        await expect(remindEmployer('tok', 'app-1')).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    });
});

describe('updateHireDetails (K4.2)', () => {
    it('puts all five fields and returns the saved details', async () => {
        answer(200, { hire_details: { ...DETAILS_IN, updated_at: '2026-10-14T15:00:00Z' } });

        const saved = await updateHireDetails('tok', 'job-1', 'w-1', DETAILS_IN);

        expect(apiFetch).toHaveBeenCalledWith(
            '/employer/jobs/job-1/applicants/w-1/hire-details',
            { method: 'PUT', body: JSON.stringify(DETAILS_IN) },
            'tok',
        );
        expect(saved).toEqual({ ...DETAILS_IN, updated_at: '2026-10-14T15:00:00Z' });
    });

    it('resolves null when the save left every field empty', async () => {
        answer(200, { hire_details: null });

        await expect(updateHireDetails('tok', 'job-1', 'w-1', {
            start_date: null, report_location: null, contact_name: null, contact_phone: null, notes: null,
        })).resolves.toBeNull();
    });

    it('throws invalid_hire_details with the fields the server refused', async () => {
        answer(400, { error: 'invalid_hire_details', fields: ['contact_phone'] });

        const err = await updateHireDetails('tok', 'job-1', 'w-1', DETAILS_IN).catch((e) => e);

        expect(err).toMatchObject({ status: 400, code: 'invalid_hire_details' });
        expect(err.payload.fields).toEqual(['contact_phone']);
    });
});
