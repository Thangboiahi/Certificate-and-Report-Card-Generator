import { defineConfig } from 'vitest/config';

import { sharedResolve } from './tests/support/vitest-shared.mjs';

/**
 * Tests against the Firebase Auth and Firestore emulators. Run with `npm run test:emulator`,
 * which starts the emulators, sets their host variables, runs these tests and stops them.
 */
export default defineConfig({
  resolve: sharedResolve,
  test: {
    environment: 'node',
    include: ['**/*.emulator.test.ts'],
    exclude: ['**/node_modules/**'],
    // The suites share one emulator; running them one after another keeps their data apart.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      FIREBASE_PROJECT_ID: 'demo-v6',
      GCLOUD_PROJECT: 'demo-v6',
    },
  },
});
