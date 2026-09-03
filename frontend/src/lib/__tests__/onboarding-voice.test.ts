import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    VOICE_POLL_CEILING_MS,
    baseContentType,
    pickRecordingMimeType,
    transcribeVoiceAnswer,
    type VoiceAnswerClock,
} from '../onboarding-voice';
import { MAX_VOICE_BYTES } from '../api/worker';

/**
 * The voice-answer sequence, driven through REAL `Response` objects (the
 * helpers under it clone and re-read bodies, which a `clone(): this` stub
 * cannot catch) and a FAKE clock (the real one would make the ceiling test a
 * one-minute test).
 */

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TOKEN = 'id-token';
const REQUEST = {
    token: TOKEN,
    contentType: 'audio/webm;codecs=opus',
    stepKey: 'trust.question.1',
    questionIndex: 0,
    lockVersion: 4,
};

function blob(bytes = 1024): Blob {
    return new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' });
}

/** Advances only when the code sleeps, so a 60s ceiling costs no real time. */
function fakeClock(): VoiceAnswerClock & { elapsed: number } {
    const clock = {
        elapsed: 0,
        now: () => clock.elapsed,
        sleep: async (ms: number) => { clock.elapsed += ms; },
    };
    return clock;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** presign, S3 PUT, transcribe, then one response per poll. */
function script(...polls: Response[]): void {
    fetchMock
        .mockResolvedValueOnce(json(200, {
            key: 'voice/w1/abc.webm', url: 'https://s3.test/put', expiresAt: '2026-09-02T12:05:00.000Z',
        }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(json(202, { transcriptOutputKey: 'voice/w1/transcripts/jale-vtw-abc.json' }));
    for (const poll of polls) fetchMock.mockResolvedValueOnce(poll);
}

describe('baseContentType', () => {
    it('strips codec parameters and accepts only the allowlist', () => {
        expect(baseContentType('audio/webm;codecs=opus')).toBe('audio/webm');
        expect(baseContentType('AUDIO/MP4')).toBe('audio/mp4');
        expect(baseContentType('video/mp4')).toBeNull();
        expect(baseContentType(undefined)).toBeNull();
    });
});

describe('pickRecordingMimeType', () => {
    it('prefers opus webm, falls back through the list, and gives up cleanly', () => {
        expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
        expect(pickRecordingMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
        expect(pickRecordingMimeType(() => false)).toBeNull();
    });

    // Safari has historically thrown from isTypeSupported for odd inputs; a
    // throw must read as "cannot record", never crash the screen.
    it('treats a throwing isTypeSupported as unsupported', () => {
        expect(pickRecordingMimeType(() => { throw new Error('nope'); })).toBeNull();
    });
});

describe('transcribeVoiceAnswer', () => {
    it('presigns, PUTs the recording, starts the job and returns the transcript', async () => {
        script(json(200, { transcript: 'I frame houses.', confidence: 0.91 }));

        const outcome = await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock());

        expect(outcome).toEqual({ kind: 'transcribed', transcript: 'I frame houses.', confidence: 0.91 });

        // The presign asks for the BASE type, not MediaRecorder's parameterized one.
        const presignBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(presignBody).toEqual({
            stepKey: 'trust.question.1', questionIndex: 0, contentType: 'audio/webm', sizeBytes: 1024,
        });

        // The S3 PUT goes to the presigned URL with NO Authorization header —
        // S3 would treat one as a competing SigV4 credential — and with the
        // Content-Type that was signed.
        const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(putUrl).toBe('https://s3.test/put');
        expect(putInit.method).toBe('PUT');
        expect(putInit.headers).toEqual({ 'Content-Type': 'audio/webm' });
        expect(JSON.stringify(putInit.headers)).not.toContain('Authorization');

        const startBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
        expect(startBody).toEqual({
            key: 'voice/w1/abc.webm', stepKey: 'trust.question.1', questionIndex: 0, lockVersion: 4,
        });
    });

    it('omits confidence when the provider reported none', async () => {
        script(json(200, { transcript: 'I hang doors.' }));
        const outcome = await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock());
        expect(outcome).toEqual({ kind: 'transcribed', transcript: 'I hang doors.' });
    });

    it('polls with backoff while the job is pending', async () => {
        script(
            json(202, { status: 'pending' }),
            json(202, { status: 'pending' }),
            json(200, { transcript: 'I set trusses.' }),
        );
        const clock = fakeClock();

        const outcome = await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, clock);

        expect(outcome).toMatchObject({ kind: 'transcribed' });
        // Backoff, not a fixed interval: 1.5s + 2s + 3s.
        expect(clock.elapsed).toBe(6500);
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('gives up at the 60s ceiling rather than polling forever', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { key: 'voice/w1/a.webm', url: 'https://s3.test/put', expiresAt: 'x' }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(json(202, { transcriptOutputKey: 'k' }))
            .mockResolvedValue(json(202, { status: 'pending' }));
        const clock = fakeClock();

        const outcome = await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, clock);

        expect(outcome).toEqual({ kind: 'timeout' });
        expect(clock.elapsed).toBeLessThanOrEqual(VOICE_POLL_CEILING_MS);
    });

    // 410 is the door's answer for "Transcribe finished and heard nothing" —
    // silence, or a failed job the receiver left a marker for. Not retryable.
    it('reports an unusable transcription as such, not as a failure to retry', async () => {
        script(json(410, { error: 'transcription_failed' }));
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toEqual({ kind: 'unusable' });
    });

    it('keeps polling through a transient poll failure', async () => {
        script(
            json(500, { error: 'internal_error' }),
            json(200, { transcript: 'I frame houses.' }),
        );
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toMatchObject({ kind: 'transcribed' });
    });

    it('reports a lock conflict as a conflict, so the caller re-reads rather than retrying', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { key: 'voice/w1/a.webm', url: 'https://s3.test/put', expiresAt: 'x' }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(json(409, { error: 'lock_conflict' }));
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toEqual({ kind: 'conflict' });
    });

    it('reports a step mismatch as a conflict too', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { key: 'voice/w1/a.webm', url: 'https://s3.test/put', expiresAt: 'x' }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(json(422, { error: 'step_mismatch' }));
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toEqual({ kind: 'conflict' });
    });

    // Checked before the upload so a worker who talked for ten minutes is told
    // so, rather than waiting out an upload that ends in a 400.
    it('refuses an oversized recording without touching the network', async () => {
        const big = { size: MAX_VOICE_BYTES + 1, type: 'audio/webm' } as Blob;
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: big }, fakeClock()))
            .toEqual({ kind: 'rejected', reason: 'file_too_large' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats an empty recording as unusable without touching the network', async () => {
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob(0) }, fakeClock()))
            .toEqual({ kind: 'unusable' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a container the door would not accept', async () => {
        expect(await transcribeVoiceAnswer({ ...REQUEST, contentType: 'audio/aiff', blob: blob() }, fakeClock()))
            .toEqual({ kind: 'rejected', reason: 'invalid_content_type' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a rejected presign as its own reason', async () => {
        fetchMock.mockResolvedValueOnce(json(400, {
            error: 'invalid_content_type', allowed: ['audio/webm'],
        }));
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toEqual({ kind: 'rejected', reason: 'invalid_content_type' });
    });

    it('fails cleanly when the S3 PUT is refused, and never starts a job', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { key: 'voice/w1/a.webm', url: 'https://s3.test/put', expiresAt: 'x' }))
            .mockResolvedValueOnce(new Response('<Error/>', { status: 403 }));
        expect(await transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .toEqual({ kind: 'failed' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never throws when the network is gone', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(transcribeVoiceAnswer({ ...REQUEST, blob: blob() }, fakeClock()))
            .resolves.toEqual({ kind: 'failed' });
    });
});
