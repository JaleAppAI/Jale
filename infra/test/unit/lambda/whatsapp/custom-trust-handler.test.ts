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

const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((input) => input),
}));

// handleBuildingCustomTrust (the legacy building_custom_trust state handler)
// was deleted along with the rest of the v1 state machine — v2 is now the
// only onboarding lane. normalizeProfession/loadOrGenerateQuestions remain in
// this module because the v2 onboarding adapters (lib/onboarding-adapters.ts)
// depend on them for custom-trade question generation.
