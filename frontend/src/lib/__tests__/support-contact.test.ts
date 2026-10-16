import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORT_CONTACT } from '../support-contact';

/**
 * The report flow's fallback contacts are not new contacts: they are the
 * address the legal pages already publish and the keyword the WhatsApp support
 * flow already answers. These read the sources those two facts live in, so a
 * change to either shows up here instead of in a dead link.
 */

function source(relativeToThisFile: string): string {
    return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');
}

describe('support contact', () => {
    it('is the address both legal pages already publish', () => {
        for (const page of ['../../app/privacypolicy/route.ts', '../../app/terms/route.ts']) {
            expect(source(page)).toContain(`mailto:${SUPPORT_CONTACT.email}`);
        }
    });

    it('names a keyword the WhatsApp support flow matches', () => {
        const flows = source('../../../../infra/lambda/whatsapp/lib/flows.ts');
        const matcher = flows.match(/return (\/\^\((?:[a-z|]+)\)\$\/)\.test\(/);
        expect(matcher).not.toBeNull();
        const pattern = new RegExp(matcher![1].slice(1, -1));
        expect(pattern.test(SUPPORT_CONTACT.whatsappKeyword)).toBe(true);
        expect(SUPPORT_CONTACT.whatsappKeyword).toBe('soporte');
    });
});
