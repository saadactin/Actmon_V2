/**
 * Shared MySQL health-score formula — used by both the Dashboard and the
 * Reports page so the two never diverge (previously each computed its own,
 * different score). `longRunningCount` is the ACTIVE long-running-query
 * count; historical report periods that don't have this data pass 0, which
 * simply drops that term's penalty rather than fabricating a count.
 */
export function computeHealthScore(longRunningCount, connPct, cachePct) {
  let score = 100;
  if (connPct > 90) score -= 30;
  else if (connPct > 70) score -= 15;
  if (cachePct < 80) score -= 20;
  else if (cachePct < 90) score -= 10;
  if (longRunningCount > 5) score -= 15;
  else if (longRunningCount > 0) score -= 5;
  return Math.max(0, score);
}
