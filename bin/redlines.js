#!/usr/bin/env node
// redlines <command>: see README.md.
import fs from 'node:fs';
import path from 'node:path';

import { diffTrees, formatChanges } from '../src/diff.js';
import { compareFolders, writeReport } from '../src/report.js';
import { loadConfig, shoot } from '../src/shoot.js';

const HELP = `redlines — see what a UI change does, state by state

  redlines shoot --out <dir> [--base <url>] [--config <file>] [state…]
      open each state the config lists and save its page tree and screenshot
  redlines diff <before> <after> [--json]
      the changes between two shots (folders from shoot, or two tree .json files)
  redlines report <before> <after> --out <dir> [--title <text>]
      a review page: before and after side by side, each change boxed and numbered
`;

const [command, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { args.push(a); continue; }
    const name = a.slice(2);
    if (name === 'json') flags.json = true;
    else flags[name] = rest[++i];
}

async function main() {
    switch (command) {
        case 'shoot': {
            if (!flags.out) throw new Error('shoot needs --out <dir>');
            const config = await loadConfig(flags.config);
            const results = await shoot({ config, base: flags.base, out: path.resolve(flags.out), only: args });
            if (results.some(r => !r.ok)) process.exitCode = 1;
            return;
        }
        case 'diff': {
            if (args.length !== 2) throw new Error('diff <before> <after>');
            if (args.every(a => a.endsWith('.json') && fs.statSync(a).isFile())) {
                const list = diffTrees(...args.map(a => JSON.parse(fs.readFileSync(a, 'utf8'))));
                console.log(flags.json ? JSON.stringify(list, null, 2) : formatChanges(list));
                return;
            }
            const states = compareFolders(...args);
            if (flags.json) { console.log(JSON.stringify(states.map(({ name, title, status, changes }) => ({ name, title, status, changes })), null, 2)); return; }
            for (const s of states) {
                if (s.status === 'same') continue;
                console.log(`### ${s.title} (${s.name})\n${s.status === 'changed' ? formatChanges(s.changes) : s.status === 'added' ? 'a new state' : 'removed'}\n`);
            }
            const same = states.filter(s => s.status === 'same').map(s => s.name);
            if (same.length) console.log(`no changes: ${same.join(', ')}`);
            return;
        }
        case 'report': {
            if (args.length !== 2 || !flags.out) throw new Error('report <before> <after> --out <dir>');
            const states = compareFolders(...args);
            const file = writeReport(states, path.resolve(flags.out), { title: flags.title });
            const total = states.reduce((n, s) => n + s.changes.length, 0);
            console.log(`${file}: ${total} change${total === 1 ? '' : 's'} in ${states.filter(s => s.status !== 'same').length} of ${states.length} states`);
            return;
        }
        default:
            console.log(HELP);
            if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(`redlines: ${error.message}`);
    process.exitCode = 1;
});
