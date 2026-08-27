-- ─────────────────────────────────────────────────────────────────────────────
--  Turn the "Add Data" tab bar and its ~80 catalog cards into a real,
--  independently-governable page hierarchy, instead of one flat page per
--  route pattern. Supersedes the tab-level wildcard rows added by
--  2026-08-21_agents_setup_catalog_pages.sql (AGENTS_SETUP_APM,
--  AGENTS_SETUP_NETWORK_DEVICE, AGENTS_SETUP_INTEGRATION), which are
--  deactivated below in favor of one page per tab plus one page per item.
--
--  Hierarchy (parent_id chain, enforced at read-time by
--  access_control_service.get_role_permissions — see that file's cascade
--  fix in the same change as this migration):
--    AGENTS_SETUP (existing, page_id from page_code)
--      -> AGENTS_SETUP_TAB_<TAB>            (8 new — one per tab bar entry)
--           -> AGENTS_SETUP_<TAB>_<ITEM>    (new — one per catalog card)
--
--  This is what makes "revoke Integrations" also revoke every Integrations
--  card, and "revoke Digital Experience -> Website Availability" specifically
--  deny just that one card while Digital Experience itself (and its other
--  cards) stay granted — every card gets its OWN page_master row rather than
--  sharing one wildcard row, so it can be revoked independently.
--
--  Known, deliberate scope limits (shared governance, not per-item):
--    - Digital Experience's TCP Port / Ping / DNS / UDP Port all launch the
--      same AddNetworkCheckWizard distinguished only by a query string
--      (?type=...), and page_master matching ignores query strings — these
--      four remain one shared page (AGENTS_SETUP_NETWORK_CHECK, re-parented
--      under Digital Experience below), same as before this migration.
--    - Infrastructure's Hosts/AWS/Azure/GCP/"Discover On-Prem Hosts" and
--      Network's "Network Device"/"Discover Network Devices" point at
--      already-existing shared pages (/agents/deploy, /cloud, /infra) used
--      by other parts of the app too — left ungoverned-per-item, same as
--      before.
--    - Logs' 2 cards point at /logs (its own module) and /agents/deploy
--      (shared with Infrastructure's Hosts and the top-level Deploy Agent
--      page) — not re-parented under this hierarchy, since /logs is already
--      independently governed by the LOGS module.
--
--  Safe to re-run: every page insert guarded by page_code, every grant
--  insert guarded by NOT EXISTS, re-parent/deactivate UPDATEs are no-ops on
--  a second run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Deactivate the superseded tab-level wildcard rows from the prior migration.
UPDATE public.page_master
SET is_active = false
WHERE page_code IN ('AGENTS_SETUP_APM', 'AGENTS_SETUP_NETWORK_DEVICE', 'AGENTS_SETUP_INTEGRATION');

-- 2. Eight tab-bar pages, parented directly under Add Data (AGENTS_SETUP).
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_TAB_INTRO', 'Add Data: Intro', '/agents/setup/intro', 1),
  ('AGENTS_SETUP_TAB_DX', 'Add Data: Digital Experience', '/agents/setup/digital-experience', 2),
  ('AGENTS_SETUP_TAB_APM', 'Add Data: APM', '/agents/setup/apm', 3),
  ('AGENTS_SETUP_TAB_DATABASES', 'Add Data: Databases', '/agents/setup/databases', 4),
  ('AGENTS_SETUP_TAB_INFRA', 'Add Data: Infrastructure', '/agents/setup/infrastructure', 5),
  ('AGENTS_SETUP_TAB_NETWORK', 'Add Data: Network', '/agents/setup/network', 6),
  ('AGENTS_SETUP_TAB_LOGS', 'Add Data: Logs', '/agents/setup/logs', 7),
  ('AGENTS_SETUP_TAB_INTEGRATIONS', 'Add Data: Integrations', '/agents/setup/integrations', 8)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 3. Re-parent existing catalog pages under their real tab (instead of AGENTS_SETUP directly).
UPDATE public.page_master SET parent_id = (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DX')
WHERE page_code = 'AGENTS_SETUP_WEBSITE';

UPDATE public.page_master SET parent_id = (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DX')
WHERE page_code = 'AGENTS_SETUP_NETWORK_CHECK';

UPDATE public.page_master SET parent_id = (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DATABASES')
WHERE page_code = 'AGENTS_SETUP_TECH';

-- 4. One page per APM language card.
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_APM'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_APM_JAVA', 'Java', '/agents/setup/apm/java', 1),
  ('AGENTS_SETUP_APM_PYTHON', 'Python', '/agents/setup/apm/python', 2),
  ('AGENTS_SETUP_APM_NODEJS', 'NodeJS', '/agents/setup/apm/nodejs', 3),
  ('AGENTS_SETUP_APM_PHP', 'PHP', '/agents/setup/apm/php', 4),
  ('AGENTS_SETUP_APM_DOTNET', '.Net', '/agents/setup/apm/dotnet', 5),
  ('AGENTS_SETUP_APM_RUBY', 'Ruby', '/agents/setup/apm/ruby', 6),
  ('AGENTS_SETUP_APM_GO', 'Go', '/agents/setup/apm/go', 7)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 5. One page per Network device-type card (netdevice/discover excluded — they
--    already point at the real, shared /infra add-host flow, unchanged).
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_NETWORK'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_NETWORK_NETPATH', 'NetPath Endpoints', '/agents/setup/network/netpath', 1),
  ('AGENTS_SETUP_NETWORK_ARUBA', 'Aruba Orchestrators and Edges', '/agents/setup/network/aruba', 2),
  ('AGENTS_SETUP_NETWORK_MERAKI', 'Meraki Orchestrators and Edges', '/agents/setup/network/meraki', 3),
  ('AGENTS_SETUP_NETWORK_PRISMA', 'Prisma Orchestrators and Edges', '/agents/setup/network/prisma', 4),
  ('AGENTS_SETUP_NETWORK_FORTINET', 'Fortinet Orchestrators and Edges', '/agents/setup/network/fortinet', 5),
  ('AGENTS_SETUP_NETWORK_EXTREME', 'ExtremeCloud IQ Wireless Controllers', '/agents/setup/network/extreme', 6),
  ('AGENTS_SETUP_NETWORK_ARISTA', 'Arista Wireless Manager Wireless Controllers', '/agents/setup/network/arista', 7),
  ('AGENTS_SETUP_NETWORK_JUNIPER', 'Juniper Mist Wireless Controllers', '/agents/setup/network/juniper', 8),
  ('AGENTS_SETUP_NETWORK_RUCKUS', 'Ruckus Wireless Controllers', '/agents/setup/network/ruckus', 9),
  ('AGENTS_SETUP_NETWORK_VELOCLOUD', 'VeloCloud Orchestrators and Edges', '/agents/setup/network/velocloud', 10),
  ('AGENTS_SETUP_NETWORK_VIPTELA', 'Viptela Orchestrators and Edges', '/agents/setup/network/viptela', 11),
  ('AGENTS_SETUP_NETWORK_UPS', 'UPS Device', '/agents/setup/network/ups', 12),
  ('AGENTS_SETUP_NETWORK_DHCP', 'DHCP Server Monitoring', '/agents/setup/network/dhcp', 13),
  ('AGENTS_SETUP_NETWORK_PALOALTO', 'Palo Alto Firewalls', '/agents/setup/network/paloalto', 14),
  ('AGENTS_SETUP_NETWORK_F5', 'F5 Load Balancers', '/agents/setup/network/f5', 15),
  ('AGENTS_SETUP_NETWORK_CISCOASA', 'Cisco ASA Devices', '/agents/setup/network/ciscoasa', 16),
  ('AGENTS_SETUP_NETWORK_CISCOUCS', 'Cisco UCS Devices', '/agents/setup/network/ciscoucs', 17),
  ('AGENTS_SETUP_NETWORK_CISCOACI', 'Cisco ACI Devices', '/agents/setup/network/ciscoaci', 18)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 6. One page per dead Infrastructure resource-type card (Hosts/AWS/Azure/GCP/
--    "Discover On-Prem Hosts" excluded — they point at real, shared pages).
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_INFRA'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_INFRA_K8S', 'Kubernetes Cluster', '/agents/setup/infrastructure/k8s', 1),
  ('AGENTS_SETUP_INFRA_HYPERV', 'Hyper-V Host', '/agents/setup/infrastructure/hyperv', 2),
  ('AGENTS_SETUP_INFRA_VMWARE', 'VMware Resources', '/agents/setup/infrastructure/vmware', 3),
  ('AGENTS_SETUP_INFRA_NUTANIX', 'Nutanix Resources', '/agents/setup/infrastructure/nutanix', 4),
  ('AGENTS_SETUP_INFRA_STORAGE', 'Storage Array', '/agents/setup/infrastructure/storage', 5),
  ('AGENTS_SETUP_INFRA_OTEL', 'ActMon OTel Collector', '/agents/setup/infrastructure/otel', 6)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 7. One page per not-yet-built Digital Experience check (Website Availability
--    and the 4 network-check types already have their own pages, re-parented above).
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DX'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_DX_SYNTHETIC_TRANSACTION', 'Synthetic Transaction', '/agents/setup/digital-experience/synthetic-transaction', 1),
  ('AGENTS_SETUP_DX_PAGE_SPEED', 'Page Speed', '/agents/setup/digital-experience/page-speed', 2),
  ('AGENTS_SETUP_DX_RUM', 'RUM', '/agents/setup/digital-experience/rum', 3)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 8. One page per Integrations receiver card.
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_INTEGRATIONS'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_INTEG_APACHE', 'Apache', '/agents/setup/integrations/apache', 1),
  ('AGENTS_SETUP_INTEG_CONFLUENT', 'Confluent Cloud', '/agents/setup/integrations/confluent', 2),
  ('AGENTS_SETUP_INTEG_DNSQUERY', 'DNS Query', '/agents/setup/integrations/dnsquery', 3),
  ('AGENTS_SETUP_INTEG_DOCKER', 'Docker', '/agents/setup/integrations/docker', 4),
  ('AGENTS_SETUP_INTEG_ELASTICSEARCH', 'Elasticsearch', '/agents/setup/integrations/elasticsearch', 5),
  ('AGENTS_SETUP_INTEG_EXEC', 'Exec', '/agents/setup/integrations/exec', 6),
  ('AGENTS_SETUP_INTEG_FLUENTD', 'Fluentd', '/agents/setup/integrations/fluentd', 7),
  ('AGENTS_SETUP_INTEG_HAPROXY', 'HAProxy', '/agents/setup/integrations/haproxy', 8),
  ('AGENTS_SETUP_INTEG_IIS', 'IIS', '/agents/setup/integrations/iis', 9),
  ('AGENTS_SETUP_INTEG_KAFKA', 'Kafka', '/agents/setup/integrations/kafka', 10),
  ('AGENTS_SETUP_INTEG_MEMCACHED', 'Memcached', '/agents/setup/integrations/memcached', 11),
  ('AGENTS_SETUP_INTEG_MONGODB', 'MongoDB', '/agents/setup/integrations/mongodb', 12),
  ('AGENTS_SETUP_INTEG_MYSQL', 'MySQL', '/agents/setup/integrations/mysql', 13),
  ('AGENTS_SETUP_INTEG_NGINX', 'NGINX', '/agents/setup/integrations/nginx', 14),
  ('AGENTS_SETUP_INTEG_NGINXPLUS', 'NGINX Plus API', '/agents/setup/integrations/nginxplus', 15),
  ('AGENTS_SETUP_INTEG_NTPQ', 'NTPQ', '/agents/setup/integrations/ntpq', 16),
  ('AGENTS_SETUP_INTEG_ORACLE', 'Oracle DB', '/agents/setup/integrations/oracle', 17),
  ('AGENTS_SETUP_INTEG_OTLP', 'OTLP', '/agents/setup/integrations/otlp', 18),
  ('AGENTS_SETUP_INTEG_PHPFPM', 'PHP-FPM', '/agents/setup/integrations/phpfpm', 19),
  ('AGENTS_SETUP_INTEG_POSTGRESQL', 'PostgreSQL', '/agents/setup/integrations/postgresql', 20),
  ('AGENTS_SETUP_INTEG_PROMETHEUS', 'Prometheus', '/agents/setup/integrations/prometheus', 21),
  ('AGENTS_SETUP_INTEG_RABBITMQ', 'RabbitMQ', '/agents/setup/integrations/rabbitmq', 22),
  ('AGENTS_SETUP_INTEG_REDIS', 'Redis', '/agents/setup/integrations/redis', 23),
  ('AGENTS_SETUP_INTEG_SNOWFLAKE', 'Snowflake', '/agents/setup/integrations/snowflake', 24),
  ('AGENTS_SETUP_INTEG_SQLSERVER', 'SQL Server', '/agents/setup/integrations/sqlserver', 25),
  ('AGENTS_SETUP_INTEG_STATSD', 'StatsD', '/agents/setup/integrations/statsd', 26),
  ('AGENTS_SETUP_INTEG_VARNISH', 'Varnish', '/agents/setup/integrations/varnish', 27),
  ('AGENTS_SETUP_INTEG_ZOOKEEPER', 'ZooKeeper', '/agents/setup/integrations/zookeeper', 28)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 9. One literal page per DB engine, layered on top of the existing
--    AGENTS_SETUP_TECH wildcard (re-parented under Databases in step 3) —
--    the literal, longer match always wins over the wildcard for these six,
--    so each engine can be individually revoked; any other/future tech id
--    keeps falling back to the wildcard's own grant.
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DATABASES'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_DB_MYSQL', 'MySQL', '/agents/setup/mysql', 1),
  ('AGENTS_SETUP_DB_POSTGRESQL', 'PostgreSQL', '/agents/setup/postgresql', 2),
  ('AGENTS_SETUP_DB_MSSQL', 'SQL Server', '/agents/setup/mssql', 3),
  ('AGENTS_SETUP_DB_ORACLE', 'Oracle', '/agents/setup/oracle', 4),
  ('AGENTS_SETUP_DB_MONGODB', 'MongoDB', '/agents/setup/mongodb', 5),
  ('AGENTS_SETUP_DB_CLICKHOUSE', 'ClickHouse', '/agents/setup/clickhouse', 6)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

-- 10. Default grant of View (permission bit 1) to every active role, for
--     every page under this hierarchy that doesn't already have one — so
--     turning this on doesn't lock anyone out of something they could
--     already reach; a Super Admin narrows it per role afterward.
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT r.org_id, r.role_id, p.page_id, 1, 'View', true, 1, CURRENT_TIMESTAMP
FROM public.role r
CROSS JOIN public.page_master p
WHERE p.page_code LIKE 'AGENTS_SETUP%'
  AND p.is_active = true
  AND r.is_active = true
  AND r.deleted_at IS NULL
  -- Excludes ANY existing row for this (org, role, page) — not just active
  -- ones. group_role_page_permission's unique constraint on
  -- (org_id, role_id, page_id) isn't filtered on deleted_at, so a
  -- soft-deleted row still physically occupies that key and would collide
  -- with a plain "WHERE deleted_at IS NULL" guard; more importantly, a
  -- soft-deleted grant may represent a deliberate prior revoke, which this
  -- migration must never silently undo.
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = r.org_id AND x.role_id = r.role_id AND x.page_id = p.page_id
  );
