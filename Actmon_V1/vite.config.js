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
  server: {
    port: 3000,
    // Disable overlay so proxy connection errors won't show the full overlay in the browser
    hmr: {
      overlay: false,
    },
    proxy: disableApiProxy
      ? undefined
      : {
          // WebSocket — database service
          '/api/v1/terminal/ws': {
            target: 'ws://127.0.0.1:8000',
            ws: true,
            changeOrigin: true,
          },
          // Cloud microservice — must be declared BEFORE the generic /api rule
          '/api/v1/cloud': {
            target: 'http://127.0.0.1:8002',
            changeOrigin: true,
          },
          // All other API calls → database / main backend service
          '/api': {
            target: 'http://127.0.0.1:8000',
            changeOrigin: true,
            ws: true,
          },
        },
  },
});
