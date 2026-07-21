import React, { useState, useEffect } from 'react';
import { useAgentsList } from '../../hooks/useAgents';
import { getPredictions, getRCA, getRiskTrend } from '../../api/ml';
import { PredictionChart } from '../../components/charts/PredictionChart';
import { RiskTrendChart } from '../../components/charts/RiskTrendChart';
import { useToast } from '../../components/ui/ToastProvider';
import {
  Spinner,
  Select,
  Badge,
  TabList,
  Tab,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import { Brain, ShieldAlert, Sparkles, AlertCircle, AlertTriangle, Info } from 'lucide-react';

export const MLPage = () => {
  const { addToast } = useToast();
  
  // Fetch agents list for dropdown selector
  const { data: agents = [], isLoading: agentsLoading } = useAgentsList();
  
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedMetric, setSelectedMetric] = useState('db_cpu');
  const [selectedHorizon, setSelectedHorizon] = useState('24h');
  
  const [activeTab, setActiveTab] = useState('forecast');

  // Query state data
  const [predictions, setPredictions] = useState([]);
  const [rcaLogs, setRcaLogs] = useState([]);
  const [riskData, setRiskData] = useState([]);

  const [loadingForecast, setLoadingForecast] = useState(false);
  const [loadingRca, setLoadingRca] = useState(false);

  // Set default agent when loaded
  useEffect(() => {
    if (agents.length > 0 && !selectedAgent) {
      setSelectedAgent(agents[0].name);
    }
  }, [agents]);

  // Fetch Forecasts and Risk trends
  const fetchForecastData = async () => {
    if (!selectedAgent) return;
    setLoadingForecast(true);
    try {
      const predRes = await getPredictions(selectedAgent, selectedMetric, selectedHorizon);
      setPredictions(predRes);
      
      const riskRes = await getRiskTrend(selectedAgent, 48);
      // Map RiskTrendPoint { timestamp, risk_score } to RiskTrendChart structure { timestamp, score }
      const mappedRisk = riskRes.map((r) => ({
        timestamp: r.timestamp,
        score: r.risk_score,
      }));
      setRiskData(mappedRisk);
    } catch (err) {
      addToast('Error syncing machine learning forecasting engines.', 'error');
    } finally {
      setLoadingForecast(false);
    }
  };

  // Fetch RCA records
  const fetchRcaData = async () => {
    if (!selectedAgent) return;
    setLoadingRca(true);
    try {
      const rcaRes = await getRCA(selectedAgent, 10);
      setRcaLogs(rcaRes);
    } catch (err) {
      addToast('Error syncing automated Root Cause diagnostics.', 'error');
    } finally {
      setLoadingRca(false);
    }
  };

  // Trigger loads based on active tabs
  useEffect(() => {
    if (activeTab === 'forecast') {
      fetchForecastData();
    } else {
      fetchRcaData();
    }
  }, [selectedAgent, selectedMetric, selectedHorizon, activeTab]);

  // Find the NOW marker boundary (the last point that has a historical_value)
  const getNowTimestamp = () => {
    const historicalPoints = predictions.filter((p) => p.historical_value !== undefined && p.historical_value !== null);
    if (historicalPoints.length > 0) {
      return historicalPoints[historicalPoints.length - 1].timestamp;
    }
    return '';
  };

  const getSeverityBadgeColor = (sev) => {
    switch (sev?.toLowerCase()) {
      case 'critical': return 'danger';
      case 'warning': return 'warning';
      case 'info':
      default:
        return 'informative';
    }
  };

  const getSeverityIcon = (sev) => {
    switch (sev?.toLowerCase()) {
      case 'critical': return <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />;
      case 'warning': return <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />;
      case 'info':
      default:
        return <Info className="h-5 w-5 text-blue-600 mt-0.5" />;
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-brand-border pb-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-text-primary flex items-center gap-2">
            <Brain className="h-6 w-6 text-brand-primary" />
            <span>AI Predictive Analytics & Diagnostics</span>
          </h1>
          <p className="text-sm text-brand-text-secondary">
            Machine Learning forecasting engines, anomaly detection, and automated Root Cause Analysis.
          </p>
        </div>

        {/* Global Selectors */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-brand-text-secondary">Target Database:</span>
          {agentsLoading ? (
            <Spinner size="tiny" />
          ) : (
            <Select
              value={selectedAgent}
              onChange={(_, d) => setSelectedAgent(d.value)}
              size="small"
              className="w-48"
            >
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({a.db_type})
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>

      <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value)}>
        <Tab id="forecast" value="forecast" icon={<Sparkles className="h-4 w-4" />}>Resource Forecasting</Tab>
        <Tab id="rca" value="rca" icon={<ShieldAlert className="h-4 w-4" />}>Root Cause Analysis (RCA)</Tab>
      </TabList>

      <div className="bg-white p-6 border border-brand-border rounded-card shadow-card min-h-[400px]">
        {activeTab === 'forecast' && (
          <div className="space-y-8">
            {/* Forecast Selectors */}
            <div className="flex items-center gap-4 flex-wrap border-b border-brand-border pb-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-brand-text-secondary">Target Metric:</span>
                <Select value={selectedMetric} onChange={(_, d) => setSelectedMetric(d.value)} size="small">
                  <option value="db_cpu">Database CPU (%)</option>
                  <option value="host_cpu">Host CPU (%)</option>
                  <option value="host_memory">Host Memory (%)</option>
                  <option value="active_sessions">Active Sessions Count</option>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-brand-text-secondary">Forecast Horizon:</span>
                <Select value={selectedHorizon} onChange={(_, d) => setSelectedHorizon(d.value)} size="small">
                  <option value="6h">Next 6 Hours</option>
                  <option value="12h">Next 12 Hours</option>
                  <option value="24h">Next 24 Hours</option>
                  <option value="48h">Next 48 Hours</option>
                </Select>
              </div>
            </div>

            {loadingForecast ? (
              <div className="flex justify-center items-center h-80">
                <Spinner label="Executing prediction inference engines..." />
              </div>
            ) : predictions.length === 0 ? (
              <div className="text-center py-20 text-brand-text-secondary">
                No telemetry forecasts generated. Verify agent telemetry polling is healthy.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Main Prediction Chart */}
                <div className="lg:col-span-2 space-y-3">
                  <h3 className="text-sm font-semibold text-brand-text-primary uppercase tracking-wider">
                    Resource Forecast & Confidence Bands
                  </h3>
                  <PredictionChart
                    data={predictions}
                    nowTimestamp={getNowTimestamp()}
                    metricLabel={selectedMetric === 'active_sessions' ? 'Active Sessions' : 'Percent Load'}
                  />
                </div>

                {/* Risk Trend Chart */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-brand-text-primary uppercase tracking-wider">
                    Anomaly Risk Score Trend
                  </h3>
                  <RiskTrendChart data={riskData} />
                  <div className="p-3 bg-gray-50 border border-brand-border rounded-md text-xs text-brand-text-secondary space-y-1">
                    <p className="font-bold text-brand-text-primary text-sm">Risk Assessment Mode</p>
                    <p>Risk Score indexes the anomaly score combining CPU spikes, disk queue length, and lock contentions. An index above 70 indicates impending degradation hazards.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'rca' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-brand-text-primary">System Anomaly Diagnostics Log</h3>
            
            {loadingRca ? (
              <div className="flex justify-center items-center h-80">
                <Spinner label="Correlating anomaly patterns..." />
              </div>
            ) : rcaLogs.length === 0 ? (
              <div className="text-center py-20 text-brand-text-secondary">
                No system anomalies detected. Everything looks healthy!
              </div>
            ) : (
              <div className="space-y-4">
                {rcaLogs.map((log) => (
                  <div
                    key={log.id}
                    className="p-4 bg-white border border-brand-border rounded-card shadow-card flex gap-4 items-start hover:shadow-md transition-shadow"
                  >
                    <div className="flex-shrink-0">
                      {getSeverityIcon(log.severity)}
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-sm text-brand-text-primary">
                          Anomaly: {log.affected_metric}
                        </span>
                        <Badge color={getSeverityBadgeColor(log.severity)}>{log.severity}</Badge>
                        <span className="text-xs text-brand-text-secondary">
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm text-brand-text-secondary leading-normal">
                        {log.summary}
                      </p>
                      <div className="pt-2">
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Diagnostic Advisory</MessageBarTitle>
                            Automated mitigation advised. Check active SQL statements during CPU spikes to isolate lock contention.
                          </MessageBarBody>
                        </MessageBar>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
