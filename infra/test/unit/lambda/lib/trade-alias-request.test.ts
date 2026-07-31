const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((input) => input),
}));

describe('requestTradeAliasGeneration', () => {
  const { requestTradeAliasGeneration } = require('../../../../lambda/lib/trade-alias-request');
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    delete process.env.ALIAS_GENERATOR_ARN;
  });

  afterAll(() => {
    process.env = env;
  });

  it('resolves without throwing and does not invoke when ALIAS_GENERATOR_ARN is unset', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(requestTradeAliasGeneration('Soldador')).resolves.toBeUndefined();

    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('swallows an invoke rejection and never throws', async () => {
    process.env.ALIAS_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123456789012:function:alias-generator';
    mockLambdaSend.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(requestTradeAliasGeneration('Soldador')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    const loggedArgs = JSON.stringify(warnSpy.mock.calls);
    expect(loggedArgs).not.toContain('Soldador');
    warnSpy.mockRestore();
  });

  it('sends an Event-invocation with the normalized trade key on the happy path', async () => {
    process.env.ALIAS_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123456789012:function:alias-generator';
    mockLambdaSend.mockResolvedValueOnce({});

    await requestTradeAliasGeneration('  Soldador  ');

    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const invokeInput = mockLambdaSend.mock.calls[0][0];
    expect(invokeInput.FunctionName).toBe('arn:aws:lambda:us-east-2:123456789012:function:alias-generator');
    expect(invokeInput.InvocationType).toBe('Event');
    const payload = JSON.parse(Buffer.from(invokeInput.Payload).toString());
    expect(payload).toEqual({ tradeKey: 'soldador', tradeRaw: '  Soldador  ' });
  });
});

export {};
