import { isImageFlagged, moderateImage } from '../../../../lambda/lib/moderation';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rekognition', () => ({
  // TDZ-safe: reference the mock through a closure evaluated at call
  // time, not at (hoisted) client construction time.
  RekognitionClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockSend(...a) })),
  DetectModerationLabelsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('isImageFlagged', () => {
  it('flags a top-level banned category by Name', () => {
    expect(isImageFlagged([{ Name: 'Explicit Nudity', ParentName: '', Confidence: 90 }])).toBe(true);
  });
  it('flags a child label whose ParentName is banned', () => {
    expect(isImageFlagged([{ Name: 'Graphic Violence', ParentName: 'Violence', Confidence: 75 }])).toBe(true);
  });
  it('does not flag unrelated labels', () => {
    expect(isImageFlagged([{ Name: 'Alcohol', ParentName: '', Confidence: 99 }])).toBe(false);
  });
  it('does not flag an empty label list', () => {
    expect(isImageFlagged([])).toBe(false);
  });
});

describe('moderateImage', () => {
  beforeEach(() => mockSend.mockReset());

  it('returns approved for clean images and pins the object version', async () => {
    mockSend.mockResolvedValue({ ModerationLabels: [] });
    await expect(moderateImage('bucket', 'w/posts/p/x.jpg', 'v123')).resolves.toBe('approved');
    const { DetectModerationLabelsCommand } = jest.requireMock('@aws-sdk/client-rekognition');
    expect(DetectModerationLabelsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: { S3Object: { Bucket: 'bucket', Name: 'w/posts/p/x.jpg', Version: 'v123' } },
      }),
    );
  });

  it('omits Version when versionId is null', async () => {
    mockSend.mockResolvedValue({ ModerationLabels: [] });
    await moderateImage('bucket', 'k.jpg', null);
    const { DetectModerationLabelsCommand } = jest.requireMock('@aws-sdk/client-rekognition');
    const input = (DetectModerationLabelsCommand as jest.Mock).mock.calls.at(-1)?.[0];
    expect(input.Image.S3Object.Version).toBeUndefined();
  });

  it('returns flagged when a banned label comes back', async () => {
    mockSend.mockResolvedValue({ ModerationLabels: [{ Name: 'Hate Symbols', ParentName: '' }] });
    await expect(moderateImage('bucket', 'k.jpg', 'v1')).resolves.toBe('flagged');
  });

  it('FAILS CLOSED (flagged) on content errors — attacker-controllable', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('bad image'), { name: 'InvalidImageFormatException' }));
    await expect(moderateImage('bucket', 'k.jpg', 'v1')).resolves.toBe('flagged');
    expect(mockSend).toHaveBeenCalledTimes(1); // no retry for content errors
  });

  it('fails open (approved) on service faults, after one retry', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(moderateImage('bucket', 'k.jpg', 'v1')).resolves.toBe('approved');
    expect(mockSend).toHaveBeenCalledTimes(2); // one retry attempted
  });
});
