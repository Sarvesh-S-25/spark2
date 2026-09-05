import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { db } from '../db/db.js';
import { registerReadTools } from './tools-read.js';
import { registerWriteTools } from './tools-write.js';
import { registerResources } from './resources.js';

/**
 * SparkX's MCP server — so Claude Code, Codex or any MCP client can ask
 * "what can I start now?", read the contract graph, and run the checker.
 *
 * Every tool calls the *same* core functions `server/api.ts` calls
 * (`deriveAll`, `runCheck`, `runSplit`, `generate`, ...) — no logic is
 * reimplemented here. Talks stdio, so it needs no port and works with any
 * client that can spawn a process.
 */

db(); // open and migrate before the first tool call, same as the HTTP server

const server = new McpServer({ name: 'sparkx', version: '0.1.0' });

registerReadTools(server);
registerWriteTools(server);
registerResources(server);

await server.connect(new StdioServerTransport());
