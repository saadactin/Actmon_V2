// Shared tab-label <-> URL-slug mapping for the "Add Data" catalog
// (AgentSetupPage.jsx + ComingSoonSetup.jsx both need it: AgentSetupPage to
// route tab switches to a real URL, ComingSoonSetup to turn that same URL
// segment back into a human label and a "back to this tab" link).
export const TAB_SLUGS = {
  Intro: 'intro',
  'Digital Experience': 'digital-experience',
  APM: 'apm',
  Databases: 'databases',
  Infrastructure: 'infrastructure',
  Network: 'network',
  Logs: 'logs',
  Integrations: 'integrations',
};

export const SLUG_TO_TAB = Object.fromEntries(Object.entries(TAB_SLUGS).map(([label, slug]) => [slug, label]));
