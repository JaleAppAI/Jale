import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// A Next internal: the matcher Next itself runs `headers()` sources through.
// Not public API; if a Next bump moves or breaks it, re-point this import.
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { HEADER_LOCALES, securityHeaders } from '../../../security-headers.mjs';
import { locales } from '@/i18n/locales';

const FRONTEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

const NO_REFERRER = { 'Referrer-Policy': 'no-referrer' };

/** The pages whose address carries a secret `?token=`. */
const TOKEN_PAGES = ['/auth/employer/invite', '/digest-unsubscribe'];

async function rules(): Promise<HeaderRule[]> {
  return securityHeaders();
}

/** The header values Next would add to a request for `pathname`. */
async function headersFor(pathname: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rule of await rules()) {
    if (getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(pathname)) {
      for (const { key, value } of rule.headers) out[key] = value;
    }
  }
  return out;
}

describe('security headers', () => {
  it('match exactly the locales in src/i18n/locales.ts', () => {
    expect([...HEADER_LOCALES].sort()).toEqual([...locales].sort());
  });

  it.each(TOKEN_PAGES)('sends Referrer-Policy: no-referrer on %s in every locale', async (page) => {
    for (const locale of locales) {
      expect(await headersFor(`/${locale}${page}`)).toEqual(NO_REFERRER);
    }
  });

  it.each(TOKEN_PAGES)('sends it on the unprefixed %s the proxy redirects from', async (page) => {
    expect(await headersFor(page)).toEqual(NO_REFERRER);
  });

  it('leaves other pages and unknown locales alone', async () => {
    for (const path of [
      '/en/auth/employer',
      '/en/auth/employer/invite/extra',
      '/en/auth/worker',
      '/fr/auth/employer/invite',
      '/en/digest-unsubscribe/extra',
      '/fr/digest-unsubscribe',
      '/en/upload/abc',
      '/en',
    ]) {
      expect(await headersFor(path)).toEqual({});
    }
  });

  it('every rule is a plain path with no query condition, so any ?token= matches', async () => {
    for (const rule of await rules()) {
      expect(rule).not.toHaveProperty('has');
      expect(rule).not.toHaveProperty('missing');
      expect(rule.source).not.toContain('?');
    }
  });
});

describe('next.config.mjs', () => {
  it('serves exactly these rules from headers()', async () => {
    // A child process, as in build-id.test.ts: importing the config runs the
    // next-intl plugin and computeBuildId, which want plain Node.
    const configUrl = pathToFileURL(join(FRONTEND_DIR, 'next.config.mjs')).href;
    const probe = [
      `const config = (await import(${JSON.stringify(configUrl)})).default;`,
      'console.log("RESULT " + JSON.stringify(await config.headers()));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
    });
    const line = out.trim().split('\n').find((l) => l.startsWith('RESULT '))!;
    expect(JSON.parse(line.slice('RESULT '.length))).toEqual(await rules());
  }, 30_000);
});
