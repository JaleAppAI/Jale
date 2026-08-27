/**
 * Client-side downscale before upload (spec §3): longest edge capped at
 * 1600px so the grid never pays for 8MB camera originals, without any
 * server-side thumbnail pipeline. The mime type is preserved — the presigned
 * PUT is signed for the file's ContentType, so converting formats here would
 * break the upload.
 */
export const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export function targetDimensions(
  width: number,
  height: number,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return null;
  const scale = MAX_EDGE / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

interface ResizeDeps {
  measure(file: File): Promise<{ width: number; height: number }>;
  draw(file: File, dims: { width: number; height: number }, mime: string): Promise<Blob>;
}

async function browserMeasure(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}

async function browserDraw(
  file: File,
  dims: { width: number; height: number },
  mime: string,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas_export_failed'))),
      mime,
      mime === 'image/png' ? undefined : JPEG_QUALITY,
    );
  });
}

/** deps is a test seam; production callers pass nothing. */
export async function downscaleImage(file: File, deps?: ResizeDeps): Promise<File> {
  const { measure, draw } = deps ?? { measure: browserMeasure, draw: browserDraw };
  const { width, height } = await measure(file);
  const dims = targetDimensions(width, height);
  if (!dims) return file;
  const blob = await draw(file, dims, file.type);
  return new File([blob], file.name, { type: file.type });
}
