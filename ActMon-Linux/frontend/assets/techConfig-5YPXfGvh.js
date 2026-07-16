const c=[{id:"mysql",name:"MySQL",emoji:"🐬",accent:"from-orange-400 to-orange-600",desc:"MySQL, AWS Aurora, MariaDB, Percona Server, Google Cloud SQL, Azure DB and AWS RDS are supported.",port:3306},{id:"postgresql",name:"PostgreSQL",emoji:"🐘",accent:"from-indigo-400 to-indigo-700",desc:"PostgreSQL, AWS Aurora, Percona Distribution, Google Cloud SQL, Azure DB and AWS RDS are supported.",port:5432},{id:"mssql",name:"SQL Server",emoji:"🖥️",accent:"from-sky-400 to-sky-700",desc:"SQL Server, AWS RDS, Google Cloud SQL and Azure DB are supported.",port:1433},{id:"oracle",name:"Oracle",emoji:"☀️",accent:"from-red-400 to-red-600",desc:"Oracle Database (via SID or Service Name) is supported.",port:1521},{id:"mongodb",name:"MongoDB",emoji:"🍃",accent:"from-emerald-400 to-emerald-700",desc:"MongoDB and MongoDB Atlas are supported.",port:27017},{id:"clickhouse",name:"ClickHouse",emoji:"⚡",accent:"from-yellow-400 to-amber-500",desc:"ClickHouse columnar analytics database is supported.",port:9e3}],s=o=>c.find(a=>a.id===o)||null;function E(o,{username:a="actmon_user",password:r="<password>",database:n=""}={}){const e=a||"actmon_user",t=n||"your_database";switch(o){case"mysql":return{createUser:`CREATE USER '${e}'@'%'
  IDENTIFIED BY '${r}';`,grant:`GRANT PROCESS, SELECT, SHOW VIEW, REPLICATION CLIENT
  ON *.*
  TO '${e}'@'%';
GRANT SELECT ON performance_schema.*
  TO '${e}'@'%';`};case"postgresql":return{createUser:`CREATE ROLE ${e} LOGIN
  PASSWORD '${r}';`,grant:`GRANT pg_monitor TO ${e};
GRANT CONNECT ON DATABASE ${t} TO ${e};`};case"mssql":return{createUser:`CREATE LOGIN [${e}] WITH PASSWORD = '${r}';
CREATE USER [${e}] FOR LOGIN [${e}];`,grant:`GRANT VIEW SERVER STATE TO [${e}];
GRANT VIEW ANY DEFINITION TO [${e}];`};case"oracle":return{createUser:`CREATE USER ${e} IDENTIFIED BY "${r}";`,grant:`GRANT CREATE SESSION TO ${e};
GRANT SELECT_CATALOG_ROLE TO ${e};
GRANT SELECT ANY DICTIONARY TO ${e};`};case"mongodb":return{createUser:`use admin
db.createUser({
  user: "${e}",
  pwd: "${r}",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "read", db: "local" }
  ]
})`,grant:"// clusterMonitor + read(local) provide read-only monitoring access."};case"clickhouse":return{createUser:`CREATE USER ${e} IDENTIFIED BY '${r}';`,grant:`GRANT SELECT ON *.* TO ${e};
GRANT SHOW ON *.* TO ${e};`};default:return{createUser:"",grant:""}}}export{c as T,E as p,s as t};
