/* Mounts the real PlanCanvas, against the real stylesheet, so its controls can
   be driven and its rendering measured. The rows below are a FIXTURE for the
   harness only — the component itself never ships sample data. */
import { createRoot } from 'react-dom/client';
import PlanCanvas from '../PlanCanvas';
import '@/styles/index.css';

const ROWS = [
  { id: 0, parent_id: null, depth: 0, operation: 'SELECT STATEMENT', options: '', cost: 4205394, cardinality: 0 },
  { id: 1, parent_id: 0, depth: 1, operation: 'TEMP TABLE TRANSFORMATION', options: '', cost: 0, cardinality: 0 },
  {
    id: 2, parent_id: 1, depth: 2, operation: 'LOAD AS SELECT', options: 'CURSOR DURATION MEMORY',
    object_name: 'SYS_TEMP_0FD90684E_F77FA056', cost: 0, cardinality: 0,
  },
  { id: 3, parent_id: 2, depth: 3, operation: 'FILTER', options: '', cost: 0, cardinality: 0 },
  {
    id: 4, parent_id: 3, depth: 4, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEAD$', object_type: 'TABLE',
    cost: 4781, cardinality: 1574316, cpu_cost: 912345678, io_cost: 4700,
    filter_predicates: '"E"."OBJ#" IS NOT NULL AND "E"."OWNER#"=:B1',
  },
  {
    id: 5, parent_id: 3, depth: 4, operation: 'INDEX', options: 'RANGE SCAN',
    object_owner: 'SYS', object_name: 'I_OBJ1', object_type: 'INDEX',
    cost: 3, cardinality: 1, access_predicates: '"O"."OBJ#"="E"."OBJN"',
  },
  { id: 6, parent_id: 1, depth: 2, operation: 'COUNT', options: 'STOPKEY', cost: 0, cardinality: 0 },
  { id: 7, parent_id: 6, depth: 3, operation: 'VIEW', options: '', cost: 98037, cardinality: 1590036 },
  { id: 8, parent_id: 7, depth: 4, operation: 'UNION-ALL', options: '', cost: 0, cardinality: 0 },
  { id: 9, parent_id: 8, depth: 5, operation: 'VIEW', options: '', cost: 1048, cardinality: 1574293 },
  {
    id: 10, parent_id: 9, depth: 6, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEAD$', object_type: 'TABLE',
    cost: 4801, cardinality: 1574316,
  },
  { id: 11, parent_id: 8, depth: 5, operation: 'FILTER', options: '', cost: 0, cardinality: 0 },
  { id: 12, parent_id: 11, depth: 6, operation: 'HASH JOIN', options: 'ANTI', cost: 10199, cardinality: 1574293 },
  { id: 13, parent_id: 11, depth: 6, operation: 'SORT', options: 'AGGREGATE', cost: 0, cardinality: 1 },
];

// `?empty=1` exercises the no-rows path.
const empty = new URLSearchParams(location.search).has('empty');

createRoot(document.getElementById('root')).render(
  <div style={{ padding: 16 }}>
    <PlanCanvas rows={empty ? [] : ROWS} />
  </div>,
);
