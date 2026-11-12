import { fileURLToPath } from 'node:url';

/** Module resolution shared by the unit-test and emulator-test Vitest configs. */
export const sharedResolve = {
  alias: {
    '@': fileURLToPath(new URL('../../src', import.meta.url)),
    // Next.js resolves `server-only` to an empty module on the server; tests run on the server.
    'server-only': fileURLToPath(new URL('./empty-module.ts', import.meta.url)),
  },
};
