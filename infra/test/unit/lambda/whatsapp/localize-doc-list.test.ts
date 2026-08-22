/**
 * `localizeDocList` — unit tests.
 *
 * This helper renders the `{missing_docs}` slot of the customer-facing
 * `job_documents_required` WhatsApp reply. Every member of the canonical
 * `DOC_TYPES` enum (`lambda/lib/job-fields.ts`) can reach it — a job's
 * `required_docs` is what `applyWorkerToJob` diffs against the vault — plus
 * legacy `ssn`, which stays valid in the DB CHECK for old rows.
 *
 * The suite therefore covers all five reachable keys in both languages
 * (migration 074 added `work_auth_doc`/`certification_doc`, which used to
 * print as raw enum strings to the worker) and pins the unknown-key fallback
 * so a future enum addition shows up as a visibly wrong label rather than a
 * silently dropped requirement.
 */

import { localizeDocList } from '../../../../lambda/whatsapp/processor';

describe('localizeDocList', () => {
  describe('English labels', () => {
    it.each([
      ['resume', 'Resume'],
      ['driver_license', "Driver's license"],
      ['ssn', 'SSN card / ITIN'],
      ['work_auth_doc', 'Work authorization document'],
      ['certification_doc', 'Certification'],
    ])('labels %s', (docType, expected) => {
      expect(localizeDocList([docType], 'en')).toBe(expected);
    });
  });

  describe('Spanish labels', () => {
    it.each([
      ['resume', 'Resume'],
      ['driver_license', 'Licencia de conducir'],
      ['ssn', 'Tarjeta SSN / ITIN'],
      ['work_auth_doc', 'Documento de autorización de trabajo'],
      ['certification_doc', 'Certificación'],
    ])('labels %s', (docType, expected) => {
      expect(localizeDocList([docType], 'es')).toBe(expected);
    });
  });

  it('joins several docs with ", " in the order given', () => {
    expect(localizeDocList(['work_auth_doc', 'resume', 'certification_doc'], 'en')).toBe(
      'Work authorization document, Resume, Certification',
    );
    expect(localizeDocList(['certification_doc', 'driver_license'], 'es')).toBe(
      'Certificación, Licencia de conducir',
    );
  });

  it('renders every canonical DOC_TYPES member without falling back to a raw key', () => {
    // Ties the labels table to the enum rather than to the list above: a new
    // DOC_TYPES member with no label would otherwise reach a worker as the
    // raw identifier and pass every other test here.
    const docTypes = ['resume', 'driver_license', 'work_auth_doc', 'certification_doc'];
    for (const lang of ['en', 'es'] as const) {
      for (const docType of docTypes) {
        expect(localizeDocList([docType], lang)).not.toBe(docType);
      }
    }
  });

  it('falls back to the raw key for an unknown doc type (deliberate: never drop a requirement)', () => {
    expect(localizeDocList(['mystery_doc'], 'en')).toBe('mystery_doc');
    expect(localizeDocList(['mystery_doc'], 'es')).toBe('mystery_doc');
    expect(localizeDocList(['resume', 'mystery_doc'], 'en')).toBe('Resume, mystery_doc');
  });

  it('renders an empty list as an empty string', () => {
    expect(localizeDocList([], 'en')).toBe('');
    expect(localizeDocList([], 'es')).toBe('');
  });
});
