import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerInstructions } from '../../src/application/controller-context.js';
import { retrievalDetail } from '../../src/adapters/mcp-bridge.js';

test('C12R.8 optional history inspection remains a Controller choice rather than a mandatory workflow', () => {
  const instructions = controllerInstructions.join('\n');
  assert.match(instructions, /choose whether to use historical list\/fetch/);
  assert.match(instructions, /do not enumerate history by default/);
  assert.doesNotMatch(instructions, /page through metadata/i);
  // A separate model-owned summary is not elevated to a tool observation.
  assert.match(instructions, /Model summaries are separate claims citing covered observation references/);
});

test('C12R.8 MCP advice advertises optional retrieval without disabling the tools or hiding missing evidence', () => {
  const enabled = retrievalDetail(true);
  assert.match(enabled, /Optional MCP context_list and context_fetch/);
  assert.match(enabled, /when useful/);
  assert.match(enabled, /material unavailable evidence/);
  assert.doesNotMatch(enabled, /Use MCP tools context_list and context_fetch/);
  const disabled = retrievalDetail(false);
  assert.match(disabled, /unavailable in this transport/);
  assert.match(disabled, /material missing evidence when relevant/);
});
