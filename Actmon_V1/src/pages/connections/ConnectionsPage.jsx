import React, { useState } from 'react';

import { useNavigate } from 'react-router-dom';

import {
  Database,
  Plus,
  Trash2,
  Globe,
  User,
  HardDrive,
  Server,
} from 'lucide-react';

import {
  useConnectionsList,
  useConnectionMutations,
} from '../../hooks/useConnections';


const DATABASES = [

  {
    name: 'MySQL',
    icon: '🐬',
    color: 'from-orange-500 to-orange-600',
  },

  {
    name: 'PostgreSQL',
    icon: '🐘',
    color: 'from-blue-500 to-blue-600',
  },

  {
    name: 'Oracle',
    icon: '🟥',
    color: 'from-red-500 to-red-600',
  },

  {
    name: 'MSSQL',
    icon: '💠',
    color: 'from-purple-500 to-purple-600',
  },

  {
    name: 'MongoDB',
    icon: '🍃',
    color: 'from-green-500 to-green-600',
  },

  {
    name: 'ClickHouse',
    icon: '📊',
    color: 'from-yellow-400 to-yellow-500',
  },
];


export const ConnectionsPage = () => {

  const navigate = useNavigate();

  const [activeDatabase, setActiveDatabase] =
    useState('PostgreSQL');

  const {
    data: connections = [],
    isLoading,
  } = useConnectionsList(
    activeDatabase
  );

  const {
    deleteConnection,
  } = useConnectionMutations(
    activeDatabase
  );


  const handleDelete = async (
    id
  ) => {

    const confirmed =
      window.confirm(
        'Delete this connection profile?'
      );

    if (!confirmed) return;

    try {

      await deleteConnection(id);

    } catch (error) {

      console.error(error);
    }
  };


  const getDashboardPath = (
    connection
  ) => {

    const type =
      (
        connection.db_type || ''
      ).toLowerCase();

    switch (type) {

      case 'mysql':
        return `/mysql-dashboard/${connection.id}`;

      case 'postgresql':
        return `/postgresql-dashboard/${connection.id}`;

      case 'oracle':
        return `/oracle-dashboard/${connection.id}`;

      case 'mssql':
        return `/mssql-dashboard/${connection.id}`;

      case 'mongodb':
        return `/mongodb-dashboard/${connection.id}`;

      case 'clickhouse':
        return `/clickhouse-dashboard/${connection.id}`;

      default:
        return '/connections';
    }
  };


  return (

    <div className="min-h-screen bg-[#f4f7fb] p-8">

      <div className="max-w-7xl mx-auto">

        {/* HEADER */}

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 mb-10">

        <div>

            <h1 className="text-4xl font-bold text-slate-900">
              Database Connections
            </h1>

            <p className="text-slate-500 mt-2 text-base">
              Manage enterprise database
              connections and monitoring
              profiles.
          </p>

        </div>


          <button
            onClick={() =>
              navigate('/connections/add')
            }
            className="h-14 px-7 rounded-2xl bg-slate-900 text-white font-semibold flex items-center gap-3 hover:bg-slate-800 transition-all shadow-lg"
          >

            <Plus className="w-5 h-5" />

            Add Connection

          </button>

        </div>


        {/* DATABASE FILTERS */}

        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-5 mb-10">

          {DATABASES.map((database) => (

            <button
              key={database.name}
              onClick={() =>
                setActiveDatabase(
                  database.name
                )
              }
              className={`rounded-3xl overflow-hidden border transition-all duration-300 ${
                activeDatabase ===
                database.name
                  ? 'border-slate-900 shadow-xl scale-[1.03]'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >

              <div
                className={`h-2 bg-gradient-to-r ${database.color}`}
              />

              <div className="p-6 flex flex-col items-center justify-center">

                <div className="text-5xl mb-4">
                  {database.icon}
      </div>

                <div className="font-semibold text-slate-800">
                  {database.name}
          </div>

        </div>

            </button>
          ))}
        </div>


        {/* CONTENT */}

        {isLoading ? (

          <div className="bg-white rounded-3xl border border-slate-200 h-[400px] flex items-center justify-center">

            <div className="text-center">

              <div className="w-14 h-14 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto mb-5" />

              <p className="text-slate-500 font-medium">
                Loading database connections...
              </p>

            </div>

            </div>

        ) : connections.length === 0 ? (

          <div className="bg-white rounded-3xl border border-slate-200 h-[400px] flex flex-col items-center justify-center text-center">

            <Database className="w-16 h-16 text-slate-300 mb-5" />

            <h2 className="text-2xl font-bold text-slate-800">
              No Connections Available
            </h2>

            <p className="text-slate-500 mt-3 max-w-md">
              Create your first database
              connection profile to start
              telemetry monitoring and analytics.
            </p>

          </div>

        ) : (

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-7">

            {connections.map((connection) => (

              <div
                key={connection.id}
                className="bg-white rounded-3xl border border-slate-200 p-7 hover:shadow-2xl transition-all duration-300"
              >

                {/* TOP */}

                <div className="flex items-start justify-between mb-7">

                  <div className="flex items-center gap-5">

                    <div className="w-16 h-16 rounded-2xl bg-slate-900 text-white flex items-center justify-center text-3xl">

                      {
                        DATABASES.find(
                          (d) =>
                            d.name ===
                            activeDatabase
                        )?.icon
                      }

            </div>


                    <div>

                      <button
                        onClick={() =>
                          navigate(
                            getDashboardPath(
                              connection
                            )
                          )
                        }
                        className="text-2xl font-bold text-slate-900 hover:text-blue-600 transition-all"
                      >

                        {
                          connection.connection_name
                        }

                      </button>

                      <p className="text-sm text-slate-500 mt-1 capitalize">

                        {
                          connection.db_type
                        }

                      </p>

            </div>

            </div>


                  <button
                    onClick={() =>
                      handleDelete(
                        connection.id
                      )
                    }
                    className="w-11 h-11 rounded-2xl border border-red-200 text-red-500 hover:bg-red-50 transition-all flex items-center justify-center"
                  >

                    <Trash2 className="w-4 h-4" />

                  </button>

                </div>


                {/* DETAILS */}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

                  <InfoCard
                    icon={
                      <Globe className="w-5 h-5" />
                    }
                    label="Host Address"
                    value={`${connection.host}:${connection.port}`}
                  />

                  <InfoCard
                    icon={
                      <HardDrive className="w-5 h-5" />
                    }
                    label="Database"
                    value={
                      connection.database_name ||
                      '-'
                    }
                  />

                  <InfoCard
                    icon={
                      <User className="w-5 h-5" />
                    }
                    label="Username"
                    value={
                      connection.username ||
                      '-'
                    }
                  />

                  <InfoCard
                    icon={
                      <Server className="w-5 h-5" />
                    }
                    label="Environment"
                    value={
                      connection.environment ||
                      'Production'
                    }
                  />

                </div>


                {/* FOOTER */}

                <div className="mt-7 pt-6 border-t border-slate-200 flex items-center justify-between">

                  <div className="flex items-center gap-2 text-green-600 font-semibold text-sm">

                    <div className="w-2 h-2 rounded-full bg-green-500" />

                    Active Connection

                  </div>


                  <button
                    onClick={() =>
                      navigate(
                        getDashboardPath(
                          connection
                        )
                      )
                    }
                    className="px-5 h-11 rounded-2xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition-all"
                  >

                    Open Dashboard

                  </button>

                </div>

              </div>
            ))}
          </div>
        )}

      </div>

    </div>
  );
};


/* =========================================================
   INFO CARD
========================================================= */

function InfoCard({
  icon,
  label,
  value,
}) {

  return (

    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">

      <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">

        {icon}

        {label}

      </div>

      <div className="font-semibold text-slate-900 break-all">

        {value}

      </div>

    </div>
  );
}