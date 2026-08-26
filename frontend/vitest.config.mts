import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // `tsconfig.json` sets `jsx: "preserve"` because Next owns the real JSX
  // transform. esbuild would honour that and hand Vite untransformed JSX, so
  // the component suites are told here to use the automatic runtime — React 18
  // ships `react/jsx-runtime`, and nothing about the app build changes.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Stays 'node': the vast majority of these suites are pure functions and a
    // DOM per file is not free. Component suites opt in with a
    // `// @vitest-environment jsdom` comment on their first line.
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
