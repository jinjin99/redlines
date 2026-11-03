#!/usr/bin/env node
// redlines <tool> --<input> <value> …: the same tools as the MCP server (src/tools.js), with the same
// names and inputs. Arrays and objects are given as JSON (--steps '[{"click":"text=Save"}]'), a
// boolean as a bare flag (--fullPage). `redlines mcp` serves them over stdio instead.
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { TOOLS } from '../src/tools.js';

const kindOf = schema => {
    let s = schema;
    while (s?._def && ['ZodOptional', 'ZodDefault', 'ZodEffects', 'ZodNullable'].includes(s._def.typeName)) s = s._def.innerType ?? s._def.schema;
    return s?._def?.typeName;
};

function help() {
    const lines = ['redlines — see what a UI change does, state by state', '', 'redlines <tool> [--<input> <value> …]', ''];
    for (const t of TOOLS) {
        const inputs = Object.entries(t.input).map(([k, s]) => {
            const kind = kindOf(s), optional = s.isOptional();
            const value = kind === 'ZodBoolean' ? '' : kind === 'ZodArray' || kind === 'ZodRecord' || kind === 'ZodObject' ? ' <json>' : ` <${k}>`;
            return optional ? `[--${k}${value}]` : `--${k}${value}`;
        });
        lines.push(`  ${t.name} ${inputs.join(' ')}`, `      ${t.description}`, '');
    }
    lines.push('  mcp', '      Serve these tools over stdio for coding agents: claude mcp add redlines -- npx redlines mcp');
    return lines.join('\n');
}

/** --name value pairs, typed by the tool's inputs. */
function parse(tool, argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`Unexpected "${a}": inputs are --<name> <value>`);
        const name = a.slice(2);
        const schema = tool.input[name];
        if (!schema) throw new Error(`${tool.name} has no input --${name}; it takes ${Object.keys(tool.input).map(k => `--${k}`).join(', ')}`);
        const kind = kindOf(schema);
        if (kind === 'ZodBoolean') { args[name] = true; continue; }
        const raw = argv[++i];
        if (raw === undefined) throw new Error(`--${name} needs a value`);
        if (kind === 'ZodNumber') args[name] = Number(raw);
        else if (kind === 'ZodArray' || kind === 'ZodRecord' || kind === 'ZodObject') {
            try { args[name] = JSON.parse(raw); } catch (e) {
                // A list of plain words can be given comma-separated (--states list,details).
                if (kind === 'ZodArray' && /^[\w,-]+$/.test(raw)) args[name] = raw.split(',');
                else throw new Error(`--${name} is JSON: ${e.message}`);
            }
        } else args[name] = raw;
    }
    return z.object(tool.input).strict().parse(args);
}

async function main() {
    const [command, ...argv] = process.argv.slice(2);
    if (command === 'mcp') {
        const { serveStdio } = await import('../src/mcp.js');
        await serveStdio();
        return;
    }
    const tool = TOOLS.find(t => t.name === command);
    if (!tool) {
        console.log(help());
        if (command && !['help', '--help', '-h'].includes(command)) { console.error(`\nredlines: no tool "${command}"`); process.exitCode = 1; }
        return;
    }
    const root = process.env.REDLINES_ROOT ? path.resolve(process.env.REDLINES_ROOT) : process.cwd();
    let args;
    try { args = parse(tool, argv); } catch (e) {
        throw new Error(e instanceof z.ZodError ? e.issues.map(i => `--${i.path.join('.') || '?'}: ${i.message}`).join('; ') : e.message);
    }
    const r = await tool.run(args, { root, log: m => console.error(m) });
    if (r.image) {
        // The screenshot an agent gets inline over MCP, as a file here.
        const file = path.join(root, '.redlines', `${tool.name}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, r.image);
        console.log(`screenshot: ${file}`);
    }
    console.log(r.text);
    if (r.isError) process.exitCode = 1;
}

main().catch(error => {
    console.error(`redlines: ${error.message}`);
    process.exitCode = 1;
});
