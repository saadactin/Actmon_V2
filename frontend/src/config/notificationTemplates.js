/**
 * Standard subject/body starting points for the template wizard
 * (NotificationTemplateWizard.jsx). Email gets HTML presets since it's the
 * only channel that renders markup; every other channel is a plain-text
 * message, so they share one plain preset. All of these use the same 14
 * {{Variable}} placeholders template_service.py substitutes server-side.
 */
export const TEMPLATE_VARIABLES = [
  'Organization', 'AlertName', 'Severity', 'ServerName', 'Hostname',
  'DatabaseName', 'DatabaseType', 'Metric', 'CurrentValue', 'Threshold',
  'Error', 'IPAddress', 'Timestamp', 'AlertDescription',
];

export const SUBJECT_PRESETS = [
  { id: 'bracket-severity', label: 'Bracket severity', value: '[{{Severity}}] {{AlertName}} — {{ServerName}}' },
  { id: 'org-prefixed', label: 'Organization prefixed', value: '{{Organization}} Alert: {{AlertName}} on {{ServerName}}' },
  { id: 'flagged', label: 'Flagged', value: '🚨 {{Severity}} — {{AlertName}} ({{ServerName}})' },
  { id: 'minimal', label: 'Minimal', value: '{{AlertName}}: {{Metric}} {{CurrentValue}} (threshold {{Threshold}})' },
];

const PLAIN_BODY = (
  'Alert: {{AlertName}}\n'
  + 'Severity: {{Severity}}\n'
  + 'Organization: {{Organization}}\n'
  + 'Server: {{ServerName}} ({{Hostname}})\n'
  + 'Database: {{DatabaseName}} [{{DatabaseType}}]\n'
  + 'Metric: {{Metric}} — current value {{CurrentValue}}, threshold {{Threshold}}\n'
  + 'IP Address: {{IPAddress}}\n'
  + 'Time: {{Timestamp}}\n\n'
  + '{{AlertDescription}}\n'
  + '{{Error}}'
);

const SIMPLE_HTML_BODY = (
  '<p><b>Alert:</b> {{AlertName}}<br>'
  + '<b>Severity:</b> {{Severity}}<br>'
  + '<b>Organization:</b> {{Organization}}<br>'
  + '<b>Server:</b> {{ServerName}} ({{Hostname}})<br>'
  + '<b>Database:</b> {{DatabaseName}} [{{DatabaseType}}]<br>'
  + '<b>Metric:</b> {{Metric}} — current value {{CurrentValue}}, threshold {{Threshold}}<br>'
  + '<b>IP Address:</b> {{IPAddress}}<br>'
  + '<b>Time:</b> {{Timestamp}}</p>'
  + '<p>{{AlertDescription}}</p>'
  + '<p style="color:#a02128">{{Error}}</p>'
);

const ROW = (label, value) => (
  `<tr><td style="padding:6px 10px;font-weight:bold;background:#f4f4f4;border:1px solid #e2e2e2;width:170px">${label}</td>`
  + `<td style="padding:6px 10px;border:1px solid #e2e2e2">${value}</td></tr>`
);

const TABLE_HTML_BODY = (
  '<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px">'
  + ROW('Alert', '{{AlertName}}')
  + ROW('Severity', '{{Severity}}')
  + ROW('Organization', '{{Organization}}')
  + ROW('Server', '{{ServerName}} ({{Hostname}})')
  + ROW('Database', '{{DatabaseName}} [{{DatabaseType}}]')
  + ROW('Metric', '{{Metric}}')
  + ROW('Current Value', '{{CurrentValue}}')
  + ROW('Threshold', '{{Threshold}}')
  + ROW('IP Address', '{{IPAddress}}')
  + ROW('Time', '{{Timestamp}}')
  + '</table>'
  + '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px">{{AlertDescription}}</p>'
  + '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#a02128">{{Error}}</p>'
);

const CARD_HTML_BODY = (
  '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;border:1px solid #e2e2e2;border-radius:8px;overflow:hidden">'
  + '<div style="background:#1f2937;color:#fff;padding:12px 16px;font-size:15px;font-weight:bold">{{Severity}} · {{AlertName}}</div>'
  + '<div style="padding:14px 16px;font-size:13px;color:#1f2937">'
  + '<p style="margin:0 0 8px">{{AlertDescription}}</p>'
  + '<p style="margin:0"><b>Server:</b> {{ServerName}} ({{Hostname}})</p>'
  + '<p style="margin:0"><b>Metric:</b> {{Metric}} — {{CurrentValue}} (threshold {{Threshold}})</p>'
  + '<p style="margin:0"><b>Organization:</b> {{Organization}} &nbsp;·&nbsp; <b>Time:</b> {{Timestamp}}</p>'
  + '<p style="margin:8px 0 0;color:#a02128">{{Error}}</p>'
  + '</div></div>'
);

export const EMAIL_BODY_PRESETS = [
  { id: 'simple', label: 'Simple text', desc: 'A short paragraph — fastest to scan, works everywhere.', value: SIMPLE_HTML_BODY },
  { id: 'table', label: 'Detailed table', desc: 'Every field as a table row — clearest when forwarded into a ticket.', value: TABLE_HTML_BODY },
  { id: 'card', label: 'Compact card', desc: 'A boxed summary card with a severity header band.', value: CARD_HTML_BODY },
];

export const TEXT_BODY_PRESETS = [
  { id: 'simple', label: 'Standard text', desc: 'Plain key: value lines — this channel sends text only, no HTML.', value: PLAIN_BODY },
];

export function bodyPresetsFor(channelType) {
  return channelType === 'email' ? EMAIL_BODY_PRESETS : TEXT_BODY_PRESETS;
}
