import type { ConversationState } from '../../../../lambda/whatsapp/lib/flows';

describe('ConversationState type', () => {
  it('includes building_custom_trust', () => {
    const state: ConversationState = 'building_custom_trust';

    expect(state).toBe('building_custom_trust');
  });
});

describe('normalizeProfession', () => {
  it('lowercases and trims', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('  Soldador  ')).toBe('soldador');
  });

  it('collapses internal whitespace', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('soldador  de  arco')).toBe('soldador de arco');
  });

  it('converts punctuation to spaces', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('soldador-de/arco')).toBe('soldador de arco');
  });

  it('strips accents', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('Soldad\u00f3r')).toBe('soldador');
  });
});
