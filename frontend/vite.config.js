import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Set VITE_DISABLE_API_PROXY=true to talk to a remote backend via VITE_API_BASE instead.
const disableProxy = process.env.VITE_DISABLE_API_PROXY === 'true';

const DB_API = process.env.VITE_PROXY_DB || 'http://127.0.0.1:8000';
const CLOUD_API = process.env.VITE_PROXY_CLOUD || 'http://127.0.0.1:8001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 2106,
    hmr: { overlay: false },
    proxy: disableProxy
      ? undefined
      : {
          // WebSocket routes first — they must not fall through to the generic /api rule.
          '/api/v1/terminal/ws': { target: DB_API.replace('http', 'ws'), ws: true, changeOrigin: true },
          // Cloud discovery microservice lives on its own port.
          '/api/v1/cloud': { target: CLOUD_API, changeOrigin: true },
          '/api': { target: DB_API, changeOrigin: true, ws: true },
        },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query'],
        },
      },
    },
  },
});
