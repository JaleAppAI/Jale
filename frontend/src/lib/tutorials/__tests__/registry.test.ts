import { describe, expect, it } from 'vitest';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS } from '@/lib/api/tutorials';
import { TUTORIALS, getTutorial, tutorialsForRole } from '../registry';

/*
 * The registry is the one place that maps a contract id to its content file.
 * Only what stays true as the content lanes fill those files is checked here.
 */

describe('tutorial registry', () => {
    it('holds exactly the contract ids, each under its own id', () => {
        expect(Object.keys(TUTORIALS).sort()).toEqual([...EMPLOYER_TUTORIAL_IDS, ...WORKER_TUTORIAL_IDS].sort());
        for (const [id, definition] of Object.entries(TUTORIALS)) {
            expect(definition.id).toBe(id);
        }
    });

    it('lists each role’s tutorials in contract order, for Help', () => {
        expect(tutorialsForRole('employer').map((definition) => definition.id)).toEqual([...EMPLOYER_TUTORIAL_IDS]);
        expect(tutorialsForRole('worker').map((definition) => definition.id)).toEqual([...WORKER_TUTORIAL_IDS]);
        expect(tutorialsForRole('employer').every((definition) => definition.role === 'employer')).toBe(true);
        expect(tutorialsForRole('worker').every((definition) => definition.role === 'worker')).toBe(true);
    });

    it('finds a tutorial by id', () => {
        expect(getTutorial('worker_details')?.id).toBe('worker_details');
    });

    it('gives every tutorial at least one slide with a unique id', () => {
        for (const definition of Object.values(TUTORIALS)) {
            const ids = definition.slides.map((slide) => slide.id);
            expect(ids.length).toBeGreaterThan(0);
            expect(new Set(ids).size).toBe(ids.length);
        }
    });
});
