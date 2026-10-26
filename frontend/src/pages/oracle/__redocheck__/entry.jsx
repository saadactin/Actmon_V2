/* Mounts the real RedoGeneration against a payload produced by the real
   Python summary builder (fixture.json), so the backend/frontend contract is
   what is under test. The fixture is for the harness only. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import client from '@/api/client';
import RedoGeneration from '../RedoGeneration';
import fixture from './fixture.json';
import '@/styles/index.css';

client.get = async () => ({ data: fixture });
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={qc}><RedoGeneration connId={11} /></QueryClientProvider>,
);
