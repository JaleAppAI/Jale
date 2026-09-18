import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The attention summary's compatibility seam.
 *
 * The server computes "what still needs this worker" over their WHOLE list,
 * because the list itself is paged and the banners are not about a page. A
 * frontend can deploy before that lambda does, though, so a response without
 * the summary must not silently turn every banner off: the client derives one
 * from the rows in hand -- exactly the rule the two pages used to apply for
 * themselves, and no more complete than the page is.
 */

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api')>()),
    apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { getApplications } = await import('@/lib/api/worker');

const hire = {
    hired_at: '2026-09-02T00:00:00.000Z',
    seen_at: null,
    acknowledged_at: null,
    start_date: null,
    location: null,
    pay: null,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    shift_schedule: null,
    trade: { category: 'drywall', other: null, canonical_en: null, canonical_es: null },
    company: 'Hiring Co',
};

function row(over: Record<string, unknown> = {}) {
    return {
        application_id: 'a1',
        job_id: 'j1',
        job_title: 'Roofer',
        company_name: 'Acme',
        status: 'pending',
        applied_at: '2026-09-01T00:00:00.000Z',
        ...over,
    };
}

function answer(body: unknown) {
    apiFetch.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('getApplications — the attention summary', () => {
    it('takes the server\'s summary as authoritative', async () => {
        // Deliberately naming an application the page does NOT contain: the
        // summary spans the whole list, which is the entire point of it.
        answer({
            applications: [row()],
            next_cursor: 'c1',
            attention: {
                details_requested: [{
                    application_id: 'a137',
                    job_id: 'j137',
                    job_title: 'Framer',
                    company_name: 'Older Co',
                    remaining_count: 2,
                }],
                unacknowledged_hires: [],
            },
        });

        const page = await getApplications('token');

        expect(page.attention.details_requested).toHaveLength(1);
        expect(page.attention.details_requested[0].application_id).toBe('a137');
    });

    it('derives one from the rows when the server sends none', async () => {
        answer({
            applications: [
                row({ application_id: 'waiting', details_status: 'requested', remaining_count: 3 }),
                row({ application_id: 'hired', status: 'hired', hire }),
                row({ application_id: 'ordinary' }),
            ],
        });

        const page = await getApplications('token');

        expect(page.attention.details_requested.map((a) => a.application_id)).toEqual(['waiting']);
        expect(page.attention.details_requested[0].remaining_count).toBe(3);
        expect(page.attention.unacknowledged_hires.map((a) => a.application_id)).toEqual(['hired']);
        expect(page.attention.unacknowledged_hires[0].hire.company).toBe('Hiring Co');
    });

    it('leaves an acknowledged hire, and a hire on a row no longer hired, out of it', async () => {
        answer({
            applications: [
                row({ application_id: 'done', status: 'hired', hire: { ...hire, acknowledged_at: '2026-09-03T00:00:00.000Z' } }),
                // `status` is the authority: a `hire` block left behind on a
                // row an employer moved back out of 'hired' congratulates
                // nobody.
                row({ application_id: 'reverted', status: 'talking', hire }),
            ],
        });

        const page = await getApplications('token');

        expect(page.attention.unacknowledged_hires).toEqual([]);
    });

    it('answers with empty lists rather than nothing at all', async () => {
        answer({ applications: [], next_cursor: null });

        const page = await getApplications('token');

        // The pages read these arrays unconditionally; an absent summary would
        // be a crash rather than a quiet screen.
        expect(page.attention).toEqual({ details_requested: [], unacknowledged_hires: [] });
    });

    it('ignores a summary that is not one', async () => {
        answer({ applications: [row({ details_status: 'requested' })], attention: 'soon' });

        const page = await getApplications('token');

        expect(page.attention.details_requested).toHaveLength(1);
    });
});
