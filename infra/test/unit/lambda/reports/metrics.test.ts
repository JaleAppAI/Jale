import {
  REPORTS_METRIC_NAMESPACE,
  emitCleanupCompleted,
  emitCleanupFailed,
  emitEmailSkipped,
  emitIntakeError,
  emitReportCapture,
  emitReportCreated,
  emitRateLimited,
  emitRoleUnknown,
  emitUploadRejected,
} from '../../../../lambda/reports/lib/metrics';

interface EmfLine {
  _aws: { CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string }> }> };
  [key: string]: unknown;
}

let lines: EmfLine[];
let logSpy: jest.SpyInstance;

beforeEach(() => {
  lines = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation((text: string) => {
    lines.push(JSON.parse(text));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

/** Name, value and declared dimensions of every metric emitted. */
function emitted(): Array<{ name: string; value: unknown; dimensions: Record<string, unknown> }> {
  return lines.flatMap((line) => {
    const [directive] = line._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe(REPORTS_METRIC_NAMESPACE);
    expect(directive.Dimensions).toHaveLength(1);
    const dimensions = Object.fromEntries(directive.Dimensions[0].map((key) => [key, line[key]]));
    return directive.Metrics.map(({ Name }) => ({ name: Name, value: line[Name], dimensions }));
  });
}

describe('report metrics', () => {
  it('are in the Jale/Reports namespace', () => {
    expect(REPORTS_METRIC_NAMESPACE).toBe('Jale/Reports');
  });

  it('emit ReportsCreated twice: once with no dimensions for the alarm, once by role and verified', () => {
    emitReportCreated('employer', false);
    expect(emitted()).toEqual([
      { name: 'ReportsCreated', value: 1, dimensions: {} },
      { name: 'ReportsCreated', value: 1, dimensions: { Role: 'employer', Verified: 'false' } },
    ]);
  });

  it.each<[string, () => void, { name: string; value: number; dimensions: Record<string, string> }]>([
    ['the capture outcome', () => emitReportCapture('timeout'), { name: 'ReportCapture', value: 1, dimensions: { Outcome: 'timeout' } }],
    ['an upload rejection', () => emitUploadRejected('magic'), { name: 'ReportUploadRejected', value: 1, dimensions: { Reason: 'magic' } }],
    ['a rate limit', () => emitRateLimited('global'), { name: 'ReportRateLimited', value: 1, dimensions: { Scope: 'global' } }],
    ['a skipped team email', () => emitEmailSkipped(), { name: 'ReportEmailSkipped', value: 1, dimensions: {} }],
    ['an intake error', () => emitIntakeError(), { name: 'ReportIntakeErrors', value: 1, dimensions: {} }],
    ['a sign-in whose role is unknown', () => emitRoleUnknown(), { name: 'ReportRoleUnknown', value: 1, dimensions: {} }],
    ['a failed clean-up', () => emitCleanupFailed(), { name: 'ReportCleanupFailed', value: 1, dimensions: {} }],
  ])('emit %s', (_label, emit, expected) => {
    emit();
    expect(emitted()).toEqual([expected]);
  });

  it('emit the clean-up counts per kind and the run total with no dimensions', () => {
    emitCleanupCompleted({
      contents_erased: 2, images_expired: 3, pending_cleared: 1, notifications_deleted: 4, buckets_deleted: 0,
    });
    const metrics = emitted();
    expect(metrics).toEqual(expect.arrayContaining([
      { name: 'ReportCleanupDeleted', value: 2, dimensions: { Kind: 'contents_erased' } },
      { name: 'ReportCleanupDeleted', value: 3, dimensions: { Kind: 'images_expired' } },
      { name: 'ReportCleanupDeleted', value: 1, dimensions: { Kind: 'pending_cleared' } },
      { name: 'ReportCleanupDeleted', value: 4, dimensions: { Kind: 'notifications_deleted' } },
      { name: 'ReportCleanupDeleted', value: 0, dimensions: { Kind: 'buckets_deleted' } },
      { name: 'ReportCleanupDeleted', value: 10, dimensions: {} },
    ]));
    expect(metrics).toHaveLength(6);
  });

  it('emit a zero total for a run that deleted nothing', () => {
    emitCleanupCompleted({
      contents_erased: 0, images_expired: 0, pending_cleared: 0, notifications_deleted: 0, buckets_deleted: 0,
    });
    expect(emitted()).toContainEqual({ name: 'ReportCleanupDeleted', value: 0, dimensions: {} });
  });
});
