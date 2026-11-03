// redlines as a library: shoot states, compare page trees, write the review page.
export { snapshot } from './page/snapshot.js';
export { align, diffTrees, formatChanges, tokensOf } from './diff.js';
export { exportStates } from './export.js';
export { compareFolders, writeReport } from './report.js';
export { loadConfig, shoot } from './shoot.js';
export { createServer } from './mcp.js';
export { outline } from './outline.js';
