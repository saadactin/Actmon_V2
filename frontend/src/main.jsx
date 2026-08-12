import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThemeProvider from '@/theme/ThemeProvider';
import { DashboardAppearanceProvider } from '@/context/DashboardAppearanceContext';
import App from '@/App';
import '@/styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Per-technology dashboard appearance (indicator style, chart style,
            gauge-vs-graph) — every <Gauge>/<TrendChart>reads it through the
            scope its dashboard sets. Must sit above the router. */}
        <DashboardAppearanceProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </DashboardAppearanceProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
