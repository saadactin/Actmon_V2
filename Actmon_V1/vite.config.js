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
          '/api': {
            target: 'http://localhost:8000',
            changeOrigin: true,
            // keep default behavior; if backend is unreachable, set VITE_DISABLE_API_PROXY=true to stop proxying
          },
        },
  },
});
