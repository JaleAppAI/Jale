// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyIntent, getPublicJob, getPublicJobsList, getReferrerContext, sendOpenBeacon } from '../../api/publicJob';
import { confirmUpload, getUploadUrl, putVoiceRecording, submitUpload, uploadFileToS3 } from '../../api/worker';
import { workerSignUp } from '../../cognito';
import { clearReportBuffers, collectReportContext, type ReportContextV1 } from '../context';

/**
 * The requests that bypass `apiFetch` record themselves: one entry per
 * request, as a pattern. A presigned upload is `s3:upload` and its address
 * is never kept; codes, tokens and the phone typed at sign-up never appear.
 */

const BASE = 'https://app.example.test/api';
const REQUEST_ID = '0000aaaa-1111-4222-8333-444455556666';
const PRESIGNED = `https://bucket.example.test/incoming/upload-key?X-Amz-Signature=${'ab'.repeat(32)}`;
const JOB_CODE = 'ABC234';
const SHARE_CODE = 'XYZ23456';
const LINK_TOKEN = 'cd'.repeat(32);
const PHONE = '+15550100199';

function response(status = 200, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'x-amzn-requestid': REQUEST_ID }),
    json: async () => body,
    clone() { return this; },
  } as unknown as Response;
}

function context(): Required<ReportContextV1> {
  return collectReportContext({ includeTechnical: true, capture: { outcome: 'none', ms: 0 } }) as Required<ReportContextV1>;
}

function recorded() {
  return context().requests.map(({ m, p, s }) => ({ m, p, s }));
}

function expectNothingSecret() {
  const sent = JSON.stringify(context());
  for (const secret of ['bucket.example.test', 'X-Amz', JOB_CODE, SHARE_CODE, LINK_TOKEN, PHONE, '5550100199']) {
    expect(sent).not.toContain(secret);
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearReportBuffers();
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', BASE);
  fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, 'sendBeacon');
});

describe('the one-time upload link (lib/api/worker.ts)', () => {
  it('getUploadUrl records its POST', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { url: PRESIGNED, s3_key: 'k' }));
    await getUploadUrl(LINK_TOKEN, 'resume', 'application/pdf');
    expect(recorded()).toEqual([{ m: 'POST', p: '/worker/documents/upload-url', s: 200 }]);
    expect(context().requests[0].rid).toBe(REQUEST_ID);
    expectNothingSecret();
  });

  it('uploadFileToS3 records s3:upload and never the presigned address', async () => {
    await uploadFileToS3(PRESIGNED, new File(['x'], 'resume.pdf', { type: 'application/pdf' }));
    expect(fetchMock).toHaveBeenCalledWith(PRESIGNED, expect.objectContaining({ method: 'PUT' }));
    expect(recorded()).toEqual([{ m: 'PUT', p: 's3:upload', s: 200 }]);
    expectNothingSecret();
  });

  it('uploadFileToS3 records a failed upload as status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(uploadFileToS3(PRESIGNED, new File(['x'], 'a.pdf'))).rejects.toThrow(TypeError);
    expect(recorded()).toEqual([{ m: 'PUT', p: 's3:upload', s: 0 }]);
  });

  it('confirmUpload and submitUpload record their POSTs', async () => {
    await confirmUpload(LINK_TOKEN, 'incoming/key', 'resume', new File(['x'], 'resume.pdf', { type: 'application/pdf' }));
    fetchMock.mockResolvedValueOnce(response(410, { error: 'token_expired' }));
    await expect(submitUpload(LINK_TOKEN)).rejects.toMatchObject({ status: 410 });
    expect(recorded()).toEqual([
      { m: 'POST', p: '/worker/documents/confirm', s: 200 },
      { m: 'POST', p: '/worker/documents/submit', s: 410 },
    ]);
    expectNothingSecret();
  });

  it('putVoiceRecording records s3:upload, including when the network fails', async () => {
    await expect(putVoiceRecording(PRESIGNED, new Blob(['x']), 'audio/webm')).resolves.toEqual({ kind: 'uploaded' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(putVoiceRecording(PRESIGNED, new Blob(['x']), 'audio/webm')).resolves.toEqual({ kind: 'failed' });
    expect(recorded()).toEqual([
      { m: 'PUT', p: 's3:upload', s: 200 },
      { m: 'PUT', p: 's3:upload', s: 0 },
    ]);
    expectNothingSecret();
  });
});

describe('worker sign-up (lib/cognito.ts)', () => {
  it('records the POST and never the phone', async () => {
    await workerSignUp({ phone: PHONE });
    expect(recorded()).toEqual([{ m: 'POST', p: '/auth/worker/signup', s: 200 }]);
    expectNothingSecret();
  });
});

describe('the public job page (lib/api/publicJob.ts)', () => {
  it('getPublicJob records its GET, and keeps the fetch options it is deduplicated on', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { code: JOB_CODE, status: 'active' }));
    await getPublicJob(JOB_CODE);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/public/jobs/${JOB_CODE}`, { next: { revalidate: 60 } });
    expect(recorded()).toEqual([{ m: 'GET', p: '/public/jobs/:code', s: 200 }]);
    expectNothingSecret();
  });

  it('getReferrerContext records its GET, and a network failure as status 0', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { kind: 'worker', first_name: null }));
    await getReferrerContext(JOB_CODE, SHARE_CODE);
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/public/jobs/${JOB_CODE}/referrer?r=${SHARE_CODE}`);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getReferrerContext(JOB_CODE, SHARE_CODE)).resolves.toBeNull();
    expect(recorded()).toEqual([
      { m: 'GET', p: '/public/jobs/:code/referrer', s: 200 },
      { m: 'GET', p: '/public/jobs/:code/referrer', s: 0 },
    ]);
    expectNothingSecret();
  });

  it('sendOpenBeacon records the beacon, with status 0 because a beacon has no response', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    sendOpenBeacon(JOB_CODE, SHARE_CODE);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(context().requests).toEqual([{ m: 'POST', p: '/public/jobs/:code/open', s: 0, ms: 0 }]);
    expectNothingSecret();
  });

  it('sendOpenBeacon records its fallback fetch when there is no sendBeacon', async () => {
    fetchMock.mockResolvedValueOnce(response(204));
    sendOpenBeacon(JOB_CODE, null);
    await vi.waitFor(() => expect(recorded()).toEqual([{ m: 'POST', p: '/public/jobs/:code/open', s: 204 }]));
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/public/jobs/${JOB_CODE}/open`, expect.objectContaining({ keepalive: true }));
  });

  it('applyIntent records its POST', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { token: 't', whatsappUrl: 'u' }));
    await applyIntent(JOB_CODE, SHARE_CODE);
    expect(recorded()).toEqual([{ m: 'POST', p: '/public/jobs/:code/apply-intent', s: 200 }]);
    expectNothingSecret();
  });

  it('getPublicJobsList records every page, the 429 retry included', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, { jobs: [], next_cursor: 'next-page' }))
      .mockResolvedValueOnce(response(200, { jobs: [], next_cursor: null }));
    await getPublicJobsList(async () => {});
    expect(recorded()).toEqual([
      { m: 'GET', p: '/public/jobs', s: 429 },
      { m: 'GET', p: '/public/jobs', s: 200 },
      { m: 'GET', p: '/public/jobs', s: 200 },
    ]);
  });
});
