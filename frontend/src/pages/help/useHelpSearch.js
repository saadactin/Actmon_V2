import { useMemo } from 'react';
import { DOCS } from './content';

const textOf = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent.replace(/\s+/g, ' ').trim();
};

/**
 * One shared search index, built once per mount rather than once per
 * component — every consumer (home hero search, header search, the full
 * search-results page) queries the SAME index instead of each re-parsing
 * every article body into plain text on its own. Indexes title, dek
 * (description), module, and the plain-text body — matching what a real
 * documentation search should cover (requirement: title/heading/content/
 * module, not just the title).
 */
export function useHelpSearchIndex() {
  return useMemo(() => Object.keys(DOCS).map((id) => {
    const d = DOCS[id];
    const group = d.crumbs && d.crumbs.length > 1 ? d.crumbs[1] : 'Documentation';
    const text = `${d.title} ${d.dek || ''} ${d.module || ''} ${textOf(d.body)}`.toLowerCase();
    return { id, title: d.title, dek: d.dek || '', group, module: d.module || group, text };
  }), []);
}

export function searchDocs(index, query, limit = Infinity) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  return index
    .filter((r) => terms.every((t) => r.text.includes(t)))
    .slice(0, limit);
}
