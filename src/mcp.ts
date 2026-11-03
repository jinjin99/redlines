// redlines as an MCP server (stdio), made from the tool list (src/tools.js). Nothing is written to
// stdout but the protocol.
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { VERSION } from './package.js';
import { INSTRUCTIONS, PROMPTS, TOOLS } from './tools.js';

export function createServer({ root = process.env.REDLINES_ROOT ? path.resolve(process.env.REDLINES_ROOT) : process.cwd() } = {}) {
    const server = new McpServer({ name: 'redlines', version: VERSION }, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
        server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, async args => {
            try {
                const r = await tool.run(args, { root });
                return {
                    content: [...(r.image ? [{ type: 'image' as const, data: r.image.toString('base64'), mimeType: 'image/png' }] : []), { type: 'text' as const, text: r.text }],
                    ...(r.isError ? { isError: true } : {}),
                };
            } catch (e) {
                return { content: [{ type: 'text' as const, text: `redlines: ${(e as Error).message}` }], isError: true };
            }
        });
    }
    for (const prompt of PROMPTS) {
        server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema: prompt.args }, args => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text(args as Record<string, string | undefined>) } }],
        }));
    }
    return server;
}

export async function serveStdio() {
    await createServer().connect(new StdioServerTransport());
}
