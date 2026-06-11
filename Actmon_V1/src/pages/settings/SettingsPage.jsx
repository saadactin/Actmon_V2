import React from 'react';
import { Card, Field, Select, Checkbox, Button } from '@fluentui/react-components';
import { Settings, Save, ShieldAlert, Sliders, Database } from 'lucide-react';
import { useToast } from '../../components/ui/ToastProvider';

export const SettingsPage = () => {
  const { addToast } = useToast();

  const handleSave = () => {
    addToast('Configuration settings persisted successfully.', 'success');
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-brand-text-primary flex items-center gap-2">
          <Settings className="h-6 w-6 text-brand-primary" />
          <span>System Settings</span>
        </h1>
        <p className="text-sm text-brand-text-secondary">
          Configure global database collection thresholds, system preferences, and user experience options.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Section 1: Dashboard Preferences */}
        <Card className="p-6 border border-brand-border bg-white shadow-card rounded-card space-y-4">
          <h3 className="text-sm font-bold text-brand-text-primary flex items-center gap-2 border-b border-brand-border pb-2">
            <Sliders className="h-4 w-4 text-brand-primary" />
            <span>Dashboard & UI Controls</span>
          </h3>

          <div className="space-y-4">
            <Field label="Default Refresh Interval" hint="Automatic polling refresh rate for real-time widgets.">
              <Select defaultValue="30">
                <option value="15">15 Seconds (Aggressive)</option>
                <option value="30">30 Seconds (Default)</option>
                <option value="60">60 Seconds (Balanced)</option>
                <option value="300">5 Minutes (Telemetry)</option>
              </Select>
            </Field>

            <Field label="System Alert Sound level" hint="Play audible audio tone on Critical DB alerts.">
              <Select defaultValue="normal">
                <option value="mute">Muted</option>
                <option value="quiet">Low volume</option>
                <option value="normal">Normal volume (Default)</option>
              </Select>
            </Field>

            <div className="flex flex-col gap-2 pt-2">
              <Checkbox defaultChecked label="Enable Real-Time Toast Notifications" />
              <Checkbox defaultChecked label="Enable High-Contrast Charts for Accessibility" />
            </div>
          </div>
        </Card>

        {/* Section 2: Data Collectors */}
        <Card className="p-6 border border-brand-border bg-white shadow-card rounded-card space-y-4">
          <h3 className="text-sm font-bold text-brand-text-primary flex items-center gap-2 border-b border-brand-border pb-2">
            <Database className="h-4 w-4 text-brand-primary" />
            <span>Telemetry & Agent Collectors</span>
          </h3>

          <div className="space-y-4">
            <Field label="Audit Log Retention" hint="Retain system audit and monitoring logs locally.">
              <Select defaultValue="90">
                <option value="30">30 Days</option>
                <option value="90">90 Days (Recommended)</option>
                <option value="180">180 Days (Compliance)</option>
                <option value="365">1 Year</option>
              </Select>
            </Field>

            <div className="flex flex-col gap-2 pt-2">
              <Checkbox defaultChecked label="Enable Automatic Discovery Scanning" />
              <Checkbox label="Send Anonymous Performance Telemetry" />
              <Checkbox defaultChecked label="Enforce SSL Verification on DB Agents" />
            </div>
          </div>
        </Card>
      </div>

      {/* About Box */}
      <Card className="p-6 border border-brand-border bg-[#FAF9F8] rounded-card space-y-4">
        <h3 className="text-sm font-bold text-brand-text-primary flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-brand-primary" />
          <span>Platform Version Information</span>
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <span className="block text-brand-text-secondary uppercase">Product Version</span>
            <span className="font-semibold text-brand-text-primary">ActMon Enterprise v2026.1</span>
          </div>
          <div>
            <span className="block text-brand-text-secondary uppercase">Active Environment</span>
            <span className="font-semibold text-brand-text-primary text-brand-success">Production Gateway</span>
          </div>
          <div>
            <span className="block text-brand-text-secondary uppercase">API Server Endpoint</span>
            <span className="font-mono text-brand-text-primary">http://192.168.8.100:8000</span>
          </div>
          <div>
            <span className="block text-brand-text-secondary uppercase">System Local Time</span>
            <span className="font-semibold text-brand-text-primary">
              {new Date().toLocaleDateString()}
            </span>
          </div>
        </div>
      </Card>

      {/* Bottom Save Action */}
      <div className="flex justify-end pt-4 border-t border-brand-border">
        <Button appearance="primary" icon={<Save className="h-4 w-4" />} onClick={handleSave}>
          Save Settings
        </Button>
      </div>
    </div>
  );
};
