import type { TutorialRecord, TutorialSettings } from '@/lib/api/tutorials';
import { apiFetch, jsonResponse } from './harness';

/**
 * The tutorial endpoints with guide settings (K1-v2), for the settings
 * suites. Not a `.test.` file, so vitest collects it as a helper.
 *
 *  - GET answers `{ tutorials, settings }` (or the given failure);
 *  - POST echoes the record it was sent, as the backend's first write does;
 *  - PATCH answers the stored settings after the patch (or the given failure).
 *
 * `stored()` is what the fake server holds now, so a suite can tell an
 * optimistic screen from a saved one.
 */
export type SettingsServer = {
    stored: () => TutorialSettings;
};

/** How PATCH answers: `save` stores the patch and answers it; otherwise the failure, or a promise to hold it on. */
export type PatchAnswer = 'save' | { status: number; body?: unknown } | (() => Promise<Response>);

export function serveTutorialsWithSettings({
    records = [],
    settings = { always_show: false, muted: [] },
    read,
    patch = 'save',
    post = 'echo',
}: {
    records?: TutorialRecord[];
    settings?: TutorialSettings | null;
    /** A failed read instead of the records and settings. */
    read?: { status: number; body?: unknown };
    patch?: PatchAnswer;
    post?: 'echo' | { status: number; body?: unknown };
} = {}): SettingsServer {
    let stored: TutorialSettings = settings ? { ...settings, muted: [...settings.muted] } : { always_show: false, muted: [] };
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (!/\/(employer|worker)\/tutorials$/.test(path)) return jsonResponse(404, { error: 'not_found' });
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
            if (post !== 'echo') return jsonResponse(post.status, post.body ?? {});
            const sent = JSON.parse(String(init?.body)) as Pick<TutorialRecord, 'tutorial_id' | 'outcome'>;
            return jsonResponse(200, { tutorial: { ...sent, recorded_at: '2026-10-22T18:00:00.000Z' } });
        }
        if (method === 'PATCH') {
            if (typeof patch === 'function') return patch();
            if (patch !== 'save') return jsonResponse(patch.status, patch.body ?? {});
            const sent = JSON.parse(String(init?.body)) as Partial<TutorialSettings>;
            stored = { ...stored, ...sent };
            return jsonResponse(200, { settings: stored });
        }
        if (read) return jsonResponse(read.status, read.body ?? {});
        return jsonResponse(200, settings === null ? { tutorials: records } : { tutorials: records, settings: stored });
    });
    return { stored: () => stored };
}

/** The PATCH bodies sent so far. */
export function settingsPatches(): unknown[] {
    return apiFetch.mock.calls
        .filter(([path, init]) => String(path).includes('/tutorials') && (init as RequestInit | undefined)?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

/** The POST bodies sent so far. */
export function recordPosts(): unknown[] {
    return apiFetch.mock.calls
        .filter(([path, init]) => String(path).includes('/tutorials') && (init as RequestInit | undefined)?.method === 'POST')
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}
