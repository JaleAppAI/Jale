import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { Client } from 'pg';

describe('Check Compliance Utility', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
    } as unknown as Client;
  });

  it('should return non-compliant if user is not found', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });

    const result = await checkCompliance(mockClient, 'test-sub', 'v1.0');

    expect(result.compliant).toBe(false);
    expect(result.currentVersion).toBeNull();
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT tos_version FROM users WHERE cognito_sub = $1',
      ['test-sub']
    );
  });

  it('should return compliant if user has accepted the correct version', async () => {
    mockClient.query.mockResolvedValue({ rows: [{ tos_version: 'v1.0' }] });

    const result = await checkCompliance(mockClient, 'test-sub', 'v1.0');

    expect(result.compliant).toBe(true);
    expect(result.currentVersion).toBe('v1.0');
  });

  it('should handle whitespace in versions correctly', async () => {
    mockClient.query.mockResolvedValue({ rows: [{ tos_version: ' v1.0 ' }] });

    const result = await checkCompliance(mockClient, 'test-sub', 'v1.0 ');

    expect(result.compliant).toBe(true);
    expect(result.currentVersion).toBe(' v1.0 ');
  });

  it('should return non-compliant if user has an older version', async () => {
    mockClient.query.mockResolvedValue({ rows: [{ tos_version: 'v0.9' }] });

    const result = await checkCompliance(mockClient, 'test-sub', 'v1.0');

    expect(result.compliant).toBe(false);
    expect(result.currentVersion).toBe('v0.9');
  });

  it('should handle null tos_version gracefully', async () => {
    mockClient.query.mockResolvedValue({ rows: [{ tos_version: null }] });

    const result = await checkCompliance(mockClient, 'test-sub', 'v1.0');

    expect(result.compliant).toBe(false);
    expect(result.currentVersion).toBeNull();
  });
});
