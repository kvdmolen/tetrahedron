import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The sculpture server (backend/src/server.js) runs the model and the motors on port 4000.
// `npm run dev` serves this app with hot reload and forwards the WebSocket and API to that server;
// `npm run build` writes dist/, which the server itself serves.
const SCULPTURE_SERVER = 'localhost:4000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: {
    proxy: {
      '/ws': { target: `ws://${SCULPTURE_SERVER}`, ws: true },
      '/api': `http://${SCULPTURE_SERVER}`,
    },
    fs: { allow: ['..'] }, // allow importing ../shared
  },
});
