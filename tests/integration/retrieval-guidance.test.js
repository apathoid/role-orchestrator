import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerInstructions } from '../../src/application/controller-context.js';
import { retrievalDetail } from '../../src/adapters/mcp-bridge.js';

test('C12R.8 optional history inspection remains a Controller choice rather than a mandatory workflow', () => {
  const instructions = controllerInstructions.join('\n');
  assert.match(instructions, /Decide whether additional retrieval is necessary/);
  assert.match(instructions, /do not enumerate history by default/);
  assert.doesNotMatch(instructions, /page through metadata/i);
  // A separate model-owned summary is not elevated to a tool observation.
  assert.match(instructions, /model summary lists covered observation references and remains a separate model claim/);
});

test('C12R.8 MCP advice advertises optional retrieval without disabling the tools or hiding missing evidence', () => {
  const enabled = retrievalDetail(true);
  assert.match(enabled, /context_list and context_fetch optionally provide/);
  assert.match(enabled, /Decide whether retrieval helps this task/);
  assert.match(enabled, /material unavailable evidence/);
  assert.doesNotMatch(enabled, /Use MCP tools context_list and context_fetch/);
  const disabled = retrievalDetail(false);
  assert.match(disabled, /unavailable in this transport/);
  assert.match(disabled, /material missing evidence when relevant/);
});
