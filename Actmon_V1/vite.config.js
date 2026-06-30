import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Toggle API proxying by setting VITE_DISABLE_API_PROXY=true in your environment
const disableApiProxy = process.env.VITE_DISABLE_API_PROXY === 'true' || process.env.NO_API_PROXY === 'true';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split big, stable vendor libs into their own chunks → they download in
        // parallel with app code and stay cached across deploys (only changed app
        // code re-downloads when you ship an update).
        manualChunks: {
          'react-vendor':  ['react', 'react-dom', 'react-router-dom'],
          'query-vendor':  ['@tanstack/react-query'],
          'fluent-vendor': ['@fluentui/react-components'],
        },
      },
    },
  },
  server: {
    port: 3000,
    // Disable overlay so proxy connection errors won't show the full overlay in the browser
    hmr: {
      overlay: false,
    },
    proxy: disableApiProxy
      ? undefined
      : {
          '/api/v1/terminal/ws': {
            target: 'ws://127.0.0.1:8000',
            ws: true,
            changeOrigin: true,
          },
          // Cloud Discovery microservice (separate FastAPI on :8001). Must come
          // BEFORE the generic /api rule so cloud calls don't hit the DB backend.
          '/api/v1/cloud': {
            target: 'http://127.0.0.1:8001',
            changeOrigin: true,
          },
          '/api': {
            target: 'http://127.0.0.1:8000',
            changeOrigin: true,
            ws: true,
          },
        },
  },
});
