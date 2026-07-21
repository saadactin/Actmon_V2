import React from 'react';
import { TechLogo } from './logos';
import { LangLogo } from './langIcons';
import { InfraLogo } from './infraIcons';
import { DeployIcon } from './deploy/deployIcons';

const Box = ({ size, children }) => (
  <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>{children}</span>
);
const Mono = ({ size, text, color, fs = 0.5 }) => (
  <Box size={size}><span style={{ color, fontWeight: 900, fontSize: Math.round(size * fs) }}>{text}</span></Box>
);

// Integration catalog marks. Reuses existing DB/lang/infra/deploy logos where possible.
export function IntegLogo({ id, size = 48 }) {
  const s = size;
  switch (id) {
    // ── reused real logos ──
    case 'mysql': return <TechLogo id="mysql" size={size} />;
    case 'postgresql': return <TechLogo id="postgresql" size={size} />;
    case 'mongodb': return <TechLogo id="mongodb" size={size} />;
    case 'oracle': return <TechLogo id="oracle" size={size} />;
    case 'sqlserver': return <TechLogo id="mssql" size={size} />;
    case 'phpfpm': return <LangLogo id="php" size={size} />;
    case 'docker': return <Box size={size}><DeployIcon id="docker" size={Math.round(size * 0.7)} /></Box>;
    case 'otlp': return <InfraLogo id="otel" size={size} />;
    case 'iis': return <InfraLogo id="hyperv" size={size} />;

    // ── drawn marks ──
    case 'apache':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M17 4c-5 1-9 6-11 15 3-1 5-4 7-7s3-6 4-8Z" fill="#D22128" /><path d="M9 19c1-4 4-8 8-11" stroke="#68302A" strokeWidth="1.4" /></svg></Box>;
    case 'confluent':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#0074A2" strokeWidth="2" fill="none" /><g stroke="#0074A2" strokeWidth="1.6" strokeLinecap="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></g><circle cx="12" cy="12" r="2.4" fill="#0074A2" /></svg></Box>;
    case 'dnsquery':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><g stroke="#1B3A6B" strokeWidth="1.6"><path d="M12 6v5M12 11 7 16M12 11l5 5" /></g><g fill="#FFC400" stroke="#1B3A6B" strokeWidth="1.4"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /></g></svg></Box>;
    case 'elasticsearch':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 6h16v4H4z" fill="#F9B110" /><path d="M4 11h13v4H4z" fill="#24BBB1" /><path d="M4 16h16v4H4z" fill="#3A9BDC" /></svg></Box>;
    case 'exec':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="#1E3A5F" /><path d="M7 10l3 2-3 2M12 15h5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></Box>;
    case 'fluentd':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 14c4-6 12-8 16-8-2 6-8 10-14 10-1 0-2-1-2-2Z" fill="#0E83C8" /><circle cx="16" cy="8" r="1.2" fill="#fff" /></svg></Box>;
    case 'haproxy':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="#3C8DBC"><g>{[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => <circle key={`${r}${c}`} cx={5 + c * 3.5} cy={5 + r * 3.5} r="1.2" />))}</g></svg></Box>;
    case 'kafka':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="#231F20"><circle cx="8" cy="6" r="2.2" /><circle cx="8" cy="18" r="2.2" /><circle cx="16" cy="12" r="2.6" /><g stroke="#231F20" strokeWidth="1.4"><path d="M9.6 7 14 11M9.6 17 14 13" /></g></svg></Box>;
    case 'memcached': return <Mono size={size} text="m" color="#303030" fs={0.62} />;
    case 'nginx':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="#009639" /><text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff">N</text></svg></Box>;
    case 'nginxplus':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="#009639" /><text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">N+</text></svg></Box>;
    case 'ntpq':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#5B6B7B" strokeWidth="2" fill="none" /><path d="M12 7v5l3 2" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" /></svg></Box>;
    case 'prometheus':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 3c2 3-1 4 0 6 1 2 4 2 4 6a4 4 0 1 1-8 0c0-4 3-4 4-12Z" fill="#E6522C" /><rect x="7" y="17" width="10" height="2.4" rx="1.2" fill="#E6522C" /></svg></Box>;
    case 'rabbitmq':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="#FF6600"><path d="M5 5h4v7h3V5h4v14H5z" /></svg></Box>;
    case 'redis':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><g fill="#D82C20"><ellipse cx="12" cy="7" rx="9" ry="3.2" /><path d="M3 7v4c0 1.8 4 3.2 9 3.2s9-1.4 9-3.2V7" /><path d="M3 12v4c0 1.8 4 3.2 9 3.2s9-1.4 9-3.2v-4" opacity=".85" /></g></svg></Box>;
    case 'snowflake':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" stroke="#29B5E8" strokeWidth="1.6" strokeLinecap="round"><path d="M12 3v18M4 7l16 10M20 7 4 17" /></svg></Box>;
    case 'statsd':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M6 8 4 4l4 2M18 8l2-4-4 2" stroke="#6B7280" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="13" r="7" fill="#9CA3AF" /><g fill="#374151"><circle cx="9.5" cy="12" r="1.2" /><circle cx="14.5" cy="12" r="1.2" /></g></svg></Box>;
    case 'varnish':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="#00A0DE"><circle cx="8" cy="9" r="2.4" /><circle cx="15" cy="7" r="1.8" /><circle cx="9" cy="16" r="1.8" /><circle cx="16" cy="15" r="2.4" /></svg></Box>;
    case 'zookeeper': return <Mono size={size} text="ZK" color="#25A162" fs={0.38} />;
    default: return <Box size={size} />;
  }
}

export default IntegLogo;
