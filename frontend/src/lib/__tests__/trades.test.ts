import { describe, expect, it } from 'vitest';
import { tradeLabel } from '@/lib/trades';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * The translator stand-in resolves against the REAL catalogue, so a key this
 * helper asks for that nobody added to `common.trades` fails here rather than
 * rendering as a raw key path in front of an employer.
 */
function translator(locale: Record<string, unknown>) {
    return (key: string): string => {
        const value = key
            .split('.')
            .reduce<unknown>(
                (node, part) => (node && typeof node === 'object'
                    ? (node as Record<string, unknown>)[part]
                    : undefined),
                (locale as { common: unknown }).common,
            );
        if (typeof value !== 'string') throw new Error(`missing key: common.${key}`);
        return value;
    };
}

const t = translator(en);
const tEs = translator(es);

describe('tradeLabel', () => {
    it('translates every member of the WorkerTrade enum in both locales', () => {
        expect(tradeLabel(t, 'electrician')).toBe('Electrician');
        expect(tradeLabel(t, 'plumber')).toBe('Plumber');
        expect(tradeLabel(t, 'carpenter')).toBe('Carpenter');
        expect(tradeLabel(t, 'concrete')).toBe('Concrete');
        expect(tradeLabel(t, 'painting')).toBe('Painting');
        expect(tradeLabel(t, 'other')).toBe('Other');

        expect(tradeLabel(tEs, 'electrician')).toBe('Electricista');
        expect(tradeLabel(tEs, 'plumber')).toBe('Plomero');
        expect(tradeLabel(tEs, 'carpenter')).toBe('Carpintero');
        expect(tradeLabel(tEs, 'concrete')).toBe('Concreto');
        expect(tradeLabel(tEs, 'painting')).toBe('Pintura');
        expect(tradeLabel(tEs, 'other')).toBe('Otro');
    });

    it('says the trade is unspecified rather than rendering a blank', () => {
        expect(tradeLabel(t, null)).toBe('Trade not specified');
        expect(tradeLabel(t, undefined)).toBe('Trade not specified');
        expect(tradeLabel(t, '')).toBe('Trade not specified');
        expect(tradeLabel(tEs, null)).toBe('Oficio no especificado');
    });

    it('prefers the worker own words for `other`', () => {
        expect(tradeLabel(t, 'other', 'Welder')).toBe('Welder');
        expect(tradeLabel(tEs, 'other', 'Soldador')).toBe('Soldador');
    });

    it('falls back to the generic "Other" when the free-text field is blank', () => {
        expect(tradeLabel(t, 'other', '')).toBe('Other');
        expect(tradeLabel(t, 'other', '   ')).toBe('Other');
        expect(tradeLabel(t, 'other', null)).toBe('Other');
    });

    it('shows an unknown backend value verbatim instead of inventing a label', () => {
        expect(tradeLabel(t, 'roofing')).toBe('roofing');
    });

    it('ignores `tradeOther` for a known trade', () => {
        expect(tradeLabel(t, 'plumber', 'Welder')).toBe('Plumber');
    });
});
