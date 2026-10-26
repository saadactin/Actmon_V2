/* Mounts the real Query Analysis and Execution Plan pages with the API stubbed
   at the axios client, so the pages run their own code paths against a known
   payload. The payload is a FIXTURE for the harness; neither page ships
   sample data. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import client from '@/api/client';
import SlowQueryDetailPage from '../SlowQueryDetailPage';
import ExecutionPlanPage from '../ExecutionPlanPage';
import '@/styles/index.css';

const PLAN = [
  { id: 0, parent_id: null, depth: 0, operation: 'SELECT STATEMENT', options: '', cost: 4781, cardinality: 157431 },
  { id: 1, parent_id: 0, depth: 1, operation: 'TEMP TABLE TRANSFORMATION', options: '', cost: 0, cardinality: 0 },
  { id: 2, parent_id: 1, depth: 2, operation: 'LOAD AS SELECT', options: 'CURSOR DURATION MEMORY', object_name: 'SYS_TEMP_0FD9D684E', cost: 0, cardinality: 0 },
  { id: 3, parent_id: 2, depth: 3, operation: 'FILTER', options: '', cost: 0, cardinality: 0 },
  {
    id: 4, parent_id: 3, depth: 4, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEADS', object_type: 'TABLE',
    cost: 4781, cardinality: 157431, filter_predicates: '"E"."OBJ#" IS NOT NULL',
  },
  {
    id: 5, parent_id: 3, depth: 4, operation: 'INDEX', options: 'RANGE SCAN',
    object_owner: 'SYS', object_name: 'X_0831', object_type: 'INDEX',
    cost: 3, cardinality: 1, access_predicates: '"O"."OBJ#"="E"."OBJN"',
  },
  { id: 6, parent_id: 1, depth: 2, operation: 'COUNT', options: 'STOPKEY', cost: 0, cardinality: 0 },
  { id: 7, parent_id: 6, depth: 3, operation: 'VIEW', options: '', cost: 98037, cardinality: 1590036 },
  { id: 8, parent_id: 7, depth: 4, operation: 'UNION-ALL', options: '', cost: 0, cardinality: 0 },
  { id: 9, parent_id: 8, depth: 5, operation: 'HASH JOIN', options: 'ANTI', cost: 10199, cardinality: 157429 },
  {
    id: 10, parent_id: 9, depth: 6, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEADS', object_type: 'TABLE', cost: 4801, cardinality: 157431,
  },
  {
    id: 11, parent_id: 9, depth: 6, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'OBJS', object_type: 'TABLE', cost: 900, cardinality: 2000,
  },
];

const ROW = {
  query_id: '9xk3h2n4pq1ab',
  query_text: 'SELECT /*+ materialize */ exp_id, objn FROM exp_heads e\nWHERE NOT EXISTS (SELECT /*+ unnest */ 1 FROM objs o WHERE o.obj# = e.objn)',
  severity: 'critical',
  average_execution_time: 34280,
  execution_count: 1,
  rows_returned: 7,
  last_seen: '2026-10-12T14:44:00Z',
  schema_name: 'SYS',
  query_type: 'system',
};

const params = new URLSearchParams(location.search);
const failPlan = params.has('failplan');

/* The axios client is stubbed here rather than the network, so the pages' own
   request code still runs. */
client.get = async (url) => {
  if (url.includes('oracle-sql-plan')) {
    if (failPlan) return { data: { status: 'error', error: 'ORA-00942: table or view does not exist' } };
    return { data: { status: 'success', plan: PLAN, sql_stats: {} } };
  }
  return { data: {} };
};
client.post = async () => ({
  data: { status: 'success', analysis: { summary: 'Stubbed analysis.', recommendations: [] } },
});

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const page = params.get('page') || 'analysis';
const start = page === 'plan'
  ? '/oracle-dashboard/11/slow-queries/plan'
  : '/oracle-dashboard/11/slow-queries/detail';

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={qc}>
    <MemoryRouter initialEntries={[{ pathname: start, state: { row: ROW } }]}>
      <Routes>
        <Route path="/oracle-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="oracle" />} />
        <Route path="/oracle-dashboard/:id/slow-queries/plan" element={<ExecutionPlanPage tech="oracle" />} />
        <Route path="*" element={<div id="navigated-away">navigated</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
