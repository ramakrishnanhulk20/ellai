import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file starts its own in-memory Postgres and migrates it; with one worker per core
    // those start-ups crowd each other past the default 10 s hook limit on this machine.
    maxWorkers: 6,
    hookTimeout: 60_000,
  },
});
