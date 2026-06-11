import React, { useState } from 'react';

import { useNavigate } from 'react-router-dom';

import { useForm } from 'react-hook-form';

import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

import { createConnection, testConnection } from '../../api/connections';
import { useConnectionsList } from '../../hooks/useConnections';


const DATABASES = [

  {
    name: 'MySQL',
    icon: '🐬',
    port: 3306,
  },

  {
    name: 'PostgreSQL',
    icon: '🐘',
    port: 5432,
  },

  {
    name: 'Oracle',
    icon: '🟥',
    port: 1521,
  },

  {
    name: 'MSSQL',
    icon: '💠',
    port: 1433,
  },

  {
    name: 'MongoDB',
    icon: '🍃',
    port: 27017,
  },

  {
    name: 'ClickHouse',
    icon: '📊',
    port: 8123,
  },
];


export default function AddConnectionPage() {

  const navigate = useNavigate();

  const [selectedDatabase, setSelectedDatabase] =
    useState('PostgreSQL');

  const [selectedServerId, setSelectedServerId] = useState('');
  const [newClusterName, setNewClusterName] = useState('');

  const [loading, setLoading] =
    useState(false);

  const [testing, setTesting] =
    useState(false);

  const [message, setMessage] =
    useState(null);


  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm({

    defaultValues: {

      port: 5432,

      sslMode: 'prefer',
    },
  });

  const {
    data: connectionsList = [],
  } = useConnectionsList(selectedDatabase);

  const serversById = connectionsList.reduce((acc, c) => {
    const id = String(c.server_id || 'unknown');
    if (!acc[id]) acc[id] = { server_id: c.server_id, cluster_name: c.cluster_name || null };
    return acc;
  }, {});

  const serverOptions = Object.values(serversById);



  const handleDatabaseChange = (
    database
  ) => {

    setSelectedDatabase(database);

    const db =
      DATABASES.find(
        (d) =>
          d.name === database
      );

    setValue(
      'port',
      db.port
    );

    setMessage(null);
  };


  const buildPayload = (
    data
  ) => {

    // NOTE: Passwords are sent to the backend over HTTPS. The backend MUST
    // encrypt sensitive credentials before persisting to the database.
    // Client-side encryption can be added later (e.g., using server public key).
    return {

      connection_name:
        data.connectionName,

      host: data.host,

      port: Number(data.port),

      username: data.username,

      password: data.password,

      database_name:
        data.databaseName,

      ssl_mode:
        data.sslMode,

      service_name:
        data.serviceName,

      sid: data.sid,

      auth_source:
        data.authSource,

      replica_set:
        data.replicaSet,
      server_id: selectedServerId && selectedServerId !== 'new' ? Number(selectedServerId) : undefined,
      cluster_name: selectedServerId === 'new' ? (newClusterName || undefined) : undefined,
    };
  };


  const handleTestConnection = async (
    data
  ) => {

    try {

      setTesting(true);

      setMessage(null);

      // reuse generic testConnection for DB types
      await testConnection(selectedDatabase, buildPayload(data));

      setMessage({

        type: 'success',

        text:
          'Connection successful',
      });

    } catch (error) {

      setMessage({

        type: 'error',

        text:
          error?.response?.data
            ?.detail ||
          'Connection failed',
      });

    } finally {

      setTesting(false);
    }
  };


  const handleSaveConnection = async (
    data
  ) => {

    try {

      setLoading(true);

      setMessage(null);

      await createConnection(selectedDatabase, buildPayload(data));

      setMessage({

        type: 'success',

        text:
          'Connection created successfully',
      });

      setTimeout(() => {

        navigate('/connections');

      }, 1000);

    } catch (error) {

      setMessage({

        type: 'error',

        text:
          error?.response?.data
            ?.detail ||
          'Failed to create connection',
      });

    } finally {

      setLoading(false);
    }
  };

  


  return (

    <div className="min-h-screen bg-[#f5f7fb] p-6">

      <div className="max-w-4xl mx-auto">


        {/* HEADER */}

        <div className="flex items-center gap-4 mb-8">

          <button
            onClick={() =>
              navigate('/connections')
            }
            className="w-10 h-10 rounded-xl border border-slate-200 bg-white flex items-center justify-center hover:bg-slate-100 transition-all"
          >

            <ArrowLeft className="w-5 h-5" />

          </button>


          <div>

            <h1 className="text-3xl font-bold text-slate-900">
              Add Connection
            </h1>

            <p className="text-slate-500 mt-1">
              Configure database connection settings.
            </p>

          </div>

        </div>


        {/* SERVER / OS SELECTION */}

        <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-6">

          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">OS Server</h3>
            <div className="text-sm text-slate-500">Assign this connection to an OS server</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            <select
              value={selectedServerId}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="col-span-1 h-11 rounded-xl border border-slate-300 px-3 bg-white outline-none"
            >
              <option value="">Select existing server (optional)</option>
              {serverOptions.map((s) => (
                <option key={String(s.server_id)} value={String(s.server_id)}>
                  {s.cluster_name ? `${s.cluster_name} — ${s.server_id}` : `Server ${s.server_id}`}
                </option>
              ))}
              <option value="new">Create new server</option>
            </select>

            {selectedServerId === 'new' && (
              <input
                placeholder="Cluster name (e.g. PROD-CLUSTER)"
                value={newClusterName}
                onChange={(e) => setNewClusterName(e.target.value)}
                className="col-span-2 h-11 rounded-xl border border-slate-300 px-3 bg-white outline-none"
              />
            )}

          </div>

        </div>

        {/* DATABASE TYPES */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-6">

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">

            {DATABASES.map((database) => (

              <button
                key={database.name}
                type="button"
                onClick={() =>
                  handleDatabaseChange(
                    database.name
                  )
                }
                className={`h-24 rounded-2xl border transition-all ${
                  selectedDatabase ===
                  database.name
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >

                <div className="flex flex-col items-center justify-center">

                  <div className="text-3xl mb-2">
                    {database.icon}
                  </div>

                  <div className="text-sm font-semibold">
                    {database.name}
                  </div>

                </div>

              </button>
            ))}
          </div>

        </div>


        {/* FORM */}

        <div className="bg-white rounded-2xl border border-slate-200">

          <div className="px-6 py-5 border-b border-slate-200">

            <h2 className="text-xl font-bold text-slate-900">

              {selectedDatabase} Configuration

            </h2>

          </div>


          <form
            onSubmit={handleSubmit(
              handleSaveConnection
            )}
            className="p-6"
          >

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">


              <InputField
                label="Connection Name"
                required
                error={
                  errors.connectionName
                    ?.message
                }
              >

                <input
                  {...register(
                    'connectionName',
                    {
                      required:
                        'Connection name required',
                    }
                  )}
                  placeholder={`${selectedDatabase} Production`}
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Host Address"
                required
                error={
                  errors.host?.message
                }
              >

                <input
                  {...register(
                    'host',
                    {
                      required:
                        'Host required',
                    }
                  )}
                  placeholder="127.0.0.1"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Port"
                required
              >

                <input
                  type="number"
                  {...register('port')}
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Database Name"
                required
              >

                <input
                  {...register(
                    'databaseName'
                  )}
                  placeholder="ACTMON"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Username"
                required
              >

                <input
                  {...register(
                    'username'
                  )}
                  placeholder="postgres"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Password"
              >

                <input
                  type="password"
                  {...register(
                    'password'
                  )}
                  placeholder="••••••••"
                  className={inputClass}
                />

              </InputField>

            </div>


              {/* (OS Server Configuration removed) */}


            {/* POSTGRESQL */}

            {selectedDatabase ===
              'PostgreSQL' && (

              <div className="mt-5">

                <InputField
                  label="SSL Mode"
                >

                  <select
                    {...register(
                      'sslMode'
                    )}
                    className={inputClass}
                  >

                    <option value="prefer">
                      prefer
                    </option>

                    <option value="disable">
                      disable
                    </option>

                    <option value="require">
                      require
                    </option>

                  </select>

                </InputField>

              </div>
            )}


            {/* ORACLE */}

            {selectedDatabase ===
              'Oracle' && (

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">

                <InputField
                  label="Service Name"
                >

                  <input
                    {...register(
                      'serviceName'
                    )}
                    placeholder="ORCLPDB1"
                    className={inputClass}
                  />

                </InputField>


                <InputField
                  label="SID"
                >

                  <input
                    {...register('sid')}
                    placeholder="ORCL"
                    className={inputClass}
                  />

                </InputField>

              </div>
            )}


            {/* MONGODB */}

            {selectedDatabase ===
              'MongoDB' && (

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">

                <InputField
                  label="Auth Source"
                >

                  <input
                    {...register(
                      'authSource'
                    )}
                    placeholder="admin"
                    className={inputClass}
                  />

                </InputField>


                <InputField
                  label="Replica Set"
                >

                  <input
                    {...register(
                      'replicaSet'
                    )}
                    placeholder="ClusterReplicaSet"
                    className={inputClass}
                  />

                </InputField>

              </div>
            )}


            {/* MESSAGE */}

            {message && (

              <div
                className={`mt-6 rounded-xl px-4 py-3 border flex items-center gap-3 ${
                  message.type ===
                  'success'
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >

                {message.type ===
                'success' ? (

                  <CheckCircle2 className="w-5 h-5" />

                ) : (

                  <AlertTriangle className="w-5 h-5" />

                )}

                {message.text}

              </div>
            )}


            {/* BUTTONS */}

            <div className="flex items-center justify-end gap-4 mt-8 pt-6 border-t border-slate-200">

              <button
                type="button"
                onClick={handleSubmit(
                  handleTestConnection
                )}
                disabled={testing}
                className="h-11 px-5 rounded-xl border border-slate-300 font-semibold hover:bg-slate-100 transition-all"
              >

                {testing
                  ? 'Testing...'
                  : 'Test Connection'}

              </button>


              <button
                type="submit"
                disabled={loading}
                className="h-11 px-6 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-all"
              >

                {loading
                  ? 'Saving...'
                  : 'Save Connection'}

              </button>

            </div>

          </form>

        </div>

      </div>

    </div>
  );
}


/* =========================================================
   INPUT FIELD
========================================================= */

function InputField({
  label,
  required,
  error,
  children,
}) {

  return (

    <div>

      <label className="block text-sm font-semibold text-slate-700 mb-2">

        {label}

        {required && (
          <span className="text-red-500">
            {' '}*
          </span>
        )}

      </label>

      {children}

      {error && (

        <p className="text-red-500 text-sm mt-1">
          {error}
        </p>

      )}

    </div>
  );
}


const inputClass =
  'w-full h-11 rounded-xl border border-slate-300 px-4 bg-white outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 transition-all';
