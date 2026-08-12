/**
 * Field configuration for the 9 notification channels — one generic panel
 * (NotificationChannelPanel.jsx) renders all of them from this data, the same
 * "config drives a shared component" approach used for the Administration
 * module's resource pages. Keys here must match the backend's
 * channel_config_service.SECRET_FIELDS / CHANNEL_TYPES exactly.
 */
export const CHANNEL_ORDER = [
  'email', 'teams', 'slack', 'telegram', 'whatsapp',
  'webhook', 'pagerduty', 'jira', 'servicenow',
];

export const CHANNEL_DEFS = {
  email: {
    label: 'Email',
    icon: 'mail',
    note: 'Sends through the SMTP server configured above. Who receives each alert is set per alert rule (Notify via → Email) — there is no shared default inbox here.',
    configFields: [
      { key: 'subject_template', label: 'Subject Template', type: 'text', placeholder: '[{{Severity}}] {{AlertName}} on {{ServerName}}' },
    ],
    secretFields: [],
  },
  teams: {
    label: 'Microsoft Teams',
    icon: 'bot',
    configFields: [
      { key: 'default_channel', label: 'Default Channel', type: 'text', placeholder: '#server-alerts' },
    ],
    secretFields: [
      { key: 'webhook_url', label: 'Incoming Webhook URL', placeholder: 'https://outlook.office.com/webhook/...' },
    ],
  },
  slack: {
    label: 'Slack',
    icon: 'send',
    configFields: [
      { key: 'channel', label: 'Channel', type: 'text', placeholder: '#alerts' },
      { key: 'username', label: 'Bot Username', type: 'text', placeholder: 'ActMon' },
      { key: 'icon', label: 'Icon (emoji or URL)', type: 'text', placeholder: ':rotating_light:' },
    ],
    secretFields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/...' },
    ],
  },
  telegram: {
    label: 'Telegram',
    icon: 'send',
    configFields: [
      { key: 'chat_ids', label: 'Chat ID(s)', type: 'list', placeholder: '-100123456789, 987654321', hint: 'Comma-separated — supports multiple chats.' },
    ],
    secretFields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: '123456789:AAExampleTokenValue' },
    ],
  },
  whatsapp: {
    label: 'WhatsApp Business Cloud API',
    icon: 'phone',
    configFields: [
      { key: 'phone_number_id', label: 'Phone Number ID', type: 'text' },
      { key: 'business_account_id', label: 'Business Account ID', type: 'text' },
      { key: 'api_version', label: 'API Version', type: 'text', placeholder: 'v20.0' },
      { key: 'default_recipient', label: 'Default Recipient', type: 'text', placeholder: '+91XXXXXXXXXX' },
    ],
    secretFields: [
      { key: 'access_token', label: 'Access Token' },
    ],
  },
  webhook: {
    label: 'Generic Webhook',
    icon: 'link',
    configFields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com/hooks/actmon' },
      { key: 'method', label: 'Method', type: 'select', options: [{ id: 'POST', label: 'POST' }, { id: 'PUT', label: 'PUT' }] },
      { key: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"X-Api-Key": "..."}' },
      { key: 'auth_type', label: 'Authentication', type: 'select', options: [{ id: 'none', label: 'None' }, { id: 'basic', label: 'Basic' }, { id: 'bearer', label: 'Bearer' }] },
      { key: 'basic_username', label: 'Basic Auth Username', type: 'text', showIf: (c) => c.auth_type === 'basic' },
    ],
    secretFields: [
      { key: 'basic_password', label: 'Basic Auth Password', showIf: (c) => c.auth_type === 'basic' },
      { key: 'auth_token', label: 'Bearer Token', showIf: (c) => c.auth_type === 'bearer' },
    ],
  },
  pagerduty: {
    label: 'PagerDuty',
    icon: 'alert',
    configFields: [],
    secretFields: [
      { key: 'integration_key', label: 'Integration Key' },
    ],
  },
  jira: {
    label: 'Jira Service Management',
    icon: 'route',
    configFields: [
      { key: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://yourcompany.atlassian.net' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'project', label: 'Project Key', type: 'text', placeholder: 'OPS' },
      { key: 'issue_type', label: 'Issue Type', type: 'text', placeholder: 'Incident' },
    ],
    secretFields: [
      { key: 'api_token', label: 'API Token' },
    ],
  },
  servicenow: {
    label: 'ServiceNow',
    icon: 'settings2',
    configFields: [
      { key: 'instance_url', label: 'Instance URL', type: 'text', placeholder: 'https://yourinstance.service-now.com' },
      { key: 'username', label: 'Username', type: 'text' },
    ],
    secretFields: [
      { key: 'password', label: 'Password / API Token' },
    ],
  },
};

export const SEVERITIES = [
  { id: 'critical', label: 'Critical', tone: 'danger' },
  { id: 'warning', label: 'Warning', tone: 'warning' },
  { id: 'information', label: 'Information', tone: 'info' },
];
