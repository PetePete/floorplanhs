import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Home Assistant loads a custom card as a single ES module from /local or
// /hacsfiles. Everything (three.js included) must be inlined into one file.
const LEGAL_NOTICE = `/*!
 * floorplan-3d-card — interactive 3D floorplan for Home Assistant
 * Copyright (C) 2026 floorplan-3d-card contributors
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. It is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
 * <https://www.gnu.org/licenses/> for the full text.
 *
 * Source: https://github.com/PetePete/floorplanhs
 *
 * Bundled, under their own licences:
 *   three.js — MIT — Copyright (c) 2010-2024 three.js authors
 *   Lit — BSD-3-Clause — Copyright (c) 2017 Google LLC
 *   fflate — MIT — Copyright (c) 2026 Arjun Barrett
 *   Chakra Petch — SIL Open Font License 1.1 — Copyright (c) 2017 Cadson Demak,
 *     with Reserved Font Name "Chakra Petch"
 *
 * Full texts: https://github.com/PetePete/floorplanhs/tree/main/licenses
 */`;

export default defineConfig({
  // Out of the project tree entirely, and not for tidiness: this repository sits
  // in a synced folder (OneDrive), the sync client holds handles on whatever is
  // inside it, and Vite then fails to clear its dependency cache with EPERM —
  // which stops the dev server before it starts. A folder under the OS temp
  // directory is per-machine, unsynced, and nobody's business but Vite's.
  cacheDir: join(tmpdir(), 'floorplan-3d-card-vite'),
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
        // The bundle is what people actually receive, and it carries three.js
        // and an embedded font inside it. Both licences require their notice to
        // travel with the copy, so the notice has to be in the file itself —
        // a LICENSE in the repository does not reach anyone who installs it.
        banner: LEGAL_NOTICE,
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
