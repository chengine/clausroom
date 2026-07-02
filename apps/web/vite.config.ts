import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @clausroom/protocol re-exports ids.js which imports node:crypto (used only by
// the server/bridge). The web UI never calls those functions, so we alias the
// builtin to a tiny throwing stub to keep the browser bundle clean.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'node:crypto': fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
