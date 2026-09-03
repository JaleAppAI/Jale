import { describe, expect, it } from 'vitest';
import {
    MAX_PROMPTS,
    MAX_PROMPT_CHARS,
    RECOMMENDED_MAX_PROMPTS,
    SOFT_PROMPT_CHARS,
    addPrompt,
    canAddPrompt,
    mintPromptId,
    movePrompt,
    normalizePrompts,
    promptTipLevel,
    removePromptAt,
    sanitizePrompts,
    updatePromptText,
    validatePrompts,
    type PromptDraft,
} from '@/lib/pre-application-prompts';

const draft = (id: string, text: string): PromptDraft => ({ id, text });

describe('bounds', () => {
    it('keeps the hard cap at the backend bound and the counter guide below it', () => {
        // B4.0 reconciliation 6: ONE bound set everywhere -- text 1..500 is what
        // migration 091's CHECK and the create/update handlers enforce; 300 is
        // only the number the editor's counter shows.
        expect(MAX_PROMPT_CHARS).toBe(500);
        expect(SOFT_PROMPT_CHARS).toBe(300);
        expect(SOFT_PROMPT_CHARS).toBeLessThan(MAX_PROMPT_CHARS);
        expect(MAX_PROMPTS).toBe(10);
        expect(RECOMMENDED_MAX_PROMPTS).toBe(2);
    });
});

describe('mintPromptId', () => {
    it('mints an id the migration-091 CHECK accepts', () => {
        // `pre_application_prompts_valid` requires ^[A-Za-z0-9_-]{1,40}$ per
        // prompt id. A v4 UUID is 36 chars of hex and hyphens, so it fits --
        // asserted rather than assumed, because the constraint fails closed.
        const id = mintPromptId();
        expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
        expect(id).not.toBe(mintPromptId());
    });
});

describe('addPrompt', () => {
    it('appends one blank prompt with a fresh id', () => {
        const next = addPrompt([]);
        expect(next).toHaveLength(1);
        expect(next[0].text).toBe('');
        expect(next[0].id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    });

    it('never grows past the cap', () => {
        const full = Array.from({ length: MAX_PROMPTS }, (_, i) => draft(`p${i}`, `q${i}`));
        expect(addPrompt(full)).toBe(full);
        expect(canAddPrompt(full)).toBe(false);
        expect(canAddPrompt(full.slice(1))).toBe(true);
    });

    it('does not mutate the input', () => {
        const before: PromptDraft[] = [draft('a', 'one')];
        addPrompt(before);
        expect(before).toHaveLength(1);
    });
});

describe('removePromptAt', () => {
    it('drops the row at the index and leaves every other id alone', () => {
        const prompts = [draft('a', 'one'), draft('b', 'two'), draft('c', 'three')];
        expect(removePromptAt(prompts, 1)).toEqual([draft('a', 'one'), draft('c', 'three')]);
    });

    it('ignores an out-of-range index', () => {
        const prompts = [draft('a', 'one')];
        expect(removePromptAt(prompts, 5)).toBe(prompts);
        expect(removePromptAt(prompts, -1)).toBe(prompts);
    });
});

describe('movePrompt', () => {
    const prompts = [draft('a', 'one'), draft('b', 'two'), draft('c', 'three')];

    it('swaps with the neighbour in the given direction', () => {
        expect(movePrompt(prompts, 1, -1)).toEqual([draft('b', 'two'), draft('a', 'one'), draft('c', 'three')]);
        expect(movePrompt(prompts, 1, 1)).toEqual([draft('a', 'one'), draft('c', 'three'), draft('b', 'two')]);
    });

    it('is a no-op at either end', () => {
        expect(movePrompt(prompts, 0, -1)).toBe(prompts);
        expect(movePrompt(prompts, 2, 1)).toBe(prompts);
    });
});

describe('updatePromptText', () => {
    it('replaces only that row’s text and keeps its id', () => {
        const prompts = [draft('a', 'one'), draft('b', 'two')];
        expect(updatePromptText(prompts, 1, 'edited')).toEqual([draft('a', 'one'), draft('b', 'edited')]);
    });

    it('ignores an out-of-range index', () => {
        const prompts = [draft('a', 'one')];
        expect(updatePromptText(prompts, 3, 'x')).toBe(prompts);
    });
});

describe('validatePrompts', () => {
    it('accepts an empty list -- a job may ask nothing', () => {
        expect(validatePrompts([])).toBeNull();
    });

    it('rejects a blank or whitespace-only row', () => {
        expect(validatePrompts([draft('a', '')])).toBe('prompt_blank');
        expect(validatePrompts([draft('a', '   \n ')])).toBe('prompt_blank');
    });

    it('measures length AFTER trimming, against the hard bound', () => {
        expect(validatePrompts([draft('a', 'x'.repeat(MAX_PROMPT_CHARS))])).toBeNull();
        expect(validatePrompts([draft('a', `  ${'x'.repeat(MAX_PROMPT_CHARS)}  `)])).toBeNull();
        expect(validatePrompts([draft('a', 'x'.repeat(MAX_PROMPT_CHARS + 1))])).toBe('prompt_too_long');
    });

    it('accepts text past the soft counter guide', () => {
        expect(validatePrompts([draft('a', 'x'.repeat(SOFT_PROMPT_CHARS + 1))])).toBeNull();
    });

    it('reports blank before too-long, so the emptiest row is named first', () => {
        expect(validatePrompts([draft('a', 'x'.repeat(MAX_PROMPT_CHARS + 1)), draft('b', '')]))
            .toBe('prompt_blank');
    });
});

describe('normalizePrompts', () => {
    it('trims text and preserves every id verbatim', () => {
        expect(normalizePrompts([draft('keep-me', '  What tools?  ')]))
            .toEqual([{ id: 'keep-me', text: 'What tools?' }]);
    });

    it('drops blank rows -- an unfilled Add is not a question', () => {
        expect(normalizePrompts([draft('a', 'real'), draft('b', '  ')]))
            .toEqual([{ id: 'a', text: 'real' }]);
    });

    it('never re-mints an id', () => {
        const prompts = [draft('stable-1', 'one'), draft('stable-2', 'two')];
        expect(normalizePrompts(prompts).map((p) => p.id)).toEqual(['stable-1', 'stable-2']);
    });

    it('caps the list at MAX_PROMPTS', () => {
        const many = Array.from({ length: MAX_PROMPTS + 3 }, (_, i) => draft(`p${i}`, `q${i}`));
        expect(normalizePrompts(many)).toHaveLength(MAX_PROMPTS);
    });
});

describe('sanitizePrompts', () => {
    it('reads a stored list back with its ids intact', () => {
        expect(sanitizePrompts([{ id: 'p1', text: 'Tell me about a pour.' }]))
            .toEqual([{ id: 'p1', text: 'Tell me about a pour.' }]);
    });

    it('treats an absent/!array value as no prompts rather than crashing', () => {
        expect(sanitizePrompts(undefined)).toEqual([]);
        expect(sanitizePrompts(null)).toEqual([]);
        expect(sanitizePrompts('nope' as unknown as unknown[])).toEqual([]);
    });

    it('drops entries that are not {id, text} strings', () => {
        expect(sanitizePrompts([
            { id: 'ok', text: 'fine' },
            { id: 7, text: 'bad id' },
            { id: 'no-text' },
            null,
            'string',
        ] as unknown[])).toEqual([{ id: 'ok', text: 'fine' }]);
    });

    it('drops an entry whose id the backend CHECK would reject', () => {
        expect(sanitizePrompts([{ id: 'has space', text: 'x' }] as unknown[])).toEqual([]);
    });
});

describe('promptTipLevel', () => {
    it('stays informational at or below the recommendation', () => {
        expect(promptTipLevel(0)).toBe('info');
        expect(promptTipLevel(RECOMMENDED_MAX_PROMPTS)).toBe('info');
    });

    it('flips to warning above it', () => {
        expect(promptTipLevel(RECOMMENDED_MAX_PROMPTS + 1)).toBe('warning');
        expect(promptTipLevel(MAX_PROMPTS)).toBe('warning');
    });
});
