import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import {
  Database,
  Server,
  Activity,
  HardDrive,
  RefreshCw,
  Clock,
  Layers,
  Network,
  ShieldCheck,
  AlertTriangle,
  Cpu,
  MemoryStick,
} from 'lucide-react';

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

import client from '../../api/client';

const MYSQL_BLUE = '#00758F';
const MYSQL_GREEN = '#22C55E';
const MYSQL_RED = '#EF4444';
const MYSQL_CYAN = '#06B6D4';

const fetchDashboard = async (id) => {
  const res = await client.get(
    `/connections/mysql/${id}/dashboard`
  );

  return res.data;
};

function StatCard({
  icon: Icon,
  title,
  value,
  color = 'blue',
}) {

  const borderColor = {
    blue: 'border-cyan-600',
    green: 'border-green-500',
    red: 'border-red-500',
    orange: 'border-orange-500',
  };

  return (
    <div
      className={`
        bg-white
        rounded-2xl
        shadow-sm
        border
        border-slate-200
        border-l-4
        ${borderColor[color]}
        p-5
        hover:shadow-md
        transition-all
      `}
    >

      <div className="flex justify-between">

        <div>

          <p
            className="
              text-xs
              uppercase
              tracking-wide
              text-slate-500
              font-semibold
            "
          >
            {title}
          </p>

          <h3
            className="
              mt-2
              text-xl
              font-bold
              text-slate-800
            "
          >
            {value ?? 'N/A'}
          </h3>

        </div>

        <Icon
          size={30}
          className="text-slate-500"
        />

      </div>

    </div>
  );
}

function SectionTitle({ title }) {
  return (
    <h2
      className="
        text-2xl
        font-bold
        text-slate-800
        mb-5
      "
    >
      {title}
    </h2>
  );
}

export default function MySQLDashboard() {

  const { id } = useParams();

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      'mysqlDashboard',
      id,
    ],
    queryFn: () =>
      fetchDashboard(id),
    retry: false,
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div
        className="
          min-h-screen
          flex
          items-center
          justify-center
          text-xl
          font-semibold
        "
      >
        Loading MySQL Dashboard...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">

        <div
          className="
            bg-red-100
            border
            border-red-300
            text-red-700
            p-4
            rounded-xl
          "
        >
          {error.message}
        </div>

      </div>
    );
  }

  const {
    connection = {},
    health_summary = {},
    databases = [],
    query_stats = {},
    connections_detail = {},
    memory = {},
    network = {},
    replication = {},
    process_list = [],
    long_running_queries = [],
    slow_query_config = {},
    error_log_path = '',
    error_log_count = 0,
  } = data || {};
    return (

    <div className="min-h-screen bg-slate-100">

      {/* HEADER */}

      <div
        className="
          bg-gradient-to-r
          from-cyan-700
          to-teal-600
          text-white
          shadow-lg
        "
      >

        <div
          className="
            px-8
            py-5
            flex
            flex-wrap
            justify-between
            items-center
          "
        >

          <div>

            <h1
              className="
                text-3xl
                font-bold
              "
            >
              ACTMON MySQL Connect
            </h1>

            <p
              className="
                mt-1
                text-sm
                text-cyan-100
              "
            >
              Connection :
              {' '}
              {connection?.name || 'MySQL'}

              {' '}
              (
              {connection?.host || 'Unknown'}
              )
            </p>

          </div>

          <div
            className="
              flex
              gap-3
              flex-wrap
              mt-3
              md:mt-0
            "
          >

            <Link
              to="/mysql-dashboard"
              className="
                px-4
                py-2
                rounded-lg
                border
                border-white/30
                hover:bg-white/10
                text-sm
                font-semibold
              "
            >
              Dashboard
            </Link>

            <Link
              to={`/mysql-dashboard/${id}/slow-queries`}
              className="
                px-4
                py-2
                rounded-lg
                border
                border-white/30
                hover:bg-white/10
                text-sm
                font-semibold
              "
            >
              Slow Queries
            </Link>

            <Link
              to={`/mysql-dashboard/${id}/error-logs`}
              className="
                px-4
                py-2
                rounded-lg
                border
                border-white/30
                hover:bg-white/10
                text-sm
                font-semibold
              "
            >
              Error Logs
            </Link>

            <Link
              to={`/mysql-dashboard/${id}/error-analysis`}
              className="
                px-4
                py-2
                rounded-lg
                border
                border-white/30
                hover:bg-white/10
                text-sm
                font-semibold
              "
            >
              AI Analysis
            </Link>

            <button
              onClick={refetch}
              className="
                bg-white
                text-cyan-700
                px-4
                py-2
                rounded-lg
                flex
                items-center
                gap-2
                font-semibold
              "
            >
              <RefreshCw size={16} />
              Refresh
            </button>

          </div>

        </div>

      </div>

      {/* PAGE BODY */}

      <div className="p-6">

        {/* HEALTH SUMMARY */}

        <SectionTitle
          title="Health Summary"
        />

        <div
          className="
            grid
            grid-cols-1
            md:grid-cols-2
            xl:grid-cols-4
            gap-5
            mb-8
          "
        >

          <StatCard
            icon={Clock}
            title="Uptime"
            value={
              health_summary.uptime
            }
            color="green"
          />

          <StatCard
            icon={Server}
            title="MySQL Version"
            value={
              health_summary.version
            }
            color="blue"
          />

          <StatCard
            icon={Network}
            title="Host Name"
            value={
              health_summary.host_name
            }
            color="blue"
          />

          <StatCard
            icon={Activity}
            title="Replication State"
            value={
              health_summary.replication_state
            }
            color="orange"
          />

          <StatCard
            icon={Database}
            title="Total Databases"
            value={
              health_summary.total_databases
            }
            color="green"
          />

          <StatCard
            icon={Layers}
            title="Total Tables"
            value={
              health_summary.total_tables
            }
            color="blue"
          />

          <StatCard
            icon={HardDrive}
            title="Database Size"
            value={
              health_summary.total_size_gb
                ? `${health_summary.total_size_gb} GB`
                : `${health_summary.total_size_mb || 0} MB`
            }
            color="orange"
          />

          <StatCard
            icon={Server}
            title="Connections"
            value={`${health_summary.current_connections || 0} / ${health_summary.max_connections || 0}`}
            color="red"
          />

          <StatCard
            icon={ShieldCheck}
            title="Storage Engine"
            value={
              health_summary.storage_engine ||
              'InnoDB'
            }
            color="green"
          />

          <StatCard
            icon={Cpu}
            title="Connection Usage"
            value={`${health_summary.connection_usage_pct || 0}%`}
            color="orange"
          />

          <StatCard
            icon={MemoryStick}
            title="Cache Usage"
            value={`${health_summary.cache_usage_pct || 0}%`}
            color="blue"
          />

          <StatCard
            icon={AlertTriangle}
            title="Last Restart"
            value={
              health_summary.last_restart ||
              'N/A'
            }
            color="red"
          />

        </div>
                {/* DATABASE OVERVIEW */}

        <div
          className="
            bg-white
            rounded-2xl
            shadow-sm
            border
            border-slate-200
            overflow-hidden
            mb-8
          "
        >

          <div
            className="
              px-6
              py-5
              border-b
              border-slate-200
            "
          >

            <h2
              className="
                text-2xl
                font-bold
                text-slate-800
              "
            >
              Databases Overview
            </h2>

            <p
              className="
                text-sm
                text-slate-500
                mt-1
              "
            >
              Database inventory and storage consumption
            </p>

          </div>

          <div
            className="
              overflow-x-auto
            "
          >

            <table
              className="
                w-full
              "
            >

              <thead
                className="
                  bg-slate-50
                "
              >

                <tr>

                  <th
                    className="
                      px-5
                      py-4
                      text-left
                      text-xs
                      uppercase
                      tracking-wider
                      text-slate-500
                    "
                  >
                    Database Name
                  </th>

                  <th
                    className="
                      px-5
                      py-4
                      text-center
                      text-xs
                      uppercase
                      tracking-wider
                      text-slate-500
                    "
                  >
                    Tables Count
                  </th>

                  <th
                    className="
                      px-5
                      py-4
                      text-center
                      text-xs
                      uppercase
                      tracking-wider
                      text-slate-500
                    "
                  >
                    Size (MB)
                  </th>

                  <th
                    className="
                      px-5
                      py-4
                      text-center
                      text-xs
                      uppercase
                      tracking-wider
                      text-slate-500
                    "
                  >
                    Actions
                  </th>

                </tr>

              </thead>

              <tbody>

                {databases &&
                databases.length > 0 ? (

                  databases.map(
                    (
                      db,
                      index
                    ) => (

                      <tr
                        key={index}
                        className="
                          border-t
                          border-slate-200
                          hover:bg-slate-50
                        "
                      >

                        <td
                          className="
                            px-5
                            py-4
                            font-semibold
                            text-cyan-700
                          "
                        >
                          {db.name}
                        </td>

                        <td
                          className="
                            px-5
                            py-4
                            text-center
                            font-mono
                          "
                        >
                          {db.tables_count}
                        </td>

                        <td
                          className="
                            px-5
                            py-4
                            text-center
                            font-mono
                          "
                        >
                          {db.size_mb}
                        </td>

                        <td
                          className="
                            px-5
                            py-4
                            text-center
                          "
                        >

                          <button
                            className="
                              bg-cyan-700
                              hover:bg-cyan-800
                              text-white
                              px-4
                              py-2
                              rounded-xl
                              text-sm
                              font-semibold
                              transition-all
                            "
                          >
                            View Tables
                          </button>

                        </td>

                      </tr>

                    )
                  )

                ) : (

                  <tr>

                    <td
                      colSpan="4"
                      className="
                        text-center
                        py-10
                        text-slate-500
                      "
                    >
                      No Databases Found
                    </td>

                  </tr>

                )}

              </tbody>

            </table>

          </div>

        </div>

        {/* CHARTS & METRICS */}

        <SectionTitle
          title="Charts & Metrics"
        />

        <div
          className="
            grid
            grid-cols-1
            xl:grid-cols-2
            gap-6
            mb-8
          "
        >

                 {/* Connection Usage */}

          <div
            className="
              bg-white
              rounded-2xl
              shadow-sm
              border
              border-slate-200
              p-6
            "
          >

            <h3
              className="
                font-bold
                text-slate-700
                mb-4
              "
            >
              Connection Usage %
            </h3>

            <div className="h-[320px]">

              <ResponsiveContainer
                width="100%"
                height="100%"
              >

                <PieChart>

                  <Pie
                    data={[
                      {
                        name: 'Used',
                        value:
                          Number(
                            health_summary.connection_usage_pct
                          ) || 0,
                      },
                      {
                        name: 'Free',
                        value:
                          100 -
                          (
                            Number(
                              health_summary.connection_usage_pct
                            ) || 0
                          ),
                      },
                    ]}
                    dataKey="value"
                    innerRadius={75}
                    outerRadius={115}
                  >

                    <Cell fill="#EF4444" />
                    <Cell fill="#22C55E" />

                  </Pie>

                  <Tooltip />

                </PieChart>

              </ResponsiveContainer>

            </div>

          </div>

          {/* Cache Usage */}

          <div
            className="
              bg-white
              rounded-2xl
              shadow-sm
              border
              border-slate-200
              p-6
            "
          >

            <h3
              className="
                font-bold
                text-slate-700
                mb-4
              "
            >
              Cache Usage %
            </h3>

            <div className="h-[320px]">

              <ResponsiveContainer
                width="100%"
                height="100%"
              >

                <PieChart>

                  <Pie
                    data={[
                      {
                        name: 'Cache Hit',
                        value:
                          Number(
                            health_summary.cache_usage_pct
                          ) || 0,
                      },
                      {
                        name: 'Remaining',
                        value:
                          100 -
                          (
                            Number(
                              health_summary.cache_usage_pct
                            ) || 0
                          ),
                      },
                    ]}
                    dataKey="value"
                    innerRadius={75}
                    outerRadius={115}
                  >

                    <Cell fill="#06B6D4" />
                    <Cell fill="#E5E7EB" />

                  </Pie>

                  <Tooltip />

                </PieChart>

              </ResponsiveContainer>

            </div>

          </div>

          {/* Query Statistics */}

          <div
            className="
              bg-white
              rounded-2xl
              shadow-sm
              border
              border-slate-200
              p-6
            "
          >

            <h3
              className="
                font-bold
                text-slate-700
                mb-4
              "
            >
              Query Statistics
            </h3>

            <div className="h-[350px]">

              <ResponsiveContainer
                width="100%"
                height="100%"
              >

                <BarChart
                  data={[
                    {
                      name: 'SELECT',
                      value:
                        query_stats.Com_select || 0,
                    },
                    {
                      name: 'INSERT',
                      value:
                        query_stats.Com_insert || 0,
                    },
                    {
                      name: 'UPDATE',
                      value:
                        query_stats.Com_update || 0,
                    },
                    {
                      name: 'DELETE',
                      value:
                        query_stats.Com_delete || 0,
                    },
                  ]}
                >

                  <CartesianGrid
                    strokeDasharray="3 3"
                  />

                  <XAxis dataKey="name" />

                  <YAxis />

                  <Tooltip />

                  <Bar
                    dataKey="value"
                    fill="#00758F"
                    radius={[8, 8, 0, 0]}
                  />

                </BarChart>

              </ResponsiveContainer>

            </div>

          </div>

          {/* Database Size Distribution */}

          <div
            className="
              bg-white
              rounded-2xl
              shadow-sm
              border
              border-slate-200
              p-6
            "
          >

            <h3
              className="
                font-bold
                text-slate-700
                mb-4
              "
            >
              Database Size Distribution
            </h3>

            <div className="h-[350px]">

              <ResponsiveContainer
                width="100%"
                height="100%"
              >

                <BarChart
                  layout="vertical"
                  data={databases}
                >

                  <CartesianGrid
                    strokeDasharray="3 3"
                  />

                  <XAxis
                    type="number"
                  />

                  <YAxis
                    width={120}
                    type="category"
                    dataKey="name"
                  />

                  <Tooltip />

                  <Bar
                    dataKey="size_mb"
                    fill="#117E7D"
                    radius={[0, 8, 8, 0]}
                  />

                </BarChart>

              </ResponsiveContainer>

            </div>

          </div>

        </div>
                {/* METRICS PANELS */}

        <div
          className="
            grid
            grid-cols-1
            xl:grid-cols-2
            gap-6
            mb-8
          "
        >

          {/* Connections */}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Connections & Capacity
            </h3>

            <div className="grid grid-cols-3 gap-4">

              <StatCard
                icon={Server}
                title="Current"
                value={connections_detail.current}
                color="green"
              />

              <StatCard
                icon={Server}
                title="Max"
                value={connections_detail.max}
                color="blue"
              />

              <StatCard
                icon={Activity}
                title="Usage %"
                value={`${connections_detail.connection_usage_pct || 0}%`}
                color="orange"
              />

            </div>

          </div>

          {/* Memory */}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Memory (InnoDB Buffer Pool)
            </h3>

            <div className="grid grid-cols-2 gap-4">

              <StatCard
                icon={MemoryStick}
                title="Buffer Pool MB"
                value={memory.buffer_pool_size_mb}
                color="blue"
              />

              <StatCard
                icon={MemoryStick}
                title="Pages Data"
                value={memory.pages_data}
                color="green"
              />

              <StatCard
                icon={MemoryStick}
                title="Pages Total"
                value={memory.pages_total}
                color="green"
              />

              <StatCard
                icon={MemoryStick}
                title="Cache %"
                value={`${memory.cache_usage_pct || 0}%`}
                color="orange"
              />

            </div>

          </div>

          {/* Query Stats */}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Query Statistics
            </h3>

            <div className="grid grid-cols-3 gap-4">

              <StatCard
                icon={Database}
                title="SELECT"
                value={query_stats.Com_select}
                color="blue"
              />

              <StatCard
                icon={Database}
                title="INSERT"
                value={query_stats.Com_insert}
                color="green"
              />

              <StatCard
                icon={Database}
                title="UPDATE"
                value={query_stats.Com_update}
                color="orange"
              />

              <StatCard
                icon={Database}
                title="DELETE"
                value={query_stats.Com_delete}
                color="red"
              />

              <StatCard
                icon={Database}
                title="Questions"
                value={query_stats.Questions}
                color="green"
              />

              <StatCard
                icon={AlertTriangle}
                title="Slow Queries"
                value={query_stats.Slow_queries}
                color="red"
              />

            </div>

          </div>

          {/* Network */}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Network
            </h3>

            <div className="grid grid-cols-2 gap-4">

              <StatCard
                icon={Network}
                title="Bytes Received"
                value={network.bytes_received}
                color="green"
              />

              <StatCard
                icon={Network}
                title="Bytes Sent"
                value={network.bytes_sent}
                color="blue"
              />

            </div>

          </div>

        </div>

        {/* SLOW QUERY + ERROR LOG */}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Slow Query Configuration
            </h3>

            <p>
              <strong>Enabled:</strong>{' '}
              {slow_query_config.slow_query_log}
            </p>

            <p>
              <strong>Long Query Time:</strong>{' '}
              {slow_query_config.long_query_time}s
            </p>

            <p>
              <strong>Path:</strong>{' '}
              {slow_query_config.slow_query_log_file}
            </p>

          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">

            <h3 className="text-xl font-bold mb-5">
              Error Log Monitoring
            </h3>

            <p>
              <strong>Error Count:</strong>{' '}
              {error_log_count}
            </p>

            <p>
              <strong>Log Path:</strong>{' '}
              {error_log_path}
            </p>

          </div>

        </div>

        {/* PROCESS LIST */}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-8">

          <h3 className="text-xl font-bold mb-5">
            Process List
          </h3>

          <pre className="overflow-auto text-xs">
            {JSON.stringify(
              process_list,
              null,
              2
            )}
          </pre>

        </div>

        {/* LONG RUNNING QUERIES */}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-8">

          <h3 className="text-xl font-bold mb-5">
            Long Running Queries
          </h3>

          <pre className="overflow-auto text-xs">
            {JSON.stringify(
              long_running_queries,
              null,
              2
            )}
          </pre>

        </div>

        {/* REPLICATION */}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-8">

          <h3 className="text-xl font-bold mb-5">
            Replication Status
          </h3>

          <pre className="overflow-auto text-xs">
            {JSON.stringify(
              replication,
              null,
              2
            )}
          </pre>

        </div>

      </div>

    </div>

  );
}