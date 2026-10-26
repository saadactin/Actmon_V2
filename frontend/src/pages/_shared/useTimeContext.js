import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Time context handed between resource pages via the URL (?range=<minutes>&bucket=<seconds>&at=<epoch ms>), e.g. the
 * Infrastructure overview opening CPU / Memory / Disk Consumption "at this point". Unknown or unsupported values fall
 * back to the page's own defaults — the URL can never select a range or interval the backend does not serve.
 */
export function useTimeContext(ranges, defaultIdx = 2, defaultBucket = 60) {
  const [sp] = useSearchParams();
  const ri = ranges.findIndex((r) => r.minutes === Number(sp.get('range')));
  const idx = ri >= 0 ? ri : defaultIdx;
  const b = Number(sp.get('bucket'));
  const allowed = ranges[idx].buckets;
  const bucket = sp.has('bucket') && allowed.includes(b) ? b : (allowed.includes(defaultBucket) ? defaultBucket : allowed[0]);
  const at = Number(sp.get('at')) || null;
  return { idx, bucket, at };
}

/** Once the chart points arrive, select the stored point nearest `at` (only if one lies within `maxGapMs`). */
export function useSelectAt(at, points, setSelected, maxGapMs) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !at || !points?.length) return;
    done.current = true;
    const p = points.reduce((best, x) => (!best || Math.abs(x.t - at) < Math.abs(best.t - at) ? x : best), null);
    if (p && Math.abs(p.t - at) <= maxGapMs) setSelected(p);
  }, [at, points, setSelected, maxGapMs]);
}
