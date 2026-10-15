import { useMemo, useState } from 'react';
import cn from '@/lib/cn';
import { Panel } from '@/pages/_shared/enginePanels';
import { AiPanel } from './AnalysisTab';
import { FindingList, QueryState, useDbQuery } from './shared';

const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'rule', label: 'Rule' }, { id: 'statistics', label: 'Statistics' }, { id: 'llm', label: 'AI' },
];
const STATUS = [{ id: 'open', label: 'Open' }, { id: 'acknowledged', label: 'Acknowledged' }, { id: 'resolved', label: 'Resolved' }, { id: 'any', label: 'Any status' }];

function Pills({ items, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button key={it.id} type="button" aria-pressed={value === it.id} onClick={() => onChange(it.id)}
                className={cn('h-7 rounded-lg px-3 text-meta font-bold transition-all',
                  value === it.id ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:bg-sunken hover:text-fg')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function RecommendationsTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'recommendations');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('open');
  const items = useMemo(() => (q.data?.items || []).filter((f) => (source === 'all' || f.source === source)
    && (status === 'any' || (f.status || 'open') === status)), [q.data, source, status]);
  return (
    <QueryState q={q}>
      {(d) => (
        <div className="flex flex-col gap-gutter">
          <Panel title="Prioritised actions" icon="check"
                 subtitle="Highest severity first; standing risks and worsening trends ahead of single-window findings. Each has rationale, validation and rollback."
                 actions={<><Pills items={FILTERS} value={source} onChange={setSource} /><Pills items={STATUS} value={status} onChange={setStatus} /></>}>
            <FindingList findings={items} empty="Nothing matches these filters." />
          </Panel>
          <AiPanel reportId={d.report_id} />
        </div>
      )}
    </QueryState>
  );
}
