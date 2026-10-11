import { randomUUID } from 'node:crypto';
import {
  MAX_BODY_BYTES,
  categoriesFor,
  readJsonBody,
  sanitizeContext,
  scrubText,
  validateAttach,
  validateCreate,
  validatePublicCreate,
  validateUpload,
} from '../../../../lambda/reports/lib/validate';

// Reserved test names, assembled at runtime.
const TEST_DOMAIN = ['example', 'invalid'].join('.');
const EMAIL = ['someone', TEST_DOMAIN].join('@');
// The 555-01xx block is reserved for fiction.
const PHONE = ['+1', '555', '010', '0142'].join(' ');
const TOKEN = 'A'.repeat(43);

const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_key: randomUUID(),
  category: 'applying',
  description: 'The apply button does nothing.',
  stops_work: null,
  locale: 'es',
  include_technical: true,
  context: { v: 1, screen: { pattern: '/worker/jobs/:id', refs: {} } },
  image: null,
  ...overrides,
});

const validPublicBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  validBody({ category: 'sign_in', role_claimed: 'worker', contact: null, ...overrides });

const fieldsOf = (result: { ok: boolean; fields?: string[] }): string[] | undefined =>
  result.ok ? undefined : result.fields;

describe('readJsonBody', () => {
  it('parses a JSON object body', () => {
    expect(readJsonBody({ body: '{"a":1}' })).toEqual({ ok: true, value: { a: 1 } });
  });

  it('answers 413 for a body over 64 KB, counted in bytes', () => {
    const big = JSON.stringify({ description: 'x'.repeat(MAX_BODY_BYTES) });
    expect(readJsonBody({ body: big })).toEqual({ ok: false, status: 413, error: 'payload_too_large' });
    // 22,000 three-byte characters are fewer than 64K characters but more than 64 KB.
    const wide = JSON.stringify({ description: '€'.repeat(22000) });
    expect(wide.length).toBeLessThan(MAX_BODY_BYTES);
    expect(readJsonBody({ body: wide })).toMatchObject({ ok: false, status: 413 });
  });

  it('accepts exactly 64 KB', () => {
    const prefix = '{"d":"';
    const body = `${prefix}${'x'.repeat(MAX_BODY_BYTES - prefix.length - 2)}"}`;
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    expect(readJsonBody({ body }).ok).toBe(true);
  });

  it('decodes a base64 body before measuring and parsing it', () => {
    const body = Buffer.from('{"a":2}').toString('base64');
    expect(readJsonBody({ body, isBase64Encoded: true })).toEqual({ ok: true, value: { a: 2 } });
  });

  it.each([
    ['no body', null],
    ['an empty body', ''],
    ['malformed JSON', '{"a":'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"text"'],
  ])('answers 400 for %s', (_label, body) => {
    expect(readJsonBody({ body })).toEqual({ ok: false, status: 400, error: 'invalid_request', fields: ['body'] });
  });
});

describe('categoriesFor', () => {
  it('gives the worker list to workers and to an unknown role, and the employer list to employers', () => {
    expect(categoriesFor('worker')).toEqual(['sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other']);
    expect(categoriesFor('unknown')).toEqual(categoriesFor('worker'));
    expect(categoriesFor('employer')).toEqual([
      'account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile', 'other',
    ]);
  });
});

describe('validateCreate (signed in)', () => {
  it('accepts a valid body and returns the trimmed, normalised input', () => {
    const key = randomUUID().toUpperCase();
    const result = validateCreate(validBody({ client_key: key, description: '  It broke.  ' }), 'worker');
    expect(result).toMatchObject({
      ok: true,
      value: {
        clientKey: key.toLowerCase(),
        category: 'applying',
        description: 'It broke.',
        stopsWork: null,
        locale: 'es',
        includeTechnical: true,
        image: null,
      },
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a missing client key', { client_key: undefined }, 'client_key'],
    ['a client key that is not a UUID', { client_key: 'not-a-uuid' }, 'client_key'],
    ['a client key that is a UUID of another version', { client_key: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }, 'client_key'],
    ['a category outside every list', { category: 'refunds' }, 'category'],
    ['a category of the other role', { category: 'billing' }, 'category'],
    ['a missing category', { category: undefined }, 'category'],
    ['an empty description', { description: '' }, 'description'],
    ['a description of spaces only', { description: '   \n ' }, 'description'],
    ['a description over 2000 characters', { description: 'x'.repeat(2001) }, 'description'],
    ['a description that is not text', { description: 42 }, 'description'],
    ['a stops-work answer from a worker', { stops_work: true }, 'stops_work'],
    ['a locale other than es and en', { locale: 'fr' }, 'locale'],
    ['a missing technical-details flag', { include_technical: undefined }, 'include_technical'],
    ['a technical-details flag that is not a boolean', { include_technical: 'yes' }, 'include_technical'],
    ['an image of another type', { image: { content_type: 'image/svg+xml', byte_size: 10 } }, 'image'],
    ['an empty image', { image: { content_type: 'image/png', byte_size: 0 } }, 'image'],
    ['an image over 5 MB', { image: { content_type: 'image/png', byte_size: 5242881 } }, 'image'],
    ['an image size that is not an integer', { image: { content_type: 'image/png', byte_size: 1.5 } }, 'image'],
    ['an image that is not an object', { image: 'photo.png' }, 'image'],
  ])('answers 400 naming the field for %s', (_label, overrides, field) => {
    expect(fieldsOf(validateCreate(validBody(overrides), 'worker'))).toEqual([field]);
  });

  it('names every failing field, and never echoes a value', () => {
    const result = validateCreate(validBody({ client_key: 'secret-looking-value', locale: 'xx', description: '' }), 'worker');
    expect(fieldsOf(result)).toEqual(['client_key', 'description', 'locale']);
    expect(JSON.stringify(result)).not.toContain('secret-looking-value');
  });

  it('counts description characters, not UTF-16 units', () => {
    const astral = '\u{1F600}'.repeat(2000);
    expect(astral.length).toBe(4000);
    expect(validateCreate(validBody({ description: astral }), 'worker').ok).toBe(true);
  });

  it('accepts exactly 2000 characters and an image at both size bounds', () => {
    expect(validateCreate(validBody({ description: 'y'.repeat(2000) }), 'worker').ok).toBe(true);
    for (const byteSize of [1, 5242880]) {
      const result = validateCreate(validBody({ image: { content_type: 'image/webp', byte_size: byteSize } }), 'worker');
      expect(result).toMatchObject({ ok: true, value: { image: { contentType: 'image/webp', byteSize } } });
    }
  });

  it('accepts the stops-work answer from an employer, and from a sign-in whose role the account decides', () => {
    const employer = validateCreate(validBody({ category: 'billing', stops_work: true }), 'employer');
    expect(employer).toMatchObject({ ok: true, value: { stopsWork: true } });
    const unknown = validateCreate(validBody({ category: 'billing', stops_work: false }), 'unknown');
    expect(unknown).toMatchObject({ ok: true, value: { category: 'billing', stopsWork: false } });
    expect(fieldsOf(validateCreate(validBody({ stops_work: 'yes' }), 'employer'))).toEqual(['category', 'stops_work']);
  });

  it('accepts any known category when the role is left to the account', () => {
    expect(validateCreate(validBody({ category: 'whatsapp' }), 'unknown').ok).toBe(true);
    expect(validateCreate(validBody({ category: 'company_profile' }), 'unknown').ok).toBe(true);
    expect(fieldsOf(validateCreate(validBody({ category: 'refunds' }), 'unknown'))).toEqual(['category']);
  });

  it('treats a missing stops-work answer and a missing image as null', () => {
    const result = validateCreate(validBody({ stops_work: undefined, image: undefined }), 'worker');
    expect(result).toMatchObject({ ok: true, value: { stopsWork: null, image: null } });
  });

  it('never rejects a malformed context: it is reduced, not refused', () => {
    for (const context of [undefined, null, 'text', [1, 2], 7, { v: 2, junk: true }]) {
      const result = validateCreate(validBody({ context }), 'worker');
      expect(result).toMatchObject({ ok: true, value: { context: { v: 1 } } });
    }
  });

  it('ignores the public-only fields on the signed-in door', () => {
    const result = validateCreate(validBody({ role_claimed: 'employer', contact: EMAIL }), 'worker');
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
  });
});

describe('validatePublicCreate (signed out)', () => {
  it('accepts a valid body with a trimmed contact', () => {
    const result = validatePublicCreate(validPublicBody({ contact: `  ${EMAIL}  ` }));
    expect(result).toMatchObject({ ok: true, value: { roleClaimed: 'worker', contact: EMAIL, category: 'sign_in' } });
  });

  it('turns a blank contact into none', () => {
    expect(validatePublicCreate(validPublicBody({ contact: '   ' }))).toMatchObject({ ok: true, value: { contact: null } });
    expect(validatePublicCreate(validPublicBody({ contact: undefined }))).toMatchObject({ ok: true, value: { contact: null } });
  });

  it('accepts a contact of exactly 200 characters and refuses 201', () => {
    expect(validatePublicCreate(validPublicBody({ contact: 'c'.repeat(200) })).ok).toBe(true);
    expect(fieldsOf(validatePublicCreate(validPublicBody({ contact: 'c'.repeat(201) })))).toEqual(['contact']);
    expect(fieldsOf(validatePublicCreate(validPublicBody({ contact: 12 })))).toEqual(['contact']);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a missing claimed role', { role_claimed: undefined }, ['role_claimed']],
    ['a claimed role outside the three', { role_claimed: 'admin' }, ['role_claimed']],
    ['a category of the other role', { role_claimed: 'employer', category: 'sign_in' }, ['category']],
    ['an employer category for an unknown role', { role_claimed: 'unknown', category: 'billing' }, ['category']],
    ['a stops-work answer from an unknown role', { role_claimed: 'unknown', stops_work: false }, ['stops_work']],
  ])('answers 400 for %s', (_label, overrides, fields) => {
    expect(fieldsOf(validatePublicCreate(validPublicBody(overrides)))).toEqual(fields);
  });

  it('gives an unknown role the worker list', () => {
    expect(validatePublicCreate(validPublicBody({ role_claimed: 'unknown', category: 'uploads' })).ok).toBe(true);
  });

  it('accepts the stops-work answer from a claimed employer', () => {
    const result = validatePublicCreate(validPublicBody({ role_claimed: 'employer', category: 'account', stops_work: true }));
    expect(result).toMatchObject({ ok: true, value: { roleClaimed: 'employer', stopsWork: true } });
  });
});

describe('validateUpload and validateAttach', () => {
  const reportId = randomUUID();

  it('accept a report id, a token of the issued shape and, for upload, an image', () => {
    expect(validateAttach({ report_id: reportId, attach_token: TOKEN })).toEqual({
      ok: true,
      value: { reportId, attachToken: TOKEN },
    });
    expect(validateUpload({ report_id: reportId, attach_token: TOKEN, image: { content_type: 'image/jpeg', byte_size: 900 } }))
      .toEqual({ ok: true, value: { reportId, attachToken: TOKEN, image: { contentType: 'image/jpeg', byteSize: 900 } } });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a report id that is not a UUID', { report_id: 'JR-1042' }, ['report_id']],
    ['a token of another length', { attach_token: 'A'.repeat(42) }, ['attach_token']],
    ['a token with characters outside base64url', { attach_token: `${'A'.repeat(42)}=` }, ['attach_token']],
    ['a missing token', { attach_token: undefined }, ['attach_token']],
  ])('attach answers 400 for %s', (_label, overrides, fields) => {
    expect(fieldsOf(validateAttach({ report_id: reportId, attach_token: TOKEN, ...overrides }))).toEqual(fields);
  });

  it('upload requires an image', () => {
    expect(fieldsOf(validateUpload({ report_id: reportId, attach_token: TOKEN }))).toEqual(['image']);
    expect(fieldsOf(validateUpload({ report_id: reportId, attach_token: TOKEN, image: null }))).toEqual(['image']);
  });

  it('refuses a body that is not an object', () => {
    expect(fieldsOf(validateAttach(null))).toEqual(['body']);
    expect(fieldsOf(validateUpload([reportId]))).toEqual(['body']);
  });
});

describe('scrubText', () => {
  it('replaces a phone number, an email address and a 9-digit run with placeholders', () => {
    const scrubbed = scrubText(`Call ${PHONE} or write ${EMAIL}; order 123456789 failed`);
    expect(scrubbed).not.toContain('555');
    expect(scrubbed).not.toContain(EMAIL);
    expect(scrubbed).not.toContain('123456789');
    expect(scrubbed).toContain('[phone]');
    expect(scrubbed).toContain('[email]');
    expect(scrubbed).toMatch(/\[(number|phone)\]/);
  });

  it('keeps short numbers and ordinary words', () => {
    expect(scrubText('Request failed with status 500 after 3 tries')).toBe('Request failed with status 500 after 3 tries');
  });

  it('replaces record ids, sign-in tokens and links', () => {
    const scrubbed = scrubText(`id ${randomUUID()} token eyJabc.def.ghi at https://${TEST_DOMAIN}/path?q=1`);
    expect(scrubbed).toBe('id [id] token [token] at [url]');
  });
});

describe('sanitizeContext', () => {
  const uuid = randomUUID();
  const full = (): Record<string, unknown> => ({
    v: 1,
    screen: { pattern: '/worker/jobs/:id', refs: { id: uuid } },
    screens: ['/worker/home', '/worker/jobs/:id'],
    app: { build: 'abcdef123456', locale: 'es', theme: 'dark' },
    device: {
      kind: 'phone', browser: 'safari', os: 'ios', viewport: [390, 844], online: true,
      tz: 'America/Chicago', local_time: '2026-10-05T10:11:12-05:00',
    },
    requests: [{ m: 'POST', p: '/worker/jobs/:id/apply', s: 500, ms: 2100, rid: 'abc-123' }],
    errors: [{ k: 'api', msg: 'Request failed', at: '2026-10-05T15:11:12.000Z' }],
    capture: { outcome: 'ok', ms: 820 },
  });

  it('keeps a well-formed v1 context as it is', () => {
    expect(sanitizeContext(full(), true)).toEqual(full());
  });

  it('drops unknown keys at every level', () => {
    const ctx = full();
    ctx.extra = 'x';
    (ctx.screen as Record<string, unknown>).title = 'Pay stub';
    (ctx.app as Record<string, unknown>).user = 'someone';
    (ctx.device as Record<string, unknown>).ip = '192.0.2.1';
    ((ctx.requests as Record<string, unknown>[])[0]).body = '{"phone":1}';
    ((ctx.errors as Record<string, unknown>[])[0]).stack = 'at x';
    (ctx.capture as Record<string, unknown>).image = 'data:';
    expect(sanitizeContext(ctx, true)).toEqual(full());
  });

  it('with technical details off keeps only the screen pattern, the build and the locale', () => {
    expect(sanitizeContext(full(), false)).toEqual({
      v: 1,
      screen: { pattern: '/worker/jobs/:id' },
      app: { build: 'abcdef123456', locale: 'es' },
    });
  });

  it('keeps only UUID screen refs', () => {
    const ctx = full();
    (ctx.screen as Record<string, unknown>).refs = { id: uuid, code: 'ABCD1234', worker_id: 'someone', n: 7 };
    expect((sanitizeContext(ctx, true).screen as Record<string, unknown>).refs).toEqual({ id: uuid });
  });

  it('truncates an over-long message after scrubbing it, and never rejects', () => {
    const ctx = full();
    ctx.errors = [{ k: 'error', msg: `${EMAIL} ${'z'.repeat(400)}`, at: '2026-10-05T15:11:12.000Z' }];
    const [error] = sanitizeContext(ctx, true).errors as Array<{ msg: string }>;
    expect(error.msg.length).toBeLessThanOrEqual(200);
    expect(error.msg.startsWith('[email] zzz')).toBe(true);
  });

  it('drops a malformed request id and an over-long or lower-case method, and keeps the rest of the entry', () => {
    const ctx = full();
    ctx.requests = [
      { m: 'POST', p: '/a', s: 200, ms: 5, rid: 'bad id; drop table' },
      { m: 'get', p: '/b', s: 200, ms: 5, rid: 'r'.repeat(80) },
    ];
    expect(sanitizeContext(ctx, true).requests).toEqual([
      { m: 'POST', p: '/a', s: 200, ms: 5 },
      { p: '/b', s: 200, ms: 5, rid: 'r'.repeat(64) },
    ]);
  });

  it('keeps an unknown browser family, shortened, and drops one with characters outside a family name', () => {
    const ctx = full();
    (ctx.device as Record<string, unknown>).browser = 'NetFront Super Browser Edition 2000 Plus';
    (ctx.device as Record<string, unknown>).os = '<script>';
    const device = sanitizeContext(ctx, true).device as Record<string, unknown>;
    expect(device.browser).toBe('NetFront Super Browser Edition 2');
    expect(device.os).toBeUndefined();
  });

  it('truncates patterns to 200 and the time zone to 64', () => {
    const ctx = full();
    (ctx.screen as Record<string, unknown>).pattern = `/${'p'.repeat(300)}`;
    (ctx.device as Record<string, unknown>).tz = 'Z'.repeat(100);
    ctx.screens = [`/${'s'.repeat(300)}`];
    ctx.requests = [{ m: 'GET', p: `/${'q'.repeat(300)}`, s: 200, ms: 1 }];
    const out = sanitizeContext(ctx, true);
    expect(((out.screen as Record<string, unknown>).pattern as string).length).toBe(200);
    expect(((out.device as Record<string, unknown>).tz as string).length).toBe(64);
    expect((out.screens as string[])[0].length).toBe(200);
    expect(((out.requests as Array<Record<string, unknown>>)[0].p as string).length).toBe(200);
  });

  it('scrubs value-shaped content out of patterns too', () => {
    const ctx = full();
    (ctx.screen as Record<string, unknown>).pattern = `/worker/${EMAIL}/1234567`;
    expect((sanitizeContext(ctx, true).screen as Record<string, unknown>).pattern).toBe('/worker/[email]/[number]');
  });

  it('caps the arrays, keeping the most recent entries', () => {
    const ctx = full();
    ctx.requests = Array.from({ length: 25 }, (_, i) => ({ m: 'GET', p: `/r${i}`, s: 200, ms: i }));
    ctx.errors = Array.from({ length: 12 }, (_, i) => ({ k: 'error', msg: `e${i}`, at: '2026-10-05T15:11:12.000Z' }));
    ctx.screens = Array.from({ length: 7 }, (_, i) => `/s${i}`);
    const out = sanitizeContext(ctx, true);
    expect((out.requests as unknown[]).length).toBe(20);
    expect((out.requests as Array<{ p: string }>)[0].p).toBe('/r5');
    expect((out.errors as unknown[]).length).toBe(10);
    expect((out.errors as Array<{ msg: string }>)[9].msg).toBe('e11');
    expect(out.screens).toEqual(['/s2', '/s3', '/s4', '/s5', '/s6']);
  });

  it('drops malformed entries and fields of the wrong shape', () => {
    const ctx = full();
    ctx.requests = ['GET /x', null, { m: 'GET', p: '/ok', s: 'x', ms: -1 }, {}];
    ctx.errors = [{ k: 'crash', msg: 5, at: 'yesterday' }, { k: 'api', msg: 'm', at: '2026-10-05T15:11:12Z' }];
    ctx.app = { build: 'not-hex-12ch', locale: 'fr', theme: 'blue' };
    ctx.device = { kind: 'watch', viewport: [390], online: 'yes', local_time: 'noon' };
    ctx.capture = { outcome: 'great', ms: '5' };
    ctx.screens = ['/ok', 3, null];
    expect(sanitizeContext(ctx, true)).toEqual({
      v: 1,
      screen: { pattern: '/worker/jobs/:id', refs: { id: uuid } },
      screens: ['/ok'],
      requests: [{ m: 'GET', p: '/ok' }],
      errors: [{ k: 'api', msg: 'm', at: '2026-10-05T15:11:12Z' }],
    });
  });

  it('keeps a zero status, which means no response was observed', () => {
    const ctx = full();
    ctx.requests = [{ m: 'GET', p: '/x', s: 0, ms: 15000 }];
    expect(sanitizeContext(ctx, true).requests).toEqual([{ m: 'GET', p: '/x', s: 0, ms: 15000 }]);
  });

  it('keeps the context well under the database size limit at every cap', () => {
    const ctx = full();
    ctx.requests = Array.from({ length: 20 }, () => ({ m: 'A'.repeat(10), p: `/${'p'.repeat(250)}`, s: 999, ms: 2147483647, rid: 'r'.repeat(64) }));
    ctx.errors = Array.from({ length: 10 }, () => ({ k: 'rejection', msg: 'm'.repeat(250), at: '2026-10-05T15:11:12.123+05:30' }));
    ctx.screens = Array.from({ length: 5 }, () => `/${'s'.repeat(250)}`);
    expect(Buffer.byteLength(JSON.stringify(sanitizeContext(ctx, true)))).toBeLessThan(16 * 1024);
  });
});

/**
 * PostgreSQL stores no NUL, and no half of a surrogate pair standing alone.
 * Before this check, a NUL reached the database and was refused there,
 * answering 500: in a text column (22021) and in the jsonb context (22P05), as
 * was a lone half in the context (22P02). A lone half in a text column never
 * reached it as such: the driver's UTF-8 encoding replaced it, and the report
 * was saved with U+FFFD in its place. The top-level text fields now refuse
 * both with a 400 that names the field; the context, which is reduced and
 * never refused, drops a NUL and replaces a lone half with U+FFFD.
 */
describe('text the database cannot store', () => {
  const NUL = String.fromCharCode(0);
  const HIGH = String.fromCharCode(0xd800);
  const LOW = String.fromCharCode(0xdc00);
  const LONE = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]');

  it.each<[string, Record<string, unknown>]>([
    ['a NUL', { description: `It broke${NUL} here.` }],
    ['a lone high surrogate', { description: `It broke ${HIGH}` }],
    ['a lone low surrogate', { description: `${LOW} It broke.` }],
  ])('refuses %s in the description, on both doors', (_label, overrides) => {
    expect(fieldsOf(validateCreate(validBody(overrides), 'worker'))).toEqual(['description']);
    expect(fieldsOf(validatePublicCreate(validPublicBody(overrides)))).toEqual(['description']);
  });

  it.each<[string, string]>([
    ['a NUL', `reach me${NUL}`],
    ['a lone high surrogate', `${HIGH}reach me`],
    ['a lone low surrogate', `reach ${LOW}me`],
  ])('refuses %s in the contact', (_label, contact) => {
    expect(fieldsOf(validatePublicCreate(validPublicBody({ contact })))).toEqual(['contact']);
  });

  it('keeps whole surrogate pairs: an emoji is ordinary text', () => {
    const emoji = '\u{1F600}';
    expect(validateCreate(validBody({ description: `It broke ${emoji}` }), 'worker').ok).toBe(true);
    expect(validatePublicCreate(validPublicBody({ contact: `${emoji} reach me` })).ok).toBe(true);
  });

  it('cleans the context instead of refusing it: no NUL and no lone half survive', () => {
    const context = {
      v: 1,
      screen: { pattern: `/worker${NUL}/jobs/:id` },
      screens: [`/worker/home${HIGH}`],
      requests: [{ m: 'GET', p: `/x${LOW}${NUL}`, s: 500, ms: 1 }],
      errors: [{ k: 'error', msg: `a${NUL}b${HIGH}`, at: '2026-10-05T15:11:12.000Z' }],
    };
    const result = validateCreate(validBody({ context }), 'worker');
    expect(result.ok).toBe(true);
    const cleaned = (result as { value: { context: Record<string, unknown> } }).value.context;
    expect(cleaned).toMatchObject({
      screen: { pattern: '/worker/jobs/:id' },
      screens: ['/worker/home�'],
      requests: [{ p: '/x�' }],
      errors: [{ msg: 'ab�' }],
    });
    const strings: string[] = [];
    JSON.stringify(cleaned, (_key, value) => {
      if (typeof value === 'string') strings.push(value);
      return value;
    });
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      expect(value).not.toContain(NUL);
      expect(LONE.test(value)).toBe(false);
    }
  });
});
