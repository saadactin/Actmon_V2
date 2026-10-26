/**
 * Process → category, by executable name only (case-insensitive, ".exe" ignored). A process that matches no
 * rule is "Other" — never guessed. The rules are the list below; extend them here, nowhere else.
 */
export const CATEGORY_RULES = [
  { id: 'Database', color: '#dc2626', match: /^(sqlservr|sqlagent|mysqld|mariadbd|postgres|postmaster|oracle|tnslsnr|mongod|mongos|clickhouse(-server)?|redis-server|db2sysc|sqlwriter)$/ },
  { id: 'Web Server', color: '#f97316', match: /^(w3wp|httpd|apache2?|nginx|tomcat\d*|iisexpress|php-fpm\d*|lighttpd|caddy|haproxy)$/ },
  { id: 'Monitoring', color: '#2563eb', match: /^(actmon[-_]?agent|actmon|zabbix_agentd?|telegraf|node_exporter|prometheus|grafana-server|datadog-agent|collectd|nagios|nrpe|healthservice|monitoringhost)$/ },
  { id: 'System', color: '#f59e0b', match: /^(system|idle|registry|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|explorer|spoolsv|searchindexer|msmpeng|wmiprvse|taskhostw|conhost|systemd.*|kworker.*|ksoftirqd.*|kthreadd|rcu_.*|migration.*|watchdog.*|init|sshd|cron|crond|rsyslogd|journald|dbus-daemon|irqbalance|polkitd|udevd|tuned)$/ },
];
export const OTHER = { id: 'Other', color: '#16a34a' };

export function categoryOf(name) {
  const n = String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
  return CATEGORY_RULES.find((r) => r.match.test(n)) || OTHER;
}

/** [{id, color, cpu, count}] over the given processes (only those with a CPU reading), largest first. */
export function byCategory(procs) {
  const m = new Map();
  for (const p of procs) {
    if (p.cpu == null) continue;
    const c = categoryOf(p.name);
    const row = m.get(c.id) || { id: c.id, color: c.color, cpu: 0, count: 0 };
    row.cpu += p.cpu; row.count += 1;
    m.set(c.id, row);
  }
  return [...m.values()].map((r) => ({ ...r, cpu: Math.round(r.cpu * 10) / 10 })).sort((a, b) => b.cpu - a.cpu);
}
