import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Home Assistant loads a custom card as a single ES module from /local or
// /hacsfiles. Everything (three.js included) must be inlined into one file.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2021',
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'floorplan-3d-card.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    cors: true,
  },
});
