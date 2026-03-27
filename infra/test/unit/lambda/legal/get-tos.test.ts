import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn(),
    GetObjectCommand: jest.fn(),
  };
});
jest.mock('@aws-sdk/s3-request-presigner');

const mockGetSignedUrl = getSignedUrl as jest.Mock;

describe('Get ToS API Lambda', () => {
  const originalEnv = process.env;
  let handler: any;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      LEGAL_BUCKET_NAME: 'test-legal-bucket',
      REQUIRED_TOS_VERSION: 'v1.0',
    };
    
    // Require handler dynamically so module-level constants pick up the mocked env variables
    handler = require('../../../../lambda/legal/get-tos').handler;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should successfully return presigned urls', async () => {
    mockGetSignedUrl.mockImplementation(async (_client, command) => {
      // It's a mock, so we just check if it was called and return a dummy URL
      return `https://s3.amazonaws.com/test-legal-bucket/document`;
    });

    const response = await handler();

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      version: 'v1.0',
      tosUrl: 'https://s3.amazonaws.com/test-legal-bucket/document',
      privacyUrl: 'https://s3.amazonaws.com/test-legal-bucket/document',
    });

    // Check it gets both tos and privacy policy
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-legal-bucket',
      Key: 'tos.md',
    });
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-legal-bucket',
      Key: 'privacy-policy.md',
    });

    // Verify presigned URL expiry is 1 hour — changing this silently would break ToS delivery
    expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 3600 });
    expect(mockGetSignedUrl.mock.calls[1][2]).toEqual({ expiresIn: 3600 });
  });

  it('should handle errors gracefully returning 500', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('S3 Error'));

    const response = await handler();

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'internal_error',
      message: 'Failed to generate document URLs',
    });
  });
});
