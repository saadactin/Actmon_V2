/**
 * Centralized config for the Database module's card grid — one entry per
 * engine (plus the non-engine "Database Fundamentals" category), each with
 * its own image, how that image should be fit/positioned, and a short list
 * of REAL monitoring capabilities. `DatabaseLandingPage.jsx` renders every
 * card from this single source instead of hand-building per-engine JSX, so
 * a new engine or a swapped image is a config change here, never a
 * component edit. Feature bullets are grounded in the same capabilities
 * documented in this Help Center's own dbm-* chapters — never invented.
 *
 * `imageFit`/`imagePosition` are NOT currently read by `DatabaseLandingPage.jsx`
 * — every card's image now goes through the shared `DocumentationCard` /
 * `CardImage` (appearance/DocumentationCard.jsx), which centralizes fit as
 * ONE admin-configurable setting (`config.image.objectFit`, default
 * 'cover') for every Help Center card, not a per-engine override. Left here,
 * unused, as historical per-image metadata rather than deleted.
 *
 * `hue` here is only the SEED default (copied verbatim into
 * `appearance/helpAppearanceConfig.js`'s `DEFAULT_CONFIG.engineColors`) —
 * at render time `DatabaseLandingPage.jsx` resolves the actual color through
 * `engineSlug` against the admin-configurable Help Center Appearance config,
 * not this literal, so an admin can recolor engines without a code change.
 */
export const DB_ENGINE_CARDS = [
  {
    treeId: 'db-engine-postgresql', engineSlug: 'postgresql', title: 'PostgreSQL', hue: '#336791',
    image: '/help-images/postgresql-engine.png', imageFit: 'contain', imagePosition: 'center',
    description: 'Performance, queries, locks, and replication monitoring.',
    features: ['Performance & query analysis', 'Replication & Patroni HA', 'Locks and sessions', 'Slow query analysis'],
  },
  {
    treeId: 'db-engine-mysql', engineSlug: 'mysql', title: 'MySQL / MariaDB', hue: '#00758F',
    image: '/help-images/mysql-engine.jpg', imageFit: 'cover', imagePosition: 'center',
    description: 'A 13-tab dashboard covering performance and replication.',
    features: ['Performance monitoring', 'Replication monitoring', 'Binary log monitoring', 'Slow query analysis'],
  },
  {
    treeId: 'db-engine-oracle', engineSlug: 'oracle', title: 'Oracle', hue: '#F80000',
    image: '/help-images/oracle-engine.jpg', imageFit: 'cover', imagePosition: 'center',
    description: 'Sessions, tablespaces, redo logs, and Data Guard status.',
    features: ['Session monitoring', 'Tablespace monitoring', 'Redo log monitoring', 'RAC / ASM / Data Guard visibility'],
  },
  {
    treeId: 'db-engine-mssql', engineSlug: 'mssql', title: 'SQL Server', hue: '#A91D22',
    image: '/help-images/mssql-engine.jpg', imageFit: 'cover', imagePosition: 'center',
    description: 'DMV-driven performance and AlwaysOn availability status.',
    features: ['Performance monitoring', 'AlwaysOn availability', 'Wait analysis', 'Error-log monitoring'],
  },
  {
    treeId: 'db-engine-mongodb', engineSlug: 'mongodb', title: 'MongoDB', hue: '#00684A',
    image: '/help-images/mongodb-engine.png', imageFit: 'cover', imagePosition: 'center',
    description: 'Replica sets, oplog, sharding, and slow operations.',
    features: ['Replica set monitoring', 'Oplog monitoring', 'Sharding visibility', 'Slow operation analysis'],
  },
  {
    treeId: 'db-engine-clickhouse', engineSlug: 'clickhouse', title: 'ClickHouse', hue: '#D4B000',
    image: '/help-images/clickhouse-engine.png', imageFit: 'cover', imagePosition: 'center',
    description: 'Part pressure, merges, and replica/cluster topology.',
    features: ['Part monitoring', 'Merge monitoring', 'Replication & cluster topology', 'Compression visibility'],
  },
  {
    treeId: 'db-engine-cosmosdb', engineSlug: 'cosmosdb', title: 'Cosmos DB', hue: '#7C5CFC',
    image: '/help-images/cosmosdb-engine.jpg', imageFit: 'cover', imagePosition: 'center',
    description: 'RU-aware monitoring for connections and containers.',
    features: ['Connection monitoring', 'Container & database visibility', 'RU consumption tracking', 'AI-assisted analysis'],
  },
];

export const DB_FUNDAMENTALS_CARD = {
  treeId: 'db-cat-fundamentals', engineSlug: 'fundamentals', title: 'Database Fundamentals', hue: '#64748B',
  image: '/help-images/database-fundamentals.jpeg', imageFit: 'cover', imagePosition: 'center',
  description: 'Adding a server, connections & collectors, reports, and cross-engine reference.',
};
