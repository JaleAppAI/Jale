import { describe, it, expect, vi } from 'vitest';
import { targetDimensions, downscaleImage, MAX_EDGE } from '../image-resize';

describe('targetDimensions', () => {
  it('returns null when both edges are within the max (no resize needed)', () => {
    expect(targetDimensions(1600, 900)).toBeNull();
    expect(targetDimensions(800, 1600)).toBeNull();
  });
  it('scales the longest edge down to MAX_EDGE preserving aspect', () => {
    expect(targetDimensions(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(targetDimensions(1000, 4000)).toEqual({ width: 400, height: 1600 });
  });
  it('rounds to integers', () => {
    const dims = targetDimensions(3333, 2222)!;
    expect(Number.isInteger(dims.width)).toBe(true);
    expect(Number.isInteger(dims.height)).toBe(true);
    expect(Math.max(dims.width, dims.height)).toBe(MAX_EDGE);
  });
});

describe('downscaleImage', () => {
  it('returns the original file when no resize is needed', async () => {
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const result = await downscaleImage(file, {
      measure: async () => ({ width: 1000, height: 800 }),
      draw: vi.fn(),
    });
    expect(result).toBe(file);
  });
  it('draws and returns a resized file when oversized', async () => {
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const resizedBlob = new Blob(['resized'], { type: 'image/jpeg' });
    const draw = vi.fn().mockResolvedValue(resizedBlob);
    const result = await downscaleImage(file, {
      measure: async () => ({ width: 4000, height: 2000 }),
      draw,
    });
    expect(draw).toHaveBeenCalledWith(file, { width: 1600, height: 800 }, 'image/jpeg');
    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('a.jpg');
    expect(result).not.toBe(file);
  });
});
