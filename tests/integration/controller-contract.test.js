import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionContract, decisionExample } from '../../src/application/decision-instructions.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { parseDecisionText, renderInvocationPrompt } from '../../src/adapters/invocation-prompt.js';
import { setup, final } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

test('C12R.10 shared Decision example decodes and admits with actual invocation ids', async () => {
  const shape=JSON.parse(decisionExample);
  assert.equal(decodeDecision(shape).kind,'accepted');
  const answer='# Heading\nПривет 🧪\n{"nested":true}';
  const {api}=setup({respond(invocation) {
    assert.equal(invocation.instructions.filter(x=>x===decisionContract).length,1);
    const host=invocation.context.find(x=>x.ref==='host:invocation-context').value;
    const prompt=renderInvocationPrompt(invocation,'fixture');
    const payload=JSON.parse(prompt.split('\n\nInvocation (JSON):\n')[1]);
    assert.equal(payload.instructions.filter(x=>x===decisionContract).length,1);
    assert.ok(!prompt.includes('cursor?: number'));
    const output={...shape,operationId:invocation.operationId,contextCursor:host.contextCursor,
      finalAssessment:{...shape.finalAssessment,author:invocation.profile.profileId,answer}};
    return {...final(invocation),output};
  }});
  try {
    const state=await (await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    assert.equal(state.assessment.answer,answer);
    assert.deepEqual(state.assessment.requirements[0].findingRefs,[]);
  } finally { await api.close(); }
});

test('C12R.10 text parse distinguishes malformed, non-object and bounded depth without repair',()=>{
  for (const raw of ['{', 'not JSON', '```json\n{}\n```']) {
    assert.deepEqual(parseDecisionText(raw),{output:raw,decisionTextError:'invalid_json'});
  }
  for (const raw of ['null','false','42','"text"','[]']) {
    assert.deepEqual(parseDecisionText(raw),{output:JSON.parse(raw),decisionTextError:'non_object'});
  }
  const deep='{"x":'.repeat(17)+'0'+'}'.repeat(17);
  assert.deepEqual(parseDecisionText(deep),{output:deep,decisionTextError:'depth'});
  assert.deepEqual(parseDecisionText(decisionExample),{output:JSON.parse(decisionExample)});
  assert.equal(decodeDecision(parseDecisionText('{"assessment":{}}').output).kind,'rejected');
});
