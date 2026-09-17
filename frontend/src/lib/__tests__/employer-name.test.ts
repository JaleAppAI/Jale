import { describe, expect, it } from 'vitest';
import { EMPLOYER_NAME_PLACEHOLDER, realCompanyName } from '../employer-name';

describe('realCompanyName', () => {
  it('reports the migration-031 placeholder as no company', () => {
    expect(realCompanyName(EMPLOYER_NAME_PLACEHOLDER)).toBeNull();
    expect(realCompanyName('Empleador')).toBeNull();
    // The server trims before storing, but a padded value must not sneak the
    // placeholder through a strict comparison.
    expect(realCompanyName('  Empleador  ')).toBeNull();
  });

  it('reports an absent or blank name as no company', () => {
    expect(realCompanyName(null)).toBeNull();
    expect(realCompanyName(undefined)).toBeNull();
    expect(realCompanyName('')).toBeNull();
    expect(realCompanyName('   ')).toBeNull();
  });

  /* Equality, not a prefix or substring test -- these are real names. */
  it('keeps a real name that merely contains the placeholder word', () => {
    expect(realCompanyName('Empleadora del Norte')).toBe('Empleadora del Norte');
    expect(realCompanyName('Grupo Empleador')).toBe('Grupo Empleador');
  });

  it('returns a real name, trimmed', () => {
    expect(realCompanyName('Rucoba & Maya')).toBe('Rucoba & Maya');
    expect(realCompanyName('  RM Construction ')).toBe('RM Construction');
  });
});
