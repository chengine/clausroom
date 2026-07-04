import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @clausroom/protocol re-exports ids.js (node:crypto) and join.js (node:buffer),
// both used only by the server/bridge. The web UI never calls those code paths,
// so we alias the builtins to tiny throwing stubs to keep the browser bundle
// clean (otherwise Vite externalizes them and the build fails to resolve them).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'node:crypto': fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)),
      'node:buffer': fileURLToPath(new URL('./src/shims/node-buffer.ts', import.meta.url)),
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
