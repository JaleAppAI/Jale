import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Centralized cleanup for all component tests (required since Vitest globals are disabled)
afterEach(cleanup);

// jsdom lacks object-URL support; the upload modal previews need it.
if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = () => `blob:test-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = () => {};
}
