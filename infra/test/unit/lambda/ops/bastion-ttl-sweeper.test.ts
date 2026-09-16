/**
 * The bastion TTL sweeper (F23): stops the bastion once it has run past its
 * TTL, and treats an instance EC2 no longer knows as the clean "nothing to
 * sweep" case instead of an error.
 */
const send = jest.fn();

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send })),
  DescribeInstancesCommand: jest.fn().mockImplementation((input) => ({ kind: 'describe', input })),
  StopInstancesCommand: jest.fn().mockImplementation((input) => ({ kind: 'stop', input })),
}));

import { handler } from '../../../../lambda/ops/bastion-ttl-sweeper';

const HOUR = 60 * 60 * 1000;

function describeResponse(launchedMsAgo: number, state = 'running') {
  return {
    Reservations: [{ Instances: [{ LaunchTime: new Date(Date.now() - launchedMsAgo), State: { Name: state } }] }],
  };
}

describe('bastion-ttl-sweeper', () => {
  let logs: string[];

  beforeEach(() => {
    send.mockReset();
    process.env.BASTION_INSTANCE_ID = 'i-0123456789abcdef0';
    process.env.BASTION_TTL_HOURS = '6';
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function metric(name: string): number | undefined {
    const emf = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((o) => o && o._aws);
    return emf?.[name];
  }

  it('stops a running instance that is past its TTL and reports it over TTL', async () => {
    send.mockResolvedValueOnce(describeResponse(7 * HOUR));
    send.mockResolvedValueOnce({});
    await handler();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({ kind: 'stop', input: { InstanceIds: ['i-0123456789abcdef0'] } });
    expect(metric('BastionOverTtl')).toBe(1);
  });

  it('leaves a running instance inside its TTL alone', async () => {
    send.mockResolvedValueOnce(describeResponse(1 * HOUR));
    await handler();
    expect(send).toHaveBeenCalledTimes(1);
    expect(metric('BastionOverTtl')).toBe(0);
  });

  it('does not stop an instance that is already stopped, however old', async () => {
    send.mockResolvedValueOnce(describeResponse(40 * HOUR, 'stopped'));
    await handler();
    expect(send).toHaveBeenCalledTimes(1);
    expect(metric('BastionOverTtl')).toBe(0);
  });

  it('treats InvalidInstanceID.NotFound as nothing to sweep, not as a failure', async () => {
    const notFound = Object.assign(new Error('The instance ID does not exist'), { name: 'InvalidInstanceID.NotFound' });
    send.mockRejectedValueOnce(notFound);
    await expect(handler()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(metric('BastionOverTtl')).toBe(0);
    expect(logs.some((l) => l.includes('BastionTtlSweepNoInstance'))).toBe(true);
  });

  it('still surfaces any other EC2 error so the sweeper-errors alarm can fire', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' }));
    await expect(handler()).rejects.toThrow('throttled');
  });

  it('refuses to run when misconfigured and calls nothing', async () => {
    delete process.env.BASTION_TTL_HOURS;
    await handler();
    expect(send).not.toHaveBeenCalled();
  });
});
