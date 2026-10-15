import Badge from '@/components/ui/Badge';
import Notice from '@/components/ui/Notice';
import Table from '@/components/ui/Table';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { Fact, ForecastChart, Insufficient, QueryState, fmtWhen, num, useDbQuery } from './shared';

const MODEL_TEXT = {
  'seasonal-baseline-1': 'Seasonal baseline — mean of the same time-of-day window in past reports, Student-t 80% prediction interval.',
  'linear-trend-1': 'Linear trend — least-squares line over time, Student-t 80% prediction interval widening with distance.',
};

function ForecastPanel({ fc }) {
  return (
    <Panel title={`${fc.label}: history & forecast`} icon="trend"
           subtitle={fc.status === 'ok' ? `${fc.model} · fitted on ${fc.train_points} reports` : 'Forecast withheld'}>
      {fc.status !== 'ok' ? (
        <>
          <ForecastChart history={fc.history} />
          <Insufficient className="mt-3" title={fc.reason} detail={fc.detail} />
        </>
      ) : (
        <>
          <ForecastChart history={fc.history} predictions={fc.predictions} />
          <p className="mt-2 text-meta text-muted">{MODEL_TEXT[fc.model]}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Fact label="Backtest MAE" value={num(fc.backtest.mae, 2)} sub={`${fc.backtest.points} past reports predicted`} />
            <Fact label="Backtest RMSE" value={num(fc.backtest.rmse, 2)} />
            <Fact label="Interval coverage" value={`${Math.round(fc.backtest.coverage * 100)}%`} sub="target 80%" tone={fc.backtest.coverage < 0.7 ? 'warning' : undefined} />
            <Fact label="Naive MAE" value={num(fc.backtest.naive_mae, 2)} sub="same as last report" tone={fc.beats_naive ? undefined : 'warning'} />
          </div>
          {!fc.beats_naive && <Notice tone="warning" className="mt-3 mb-0">This model does not beat a naive “same as the last report” forecast on past data — use it as a rough guide only.</Notice>}
          <Table className="mt-3"
            columns={[{ key: 'h', label: 'Horizon' }, { key: 'v', label: 'Forecast', align: 'right' }, { key: 'i', label: '80% interval', align: 'right' }, { key: 'n', label: 'Based on', align: 'right' }]}
            rows={fc.predictions.map((p) => ({ key: p.horizon, cells: { h: p.horizon, v: <b>{num(p.value, 1)}</b>, i: `${num(p.low, 1)} – ${num(p.high, 1)}`, n: `${p.n} reports` } }))} />
        </>
      )}
    </Panel>
  );
}

export default function PredictionsTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'predictions');
  return (
    <QueryState q={q}>
      {(d) => (
        <div className="flex flex-col gap-gutter">
          <Notice tone="info" title="How to read this.">
            Trends and anomalies describe the uploaded history. Forecasts are for the windows after the latest report
            {d.freshness?.latest_report_end ? ` (${fmtWhen(d.freshness.latest_report_end)})` : ''}, not for today, and are shown only when the history supports them —
            each with its measured past accuracy. Nothing here is a guarantee.
          </Notice>
          <div className="grid grid-cols-1 gap-gutter 2xl:grid-cols-2">
            {Object.entries(d.forecasts).map(([k, fc]) => <ForecastPanel key={k} fc={fc} />)}
          </div>

          <TablePanel title="Trends across reports" icon="trend" subtitle="Seasonal Kendall test when the workload has a daily shape; called a trend only at p < 0.05">
            {!d.trends.length ? <div className="p-card"><Insufficient detail="Trend tests need at least 6 reports of this database." /></div> : (
              <Table
                columns={[{ key: 'm', label: 'Metric' }, { key: 'dir', label: 'Direction' }, { key: 's', label: 'Change / day', align: 'right' },
                          { key: 'p', label: 'p-value', align: 'right' }, { key: 'r', label: 'Range', align: 'right' }, { key: 'n', label: 'Reports', align: 'right' }]}
                rows={d.trends.map((t) => ({ key: t.metric_key, cells: {
                  m: <span title={t.method}>{t.label}</span>,
                  dir: <Badge tone={!t.significant ? 'neutral' : t.worsening ? 'warning' : 'success'}>{t.significant ? `${t.direction}${t.worsening ? ' (worse)' : ''}` : 'no trend'}</Badge>,
                  s: `${t.slope_per_day >= 0 ? '+' : ''}${num(t.slope_per_day, 3)}`, p: num(t.p_value, 3),
                  r: `${num(t.min, 2)} – ${num(t.max, 2)}`, n: t.n } }))}
              />
            )}
          </TablePanel>

          <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
            <Panel title="Anomalies in the latest report" icon="alert" subtitle="Modified z-score (median/MAD) against the same window, |z| ≥ 3.5">
              {!d.anomalies.length ? <p className="py-3 text-center text-meta text-muted">Nothing abnormal against this database's own history (or not enough history: ≥ 5 earlier reports).</p> : (
                <ul className="flex flex-col gap-2">
                  {d.anomalies.map((a) => (
                    <li key={a.metric_key} className="rounded-lg border border-border px-3 py-2 text-meta">
                      <Badge tone={a.worse ? 'warning' : 'success'} size="xs">{a.worse ? 'worse than usual' : 'better than usual'}</Badge>
                      <span className="ml-2 font-semibold text-fg">{a.label}</span>: {num(a.value, 2)} vs median {num(a.baseline_median, 2)} ({a.scope}, z = {num(a.robust_z, 1)})
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Forecast accuracy so far" icon="check" subtitle="Earlier forecasts scored against reports uploaded later">
              {!d.scored_forecasts.length ? <p className="py-3 text-center text-meta text-muted">No forecast has been scored yet — upload a report covering a forecast window and it will be compared here.</p> : (
                <Table columns={[{ key: 't', label: 'Window' }, { key: 'm', label: 'Metric' }, { key: 'p', label: 'Forecast', align: 'right' }, { key: 'a', label: 'Actual', align: 'right' }, { key: 'in', label: 'In interval' }]}
                  rows={d.scored_forecasts.map((f, i) => ({ key: i, cells: { t: fmtWhen(f.target_time), m: f.metric_key, p: `${num(f.predicted, 1)} (${num(f.low, 1)}–${num(f.high, 1)})`,
                    a: num(f.actual, 1), in: <Badge tone={f.inside_interval ? 'success' : 'warning'} size="xs">{f.inside_interval ? 'yes' : 'no'}</Badge> } }))} />
              )}
            </Panel>
          </div>
          <Notice tone="info" className="mb-0">{d.slo.reason}</Notice>
        </div>
      )}
    </QueryState>
  );
}
