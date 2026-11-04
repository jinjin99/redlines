#!/usr/bin/env node
// redlines <tool> --<input> <value> …: the same tools as the MCP server (src/tools.js), with the same
// names and inputs. Arrays and objects are given as JSON (--steps '[{"click":"text=Save"}]'), a
// boolean as a bare flag (--fullPage). `redlines mcp` serves them over stdio instead.
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { PROMPTS, type Tool, TOOLS } from '../src/tools.js';

// zod's own description of a schema: unwrapped past optional and refinements to the kind of value it takes.
const kindOf = (schema: z.ZodTypeAny): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- _def is zod's internal description.
    let s: any = schema;
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
    for (const p of PROMPTS) lines.push(`  prompt ${p.name} ${Object.keys(p.args).map(k => `--${k} <${k}>`).join(' ')}`, `      ${p.description} Prints the steps for an agent.`, '');
    lines.push('  serve [<folder>] [--port <port>]', '      Serve a built prototype (build_prototype; default .redlines/prototype) on localhost until Ctrl-C, to click through it before uploading it.', '');
    lines.push('  mcp', '      Serve these tools over stdio for coding agents: claude mcp add redlines -- npx -y github:jinjin99/redlines mcp');
    return lines.join('\n');
}

/** --name value pairs, typed by the tool's inputs. */
function parse(tool: Tool, argv: string[]): Record<string, unknown> {
    const args: Record<string, unknown> = {};
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
                else throw new Error(`--${name} is JSON: ${(e as Error).message}`, { cause: e });
            }
        } else args[name] = raw;
    }
    return z.object(tool.input).strict().parse(args);
}

async function main() {
    const [command, ...argv] = process.argv.slice(2);
    // The data proxy's own process (data_proxy start runs it in the background).
    if (command === '__data_proxy') {
        const { runProxy } = await import('../src/proxy.js');
        const [mode, file, port] = argv;
        if ((mode !== 'record' && mode !== 'replay') || !file || !Number(port)) throw new Error('__data_proxy <record|replay> <file> <port>');
        await runProxy({ root: process.cwd(), mode, file, port: Number(port) });
        return;
    }
    if (command === 'mcp') {
        const { serveStdio } = await import('../src/mcp.js');
        await serveStdio();
        return;
    }
    if (command === 'prompt') {
        const prompt = PROMPTS.find(p => p.name === argv[0]);
        if (!prompt) throw new Error(`prompt ${PROMPTS.map(p => p.name).join(' | ')}`);
        const args = parse({ name: `prompt ${prompt.name}`, input: prompt.args } as Tool, argv.slice(1)) as Record<string, string>;
        console.log(prompt.text(args));
        return;
    }
    if (command === 'serve') {
        const { serveFolder } = await import('../src/prototype.js');
        const { inProject } = await import('../src/tools.js');
        const root = process.env.REDLINES_ROOT ? path.resolve(process.env.REDLINES_ROOT) : process.cwd();
        const at = argv.indexOf('--port');
        const port = at >= 0 ? Number(argv[at + 1]) : 8790;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port is a number from 1024 to 65535');
        const dir = inProject(root, argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port'), '.redlines/prototype');
        const ids = fs.existsSync(path.join(dir, 'p')) ? fs.readdirSync(path.join(dir, 'p')) : [];
        if (!ids.length) throw new Error(`No prototype in ${dir}: build_prototype first`);
        const served = await serveFolder(dir, port);
        console.log(`${ids.map(id => `${served.url}/p/${id}/`).join('\n')}\n(Ctrl-C to stop)`);
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
        throw new Error(e instanceof z.ZodError ? e.issues.map(i => `--${i.path.join('.') || '?'}: ${i.message}`).join('; ') : (e as Error).message, { cause: e });
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
