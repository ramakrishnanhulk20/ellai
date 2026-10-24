import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The live chain tests share one anonymous Tatum quota of 5 requests a minute,
    // so files must not run side by side.
    fileParallelism: false,
  },
});
