import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGNUP_SOURCE_CODES } from '../signup-source';

/**
 * The server owns the allow-list (`infra/lambda/lib/signup-source.ts`, contract
 * K3.6); the frontend keeps a mirror so `/app` and the sign-up pages drop an
 * unknown code before it is ever sent. This reads the server file as TEXT --
 * the same way `support-contact.test.ts` reads the WhatsApp flows -- so a code
 * added on one side and not the other fails here, by name.
 */
function serverCodes(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../infra/lambda/lib/signup-source.ts', import.meta.url)),
    'utf8',
  );
  const literal = source.match(/export\s+const\s+SIGNUP_SOURCE_CODES\b[^=]*=\s*\[([\s\S]*?)\]/);
  expect(literal, 'SIGNUP_SOURCE_CODES array literal not found in the server file').not.toBeNull();
  const codes = [...(literal as RegExpMatchArray)[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  expect(codes.length, 'the server list parsed as empty').toBeGreaterThan(0);
  return codes;
}

describe('the signup-source allow-list mirror', () => {
  it('equals the server list exactly', () => {
    expect([...SIGNUP_SOURCE_CODES].sort()).toEqual(serverCodes().sort());
  });

  it('holds only codes the pattern allows', () => {
    for (const code of SIGNUP_SOURCE_CODES) expect(code).toMatch(/^[a-z0-9-]{2,32}$/);
  });
});
