import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Shipped code is minified: smaller, and without comments or long identifiers.
  main: {
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Network scanning runs in its own utility process so the UI never blocks.
          scanner: resolve(import.meta.dirname, 'src/scanner/worker.ts'),
        },
      },
    },
    resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  },
  preload: {
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // CommonJS keeps the preload compatible with sandboxed renderers.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      minify: true,
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, 'src/shared'),
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
