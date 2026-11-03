// npm run demo: the fixture app's two versions served side by side, shot, compared, reported and
// exported into .redlines/demo. What a project does with its main branch and its change.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatChanges } from '../src/diff.js';
import { exportDesign } from '../src/export.js';
import { findChanges, writeReport } from '../src/report.js';
import { captureStates, loadConfig } from '../src/capture.js';
import { FIXTURES, serve } from '../test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, '.redlines/demo');
const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
for (const side of ['before', 'after']) {
    const server = await serve(path.join(FIXTURES, side));
    console.log(`shooting ${side} (${server.base})`);
    try { await captureStates({ config, base: server.base, out: path.join(out, side), log: m => console.log(`  ${m}`) }); } finally { server.close(); }
}
const states = findChanges(path.join(out, 'before'), path.join(out, 'after'));
for (const s of states) if (s.changes.length) console.log(`\n### ${s.title}\n${formatChanges(s.changes)}`);
const report = writeReport(states, path.join(out, 'report'), { title: 'Orders: refunds' });
const { files } = exportDesign(path.join(out, 'after'), path.join(out, 'design'), { format: 'dc', title: 'Orders (after)' });
console.log(`\nreview page: ${report}\nClaude Design canvas: ${path.join(out, 'design')} (${files.length} files)`);

