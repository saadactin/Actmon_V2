/**
 * Shared React Query cache keys for endpoints multiple pages/hooks fetch
 * independently.
 *
 * `GET /os-servers/`, `/os-servers/summary`, and `/agents/` were previously
 * cached under 3-4 DIFFERENT keys across the Dashboard, Infra, Databases,
 * Agents, and agent-setup-wizard pages (`['dash','servers']` vs
 * `['osServers','infra']` vs `['osServers']` vs `['osServers', envFilter]`,
 * etc.) — so navigating between them refetched the same data instead of
 * sharing one cache entry. Using the same key for the same (unfiltered)
 * request lets React Query dedupe in-flight requests and serve a warm cache
 * on repeat visits within `staleTime`, instead of every page treating it as
 * a brand new query.
 *
 * `osServers(filter)` still returns a DISTINCT key per filter value — a
 * filtered list is genuinely different data, not the same request under a
 * different name — only the unfiltered ("give me everything") case converges
 * on one shared key across every caller.
 */
export const QK = {
  osServers: (filter) => (filter && filter !== 'All' ? ['os-servers', filter] : ['os-servers']),
  osServersSummary: ['os-servers', 'summary'],
  agents: ['agents'],
};
