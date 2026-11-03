// redlines as an MCP server (stdio), made from the tool list (src/tools.js). Nothing is written to
// stdout but the protocol.
import fs from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { INSTRUCTIONS, TOOLS } from './tools.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createServer({ root = process.env.REDLINES_ROOT ? path.resolve(process.env.REDLINES_ROOT) : process.cwd() } = {}) {
    const server = new McpServer({ name: 'redlines', version: VERSION }, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
        server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, async args => {
            try {
                const r = await tool.run(args, { root });
                return { content: [...(r.image ? [{ type: 'image', data: r.image.toString('base64'), mimeType: 'image/png' }] : []), { type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
            } catch (e) {
                return { content: [{ type: 'text', text: `redlines: ${e.message}` }], isError: true };
            }
        });
    }
    return server;
}

export async function serveStdio() {
    await createServer().connect(new StdioServerTransport());
}
