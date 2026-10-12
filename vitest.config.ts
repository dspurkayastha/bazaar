import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests never touch the network or a live database.
    env: { TZ: 'UTC' },
  },
});
