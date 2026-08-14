-- ─────────────────────────────────────────────────────────────────────────────
--  Give every Infrastructure tab and sub-view its own page_master row, parented
--  under /infra/:id (page_id=165), mirroring the existing MYSQL_TAB_* /
--  MYSQL_DASHBOARD pattern (parent = the dashboard's own row; the default tab
--  itself has no separate "overview" row, /infra/:id already IS Overview).
--
--  Tree:
--    INFRASTRUCTURE (71, /infra)
--      INFRA_ID (165, /infra/:id)                          ← Overview (existing, unchanged)
--        INFRA_ID_FILES (166, /infra/:id/files)             ← existing, unchanged
--        INFRA_TAB_PORTS            /infra/:id/ports
--        INFRA_TAB_PROCESSES        /infra/:id/processes
--        INFRA_TAB_STORAGE          /infra/:id/storage
--        INFRA_TAB_NETWORK          /infra/:id/network
--          INFRA_NET_*  (14 rows)   /infra/:id/network/<sub>
--        INFRA_TAB_SERVICES         /infra/:id/services
--        INFRA_TAB_DIAGNOSTICS      /infra/:id/diagnostics
--        INFRA_TAB_IP_CONFIGURATION /infra/:id/ip-configuration
--          INFRA_IP_*   (10 rows)   /infra/:id/ip-configuration/<sub>
--        INFRA_TAB_CONFIG_FILES     /infra/:id/config-files
--          INFRA_CFG_*  (19 rows)   /infra/:id/config-files/<sub>
--
--  51 new rows total. Safe to re-run (every INSERT is guarded by page_code).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 8 top-level tabs, parent = INFRA_ID (165) ──────────────────────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 5, (SELECT page_id FROM public.page_master WHERE page_code = 'INFRA_ID'), v.code, v.name, v.url, v.icon, v.ord, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('INFRA_TAB_PORTS',            'Ports',            '/infra/:id/ports',            'plug',      4),
  ('INFRA_TAB_PROCESSES',        'Processes',        '/infra/:id/processes',        'box',       5),
  ('INFRA_TAB_STORAGE',          'Storage',          '/infra/:id/storage',          'desktop',   6),
  ('INFRA_TAB_NETWORK',          'Network',          '/infra/:id/network',          'network',   7),
  ('INFRA_TAB_SERVICES',         'Services',         '/infra/:id/services',         'settings2', 8),
  ('INFRA_TAB_DIAGNOSTICS',      'Diagnostics',      '/infra/:id/diagnostics',      'diagnose',  9),
  ('INFRA_TAB_IP_CONFIGURATION', 'IP Configuration', '/infra/:id/ip-configuration', 'route',     10),
  ('INFRA_TAB_CONFIG_FILES',     'Config Files',     '/infra/:id/config-files',     'file-edit', 11)
) AS v(code, name, url, icon, ord)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.code);

-- ── 14 Network sub-views, parent = INFRA_TAB_NETWORK ───────────────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 5, (SELECT page_id FROM public.page_master WHERE page_code = 'INFRA_TAB_NETWORK'), v.code, v.name, v.url, v.ord, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('INFRA_NET_IFACE_DETAILS', 'Network Interface Details', '/infra/:id/network/iface_details', 1),
  ('INFRA_NET_REALTIME',      'Real-Time Traffic',         '/infra/:id/network/realtime',      2),
  ('INFRA_NET_CONN_STATS',    'Connection Statistics',     '/infra/:id/network/conn_stats',    3),
  ('INFRA_NET_ERRORS',        'Network Errors',            '/infra/:id/network/errors',        4),
  ('INFRA_NET_IFACE_TABLE',   'Network Interfaces Table',  '/infra/:id/network/iface_table',   5),
  ('INFRA_NET_DNS',           'DNS Monitoring',             '/infra/:id/network/dns',           6),
  ('INFRA_NET_GATEWAY',       'Gateway Monitoring',         '/infra/:id/network/gateway',       7),
  ('INFRA_NET_TCP_UDP',       'TCP / UDP Monitoring',       '/infra/:id/network/tcp_udp',       8),
  ('INFRA_NET_PORTS',         'Open Ports',                 '/infra/:id/network/ports',         9),
  ('INFRA_NET_BANDWIDTH',     'Bandwidth Utilization',      '/infra/:id/network/bandwidth',     10),
  ('INFRA_NET_WIFI',          'Wi-Fi Information',          '/infra/:id/network/wifi',          11),
  ('INFRA_NET_ROUTING',       'Routing Information',        '/infra/:id/network/routing',       12),
  ('INFRA_NET_ARP',           'ARP Table',                  '/infra/:id/network/arp',           13),
  ('INFRA_NET_PROCESSES',     'Network Processes',          '/infra/:id/network/processes',     14)
) AS v(code, name, url, ord)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.code);

-- ── 10 IP Configuration sub-views, parent = INFRA_TAB_IP_CONFIGURATION ─────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 5, (SELECT page_id FROM public.page_master WHERE page_code = 'INFRA_TAB_IP_CONFIGURATION'), v.code, v.name, v.url, v.ord, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('INFRA_IP_INTERFACE', 'Interface Configuration',              '/infra/:id/ip-configuration/interface', 1),
  ('INFRA_IP_IPV4',      'IPv4 Configuration',                   '/infra/:id/ip-configuration/ipv4',      2),
  ('INFRA_IP_IPV6',      'IPv6 Configuration',                   '/infra/:id/ip-configuration/ipv6',      3),
  ('INFRA_IP_DNS',       'DNS Configuration',                    '/infra/:id/ip-configuration/dns',       4),
  ('INFRA_IP_ADVANCED',  'Advanced Configuration',                '/infra/:id/ip-configuration/advanced',  5),
  ('INFRA_IP_CONFLICT',  'IP Conflict Detection',                '/infra/:id/ip-configuration/conflict',  6),
  ('INFRA_IP_VALIDATION','Validation Checks',                    '/infra/:id/ip-configuration/validation',7),
  ('INFRA_IP_EXPORT',    'Export Options',                       '/infra/:id/ip-configuration/export',    8),
  ('INFRA_IP_EDIT',      'Edit Network Config',                  '/infra/:id/ip-configuration/edit',      9),
  ('INFRA_IP_FIREWALL',  'Firewall — Whitelist / Blacklist',     '/infra/:id/ip-configuration/firewall',  10)
) AS v(code, name, url, ord)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.code);

-- ── 19 Config Files sub-views, parent = INFRA_TAB_CONFIG_FILES ─────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 5, (SELECT page_id FROM public.page_master WHERE page_code = 'INFRA_TAB_CONFIG_FILES'), v.code, v.name, v.url, v.ord, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('INFRA_CFG_OS',         'Operating System Configuration', '/infra/:id/config-files/os',         1),
  ('INFRA_CFG_HARDWARE',   'Hardware Configuration',         '/infra/:id/config-files/hardware',   2),
  ('INFRA_CFG_CPU',        'CPU Configuration',              '/infra/:id/config-files/cpu',        3),
  ('INFRA_CFG_MEMORY',     'Memory Configuration',           '/infra/:id/config-files/memory',     4),
  ('INFRA_CFG_DISK',       'Disk Configuration',             '/infra/:id/config-files/disk',       5),
  ('INFRA_CFG_STORAGE',    'Storage Configuration',          '/infra/:id/config-files/storage',    6),
  ('INFRA_CFG_FILESYSTEM', 'Filesystem Configuration',       '/infra/:id/config-files/filesystem', 7),
  ('INFRA_CFG_PARTITION',  'Partition Configuration',        '/infra/:id/config-files/partition',  8),
  ('INFRA_CFG_NETWORK',    'Network Configuration',          '/infra/:id/config-files/network',    9),
  ('INFRA_CFG_IP',         'IP Configuration',                '/infra/:id/config-files/ip',        10),
  ('INFRA_CFG_DNS',        'DNS Configuration',               '/infra/:id/config-files/dns',       11),
  ('INFRA_CFG_ROUTING',    'Routing Configuration',           '/infra/:id/config-files/routing',   12),
  ('INFRA_CFG_FIREWALL',   'Firewall Configuration',          '/infra/:id/config-files/firewall',  13),
  ('INFRA_CFG_SSH',        'SSH Configuration',               '/infra/:id/config-files/ssh',       14),
  ('INFRA_CFG_SERVICE',    'Service Configuration',           '/infra/:id/config-files/service',   15),
  ('INFRA_CFG_PROCESS',    'Process Configuration',           '/infra/:id/config-files/process',   16),
  ('INFRA_CFG_NTP',        'Time & NTP Configuration',        '/infra/:id/config-files/ntp',       17),
  ('INFRA_CFG_POWER',      'Power Management Configuration',  '/infra/:id/config-files/power',     18),
  ('INFRA_CFG_DATABASE',   'Database Configuration',          '/infra/:id/config-files/database',  19)
) AS v(code, name, url, ord)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.code);

-- ─────────────────────────────────────────────────────────────────────────────
--  Grant cascade: every (org, role) that currently holds ANY grant on
--  /infra/:id (page_id=165) gets the SAME permission bitmask replicated onto
--  all 51 new pages — otherwise a role that could do everything on Infra
--  yesterday would find every tab freshly denied today, since a page is
--  "denied by default" the moment it exists in page_master at all.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, p.page_id, g.permission, true, 1, CURRENT_TIMESTAMP
FROM public.group_role_page_permission g
CROSS JOIN public.page_master p
WHERE g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'INFRA_ID')
  AND g.deleted_at IS NULL
  AND p.page_code IN (
    'INFRA_TAB_PORTS', 'INFRA_TAB_PROCESSES', 'INFRA_TAB_STORAGE', 'INFRA_TAB_NETWORK',
    'INFRA_TAB_SERVICES', 'INFRA_TAB_DIAGNOSTICS', 'INFRA_TAB_IP_CONFIGURATION', 'INFRA_TAB_CONFIG_FILES',
    'INFRA_NET_IFACE_DETAILS', 'INFRA_NET_REALTIME', 'INFRA_NET_CONN_STATS', 'INFRA_NET_ERRORS',
    'INFRA_NET_IFACE_TABLE', 'INFRA_NET_DNS', 'INFRA_NET_GATEWAY', 'INFRA_NET_TCP_UDP', 'INFRA_NET_PORTS',
    'INFRA_NET_BANDWIDTH', 'INFRA_NET_WIFI', 'INFRA_NET_ROUTING', 'INFRA_NET_ARP', 'INFRA_NET_PROCESSES',
    'INFRA_IP_INTERFACE', 'INFRA_IP_IPV4', 'INFRA_IP_IPV6', 'INFRA_IP_DNS', 'INFRA_IP_ADVANCED',
    'INFRA_IP_CONFLICT', 'INFRA_IP_VALIDATION', 'INFRA_IP_EXPORT', 'INFRA_IP_EDIT', 'INFRA_IP_FIREWALL',
    'INFRA_CFG_OS', 'INFRA_CFG_HARDWARE', 'INFRA_CFG_CPU', 'INFRA_CFG_MEMORY', 'INFRA_CFG_DISK',
    'INFRA_CFG_STORAGE', 'INFRA_CFG_FILESYSTEM', 'INFRA_CFG_PARTITION', 'INFRA_CFG_NETWORK', 'INFRA_CFG_IP',
    'INFRA_CFG_DNS', 'INFRA_CFG_ROUTING', 'INFRA_CFG_FIREWALL', 'INFRA_CFG_SSH', 'INFRA_CFG_SERVICE',
    'INFRA_CFG_PROCESS', 'INFRA_CFG_NTP', 'INFRA_CFG_POWER', 'INFRA_CFG_DATABASE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = g.org_id AND x.role_id = g.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
