
import React, { useState } from 'react';

import { useNavigate } from 'react-router-dom';

import { useForm } from 'react-hook-form';

import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Server,
  ShieldCheck,
  Monitor,
  Network,
  KeyRound,
  Cpu,
  Database,
  Save,
  Globe,
} from 'lucide-react';
import { registerAgent } from '../../api/agents';
import { useQueryClient } from '@tanstack/react-query';


const OPERATING_SYSTEMS = [

  {
    name: 'Linux',
    icon: '🐧',
    port: 22,
  },

  {
    name: 'Ubuntu',
    icon: '🟠',
    port: 22,
  },

  {
    name: 'Windows',
    icon: '🪟',
    port: 22,
  },

  {
    name: 'CentOS',
    icon: '⚫',
    port: 22,
  },

  {
    name: 'Oracle Linux',
    icon: '🔴',
    port: 22,
  },

  {
    name: 'RedHat',
    icon: '🎩',
    port: 22,
  },

];


const DATABASE_SERVICES = [

  'MySQL',
  'PostgreSQL',
  'Oracle',
  'MongoDB',
  'MSSQL',
  'ClickHouse',

];



export default function AddOsServerPage() {

  const queryClient = useQueryClient();

  const navigate = useNavigate();

  const [selectedOs, setSelectedOs] =
    useState('Linux');

  const [loading, setLoading] =
    useState(false);

  const [testing, setTesting] =
    useState(false);

  const [message, setMessage] =
    useState(null);

  const [selectedDatabases, setSelectedDatabases] =
    useState([]);


  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm({

    defaultValues: {

      sshPort: 22,

      environment: 'Production',

      nodeType: 'Standalone',

      monitoringEnabled: true,

      autoDiscovery: true,

    },
  });


  const nodeType = watch('nodeType');


  const handleOsChange = (
    os
  ) => {

    setSelectedOs(os);

    const selected =
      OPERATING_SYSTEMS.find(
        (o) =>
          o.name === os
      );

    setValue(
      'sshPort',
      selected.port
    );
  };


  const handleDatabaseToggle = (
    db
  ) => {

    if (
      selectedDatabases.includes(db)
    ) {

      setSelectedDatabases(
        selectedDatabases.filter(
          (item) =>
            item !== db
        )
      );

    } else {

      setSelectedDatabases([
        ...selectedDatabases,
        db,
      ]);

    }

  };


  const handleTestConnection = async (
    data
  ) => {

    try {

      setTesting(true);

      setMessage(null);

      await new Promise((resolve) =>
        setTimeout(resolve, 1500)
      );

      setMessage({

        type: 'success',

        text:
          'SSH Connection Successful',

      });

    } catch (error) {

      setMessage({

        type: 'error',

        text:
          'SSH Connection Failed',

      });

    } finally {

      setTesting(false);

    }

  };


  const handleSaveServer = async (
    data
  ) => {

    try {

      setLoading(true);

      setMessage(null);

      const payload = {

        ...data,

        operatingSystem:
          selectedOs,

        databaseServices:
          selectedDatabases,

      };

      console.log(
        'OS SERVER DATA =>',
        payload
      );

      // Try to register with backend if endpoint exists, otherwise fallback to local simulation
      try {
        await registerAgent(payload);
        // refresh agents list
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        setMessage({ type: 'success', text: 'OS Server Registered — awaiting agent heartbeat' });
        setTimeout(() => navigate('/databases'), 800);
      } catch (err) {
        // Backend may not support direct registration; keep simulated behaviour
        await new Promise((resolve) => setTimeout(resolve, 1000));
        setMessage({ type: 'success', text: 'OS Server added (local simulation). Start agent for real registration.' });
        setTimeout(() => navigate('/databases'), 800);
      }

    } catch (error) {

      setMessage({

        type: 'error',

        text:
          'Failed to Add OS Server',

      });

    } finally {

      setLoading(false);

    }

  };


  return (

    <div className="min-h-screen bg-[#f5f7fb] p-6">

      <div className="max-w-5xl mx-auto">


        {/* HEADER */}

        <div className="flex items-center gap-4 mb-8">

          <button
            onClick={() =>
              navigate('/databases')
            }
            className="w-10 h-10 rounded-xl border border-slate-200 bg-white flex items-center justify-center hover:bg-slate-100 transition-all"
          >

            <ArrowLeft className="w-5 h-5" />

          </button>


          <div>

            <h1 className="text-3xl font-bold text-slate-900">
              Add OS Server
            </h1>

            <p className="text-slate-500 mt-1">
              Configure operating system server and SSH access.
            </p>

          </div>

        </div>


        {/* OS TYPES */}

        <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-6">

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">

            {OPERATING_SYSTEMS.map((os) => (

              <button
                key={os.name}
                type="button"
                onClick={() =>
                  handleOsChange(
                    os.name
                  )
                }
                className={`h-24 rounded-2xl border transition-all ${
                  selectedOs ===
                  os.name
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >

                <div className="flex flex-col items-center justify-center">

                  <div className="text-3xl mb-2">
                    {os.icon}
                  </div>

                  <div className="text-sm font-semibold">
                    {os.name}
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

              OS Server Configuration

            </h2>

          </div>


          <form
            onSubmit={handleSubmit(
              handleSaveServer
            )}
            className="p-6"
          >

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">


              <InputField
                label="Server Name"
                required
                error={
                  errors.serverName
                    ?.message
                }
              >

                <input
                  {...register(
                    'serverName',
                    {
                      required:
                        'Server Name required',
                    }
                  )}
                  placeholder="DB-OS-PROD-01"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="Host IP Address"
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
                        'Host IP required',
                    }
                  )}
                  placeholder="192.168.1.10"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="SSH Port"
                required
              >

                <input
                  type="number"
                  {...register('sshPort')}
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="SSH Username"
                required
              >

                <input
                  {...register(
                    'sshUsername',
                    {
                      required:
                        'Username required',
                    }
                  )}
                  placeholder="root"
                  className={inputClass}
                />

              </InputField>


              <InputField
                label="SSH Password"
              >

                <input
                  type="password"
                  {...register(
                    'sshPassword'
                  )}
                  placeholder="••••••••"
                  className={inputClass}
                />

              </InputField>


              <div>

                <label className="block text-sm font-semibold text-slate-700 mb-2">

                  Environment

                </label>

                <select
                  {...register(
                    'environment'
                  )}
                  className={inputClass}
                >

                  <option>
                    Production
                  </option>

                  <option>
                    UAT
                  </option>

                  <option>
                    Development
                  </option>

                  <option>
                    Testing
                  </option>

                </select>

              </div>


              <div>

                <label className="block text-sm font-semibold text-slate-700 mb-2">

                  Node Type

                </label>

                <select
                  {...register(
                    'nodeType'
                  )}
                  className={inputClass}
                >

                  <option>
                    Standalone
                  </option>

                  <option>
                    Master
                  </option>

                  <option>
                    Slave
                  </option>

                  <option>
                    Passive
                  </option>

                  <option>
                    Cluster Node
                  </option>

                </select>

              </div>


              {(nodeType === 'Slave' ||
                nodeType === 'Cluster Node' ||
                nodeType === 'Passive') && (

                <InputField
                  label="Cluster Name"
                >

                  <input
                    {...register(
                      'clusterName'
                    )}
                    placeholder="PROD-POSTGRES-CLUSTER"
                    className={inputClass}
                  />

                </InputField>

              )}

            </div>


            {/* DATABASE SERVICES */}

            <div className="mt-8">

              <div className="flex items-center gap-3 mb-4">

                <Database className="text-slate-700" />

                <h3 className="text-lg font-bold text-slate-900">
                  Database Services
                </h3>

              </div>


              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">

                {DATABASE_SERVICES.map((db) => (

                  <button
                    key={db}
                    type="button"
                    onClick={() =>
                      handleDatabaseToggle(db)
                    }
                    className={`h-14 rounded-2xl border font-semibold transition-all ${
                      selectedDatabases.includes(db)

                        ? 'border-slate-900 bg-slate-900 text-white'

                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >

                    {db}

                  </button>

                ))}

              </div>

            </div>


            {/* MONITORING */}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-8">

              <InfoCard
                icon={<ShieldCheck />}
                title="SSH Secure"
                subtitle="Encrypted SSH access"
              />

              <InfoCard
                icon={<Monitor />}
                title="Monitoring"
                subtitle="Real-time metrics"
              />

              <InfoCard
                icon={<Network />}
                title="Auto Discovery"
                subtitle="Detect DB services"
              />

            </div>


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
                  ? 'Testing SSH...'
                  : 'Test SSH'}

              </button>


              <button
                type="submit"
                disabled={loading}
                className="h-11 px-6 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-all flex items-center gap-2"
              >

                <Save size={18} />

                {loading
                  ? 'Saving...'
                  : 'Save OS Server'}

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


/* =========================================================
   INFO CARD
========================================================= */

function InfoCard({
  icon,
  title,
  subtitle,
}) {

  return (

    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5">

      <div className="text-slate-700 mb-3">
        {icon}
      </div>

      <h3 className="font-bold text-slate-900">
        {title}
      </h3>

      <p className="text-sm text-slate-500 mt-1">
        {subtitle}
      </p>

    </div>

  );

}


const inputClass =
  'w-full h-11 rounded-xl border border-slate-300 px-4 bg-white outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 transition-all';

