import {
  JOB_VIEW_SOURCES,
  captureBestEffort,
  isJobViewSource,
  recordFeedImpressions,
  recordJobView,
  recordSignupSource,
  recordWhatsAppImpressions,
} from '../../../../lambda/lib/analytics-capture';

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';

function fakeClient(fail: (sql: string) => Error | null = () => null) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  return {
    calls,
    statements: () => calls.map((c) => c.sql),
    client: {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const err = fail(sql);
        if (err) throw err;
        return { rows: [], rowCount: 0 };
      }),
    },
  };
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('analytics-capture', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  describe('captureBestEffort', () => {
    it('runs the capture under its own savepoint and releases it', async () => {
      const f = fakeClient();
      await expect(captureBestEffort(f.client, 'job_view', 'SELECT 1', [JOB_A])).resolves.toBe(true);
      expect(f.statements()).toEqual(['SAVEPOINT analytics_capture', 'SELECT 1', 'RELEASE SAVEPOINT analytics_capture']);
      expect(f.calls[1].params).toEqual([JOB_A]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a failing capture rolls back to its savepoint, logs one static line and never throws', async () => {
      const f = fakeClient((sql) => (sql === 'SELECT 1' ? pgError('23503', `Key (job_id)=(${JOB_A}) is not present`) : null));
      await expect(captureBestEffort(f.client, 'job_view', 'SELECT 1', [JOB_A])).resolves.toBe(false);
      expect(f.statements()).toEqual([
        'SAVEPOINT analytics_capture',
        'SELECT 1',
        'ROLLBACK TO SAVEPOINT analytics_capture',
        'RELEASE SAVEPOINT analytics_capture',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({ metric: 'AnalyticsCaptureSkipped', capture: 'job_view', code: '23503' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(JOB_A);
    });

    it('a failure to open or to roll back the savepoint is swallowed too', async () => {
      const opening = fakeClient((sql) => (sql.startsWith('SAVEPOINT') ? new Error('connection lost') : null));
      await expect(captureBestEffort(opening.client, 'signup_source', 'SELECT 1', [])).resolves.toBe(false);
      expect(opening.statements()).toEqual(['SAVEPOINT analytics_capture']);

      const rollingBack = fakeClient((sql) => (sql === 'SELECT 1' || sql.startsWith('ROLLBACK') ? new Error('boom') : null));
      await expect(captureBestEffort(rollingBack.client, 'signup_source', 'SELECT 1', [])).resolves.toBe(false);
      expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toEqual({ metric: 'AnalyticsCaptureSkipped', capture: 'signup_source', code: 'unknown' });
    });
  });

  describe('the capture calls', () => {
    it('records a signup source through jale_cap.record_signup_source, always for the web door', async () => {
      const f = fakeClient();
      await recordSignupSource(f.client, USER, { src: 'qr', entry: 'app' });
      expect(f.calls[1]).toEqual({ sql: 'SELECT jale_cap.record_signup_source($1, $2, $3, $4)', params: [USER, 'web', 'app', 'qr'] });
    });

    it('records a job view through jale_cap.record_job_view', async () => {
      const f = fakeClient();
      await recordJobView(f.client, JOB_A, 'public_link');
      expect(f.calls[1]).toEqual({ sql: 'SELECT jale_cap.record_job_view($1, $2)', params: [JOB_A, 'public_link'] });
    });

    it('records the feed in one call, and nothing for an empty feed', async () => {
      const f = fakeClient();
      await recordFeedImpressions(f.client, [JOB_A, JOB_B]);
      expect(f.calls[1]).toEqual({ sql: 'SELECT jale_cap.record_feed_impressions($1::uuid[])', params: [[JOB_A, JOB_B]] });

      const empty = fakeClient();
      await expect(recordFeedImpressions(empty.client, [])).resolves.toBe(false);
      expect(empty.calls).toEqual([]);
    });

    it('records a WhatsApp alert with its intent, and a job list with none', async () => {
      const f = fakeClient();
      await recordWhatsAppImpressions(f.client, [JOB_A], INTENT);
      await recordWhatsAppImpressions(f.client, [JOB_A, JOB_B], null);
      expect(f.calls.filter((c) => c.sql.includes('record_whatsapp_impressions'))).toEqual([
        { sql: 'SELECT jale_cap.record_whatsapp_impressions($1::uuid[], $2::uuid)', params: [[JOB_A], INTENT] },
        { sql: 'SELECT jale_cap.record_whatsapp_impressions($1::uuid[], $2::uuid)', params: [[JOB_A, JOB_B], null] },
      ]);
    });

    it('sends at most 200 jobs in one call', async () => {
      const f = fakeClient();
      const many = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await recordFeedImpressions(f.client, many);
      expect((f.calls[1].params?.[0] as string[]).length).toBe(200);
    });
  });

  describe('isJobViewSource', () => {
    it.each([...JOB_VIEW_SOURCES])('accepts %s', (source) => {
      expect(isJobViewSource(source)).toBe(true);
    });
    it.each([['an unknown source', 'newsletter'], ['null', null], ['a number', 1], ['an inherited name', 'toString']])(
      'rejects %s',
      (_label, value) => {
        expect(isJobViewSource(value)).toBe(false);
      },
    );
  });
});
