import { emitEmfMetrics } from '../../../../lambda/lib/emf';

function captureLine(fn: () => void): Record<string, any> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fn();
    expect(logSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(logSpy.mock.calls[0][0] as string);
  } finally {
    logSpy.mockRestore();
  }
}

describe('emitEmfMetrics', () => {
  it('declares the given dimensions as one dimension set, with matching top-level fields', () => {
    const line = captureLine(() =>
      emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 2 }], { Kind: 'a' }));
    expect(line._aws.CloudWatchMetrics).toEqual([{
      Namespace: 'Jale/Test',
      Dimensions: [['Kind']],
      Metrics: [{ Name: 'Thing', Unit: 'Count' }],
    }]);
    expect(line.Kind).toBe('a');
    expect(line.Thing).toBe(2);
  });

  it('declares [[]] when there are no dimensions', () => {
    const line = captureLine(() => emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 1 }]));
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it('with rollup, also declares the dimensionless set, so an alarm with no Dimensions sees every emission', () => {
    const line = captureLine(() =>
      emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 1 }], { Login: 'jale_api' }, { rollup: true }));
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Login'], []]);
    expect(line.Login).toBe('jale_api');
    expect(line.Thing).toBe(1);
  });

  it('with rollup but no dimensions, declares the single dimensionless set once', () => {
    const line = captureLine(() =>
      emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 1 }], {}, { rollup: true }));
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it('writes extra fields as top-level properties ahead of the envelope, without declaring them', () => {
    const line = captureLine(() =>
      emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 1 }], { Kind: 'a' }, {}, { origin: 'api', count: 3 }));
    expect(Object.keys(line).slice(0, 3)).toEqual(['origin', 'count', '_aws']);
    expect(line.origin).toBe('api');
    expect(line.count).toBe(3);
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Kind']]);
    expect(line.Kind).toBe('a');
    expect(line.Thing).toBe(1);
  });

  it('never lets an extra field replace the envelope, a dimension or a metric value', () => {
    const line = captureLine(() =>
      emitEmfMetrics('Jale/Test', [{ name: 'Thing', value: 2 }], { Kind: 'a' }, {},
        { _aws: 'replaced', Kind: 'field', Thing: 99, note: 'kept' }));
    expect(line._aws.CloudWatchMetrics).toEqual([{
      Namespace: 'Jale/Test',
      Dimensions: [['Kind']],
      Metrics: [{ Name: 'Thing', Unit: 'Count' }],
    }]);
    expect(line.Kind).toBe('a');
    expect(line.Thing).toBe(2);
    expect(line.note).toBe('kept');
  });
});
