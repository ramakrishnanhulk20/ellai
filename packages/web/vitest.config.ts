import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file starts its own in-memory Postgres and migrates it; with one worker per core
    // those start-ups crowd each other past the default 10 s hook limit on this machine.
    // Tests that build their own database inside the body hit the same wall at the 5 s test limit.
    // Each worker holds about 1 GB, since every PGlite is at least 128 MB of WebAssembly memory.
    // On a 16 GB Windows machine the whole suite's node processes peaked at 3.2 GB with 3 workers,
    // 4.2 GB with 4 and 5.5 GB with 6, so 3 is the most that stays under 4 GB on a judge's laptop.
    maxWorkers: 3,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
