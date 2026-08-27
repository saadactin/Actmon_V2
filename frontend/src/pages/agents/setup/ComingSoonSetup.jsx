import React from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ArrowLeft, Construction } from 'lucide-react';
import WizardShell from './components/WizardShell';
import { SLUG_TO_TAB } from './tabSlugs';

/**
 * Real destination for every "Add Data" catalog item that doesn't have a working
 * setup wizard yet — one page, ONE route pattern (`/agents/setup/:tabSlug/:itemId`)
 * shared across every tab (APM languages, most Network devices, most
 * Infrastructure resource types, Digital Experience's not-yet-built checks, all
 * Integrations). Previously these rendered as inert cards (no `to`, or for
 * Integrations not even a <button>) — clicking did nothing, silently. This gives
 * every one of them a real, individually-governed route instead, honest that the
 * integration itself isn't built yet rather than pretending it is.
 *
 * tabSlug comes straight from AgentSetupPage's own TAB_SLUGS map, so "back to
 * this tab" always lands on the real routed tab page, not a guess.
 */
export default function ComingSoonSetup() {
  const { tabSlug, itemId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const itemName = location.state?.itemName || itemId;
  const tabLabel = SLUG_TO_TAB[tabSlug] || tabSlug;
  const backTo = `/agents/setup/${tabSlug}`;

  return (
    <WizardShell
      title="Add Data"
      onClose={() => navigate(backTo)}
      aside={(
        <>
          <div className="flex justify-center pt-2">
            <div className="w-20 h-20 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center">
              <Construction size={38} />
            </div>
          </div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">{itemName}</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">
            This {tabLabel} integration isn't built yet — you're seeing this because the catalog card is real and
            routed, not a dead link.
          </p>
        </>
      )}
    >
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-10">
        <p className="text-slate-700 font-black text-lg">{itemName} — Coming Soon</p>
        <p className="text-slate-400 mt-2 max-w-sm">
          This integration is on the roadmap but not available yet. Check back later, or reach out if you need it prioritized.
        </p>
        <button
          onClick={() => navigate(backTo)}
          className="mt-6 h-10 px-6 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50 flex items-center gap-2"
        >
          <ArrowLeft size={15} /> Back to {tabLabel}
        </button>
      </div>
    </WizardShell>
  );
}
