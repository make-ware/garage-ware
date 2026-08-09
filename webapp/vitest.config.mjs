import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    dangerouslyIgnoreUnhandledErrors: true,
    testTimeout: 10000, // 10 seconds per test
    hookTimeout: 10000, // 10 seconds for hooks (beforeEach, afterEach, etc.)
    teardownTimeout: 5000, // 5 seconds for teardown
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
  },
  resolve: {
    alias: [
      {
        find: 'server-only',
        replacement: path.resolve(import.meta.dirname, './src/test/server-only-stub.ts'),
      },
      {
        find: '@garage-ware/shared/mutators',
        replacement: path.resolve(import.meta.dirname, '../shared/src/mutators/index.ts'),
      },
      {
        find: '@garage-ware/shared/schema',
        replacement: path.resolve(import.meta.dirname, '../shared/src/schema.ts'),
      },
      {
        find: '@garage-ware/shared',
        replacement: path.resolve(import.meta.dirname, '../shared'),
      },
      {
        find: '@',
        replacement: path.resolve(import.meta.dirname, './src'),
      },
    ],
  },
});