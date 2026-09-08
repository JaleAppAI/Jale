import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for the design-system primitives. These read the source text
 * rather than rendering, because what they protect is the ABSENCE of a thing:
 * a second card recipe, a resurrected `Card`/`PageSkeleton`, a `.pill-` rule,
 * a third hand-copied `BadgeList`. A render test cannot see a duplicate that
 * nothing imports yet -- only the file tree can.
 */

const UI_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../..', import.meta.url));
/* Resolved from `import.meta.url`, not from `process.cwd()`: vitest's cwd is
   not guaranteed to be `frontend/`, and a walk rooted at the wrong directory
   reads zero files and then passes forever. */
const THIS_FILE = fileURLToPath(import.meta.url);

/** Every `.ts`/`.tsx` file under `src`, minus this guard -- which necessarily
 *  contains the very strings it forbids. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            collectSourceFiles(full, out);
        } else if (/\.tsx?$/.test(entry) && full !== THIS_FILE) {
            out.push(full);
        }
    }
    return out;
}

const SOURCE_FILES = collectSourceFiles(SRC_DIR);
const SOURCES = SOURCE_FILES.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/** `from '<x>'` or `import('<x>')` -- the specifier, not a substring anywhere. */
function importsModule(text: string, suffix: string): boolean {
    const escaped = suffix.replace(/[/\-.]/g, '\\$&');
    return new RegExp(`(?:from\\s*|import\\s*\\(\\s*)['"][^'"]*${escaped}['"]`).test(text);
}

function relative(file: string): string {
    return path.relative(SRC_DIR, file);
}

describe('primitives guard: the walk itself', () => {
    // A guard that silently reads nothing is worse than no guard, so the
    // corpus is asserted before anything is asserted ABOUT the corpus.
    it('reads a plausible number of non-empty source files', () => {
        expect(SOURCE_FILES.length).toBeGreaterThan(200);
        expect(SOURCES.filter((s) => s.text.trim().length === 0)).toEqual([]);
    });

    it('roots itself at the real src directory', () => {
        expect(existsSync(path.join(SRC_DIR, 'app', 'globals.css'))).toBe(true);
        expect(existsSync(path.join(UI_DIR, 'dashboard-panel.tsx'))).toBe(true);
    });
});

describe('DashboardPanel is the one card recipe', () => {
    const panel = readFileSync(path.join(UI_DIR, 'dashboard-panel.tsx'), 'utf8');

    it('takes its radius from the token, not a Tailwind literal', () => {
        expect(panel).toContain('var(--radius-card)');
        expect(panel).not.toContain('rounded-2xl');
    });
});

describe('the retired primitives are gone', () => {
    it('has no `ui/card` module and nothing importing one', () => {
        expect(existsSync(path.join(UI_DIR, 'card.tsx'))).toBe(false);

        const offenders = SOURCES
            .filter(({ text }) => importsModule(text, 'ui/card') || importsModule(text, './card'))
            .map(({ file }) => relative(file));
        expect(offenders).toEqual([]);
    });

    it('has no `ui/PageSkeleton` module and nothing importing one', () => {
        expect(existsSync(path.join(UI_DIR, 'PageSkeleton.tsx'))).toBe(false);

        const offenders = SOURCES
            .filter(
                ({ text }) =>
                    importsModule(text, 'ui/PageSkeleton') || importsModule(text, './PageSkeleton'),
            )
            .map(({ file }) => relative(file));
        expect(offenders).toEqual([]);
    });
});

describe('globals.css', () => {
    const css = readFileSync(path.join(SRC_DIR, 'app', 'globals.css'), 'utf8');

    it('declares no `.pill` rule', () => {
        // Rule-shaped only (`.pill {`, `.pill-warn,`), so the `--radius-pill`
        // TOKEN -- which stays -- cannot trip this.
        const rules = css.match(/^\s*\.pill\b[^{,]*[{,]/gm) ?? [];
        expect(rules).toEqual([]);
    });

    it('keeps the --radius-pill token', () => {
        expect(css).toContain('--radius-pill');
    });
});

describe('BadgeList', () => {
    it('is defined exactly once, in ui/badge-list.tsx', () => {
        const definitions = SOURCES
            .filter(({ text }) => /(?:function|const|class)\s+BadgeList\b/.test(text))
            .map(({ file }) => relative(file));
        expect(definitions).toEqual([path.join('components', 'ui', 'badge-list.tsx')]);
    });
});
