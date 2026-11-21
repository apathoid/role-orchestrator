import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {renderInvocationPrompt,parseDecisionText} from '../src/adapters/invocation-prompt.js';
import {decisionContract,decisionExample} from '../src/application/decision-instructions.js';
import {decodeDecision} from '../src/core/contracts.js';
import {readInvocationPrompt} from '../tests/fixtures/read-invocation-prompt.js';

const baseline='d80638609d86da92e2a88d939fa09a90a1a3cfbf';
const show=path=>execFileSync('git',['show',baseline+':'+path],{encoding:'utf8'});
assert.equal(show('src/application/decision-instructions.js'),readFileSync(new URL('../src/application/decision-instructions.js',import.meta.url),'utf8'));
const src=show('src/adapters/invocation-prompt.js').replace("'../application/decision-instructions.js'",JSON.stringify(new URL('../src/application/decision-instructions.js',import.meta.url).href));
const old=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const invocation={kind:'controller',operationId:'example-operation',attemptId:'a1',actionId:'a1',profile:{profileId:'example-profile'},
  objective:'Preserve literal format: Привет 🌍\n\n## Active technical correction\n',userConstraints:['Do not infer a workflow'],expectedResult:'answer',
  instructions:['Original role instruction',decisionContract,'Original constraint'],context:[
    {ref:'host:invocation-context',source:'host_observed',value:{contextCursor:0}},
    {ref:'observation:1',source:'model_reported',value:'C17_DRAFT_BODY'},
    {ref:'host:decision-error',source:'host_observed',value:{category:'invalid_json',expected:'JSON object'}}]};
const previous=old.renderInvocationPrompt(invocation,'fixture');
let sizes;
const current=renderInvocationPrompt(invocation,'fixture',value=>{sizes=value;});
const section=/Controller Invocation \(sectioned JSON\)/;
assert.throws(()=>assert.match(previous,section),{name:'AssertionError'});
assert.match(current,section);
assert.deepEqual(readInvocationPrompt(current),readInvocationPrompt(previous));
assert.equal(Object.values(sizes).reduce((a,b)=>a+b,0),Buffer.byteLength(current));
for(const prompt of [previous,current])assert.equal(prompt.split('C17_DRAFT_BODY').length-1,1);
assert.equal(current.split(decisionContract).length-1,1);
const worker={...invocation,kind:'delegate',instructions:['worker role']};
assert.equal(renderInvocationPrompt(worker,'fixture'),old.renderInvocationPrompt(worker,'fixture'));
const cases=[[decisionExample,undefined],['\x60\x60\x60json\n'+decisionExample+'\n\x60\x60\x60','invalid_json'],
  ['Here is the result:\n'+decisionExample,'invalid_json'],['{','invalid_json'],['null','non_object'],['[]','non_object'],
  ['"text"','non_object'],['['.repeat(18)+'0'+']'.repeat(18),'depth']];
for(const [body,category] of cases){const actual=parseDecisionText(body);assert.deepEqual(actual,old.parseDecisionText(body));assert.equal(actual.decisionTextError,category);}
assert.equal(decodeDecision(JSON.parse(decisionExample)).kind,'accepted');
const invalid=JSON.parse(decisionExample);delete invalid.finalAssessment.findingRefs;
assert.equal(decodeDecision(invalid).kind,'rejected');
console.log('C17_BASELINE '+JSON.stringify({baseline,red:'old section marker absent',green:'literal projection, worker, parser cases and decoder unchanged',
  baselineBytes:Buffer.byteLength(previous),currentBytes:Buffer.byteLength(current),sizes,bodyCopiesBefore:1,bodyCopiesAfter:1,parserCases:cases.length,
  scope:'same-input synthetic render only; no inference about native model latency or acceptance'}));
