import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The engine needs a real WebGL context, so only the pure layers are
    // unit-tested here; the 3D side is verified in the dev harness.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
