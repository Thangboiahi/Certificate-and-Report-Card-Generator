import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The engine and the proxy are plain TypeScript with no DOM dependency, so they are tested in
    // Node. Browser-only pieces (the Worker wrapper, canvas image processing) are covered by the
    // end-to-end check in `scripts/e2e-playground.mjs`.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
