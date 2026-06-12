import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules', 'dist'],
    globals: false,
    pool: 'forks',
    testTimeout: 10_000,
  },
});
