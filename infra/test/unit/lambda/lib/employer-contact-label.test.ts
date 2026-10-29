import { normalizeTemplateVariable } from '../../../../lambda/whatsapp/lib/outbox';
import {
  CONTACT_LABEL_CASES,
  cleanLabelPart,
  collapseWhitespace,
  formatEmployerContactLabel,
  loadEmployerContactLabel,
} from '../../../../lambda/lib/employer-contact-label';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('formatEmployerContactLabel', () => {
  it.each(CONTACT_LABEL_CASES.map((c, i) => [i, c] as const))(
    'case %i',
    (_i, { contactName, companyName, label }) => {
      expect(formatEmployerContactLabel({ contactName, companyName })).toBe(label);
    },
  );

  it('is stable under the send-time normaliser for every case (contract with outbox.ts)', () => {
    for (const { contactName, companyName, label } of CONTACT_LABEL_CASES) {
      expect(formatEmployerContactLabel({ contactName, companyName })).toBe(label);
      expect(normalizeTemplateVariable(label)).toBe(label);
    }
  });

  it('compares contact and company unclipped: equal 45-character names give the company alone, clipped to 40', () => {
    const label = formatEmployerContactLabel({ contactName: 'n'.repeat(45), companyName: 'N'.repeat(45) });
    expect(label).toBe('N'.repeat(40));
  });

  it('keeps two long names that differ only after the clip point as two names', () => {
    const label = formatEmployerContactLabel({
      contactName: `${'a'.repeat(30)}x`,
      companyName: `${'a'.repeat(30)}y`,
    });
    expect(label).toBe(`${'a'.repeat(30)} (${'a'.repeat(30)}y)`);
  });

  it('drops a dangling ZWJ or variation selector left by the clip', () => {
    // 🧑‍🔧 is U+1F9D1 U+200D U+1F527; clipping after the ZWJ must not leave it.
    const contact = `${'a'.repeat(28)}🧑\u200D🔧`; // 28 + 3 = 31 code points
    const label = formatEmployerContactLabel({ contactName: contact, companyName: null });
    expect(label).toBe(`${'a'.repeat(28)}🧑`);
    const vs = formatEmployerContactLabel({ contactName: `${'a'.repeat(29)}\u2764\uFE0Fb`, companyName: null });
    expect(vs).toBe(`${'a'.repeat(29)}\u2764`);
  });

  it('keeps an emoji sequence that fits whole, ZWJ and variation selector included', () => {
    const label = formatEmployerContactLabel({ contactName: '🧑\u200D🔧 \u2764\uFE0F', companyName: null });
    expect(label).toBe('🧑\u200D🔧 \u2764\uFE0F');
  });

  it('keeps a 29-character contact plus an emoji whole at exactly 30 code points', () => {
    const label = formatEmployerContactLabel({ contactName: `${'a'.repeat(29)}🏗`, companyName: 'Acme' });
    expect(label).toBe(`${'a'.repeat(29)}🏗 (Acme)`);
    expect(label).not.toMatch(LONE_SURROGATE);
  });

  it('clips a 60-character company to 40 code points', () => {
    const label = formatEmployerContactLabel({ contactName: null, companyName: 'c'.repeat(60) });
    expect(label).toBe('c'.repeat(40));
  });

  it('falls back to Empleador when both parts are missing or blank', () => {
    expect(formatEmployerContactLabel({ contactName: null, companyName: null })).toBe('Empleador');
    expect(formatEmployerContactLabel({ contactName: '  ', companyName: ' \n ' })).toBe('Empleador');
  });

  it('shows the contact alone when the company is missing', () => {
    expect(formatEmployerContactLabel({ contactName: 'Juan', companyName: null })).toBe('Juan');
  });

  it('compares the cleaned values, case-insensitively, for contact equals company', () => {
    expect(formatEmployerContactLabel({ contactName: 'ACME\n co', companyName: 'acme co' })).toBe('acme co');
  });

  it('never leaves a lone surrogate or a control whitespace in a clipped label', () => {
    const label = formatEmployerContactLabel({
      contactName: `${'a'.repeat(29)}🏗🏗`,
      companyName: `x\n${'🚧'.repeat(50)}`,
    });
    expect(label).not.toMatch(/[\r\n\t]/);
    expect(label).not.toMatch(LONE_SURROGATE);
  });
});

describe('collapseWhitespace', () => {
  it('collapses every kind of whitespace run to one space and trims', () => {
    expect(collapseWhitespace('Acme     Co')).toBe('Acme Co');
    expect(collapseWhitespace('a\u00A0\u00A0b\vc\fd')).toBe('a b c d');
    expect(collapseWhitespace('a\u2028b\u2029c')).toBe('a b c');
    expect(collapseWhitespace(' \t\n ')).toBe('');
  });
});

describe('cleanLabelPart', () => {
  it('collapses spaces, NBSP and U+2028', () => {
    expect(cleanLabelPart('Acme     Co', 40)).toBe('Acme Co');
    expect(cleanLabelPart('Acme\u2028Co\u00A0\u00A0Ltd', 40)).toBe('Acme Co Ltd');
  });

  it('returns an empty string for null, undefined and blank input', () => {
    expect(cleanLabelPart(null, 30)).toBe('');
    expect(cleanLabelPart(undefined, 30)).toBe('');
    expect(cleanLabelPart(' \t\n ', 30)).toBe('');
  });

  it('trims again after clipping', () => {
    expect(cleanLabelPart('abcd efgh', 5)).toBe('abcd');
  });
});

describe('loadEmployerContactLabel', () => {
  it('runs the one SQL and formats the result', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ contact: 'Ana', company: 'Acme' }] });
    await expect(loadEmployerContactLabel({ query } as any, 'user-1')).resolves.toBe('Ana (Acme)');
    expect(query).toHaveBeenCalledWith(
      'SELECT jale_cap.employer_contact_name($1) AS contact, employer_display_name($1) AS company',
      ['user-1'],
    );
  });

  it('shows the company alone when the contact is null', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ contact: null, company: 'Acme' }] });
    await expect(loadEmployerContactLabel({ query } as any, 'user-1')).resolves.toBe('Acme');
  });

  it('falls back to Empleador when no row comes back', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(loadEmployerContactLabel({ query } as any, 'user-1')).resolves.toBe('Empleador');
  });
});
