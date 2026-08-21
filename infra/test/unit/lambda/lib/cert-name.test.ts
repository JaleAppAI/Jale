import { validateCertName, MAX_CERT_NAME_LENGTH } from '../../../../lambda/lib/cert-name';

describe('validateCertName', () => {
  describe('doc_type !== certification_doc', () => {
    it('accepts an absent cert_name', () => {
      expect(validateCertName('resume', undefined, true)).toEqual({ ok: true, certName: null });
      expect(validateCertName('resume', undefined, false)).toEqual({ ok: true, certName: null });
    });

    it('accepts an explicit null cert_name', () => {
      expect(validateCertName('resume', null, true)).toEqual({ ok: true, certName: null });
    });

    it('accepts a whitespace-only cert_name (treated as absent)', () => {
      expect(validateCertName('driver_license', '   ', true)).toEqual({ ok: true, certName: null });
    });

    it('rejects a non-blank cert_name with invalid_cert_name', () => {
      expect(validateCertName('resume', 'OSHA 30', true)).toEqual({ ok: false, error: 'invalid_cert_name' });
      expect(validateCertName('work_auth_doc', 'x', false)).toEqual({ ok: false, error: 'invalid_cert_name' });
    });

    it('rejects a non-string, non-blank cert_name with invalid_cert_name', () => {
      expect(validateCertName('resume', 123, true)).toEqual({ ok: false, error: 'invalid_cert_name' });
    });
  });

  describe('doc_type === certification_doc, required: false (upload-url endpoints)', () => {
    it('accepts an absent cert_name', () => {
      expect(validateCertName('certification_doc', undefined, false)).toEqual({ ok: true, certName: null });
    });

    it('accepts an explicit null cert_name', () => {
      expect(validateCertName('certification_doc', null, false)).toEqual({ ok: true, certName: null });
    });

    it('accepts a whitespace-only cert_name as absent', () => {
      expect(validateCertName('certification_doc', '   ', false)).toEqual({ ok: true, certName: null });
    });

    it('trims and accepts a valid cert_name', () => {
      expect(validateCertName('certification_doc', '  OSHA 30  ', false)).toEqual({ ok: true, certName: 'OSHA 30' });
    });

    it('rejects a cert_name over 200 chars with invalid_cert_name', () => {
      const tooLong = 'a'.repeat(MAX_CERT_NAME_LENGTH + 1);
      expect(validateCertName('certification_doc', tooLong, false)).toEqual({ ok: false, error: 'invalid_cert_name' });
    });

    it('accepts a cert_name at exactly 200 chars', () => {
      const exact = 'a'.repeat(MAX_CERT_NAME_LENGTH);
      expect(validateCertName('certification_doc', exact, false)).toEqual({ ok: true, certName: exact });
    });

    it('rejects a non-string cert_name with invalid_cert_name', () => {
      expect(validateCertName('certification_doc', 42, false)).toEqual({ ok: false, error: 'invalid_cert_name' });
    });
  });

  describe('doc_type === certification_doc, required: true (confirm endpoints)', () => {
    it('rejects an absent cert_name with missing_cert_name', () => {
      expect(validateCertName('certification_doc', undefined, true)).toEqual({ ok: false, error: 'missing_cert_name' });
    });

    it('rejects an explicit null cert_name with missing_cert_name', () => {
      expect(validateCertName('certification_doc', null, true)).toEqual({ ok: false, error: 'missing_cert_name' });
    });

    it('rejects a whitespace-only cert_name with missing_cert_name', () => {
      expect(validateCertName('certification_doc', '   ', true)).toEqual({ ok: false, error: 'missing_cert_name' });
    });

    it('trims and accepts a valid cert_name', () => {
      expect(validateCertName('certification_doc', '  Forklift cert  ', true)).toEqual({ ok: true, certName: 'Forklift cert' });
    });

    it('rejects a cert_name over 200 chars with invalid_cert_name (not missing_cert_name)', () => {
      const tooLong = 'a'.repeat(MAX_CERT_NAME_LENGTH + 1);
      expect(validateCertName('certification_doc', tooLong, true)).toEqual({ ok: false, error: 'invalid_cert_name' });
    });
  });
});
