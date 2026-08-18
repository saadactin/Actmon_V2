/**
 * Content merge layer — combines the original core chapters (Getting
 * Started, Dashboard, Agents, generic Database, all in ../helpContent.js)
 * with every new chapter added in this directory. Every new chapter file
 * populates the SAME shared `DOCS` object by importing it from
 * ../helpContent — importing each chapter file here (for its import-time
 * side effect on DOCS) is what actually pulls its content into the app.
 *
 * Why chapters live in separate files instead of growing the original
 * 2600-line helpContent.js further: the original 4 chapters are verified,
 * stable content — splitting new chapters into their own files means adding
 * chapter N+1 later never risks a merge conflict or an accidental edit
 * inside chapter N's already-reviewed HTML.
 *
 * Navigation (sidebar, breadcrumbs, home/landing card grids, prev/next) is
 * NOT built here — it all comes from `./tree`, the single hierarchical
 * source of truth. This file's only job for navigation is to import every
 * chapter BEFORE re-exporting from tree.js, since tree.js's `leaf()` calls
 * read `DOCS[id].title/dek` at module-evaluation time and need those
 * chapters' DOCS[...] assignments to have already run.
 */
import {
  DOCS, MODULES, icon, ORC_HUES, GS_TOPICS, GS_BLURBS,
} from '../helpContent';

import './postgresqlHA';
import './cloud';
import './infrastructure';
import './alerts';
import './aiAssistant';
import './administration';
import './settings';
import { TROUBLESHOOTING_TOPICS } from './troubleshooting';
import { CERT_TOPICS } from './certification';

export { TREE, findNode, pathTo, docIdFor, isLanding, leafCount, flattenLeaves } from './tree';

export { DOCS, MODULES, icon, ORC_HUES, GS_TOPICS, GS_BLURBS };
export { TROUBLESHOOTING_TOPICS, CERT_TOPICS };
