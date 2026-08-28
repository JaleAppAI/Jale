import { describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { DOC_TYPE_KEYS, docTypeLabel, isDocTypeKey } from '../doc-types';

/** A stand-in for next-intl's `useTranslations('doc_types')` return value. */
function translator(tree: Record<string, string>) {
    return (key: string) => {
        const value = tree[key];
        // next-intl does NOT return undefined for a missing key -- it renders
        // the key path (or throws, depending on config). Mirroring that here is
        // the whole point: `docTypeLabel` must decide membership BEFORE it
        // calls `t`, or an unknown doc type reaches the screen as `doc_types.x`
        // instead of being reportable as unknown.
        if (value === undefined) return `doc_types.${key}`;
        return value;
    };
}

describe('doc-types catalogue', () => {
    it('lists every doc type the app can name, legacy ssn included', () => {
        expect([...DOC_TYPE_KEYS]).toEqual([
            'resume',
            'driver_license',
            'work_auth_doc',
            'certification_doc',
            'ssn',
        ]);
    });

    it('has a non-empty label in BOTH locales for every key', () => {
        const missing: string[] = [];
        for (const [locale, tree] of [
            ['en', en],
            ['es', es],
        ] as const) {
            const namespace = (tree as unknown as { doc_types?: Record<string, string> }).doc_types;
            for (const key of DOC_TYPE_KEYS) {
                const value = namespace?.[key];
                if (typeof value !== 'string' || value.trim() === '') {
                    missing.push(`${locale}:doc_types.${key}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('resolves a known key through the single doc_types namespace', () => {
        const t = translator((en as unknown as { doc_types: Record<string, string> }).doc_types);
        expect(docTypeLabel('resume', t)).toBe('Resume');
        expect(docTypeLabel('certification_doc', t)).toBe('Certification');
        expect(docTypeLabel('ssn', t)).toBe('SSN Card / ITIN');
    });

    it('resolves the Spanish catalogue from the same key set', () => {
        const t = translator((es as unknown as { doc_types: Record<string, string> }).doc_types);
        expect(docTypeLabel('driver_license', t)).toBe('Licencia de conducir');
        expect(docTypeLabel('work_auth_doc', t)).toBe('Documento de autorización de trabajo');
    });

    it('returns null for an unknown key WITHOUT calling the translator', () => {
        // Callers branch on null to show a visible error. Calling `t` first
        // would leak a raw key path into the UI and, under a strict next-intl
        // config, throw during render.
        const t = vi.fn(() => 'should not be reached');
        expect(docTypeLabel('passport', t)).toBeNull();
        expect(docTypeLabel('', t)).toBeNull();
        expect(t).not.toHaveBeenCalled();
    });

    it('narrows with isDocTypeKey', () => {
        expect(isDocTypeKey('work_auth_doc')).toBe(true);
        expect(isDocTypeKey('Resume')).toBe(false);
        expect(isDocTypeKey('passport')).toBe(false);
    });

    it('never resolves a doc_types key path as a label (guards the lookup order)', () => {
        const t = translator((en as unknown as { doc_types: Record<string, string> }).doc_types);
        for (const key of ['passport', 'i9', 'unknown']) {
            expect(docTypeLabel(key, t)).toBeNull();
        }
    });
});
