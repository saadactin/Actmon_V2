import { providerKeyOf } from '../utils/providerScope';

/**
 * Provider brand marks, inline as SVG.
 *
 * Inline rather than image files on purpose: no network fetch, no missing-asset
 * flash, they inherit size from a prop and stay crisp at any zoom. The tiles
 * previously used emoji (🟠 🔵 🔴), which looked like placeholders because they
 * were.
 *
 * These are clean brand-coloured renditions drawn from each provider's mark, not
 * the official trademark files. To swap in the official assets, drop them in
 * `public/logos/{aws,azure,oci}.svg` and replace the matching `MARKS` entry with
 * `<img src="/logos/aws.svg" .../>` — nothing else needs to change, since every
 * caller goes through this component.
 */

const AwsMark = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Amazon Web Services">
    {/* wordmark bar */}
    <rect x="6" y="13" width="36" height="9" rx="2" fill="#232F3E" />
    <text
      x="24" y="20.4" textAnchor="middle"
      fontSize="8.5" fontWeight="700" fill="#FFFFFF"
      fontFamily="Arial, Helvetica, sans-serif" letterSpacing="0.5"
    >
      aws
    </text>
    {/* the smile */}
    <path
      d="M7 28c5.6 4.6 12.2 6.9 19.6 6.9 4.9 0 10.2-1 15.4-3.1.9-.4 1.6.6.8 1.2-4.7 3.5-11.4 5.4-17.2 5.4-8.1 0-15.4-3-21-8-.6-.5-.1-1.3.4-1.4z"
      fill="#FF9900"
    />
    <path
      d="M35.6 26.4c-.7-.9.4-1.3 1.9-1.4 1.6-.1 3.5.1 4.4.9.9.9.4 3.5-.7 5.4-.3.6-1 .4-.9-.3.3-1.7.6-3.6.1-4.1-.6-.6-2.7-.4-4.8-.5z"
      fill="#FF9900"
    />
  </svg>
);

const AzureMark = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Microsoft Azure">
    <defs>
      <linearGradient id="actmon-az-a" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor="#3CCBF4" />
        <stop offset="1" stopColor="#0078D4" />
      </linearGradient>
      <linearGradient id="actmon-az-b" x1="0.2" y1="0" x2="0.9" y2="1">
        <stop offset="0" stopColor="#0078D4" />
        <stop offset="1" stopColor="#005BA1" />
      </linearGradient>
    </defs>
    {/* left wing */}
    <path d="M17.8 6h9.4l-9.6 28.4L4 40.5 17.8 6z" fill="url(#actmon-az-a)" />
    {/* right body */}
    <path d="M28.4 6h8.4L44 40.5H17.1l4-8.6h13.3L28.4 6z" fill="url(#actmon-az-b)" />
  </svg>
);

const OciMark = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Oracle Cloud Infrastructure">
    {/* Oracle's mark is the wordmark inside its red rounded ring. */}
    <rect
      x="4.5" y="15.5" width="39" height="17" rx="8.5"
      fill="none" stroke="#C74634" strokeWidth="4"
    />
    <text
      x="24" y="27.6" textAnchor="middle"
      fontSize="8" fontWeight="700" fill="#C74634"
      fontFamily="Arial, Helvetica, sans-serif" letterSpacing="0.3"
    >
      ORACLE
    </text>
  </svg>
);

const MARKS = { AWS: AwsMark, Azure: AzureMark, OCI: OciMark };

/** Brand accent per provider, for callers that need a matching colour. */
export const PROVIDER_COLOR = { AWS: '#FF9900', Azure: '#0078D4', OCI: '#C74634' };

/**
 * `provider` accepts a canonical key (AWS/Azure/OCI), the raw API value
 * ("Oracle"), or a route slug ("aws"). Unknown providers render nothing rather
 * than a broken box.
 */
export default function ProviderLogo({ provider, size = 24, className }) {
  const raw = String(provider || '');
  const key =
    providerKeyOf(raw) in MARKS
      ? providerKeyOf(raw)
      : { aws: 'AWS', azure: 'Azure', oci: 'OCI', oracle: 'OCI' }[raw.toLowerCase()];

  const Mark = MARKS[key];
  if (!Mark) return null;
  return (
    <span className={className} style={{ display: 'inline-flex', lineHeight: 0 }}>
      <Mark size={size} />
    </span>
  );
}
