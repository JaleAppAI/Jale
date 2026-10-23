import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/** The company-billing keys (Phase 2), resolved against both catalogues. */
type MessageNode = string | { [key: string]: MessageNode };

function resolve(tree: MessageNode, path: string): string | undefined {
    let node: MessageNode = tree;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

const KEYS = ['billing.company.owner_only', 'billing.company.suspended_title', 'billing.company.suspended_body'] as const;

describe('company billing i18n keys', () => {
    it.each(KEYS)('%s has a non-empty value in en and es', (path) => {
        expect(resolve(en as MessageNode, path)?.trim()).toBeTruthy();
        expect(resolve(es as MessageNode, path)?.trim()).toBeTruthy();
    });

    it('the suspended body is a plural on {count} with a one and an other branch in both languages', () => {
        for (const catalogue of [en, es]) {
            const body = resolve(catalogue as MessageNode, 'billing.company.suspended_body');
            expect(body).toMatch(/^\{count, plural,/);
            expect(body).toMatch(/\bone \{/);
            expect(body).toMatch(/\bother \{/);
        }
    });
});
