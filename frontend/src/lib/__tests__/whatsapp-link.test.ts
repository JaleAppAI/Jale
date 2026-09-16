import { describe, expect, it } from 'vitest';
import { whatsappHref } from '../whatsapp-link';

describe('whatsappHref', () => {
  it('links to /whatsapp with ?lang=en for the English locale', () => {
    expect(whatsappHref('en')).toBe('/whatsapp?lang=en');
  });

  it('links to plain /whatsapp (Spanish default text) for the Spanish locale', () => {
    expect(whatsappHref('es')).toBe('/whatsapp');
  });

  it('falls back to plain /whatsapp for any other locale', () => {
    expect(whatsappHref('fr')).toBe('/whatsapp');
  });
});
