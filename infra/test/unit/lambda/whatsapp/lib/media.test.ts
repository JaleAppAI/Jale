import {
  detectMediaCategory,
  buildS3Key,
  ALLOWED_PHOTO_TYPES,
  ALLOWED_VOICE_TYPES,
} from '../../../../../lambda/whatsapp/lib/media';

describe('detectMediaCategory', () => {
  test.each([
    ['image/jpeg', 'photo'],
    ['image/png', 'photo'],
    ['image/webp', 'photo'],
  ])('%s → photo', (ct, expected) => {
    expect(detectMediaCategory(ct)).toBe(expected);
  });

  test.each([
    ['audio/ogg', 'voice'],
    ['audio/mpeg', 'voice'],
    ['audio/mp4', 'voice'],
  ])('%s → voice', (ct, expected) => {
    expect(detectMediaCategory(ct)).toBe(expected);
  });

  test.each([
    ['application/pdf'],
    ['video/mp4'],
    ['text/plain'],
    [''],
  ])('%s → null', (ct) => {
    expect(detectMediaCategory(ct)).toBeNull();
  });
});

describe('buildS3Key', () => {
  test('photo key uses profile-photos prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'photo');
    expect(key).toBe('user-1/profile-photos/media-1');
  });

  test('work_sample key uses work-samples prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'work_sample');
    expect(key).toBe('user-1/work-samples/media-1');
  });

  test('voice key uses voice-messages prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'voice');
    expect(key).toBe('user-1/voice-messages/media-1');
  });
});

describe('ALLOWED_PHOTO_TYPES and ALLOWED_VOICE_TYPES', () => {
  test('ALLOWED_PHOTO_TYPES contains image types', () => {
    expect(ALLOWED_PHOTO_TYPES).toContain('image/jpeg');
    expect(ALLOWED_PHOTO_TYPES).toContain('image/png');
    expect(ALLOWED_PHOTO_TYPES).toContain('image/webp');
  });

  test('ALLOWED_VOICE_TYPES contains audio types', () => {
    expect(ALLOWED_VOICE_TYPES).toContain('audio/ogg');
    expect(ALLOWED_VOICE_TYPES).toContain('audio/mpeg');
    expect(ALLOWED_VOICE_TYPES).toContain('audio/mp4');
  });
});
