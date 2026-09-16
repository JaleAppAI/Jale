import { defineConfig } from 'vitest/config';
import path from 'node:path';

// There is deliberately no `esbuild.jsx: 'automatic'` here any more.
//
// It existed because `tsconfig.json` set `jsx: "preserve"` (Next owned the real
// JSX transform), which the transformer honoured by handing Vite untransformed
// JSX. Two things changed with this upgrade: `next build` now rewrites that
// tsconfig entry to `jsx: "react-jsx"` itself, and Vitest 5's transformer is
// oxc, which reads that value and warns that any `esbuild` options are being
// ignored. The automatic runtime is therefore already what the component
// suites get -- from the tsconfig, not from an override that no longer does
// anything. React 19 ships `react/jsx-runtime`, so nothing else is needed.
export default defineConfig({
  test: {
    // Two projects rather than one environment plus `environmentMatchGlobs`:
    // that option was removed in Vitest 4, and it failed OPEN -- the three
    // component suites that had no `// @vitest-environment jsdom` docblock of
    // their own quietly ran in `node` and failed on `document is not defined`.
    //
    // A per-file docblock still wins over its project's environment, which is
    // what keeps `src/lib/__tests__/session-storage.test.ts` -- a `.test.ts`
    // that needs a DOM -- working while it sits in the `unit` project.
    //
    // `extends: true` is what gives both projects the `setupFiles` and the
    // `@` alias below; without it a project starts from an empty config.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Stays 'node': the vast majority of these suites are pure functions
          // and a DOM per file is not free.
          environment: 'node',
          include: ['**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['**/*.test.tsx'],
        },
      },
    ],
    setupFiles: ['./src/test/setup.ts'],
    // `proxy.test.ts` imports `proxy.ts`, which imports next-intl's
    // middleware, which imports `next/server`. Vitest externalizes
    // node_modules deps to Node's native ESM loader by default, and Next's
    // package has no "exports" map -- so a bare `next/server` specifier
    // fails Node's strict (no-extension-probing) ESM resolution even though
    // `node_modules/next/server.js` exists. Inlining next-intl routes it
    // through Vite's resolver instead, which (like every other import in
    // this project) probes extensions. Scoped to next-intl specifically
    // rather than "all deps" to keep the rest of the suite externalized.
    server: { deps: { inline: [/next-intl/] } },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
