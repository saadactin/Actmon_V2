import cn from '@/lib/cn';
import { APP } from '@/config/app.config';

/**
 * ActMon's product mark — the ACTIN spiral. Path data is exact, taken from the
 * brand's own source SVG, not redrawn — only the background rect from that
 * source was dropped (a white canvas backdrop for previewing it standalone),
 * so the mark sits transparent on whatever surface it's placed on.
 *
 * `VITE_APP_LOGO` overrides it with a real asset, same escape hatch as the
 * rest of the app's branding.
 */
export default function LogoMark({ size = 48, className, title = APP.name }) {
  const asset = APP.logoUrl;

  return (
    <span className={cn('inline-grid shrink-0 place-items-center', className)} style={{ width: size, height: size }}>
      {asset ? (
        <img src={asset} alt={title} width={size} height={size} className="h-full w-full object-contain" />
      ) : (
        <svg viewBox="0 0 500 500" className="h-full w-full" role="img" aria-label={title}>
          <g fill="#0c23a0">
            <path d="M 50,50 H 450 V 380 H 410 V 90 H 90 V 170 H 50 Z" />
            <path d="M 50,210 H 90 V 410 H 410 V 450 H 50 Z" />
            <path d="M 140,170 H 330 V 370 H 290 V 210 H 180 V 370 H 270 V 330 H 140 Z" />
          </g>
          <rect x="210" y="250" width="40" height="40" fill="#14b8a6" />
        </svg>
      )}
    </span>
  );
}
