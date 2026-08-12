import { useParams } from 'react-router-dom';
import useAgents from '@/hooks/useAgents';
import HostAgentPage from './HostAgentPage';
import DatabaseAgentPage from './DatabaseAgentPage';

/**
 * Which detail view an agent gets.
 *
 * Same rule as the existing module: an agent with no linked DB connection is a
 * HOST agent and gets the agent-monitoring view; one with a connection gets the
 * database dashboard.
 *
 * The decision needs the agent's metadata, which only the list endpoint returns,
 * so this reuses useAgents() — the SAME hook the list page uses, not a second,
 * independently-configured useQuery on the same key. That used to be two
 * definitions of one query: this page's copy polled never (no refetchInterval)
 * while the list page's polled every TIMING.refreshSeconds, so an agent that
 * flipped status while someone had arrived here directly (a bookmark, a deep
 * link) would show stale metadata until they navigated away and back. One
 * definition now, so there is nothing left to drift.
 */
export default function AgentDetailPage() {
  const { name = '' } = useParams();
  const { agents, isLoading } = useAgents();

  const meta = agents.find((a) => a.name === name);

  // While the list loads, render the host view: it fetches its own data and shows
  // its own spinner, and it's the right answer for most agents. Flashing a
  // placeholder first would be worse than being briefly optimistic.
  if (isLoading || !meta || !meta.has_connection) {
    return <HostAgentPage name={name} hasConnection={Boolean(meta?.has_connection)} />;
  }

  return <DatabaseAgentPage name={name} meta={meta} />;
}
