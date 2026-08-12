import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Bilingual parity is a product requirement, not a nicety: a worker on the
 * Spanish locale who hits an English-only key sees the raw key path (or a
 * next-intl error) instead of a sentence.
 *
 * This walks the WHOLE message tree, not just `common`, and compares the two
 * locales' leaf-key sets. Anything added to one file and forgotten in the other
 * fails here with the exact paths.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Every leaf path in dotted form, e.g. `common.errors.offline`. */
function leafPaths(node: MessageNode, prefix = ''): string[] {
    if (typeof node === 'string') return [prefix];

    return Object.entries(node).flatMap(([key, value]) =>
        leafPaths(value, prefix ? `${prefix}.${key}` : key),
    );
}

function difference(a: readonly string[], b: readonly string[]): string[] {
    const other = new Set(b);
    return a.filter((path) => !other.has(path)).sort();
}

describe('message catalogue parity', () => {
    const enPaths = leafPaths(en as MessageNode);
    const esPaths = leafPaths(es as MessageNode);

    it('has no key present in en.json but missing from es.json', () => {
        expect(difference(enPaths, esPaths)).toEqual([]);
    });

    it('has no key present in es.json but missing from en.json', () => {
        expect(difference(esPaths, enPaths)).toEqual([]);
    });

    it('resolves the same total number of leaf keys in both locales', () => {
        expect(esPaths.length).toBe(enPaths.length);
    });

    it('has no duplicate leaf paths within a locale', () => {
        expect(new Set(enPaths).size).toBe(enPaths.length);
        expect(new Set(esPaths).size).toBe(esPaths.length);
    });

    it('has no empty string values in either locale', () => {
        const empties: string[] = [];
        for (const [locale, tree] of [
            ['en', en],
            ['es', es],
        ] as const) {
            const walk = (node: MessageNode, prefix: string) => {
                if (typeof node === 'string') {
                    if (node.trim() === '') empties.push(`${locale}:${prefix}`);
                    return;
                }
                for (const [key, value] of Object.entries(node)) {
                    walk(value, prefix ? `${prefix}.${key}` : key);
                }
            };
            walk(tree as MessageNode, '');
        }
        expect(empties).toEqual([]);
    });
});
