import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/voice': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'], globals: false },
});
