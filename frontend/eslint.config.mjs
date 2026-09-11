import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Flat config, because Next 16 removed `next lint` and `next build` no longer
// runs ESLint at all -- linting is now only ever this file plus `eslint .`.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next leaves `settings.react.version` at 'detect', and
    // detection is the one path in eslint-plugin-react 7.37.5 (its latest
    // release) that still calls `context.getFilename()`, which ESLint 10
    // removed -- it crashes the entire run with
    // "TypeError: Error while loading rule 'react/display-name'".
    // Naming the version skips detection; the plugin reads this string
    // instead. Keep it in step with `react` in package.json. It can go once
    // eslint-plugin-react supports ESLint 10 -- its peer range stops at ^9.7,
    // so eslint-config-next@16 + eslint@10 does not work without this.
    settings: { react: { version: '19.3.0' } },
  },
  {
    // The old `next build` lint step treated this as an error, so anything
    // less would quietly widen what CI accepts. src/ has zero explicit `any`.
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    // eslint-config-next@16 pulls in eslint-plugin-react-hooks 7, whose React
    // Compiler rules are all 'error' by default. The twelve below did not
    // exist under eslint-config-next@14, and this tree violates six of them 50
    // times across 24 files.
    //
    // They are demoted to 'warn' -- still printed on every run, nothing
    // hidden -- for two reasons. This upgrade's job is to preserve the lint
    // surface CI already enforced, and turning twelve brand-new rules into
    // build breakers is a widening of it, not a preservation. And clearing
    // them means rewriting effects, refs and memoization across 24 files,
    // which is exactly the behavioural change a toolchain upgrade must not
    // smuggle in.
    //
    // `rules-of-hooks` (error) and `exhaustive-deps` (warn) are NOT listed:
    // they are the two that existed under Next 14, they keep their old
    // severities, and both are clean today.
    //
    // Adopting these properly -- fixing the 50 and restoring 'error' -- is a
    // follow-up, not part of this lane. The six that currently fire are
    // set-state-in-effect (26), refs (15), preserve-manual-memoization (5),
    // immutability (3), use-memo (1). The rest are named anyway so a new
    // violation does not turn red on somebody unrelated to that work.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/config': 'warn',
      'react-hooks/gating': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
