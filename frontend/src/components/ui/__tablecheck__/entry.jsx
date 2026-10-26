/* A darkHeader + cellText table with a sentence-length column — the shape
   that ran past its own header on the alert-log page. */
import { createRoot } from 'react-dom/client';
import Table from '../Table';
import '@/styles/index.css';

const SENT = 'The session is connected but doing nothing. Idle waits are not a problem and are normally excluded from wait analysis.';
const rows = Array.from({ length: 4 }, (_, i) => ({
  key: String(i),
  cells: {
    sid: <span className="font-mono">{4000 + i},26229</span>,
    event: <span className="font-mono">rdbms ipc message</span>,
    secs: <span className="font-mono">523.1Ks</span>,
    why: <span className="block max-w-[280px] leading-snug text-muted">{SENT}</span>,
    free: <span>{SENT} {SENT}</span>,
  },
}));
createRoot(document.getElementById('root')).render(
  <div id="panel" style={{ background: '#fff', borderRadius: 16, overflow: 'hidden' }}>
    <Table rowHeight={64} darkHeader cellText
      columns={[{ key: 'sid', label: 'SID' }, { key: 'event', label: 'Waiting on' },
        { key: 'secs', label: 'For', align: 'right' }, { key: 'why', label: 'What it means' },
        { key: 'free', label: 'Unbounded text' }]}
      rows={rows} />
  </div>,
);
