import { useQuery } from '@tanstack/react-query';
import {
  listAgents,
  getAgentDashboard,
  getAgentMetrics,
  getAgentSQL,
  getWaitEvents,
  getOracleSnapshot,
} from '../api/agents';

// Fetches list of all monitored database agents with 30s polling for dashboard
export const useAgentsList = (polling = false) => {
  return useQuery({
    queryKey: ['agents'],
    queryFn: listAgents,
    refetchInterval: polling ? 30000 : false,
    refetchIntervalInBackground: polling,
  });
};

// Fetches agent's live dashboard data
export const useAgentDashboard = (agentName, hours = 6) => {
  return useQuery({
    queryKey: ['agent', 'dashboard', agentName, hours],
    queryFn: () => getAgentDashboard(agentName, hours),
    enabled: !!agentName,
  });
};

// Fetches historical performance metrics (CPU, memory, active sessions)
export const useAgentMetrics = (agentName, hours = 24) => {
  return useQuery({
    queryKey: ['agent', 'metrics', agentName, hours],
    queryFn: () => getAgentMetrics(agentName, hours),
    enabled: !!agentName,
  });
};

// Fetches SQL queries executed with execution times and resources consumed
export const useAgentSQL = (agentName, hours = 6, limit = 50) => {
  return useQuery({
    queryKey: ['agent', 'sql', agentName, hours, limit],
    queryFn: () => getAgentSQL(agentName, hours, limit),
    enabled: !!agentName,
  });
};

// Fetches database engine wait events
export const useAgentWaitEvents = (agentName, hours = 6) => {
  return useQuery({
    queryKey: ['agent', 'wait-events', agentName, hours],
    queryFn: () => getWaitEvents(agentName, hours),
    enabled: !!agentName,
  });
};

// Fetches Oracle instance metadata snapshot (if db_type is Oracle)
export const useOracleSnapshot = (agentName, isOracle) => {
  return useQuery({
    queryKey: ['agent', 'oracle-snapshot', agentName],
    queryFn: () => getOracleSnapshot(agentName),
    enabled: !!agentName && isOracle,
  });
};
