const mockSend = jest.fn();

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockSend })),
  DescribeInstancesCommand: jest.fn((input: unknown) => ({ __type: 'Describe', input })),
  StopInstancesCommand: jest.fn((input: unknown) => ({ __type: 'Stop', input })),
}));

import { handler } from '../../../../lambda/ops/bastion-ttl-sweeper';

const INSTANCE_ID = 'i-0123456789abcdef0';

/** The EMF lines this function emits, parsed back out of console.log. */
function emfLines(log: jest.SpyInstance): Record<string, any>[] {
  return log.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
    .filter((o): o is Record<string, any> => o !== null && o._aws !== undefined);
}

function events(log: jest.SpyInstance): string[] {
  return log.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)).event; } catch { return undefined; } })
    .filter((e): e is string => typeof e === 'string');
}

function describeResult(overrides: Record<string, unknown> = {}) {
  return {
    Reservations: [{
      Instances: [{
        // 10 hours old against the 6h TTL below.
        LaunchTime: new Date(Date.now() - 10 * 60 * 60 * 1000),
        State: { Name: 'running' },
        ...overrides,
      }],
    }],
  };
}

describe('bastion-ttl-sweeper', () => {
  const env = process.env;
  let log: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, BASTION_INSTANCE_ID: INSTANCE_ID, BASTION_TTL_HOURS: '6' };
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { log.mockRestore(); errorLog.mockRestore(); });
  afterAll(() => { process.env = env; });

  it('stops an instance past its TTL and reports the breach once', async () => {
    mockSend.mockResolvedValueOnce(describeResult()).mockResolvedValueOnce({});

    await handler();

    const stop = mockSend.mock.calls.map(([c]) => c).find((c) => c.__type === 'Stop');
    expect(stop).toBeDefined();
    expect(stop.input).toEqual({ InstanceIds: [INSTANCE_ID] });
    expect(events(log)).toContain('BastionStoppedOnTtl');
    expect(emfLines(log)[0].BastionOverTtl).toBe(1);
  });

  it('leaves an instance inside its TTL alone and reports zero', async () => {
    mockSend.mockResolvedValueOnce(describeResult({
      LaunchTime: new Date(Date.now() - 60 * 60 * 1000), // 1h old
    }));

    await handler();

    expect(mockSend.mock.calls.map(([c]) => c).some((c) => c.__type === 'Stop')).toBe(false);
    expect(emfLines(log)[0].BastionOverTtl).toBe(0);
  });

  /**
   * R2. A 'pending' instance is counted as running on purpose -- a TTL that
   * only starts once the box finishes booting is a TTL a stuck boot defeats --
   * but EC2 refuses to stop one, with `IncorrectInstanceState`. That is a
   * "not now", not a failure: the next sweep is 15 minutes away. Throwing
   * would trip the sweeper's own Errors alarm every quarter hour and teach
   * whoever owns it to ignore both alarms.
   */
  it('treats IncorrectInstanceState as try-next-sweep: logs, does not throw', async () => {
    const err: any = new Error('The instance is not in a state from which it can be stopped.');
    err.name = 'IncorrectInstanceState';
    mockSend
      .mockResolvedValueOnce(describeResult({ State: { Name: 'pending' } }))
      .mockRejectedValueOnce(err);

    await expect(handler()).resolves.toBeUndefined();

    expect(events(log)).toContain('BastionStopDeferred');
    expect(events(log)).not.toContain('BastionStoppedOnTtl');
    // Still reported as breaching: the bastion IS over its TTL and still up,
    // which is exactly what the backstop alarm is for.
    expect(emfLines(log)[0].BastionOverTtl).toBe(1);
  });

  it('still throws on any OTHER stop failure, so the Errors alarm can see it', async () => {
    const err: any = new Error('UnauthorizedOperation');
    err.name = 'UnauthorizedOperation';
    mockSend.mockResolvedValueOnce(describeResult()).mockRejectedValueOnce(err);

    await expect(handler()).rejects.toThrow('UnauthorizedOperation');
  });

  it('reports a clean zero when the instance is gone (stack properly destroyed)', async () => {
    mockSend.mockResolvedValueOnce({ Reservations: [] });

    await handler();

    expect(emfLines(log)[0].BastionOverTtl).toBe(0);
    expect(events(log)).toContain('BastionTtlSweepNoInstance');
  });

  it('emits NO metric when misconfigured, so NOT_BREACHING cannot absolve it', async () => {
    process.env.BASTION_TTL_HOURS = 'six';

    await handler();

    expect(emfLines(log)).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });
});
