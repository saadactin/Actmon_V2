// Supported database engines for the Agent Setup wizard (ActMon-style).
export const TECHS = [
  { id: 'mysql',      name: 'MySQL',      emoji: '🐬', accent: 'from-orange-400 to-orange-600',
    desc: 'MySQL, AWS Aurora, MariaDB, Percona Server, Google Cloud SQL, Azure DB and AWS RDS are supported.', port: 3306 },
  { id: 'postgresql', name: 'PostgreSQL', emoji: '🐘', accent: 'from-indigo-400 to-indigo-700',
    desc: 'PostgreSQL, AWS Aurora, Percona Distribution, Google Cloud SQL, Azure DB and AWS RDS are supported.', port: 5432 },
  { id: 'mssql',      name: 'SQL Server', emoji: '🖥️', accent: 'from-sky-400 to-sky-700',
    desc: 'SQL Server, AWS RDS, Google Cloud SQL and Azure DB are supported.', port: 1433 },
  { id: 'oracle',     name: 'Oracle',     emoji: '☀️', accent: 'from-red-400 to-red-600',
    desc: 'Oracle Database (via SID or Service Name) is supported.', port: 1521 },
  { id: 'mongodb',    name: 'MongoDB',    emoji: '🍃', accent: 'from-emerald-400 to-emerald-700',
    desc: 'MongoDB and MongoDB Atlas are supported.', port: 27017 },
  { id: 'clickhouse', name: 'ClickHouse', emoji: '⚡', accent: 'from-yellow-400 to-amber-500',
    desc: 'ClickHouse columnar analytics database is supported.', port: 9000 },
];

export const techById = (id) => TECHS.find((t) => t.id === id) || null;

// Engine-specific "prepare your database" scripts (create a read-only monitoring user + grants).
export function prepareSql(techId, { username = 'actmon_user', password = '<password>', database = '' } = {}) {
  const u = username || 'actmon_user';
  const db = database || 'your_database';
  switch (techId) {
    case 'mysql':
      return {
        createUser: `CREATE USER '${u}'@'%'\n  IDENTIFIED BY '${password}';`,
        grant: `GRANT PROCESS, SELECT, SHOW VIEW, REPLICATION CLIENT\n  ON *.*\n  TO '${u}'@'%';\nGRANT SELECT ON performance_schema.*\n  TO '${u}'@'%';`,
      };
    case 'postgresql':
      return {
        createUser: `CREATE ROLE ${u} LOGIN\n  PASSWORD '${password}';`,
        grant: `GRANT pg_monitor TO ${u};\nGRANT CONNECT ON DATABASE ${db} TO ${u};`,
      };
    case 'mssql':
      return {
        createUser: `CREATE LOGIN [${u}] WITH PASSWORD = '${password}';\nCREATE USER [${u}] FOR LOGIN [${u}];`,
        grant: `GRANT VIEW SERVER STATE TO [${u}];\nGRANT VIEW ANY DEFINITION TO [${u}];`,
      };
    case 'oracle':
      return {
        createUser: `CREATE USER ${u} IDENTIFIED BY "${password}";`,
        grant: `GRANT CREATE SESSION TO ${u};\nGRANT SELECT_CATALOG_ROLE TO ${u};\nGRANT SELECT ANY DICTIONARY TO ${u};`,
      };
    case 'mongodb':
      return {
        createUser: `use admin\ndb.createUser({\n  user: "${u}",\n  pwd: "${password}",\n  roles: [\n    { role: "clusterMonitor", db: "admin" },\n    { role: "read", db: "local" }\n  ]\n})`,
        grant: '// clusterMonitor + read(local) provide read-only monitoring access.',
      };
    case 'clickhouse':
      return {
        createUser: `CREATE USER ${u} IDENTIFIED BY '${password}';`,
        grant: `GRANT SELECT ON *.* TO ${u};\nGRANT SHOW ON *.* TO ${u};`,
      };
    default:
      return { createUser: '', grant: '' };
  }
}
