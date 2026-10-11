import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from 'next';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { message } from '@/components/worker/onboarding/__tests__/render-intl';
import { generateMetadata as landingMetadata } from '../page';
import { generateMetadata as workerSignupMetadata } from '../auth/worker/layout';

/*
 * Link previews for the two pages a shared Jale link lands on: the landing
 * page (jaleapp.ai) and the worker sign-up (where jaleapp.ai/app redirects).
 * A chat app renders these from the page's metadata, so a wrong locale, a raw
 * message key or a transparent image is what the recipient sees.
 *
 * `getTranslations` is faked with next-intl's own `createTranslator` over the
 * REAL catalogues (as in j/[code]/__tests__/facts-card.test.tsx), so a key
 * missing from one locale fails here instead of shipping as a raw key path.
 */

const catalogues = { en, es } as const;
type CreateTranslatorOptions = Parameters<typeof createTranslator>[0];

vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) =>
    createTranslator({
      locale,
      messages: catalogues[locale as keyof typeof catalogues],
      namespace,
      onError: () => {},
    } as unknown as CreateTranslatorOptions),
}));

type GenerateMetadata = (props: { params: Promise<{ locale: string }> }) => Promise<Metadata>;

const SURFACES: ReadonlyArray<{ name: string; namespace: string; generate: GenerateMetadata }> = [
  { name: 'landing page', namespace: 'seo.landing', generate: landingMetadata },
  { name: 'worker sign-up', namespace: 'seo.worker_signup', generate: workerSignupMetadata },
];

const LOCALES = ['en', 'es'] as const;
const OG_LOCALE = { en: 'en_US', es: 'es_US' } as const;
const DEFAULT_IMAGE = { url: '/brand/og-default.png', width: 1200, height: 630, alt: 'Jale' };

function metadataFor(generate: GenerateMetadata, locale: string): Promise<Metadata> {
  return generate({ params: Promise.resolve({ locale }) });
}

/** Every string anywhere in a metadata object. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** What next-intl prints for a missing key: dotted lowercase segments. */
const RAW_MESSAGE_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

describe.each(SURFACES)('$name generateMetadata', ({ namespace, generate }) => {
  describe.each(LOCALES)('in %s', (locale) => {
    it('takes the title and description from the catalogue', async () => {
      const meta = await metadataFor(generate, locale);
      expect(meta.title).toBe(message(`${namespace}.title`, locale));
      expect(meta.description).toBe(message(`${namespace}.description`, locale));
    });

    it('localizes the Open Graph card', async () => {
      const meta = await metadataFor(generate, locale);
      expect(meta.openGraph).toMatchObject({
        title: message(`${namespace}.title`, locale),
        description: message(`${namespace}.description`, locale),
        type: 'website',
        locale: OG_LOCALE[locale],
      });
    });

    it('previews with the 1200x630 default image', async () => {
      const meta = await metadataFor(generate, locale);
      expect(meta.openGraph?.images).toEqual([DEFAULT_IMAGE]);
    });

    it('uses a large-image Twitter card with the same copy and image', async () => {
      const meta = await metadataFor(generate, locale);
      expect(meta.twitter).toEqual({
        card: 'summary_large_image',
        title: message(`${namespace}.title`, locale),
        description: message(`${namespace}.description`, locale),
        images: [DEFAULT_IMAGE],
      });
    });

    it('leaks no raw message keys', async () => {
      const meta = await metadataFor(generate, locale);
      expect(strings(meta).filter((s) => RAW_MESSAGE_KEY.test(s))).toEqual([]);
    });

    // Not setting it is what keeps the root layout's RSS <link> on the page.
    it('inherits alternates from the root layout', async () => {
      const meta = await metadataFor(generate, locale);
      expect(meta).not.toHaveProperty('alternates');
    });
  });

  it('previews in Spanish and English, not one language twice', async () => {
    const [enMeta, esMeta] = await Promise.all([metadataFor(generate, 'en'), metadataFor(generate, 'es')]);
    expect(esMeta.title).not.toBe(enMeta.title);
    expect(esMeta.description).not.toBe(enMeta.description);
  });
});

describe('worker sign-up robots', () => {
  it.each(LOCALES)('is noindex in %s', async (locale) => {
    const meta = await metadataFor(workerSignupMetadata, locale);
    expect(meta.robots).toEqual({ index: false });
  });
});

describe('landing robots', () => {
  it('stays indexable (nothing set, so the root layout decides)', async () => {
    const meta = await metadataFor(landingMetadata, 'es');
    expect(meta).not.toHaveProperty('robots');
  });
});

/**
 * Decodes an 8-bit truecolor (RGB), non-interlaced PNG into packed RGB rows:
 * inflate the IDAT stream, then undo each scanline's filter (PNG spec 9.2).
 */
function decodeRgbPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png[24] !== 8 || png[25] !== 2 || png[28] !== 0) {
    throw new Error('expected an 8-bit truecolor, non-interlaced PNG');
  }
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      out[i] = (line[i] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

/*
 * Every other brand PNG is transparent, which chat apps render on white or
 * black. Read the PNG directly so a swapped-in asset cannot regress this
 * silently.
 */
describe('public/brand/og-default.png', () => {
  const readPng = () => readFileSync(new URL('../../../../public/brand/og-default.png', import.meta.url));

  it('is a PNG of exactly 1200x630', () => {
    const png = readPng();
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it('is opaque: truecolor without alpha, and no transparency chunk', () => {
    const png = readPng();
    expect(png[25]).toBe(2);
    expect(png.includes(Buffer.from('tRNS', 'latin1'))).toBe(false);
  });

  it('is under 300 KB', () => {
    expect(readPng().byteLength).toBeLessThan(300 * 1024);
  });

  // WhatsApp's small preview is a centred square crop. On a 1200x630 card
  // that square spans x 285 to 915, so anything outside it is cut off.
  it('keeps the wordmark inside the centred 630px square a small preview crops to', () => {
    const { width, height, pixels } = decodeRgbPng(readPng());
    // The ground is the brand navy #181855 (--jale-blue-900).
    expect([...pixels.subarray(0, 3)]).toEqual([0x18, 0x18, 0x55]);

    let minX = width;
    let maxX = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3;
        if (pixels[i] !== 0x18 || pixels[i + 1] !== 0x18 || pixels[i + 2] !== 0x55) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }

    expect(maxX - minX + 1).toBeGreaterThanOrEqual(500); // the mark is there, at size
    expect(minX).toBeGreaterThanOrEqual(285);
    expect(maxX).toBeLessThan(915);
  });
});
