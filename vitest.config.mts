import { defineConfig } from 'vitest/config';

import { sharedResolve } from './tests/support/vitest-shared.mjs';

export default defineConfig({
  resolve: sharedResolve,
  test: {
    // The engine and the proxy are plain TypeScript with no DOM dependency, so they are tested in
    // Node. Browser-only pieces (the Worker wrapper, canvas image processing) are covered by the
    // end-to-end check in `scripts/e2e-playground.mjs`.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'firebase/**/*.test.ts'],
    // Tests that need the Firebase emulators run with `npm run test:emulator`.
    exclude: ['**/node_modules/**', '**/*.emulator.test.ts'],
    testTimeout: 20_000,
  },
});
