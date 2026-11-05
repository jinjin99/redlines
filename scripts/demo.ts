// npm run demo: the fixture app's two versions served side by side, captured, compared, reviewed and
// exported into .redlines/demo. What a project does with its main branch and its change.
import path from 'node:path';

import { formatChanges } from '../src/diff.js';
import { exportDesign } from '../src/export.js';
import { findChanges, writeReport } from '../src/report.js';
import { captureStates, loadConfig } from '../src/capture.js';
import { PACKAGE_ROOT } from '../src/package.js';
import { FIXTURES, serve } from '../test/helpers.js';

const out = path.join(PACKAGE_ROOT, '.redlines/demo');
const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
for (const side of ['before', 'after'] as const) {
    const server = await serve(path.join(FIXTURES, side));
    console.log(`capturing ${side} (${server.base})`);
    try { await captureStates({ config, base: server.base, out: path.join(out, side), log: m => console.log(`  ${m}`) }); } finally { server.close(); }
}
const states = findChanges(path.join(out, 'before'), path.join(out, 'after'));
for (const s of states) if (s.changes.length) console.log(`\n### ${s.title}\n${formatChanges(s.changes)}`);
const report = writeReport(states, path.join(out, 'review'), { title: 'Orders: refunds' });
const { files } = await exportDesign(path.join(out, 'after'), path.join(out, 'design'), { format: 'dc', title: 'Orders (after)' });
console.log(`\nreview page: ${report}\nClaude Design canvas: ${path.join(out, 'design')} (${files.length} files)`);

