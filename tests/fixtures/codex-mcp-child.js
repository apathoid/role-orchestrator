import assert from 'node:assert/strict';
import { retrieveContext } from './mcp-client.js';

const urlArg = process.argv.find(value => value.startsWith('mcp_servers.role_orchestrator.url='));
const url = JSON.parse(urlArg.split('=')[1]);
assert.ok(process.argv.includes('mcp_servers.role_orchestrator.required=true'));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
assert.match(prompt, /Optional MCP context_list and context_fetch/);
const separator = '\n\nInvocation (JSON):\n';
const invocation = JSON.parse(prompt.slice(prompt.indexOf(separator) + separator.length));
const decision = await retrieveContext(url, invocation);
for (const event of [
  { type: 'thread.started', thread_id: 'mcp-fixture' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', id: 'decision', text: JSON.stringify(decision) } },
  { type: 'turn.completed', usage: {} },
]) process.stdout.write(JSON.stringify(event) + '\n');
