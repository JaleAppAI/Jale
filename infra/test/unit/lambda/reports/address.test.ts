import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  VIEWER_ADDRESS_HEADER,
  clearAddressSaltCache,
  getAddressSalt,
  hashAddress,
  readViewerAddress,
  viewerAddressKey,
} from '../../../../lambda/reports/lib/address';
import { hashVisitor } from '../../../../lambda/lib/referral-codes';

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockSend = (SecretsManagerClient as jest.Mock).mock.results[0].value.send as jest.Mock;
const eventWith = (headers: Record<string, string> | null): APIGatewayProxyEvent =>
  ({ headers }) as unknown as APIGatewayProxyEvent;

// Documentation ranges (RFC 5737 / RFC 3849).
const IPV4 = ['192', '0', '2', '33'].join('.');
const IPV6 = '2001:DB8::1';

describe('readViewerAddress', () => {
  it('reads the header the edge sets, in any letter case', () => {
    expect(VIEWER_ADDRESS_HEADER).toBe('x-jale-viewer-address');
    expect(readViewerAddress(eventWith({ 'X-Jale-Viewer-Address': IPV4 }))).toBe(IPV4);
    expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': ` ${IPV4} ` }))).toBe(IPV4);
  });

  it('keys an IPv6 address on its /64, in canonical form', () => {
    expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': IPV6 }))).toBe('2001:db8:0:0::/64');
  });

  it('gives nothing when the header is missing, empty or not an address', () => {
    expect(readViewerAddress(eventWith(null))).toBeUndefined();
    expect(readViewerAddress(eventWith({}))).toBeUndefined();
    expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': '' }))).toBeUndefined();
    expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': `${IPV4}, ${IPV4}` }))).toBeUndefined();
    expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': 'localhost' }))).toBeUndefined();
  });

  it('never reads X-Forwarded-For or the source address', () => {
    const event = {
      headers: { 'X-Forwarded-For': IPV4 },
      requestContext: { identity: { sourceIp: IPV4 } },
    } as unknown as APIGatewayProxyEvent;
    expect(readViewerAddress(event)).toBeUndefined();
  });
});

describe('viewerAddressKey', () => {
  it('uses an IPv4 address whole', () => {
    expect(viewerAddressKey(IPV4)).toBe(IPV4);
    expect(viewerAddressKey(['198', '51', '100', '250'].join('.'))).toBe(['198', '51', '100', '250'].join('.'));
  });

  it('gives addresses in the same /64 the same key', () => {
    const key = viewerAddressKey('2001:db8:aa:bb::1');
    expect(key).toBe('2001:db8:aa:bb::/64');
    for (const address of ['2001:db8:aa:bb::2', '2001:db8:aa:bb:ffff:ffff:ffff:ffff', '2001:db8:aa:bb:1234:5678:9abc:def0']) {
      expect(viewerAddressKey(address)).toBe(key);
    }
  });

  it('gives different /64s different keys', () => {
    const keys = ['2001:db8:aa:bb::1', '2001:db8:aa:bc::1', '2001:db8:ab:bb::1', '2001:db9:aa:bb::1', '2001:db8::1']
      .map(viewerAddressKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('agrees across compressed, expanded, zero-padded and upper-case spellings', () => {
    const spellings = [
      '2001:db8::1',
      '2001:DB8::1',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
      '2001:db8:0:0:0:0:0:1',
      '2001:0DB8:0:0::1',
      '2001:db8:0::',
    ];
    for (const address of spellings) expect(viewerAddressKey(address)).toBe('2001:db8:0:0::/64');
    expect(viewerAddressKey('2001:db8:1:2:3::')).toBe('2001:db8:1:2::/64');
    expect(viewerAddressKey('::1')).toBe('0:0:0:0::/64');
    expect(viewerAddressKey('::')).toBe('0:0:0:0::/64');
    expect(viewerAddressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('treats an IPv4-mapped IPv6 address as its IPv4 address, in any spelling', () => {
    const mapped = ['192', '0', '2', '33'].join('.');
    for (const address of [
      `::ffff:${mapped}`,
      `::FFFF:${mapped}`,
      `0:0:0:0:0:ffff:${mapped}`,
      `0000:0000:0000:0000:0000:FFFF:${mapped}`,
      '::ffff:c000:221',
      '::FFFF:C000:0221',
    ]) {
      expect(viewerAddressKey(address)).toBe(IPV4);
    }
  });

  it('keeps other addresses with an IPv4 tail on their /64', () => {
    expect(viewerAddressKey(`64:ff9b::${IPV4}`)).toBe('64:ff9b:0:0::/64');
  });

  it('refuses anything that is not one address', () => {
    for (const value of [
      '', ' ', 'localhost', `${IPV4}, ${IPV4}`, '192.000.2.1', '2001:db8::1/64', '[2001:db8::1]',
      '1::2::3', '1:2:3:4:5:6:7:8:9', '2001:db8:::1', 'gggg::1', '12345::1',
    ]) {
      expect(viewerAddressKey(value)).toBeUndefined();
      expect(readViewerAddress(eventWith({ 'x-jale-viewer-address': value }))).toBeUndefined();
    }
  });
});

describe('getAddressSalt', () => {
  const salt = randomBytes(24).toString('hex');

  beforeEach(() => {
    mockSend.mockReset();
    clearAddressSaltCache();
    process.env.REPORT_ADDRESS_SALT_SECRET_ARN = 'test-address-salt-secret';
  });

  afterAll(() => {
    delete process.env.REPORT_ADDRESS_SALT_SECRET_ARN;
  });

  it('reads the bare secret string and caches it', async () => {
    mockSend.mockResolvedValue({ SecretString: `${salt}\n` });
    await expect(getAddressSalt()).resolves.toBe(salt);
    await expect(getAddressSalt()).resolves.toBe(salt);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toEqual({ SecretId: 'test-address-salt-secret' });
  });

  it('reads it again once the cache has expired', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      mockSend.mockResolvedValue({ SecretString: salt });
      await getAddressSalt();
      now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
      await getAddressSalt();
      expect(mockSend).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('fails closed when the secret is not configured, empty or unreadable', async () => {
    delete process.env.REPORT_ADDRESS_SALT_SECRET_ARN;
    await expect(getAddressSalt()).rejects.toThrow();
    expect(mockSend).not.toHaveBeenCalled();

    process.env.REPORT_ADDRESS_SALT_SECRET_ARN = 'test-address-salt-secret';
    mockSend.mockResolvedValueOnce({ SecretString: '   ' });
    await expect(getAddressSalt()).rejects.toThrow();
    mockSend.mockResolvedValueOnce({});
    await expect(getAddressSalt()).rejects.toThrow();
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(getAddressSalt()).rejects.toThrow();
  });

  it('does not remember a failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(getAddressSalt()).rejects.toThrow();
    mockSend.mockResolvedValueOnce({ SecretString: salt });
    await expect(getAddressSalt()).resolves.toBe(salt);
  });
});

describe('hashAddress', () => {
  it("is the visitor hash with a fixed 'reports' user-agent slot", () => {
    const salt = randomBytes(24).toString('hex');
    const hash = hashAddress(salt, IPV4);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashVisitor(salt, IPV4, 'reports'));
  });

  it('changes with the salt and with the address', () => {
    const salt = randomBytes(24).toString('hex');
    expect(hashAddress(salt, IPV4)).not.toBe(hashAddress(randomBytes(24).toString('hex'), IPV4));
    expect(hashAddress(salt, IPV4)).not.toBe(hashAddress(salt, IPV6.toLowerCase()));
  });

  it('refuses an empty salt', () => {
    expect(() => hashAddress('', IPV4)).toThrow();
  });
});
