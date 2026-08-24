import {
  RekognitionClient,
  DetectModerationLabelsCommand,
  type ModerationLabel,
} from '@aws-sdk/client-rekognition';
import { errorMessage } from './http';

const rekognition = new RekognitionClient({});

export const MODERATION_MIN_CONFIDENCE = 60;

const FLAGGED_CATEGORIES = new Set([
  'Explicit Nudity',
  'Violence',
  'Visually Disturbing',
  'Hate Symbols',
]);

// Content errors are attacker-controllable ("make the image
// unparseable" must not be a moderation bypass) → fail CLOSED.
// Service faults are not → fail OPEN after one retry (spec §5).
const CONTENT_ERROR_NAMES = new Set(['InvalidImageFormatException', 'ImageTooLargeException']);

export type ModerationStatus = 'approved' | 'flagged';

export function isImageFlagged(labels: ModerationLabel[]): boolean {
  return labels.some(
    (label) =>
      (label.Name !== undefined && FLAGGED_CATEGORIES.has(label.Name)) ||
      (label.ParentName !== undefined && label.ParentName !== '' && FLAGGED_CATEGORIES.has(label.ParentName)),
  );
}

export async function moderateImage(
  bucket: string,
  s3Key: string,
  versionId: string | null,
): Promise<ModerationStatus> {
  const command = () =>
    rekognition.send(
      new DetectModerationLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: s3Key, ...(versionId ? { Version: versionId } : {}) } },
        MinConfidence: MODERATION_MIN_CONFIDENCE,
      }),
    );
  try {
    let res;
    try {
      res = await command();
    } catch (err) {
      if (CONTENT_ERROR_NAMES.has((err as Error).name)) {
        console.error(`moderateImage content error (fail-closed) key=${s3Key}:`, errorMessage(err));
        return 'flagged';
      }
      res = await command(); // one retry for service faults
    }
    return isImageFlagged(res.ModerationLabels ?? []) ? 'flagged' : 'approved';
  } catch (err) {
    if (CONTENT_ERROR_NAMES.has((err as Error).name)) {
      console.error(`moderateImage content error (fail-closed) key=${s3Key}:`, errorMessage(err));
      return 'flagged';
    }
    console.error(`moderateImage service fault (fail-open) key=${s3Key}:`, errorMessage(err));
    return 'approved';
  }
}
