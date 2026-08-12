import { Link, useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Button from '@/components/ui/Button';
import { engineMeta, engineQuickLinks } from '@/config/engines';

/**
 * The header every engine dashboard uses — MySQL, PostgreSQL, Oracle, SQL Server,
 * MongoDB, ClickHouse.
 *
 * Centralised on purpose: each dashboard used to draw its own gradient hero in its
 * own colours, so six pages disagreed with each other and with the rest of the app.
 * This wraps the shared `PageHeader`, and everything technology-specific — the
 * mark, the accent, the route prefix, the sub-page links — comes from
 * `config/engines.js`, so a new engine needs no header work at all.
 *
 *   tech        engine id ('mysql', 'oracle', …)
 *   connection  { name, host, port, database } as the dashboards already hold it
 *   tabs        [{ id, label, icon }] — icon is a lucide component, as the
 *               dashboards' own TABS arrays already define
 *   alerts      { [tabId]: count } → badge on that tab
 */
export default function EngineDashboardHeader({
  tech,
  connectionId,
  connection,
  tabs = [],
  activeTab,
  onTabChange,
  alerts = {},
  health,
  onRefresh,
  isFetching,
  countdown,
}) {
  const engine = engineMeta(tech);
  const links = engineQuickLinks(tech, connectionId);
  const navigate = useNavigate();

  const target = [
    connection?.name || engine.name,
    connection?.host ? `${connection.host}${connection.port ? `:${connection.port}` : ''}` : null,
    connection?.database || null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <PageHeader
        title={`${engine.name} Dashboard`}
        description={target}
        /* The engine's own mark, tinted with its validated slot colour — the same
           colour it carries in the agents list, the databases hub and the charts. */
        leading={(
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
            style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}
          >
            {engine.emoji}
          </span>
        )}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {health}

            {/* Available regardless of health state (Healthy/Warning/Error/
                Offline/Down) — the Diagnosis page itself decides what's
                relevant to show for the current status. */}
            {connectionId && (
              <Button variant="subtle" size="sm" icon="diagnose" onClick={() => navigate(`/diagnose/${connectionId}`)}>
                Diagnose
              </Button>
            )}

            {/* sub-pages that aren't tabs */}
            <div className="hidden items-center gap-1 xl:flex">
              {links.map(({ to, label, icon }) => (
                <Link
                  key={to}
                  to={to}
                  className="flex h-control-sm items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
                >
                  <Icon name={icon} size={12} />
                  {label}
                </Link>
              ))}
            </div>

            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                title="Refresh now"
                className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
              >
                <Icon name="refresh" size={13} className={isFetching ? 'animate-spin' : undefined} />
                <span className="tabular-nums">{countdown != null ? `${countdown}s` : 'Refresh'}</span>
              </button>
            )}
          </div>
        )}
        tabs={tabs.length ? (
          <EngineTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} alerts={alerts} />
        ) : undefined}
      />

      {/* The quick links collapse out of the header on narrow screens — keep them
          reachable rather than hidden entirely. */}
      <div className="no-scrollbar mb-gutter flex gap-1 overflow-x-auto xl:hidden">
        {links.map(({ to, label, icon }) => (
          <Link
            key={to}
            to={to}
            className="flex h-control-sm shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
          >
            <Icon name={icon} size={12} />
            {label}
          </Link>
        ))}
      </div>
    </>
  );
}

/** Underline tab strip, matching the app's Tabs component but taking the
    dashboards' existing lucide icon components and alert counts. */
function EngineTabs({ tabs, activeTab, onTabChange, alerts }) {
  return (
    <>
      {tabs.map((tab) => {
        const TabIcon = tab.icon;
        const active = tab.id === activeTab;
        const alert = alerts[tab.id] || 0;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-2 px-3 pt-2 pb-2.5 text-[13px] font-semibold',
              'transition-colors duration-[var(--dur-fast)]',
              active ? 'text-accent-text' : 'text-muted hover:text-fg',
            )}
          >
            {TabIcon && <TabIcon size={15} />}
            {tab.label}
            {alert > 0 && (
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold text-white tabular-nums">
                {alert}
              </span>
            )}
            {active && <span className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent" />}
          </button>
        );
      })}
    </>
  );
}
