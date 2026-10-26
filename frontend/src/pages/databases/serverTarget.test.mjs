/* Every node of a shared-storage cluster resolves to the SAME connection,
   because there is only one database. Without naming the node in the link,
   both RAC cards opened one dashboard describing one instance — node 2's
   button showed node 1's instance name and node 1's numbers. */

// serverTarget is pure, but its module pulls in the whole page. Rather than
// stand up a DOM, the function under test is re-declared here from the same
// source and kept honest by a check that the real file still matches.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('E:/ACTMON V1/frontend/src/pages/databases/DatabaseServersPage.jsx', 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

const DEFAULT_PORTS = { mysql: 3306, postgresql: 5432, oracle: 1521 };

function getDashboardPath(conn) {
  const type = (conn.db_type || '').toLowerCase();
  const map = {
    mysql: `/mysql-dashboard/${conn.id}`,
    postgresql: `/postgresql-dashboard/${conn.id}`,
    oracle: `/oracle-dashboard/${conn.id}`,
  };
  return map[type] || '/connections';
}

function serverTarget({ node, conn, linkedInst, want, dbUp }) {
  const connId = conn?.id || linkedInst?.connection_id;
  if (connId && !dbUp) return `/diagnose/${connId}`;
  const clusterNode = node?.cluster_name && node?.node_type && node.node_type !== 'Standalone'
    ? (node.hostname || node.server_name) : null;
  const withNode = (path) => (clusterNode
    ? `${path}?node=${encodeURIComponent(clusterNode)}` : path);
  if (conn) return withNode(getDashboardPath(conn));
  if (linkedInst) return withNode(getDashboardPath({ db_type: linkedInst.db_type, id: linkedInst.connection_id }));
  const db = want || node.database_services?.[0]?.toLowerCase() || 'mysql';
  return `/connections/add?type=${db}&host=${node.ip_address}`
    + `&port=${DEFAULT_PORTS[db] || 3306}`
    + `&name=${encodeURIComponent(`${node.server_name}-${db}`)}`;
}

const oracleConn = { id: 11, db_type: 'oracle' };
const racNode1 = {
  server_name: 'koebomebspatdb01', hostname: 'koebomebspatdb01',
  node_type: 'RAC Node', cluster_name: 'KPATCH', ip_address: '10.240.72.239',
};
const racNode2 = {
  server_name: 'koebomebspatdb02', hostname: 'koebomebspatdb02',
  node_type: 'RAC Node', cluster_name: 'KPATCH', ip_address: '10.240.72.78',
};

console.log('=== a cluster node links to ITS OWN instance ===');
const t1 = serverTarget({ node: racNode1, conn: oracleConn, dbUp: true });
const t2 = serverTarget({ node: racNode2, conn: oracleConn, dbUp: true });
ok(t1 !== t2, 'the two nodes of a cluster do not open the same URL');
ok(t1.includes('node=koebomebspatdb01'), 'node 1 names itself');
ok(t2.includes('node=koebomebspatdb02'), 'node 2 names itself');
ok(t1.startsWith('/oracle-dashboard/11'), 'both still use the cluster\'s one connection');
ok(t2.startsWith('/oracle-dashboard/11'), 'node 2 uses the same connection, not a second one');

console.log('\n=== a standalone server is unchanged ===');
const solo = { server_name: 'db-a', hostname: 'db-a', node_type: 'Standalone', ip_address: '10.0.0.1' };
ok(serverTarget({ node: solo, conn: oracleConn, dbUp: true }) === '/oracle-dashboard/11',
   'no node parameter is added where there is no cluster');
const noCluster = { server_name: 'db-b', hostname: 'db-b', node_type: 'Primary', ip_address: '10.0.0.2' };
ok(serverTarget({ node: noCluster, conn: oracleConn, dbUp: true }) === '/oracle-dashboard/11',
   'a node_type without a cluster_name adds nothing');

console.log('\n=== the other routes still win where they should ===');
ok(serverTarget({ node: racNode2, conn: oracleConn, dbUp: false }) === '/diagnose/11',
   'a database that is down still goes to Diagnosis, not a dashboard of stale numbers');
ok(serverTarget({ node: { ...racNode2, database_services: ['Oracle'] }, want: 'oracle' })
     .startsWith('/connections/add?type=oracle'),
   'a host with no connection still goes to the connect form');

console.log('\n=== a hostname needing escaping is escaped ===');
const odd = { ...racNode2, hostname: 'node 2.corp' };
ok(serverTarget({ node: odd, conn: oracleConn, dbUp: true }).includes('node=node%202.corp'),
   'the hostname is URL-encoded');

console.log('\n=== the page still contains this logic ===');
ok(SRC.includes("`${path}?node=${encodeURIComponent(clusterNode)}`"),
   'DatabaseServersPage.jsx still builds the node-scoped link');
ok(SRC.includes("node.node_type !== 'Standalone'"),
   'and still excludes standalone servers from it');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
