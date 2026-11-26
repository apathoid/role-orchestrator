import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeControllerIntent } from '../../src/core/controller-intent.js';
import { materializeControllerIntent } from '../../src/application/controller-intent.js';
import { decodeDecision } from '../../src/core/contracts.js';

const binding = { operationId: 'op-18', attemptId: 'attempt-18', contextCursor: 7, profileId: 'controller-profile' };
const simple = answer => ({finalAssessment: {overall: 'complete', answer}});
const field = (value, path) => {
  assert.equal(value.kind, 'rejected');
  assert.equal(value.reason.path, path);
};

test('C18.1 minimal model-owned intent preserves unicode, Markdown and trust binding', () => {
  const answer = '# Готово 🎯\n\n{"answer":true}';
  const decoded = decodeControllerIntent(simple(answer));
  assert.equal(decoded.kind, 'accepted');
  assert.deepEqual(decoded.value.additions, []);
  assert.deepEqual(decoded.value.cancellations, []);
  assert.deepEqual(decoded.value.finalAssessment.requirements, []);
  assert.deepEqual(decoded.value.finalAssessment.observationRefs, []);
  assert.deepEqual(decoded.value.finalAssessment.findingRefs, []);
  assert.deepEqual(decoded.value.finalAssessment.unresolvedQuestions, []);
  assert.ok(!Object.hasOwn(decoded.value.finalAssessment, 'author'));
  const a = materializeControllerIntent(simple(answer), binding);
  const b = materializeControllerIntent(simple(answer), binding);
  assert.equal(a.kind, 'accepted');
  assert.deepEqual(a, b);
  assert.equal(decodeDecision(a.value).kind, 'accepted');
  assert.equal(a.value.operationId, binding.operationId);
  assert.equal(a.value.contextCursor, 7);
  assert.equal(a.value.finalAssessment.author, binding.profileId);
  assert.equal(a.value.finalAssessment.answer, answer);
  assert.notEqual(materializeControllerIntent(simple(answer + '!'), binding).value.decisionId, a.value.decisionId);
  assert.notEqual(materializeControllerIntent(simple(answer), {...binding,attemptId:'other'}).value.decisionId, a.value.decisionId);
});

test('C18.1 preserves full Decision v1 model combinations and nested references', () => {
  const action = {
    actionId: 'a1', kind: 'delegate', objective: 'Review 🧭', expectedResult: 'Report', profileId: 'worker',
    skills: ['skill'], requiredCapabilities: ['input.text'], roleId: 'reviewer',
    reasoningLevel: 'high', continuationReference: 'ctx', retryOf: 'old-attempt', retryBasis: 'no_effect',
    dependsOn: [{actionId:'prior',kind:'after_model_acceptance'}],
  };
  const input = {
    additions:[action], cancellations:['old-action'], acceptedActionIds:['prior'],
    waitPolicy:{kind:'next_completion',targets:[{kind:'action',id:'a1'}]},
    findings:[{findingId:'f1',claim:'Found',subject:'module',supersedes:'finding:before'}],
  };
  const output = materializeControllerIntent(input,binding);
  assert.equal(output.kind, 'accepted');
  assert.deepEqual(output.value.additions[0].dependsOn, action.dependsOn);
  assert.deepEqual(output.value.additions[0].contextRefs, []);
  assert.deepEqual(output.value.findings[0].supports, []);
  assert.equal(output.value.findings[0].author, binding.profileId);
  const follow = materializeControllerIntent({
    nextController:{continue:true,reasoningLevel:'high',
      contextRequest:{refs:[{ref:{revision:3,index:2},offset:4}],cursor:{revision:4,index:5},workCursor:0}},
    findings: [{findingId:'f2',claim:'Needs evidence',subject:'test',supports:['evidence:1'],uncertainties:['uncertain']}],
  },binding);
  assert.equal(follow.kind,'accepted');
  assert.equal(follow.value.nextController.contextRequest.cursor.revision,4);
  const partial=materializeControllerIntent({
    finalAssessment:{overall:'partial', answer:'Partly done',
      requirements:[{requirementId:'r1',status:'unverified',reason:'Missing observed check'}],
      unresolvedQuestions:['Did the check run?']},
  },binding);
  assert.equal(partial.kind,'accepted');
  assert.deepEqual(partial.value.finalAssessment.requirements[0].findingRefs,[]);
});

test('C18.1 rejects Host fields, unknowns, nulls and canonical semantic conflicts addressably', () => {
  field(decodeControllerIntent({...simple('text'),schemaVersion:1}),'$.schemaVersion');
  field(decodeControllerIntent({...simple('text'),operationId:'spoof'}),'$.operationId');
  field(decodeControllerIntent({...simple('text'),unexpected:true}),'$.unexpected');
  field(decodeControllerIntent({finalAssessment:{...simple('x').finalAssessment,author:'spoof'}}),'$.finalAssessment.author');
  field(decodeControllerIntent({findings:[{findingId:'f',claim:'x',subject:'y',author:'spoof'}],
    nextController:{continue:true}}),'$.findings[0].author');
  field(decodeControllerIntent({...simple('x'),cancellations:null}),'$.cancellations');
  field(decodeControllerIntent({finalAssessment:{overall:'complete',answer:'ok',
    requirements:[{requirementId:'r',status:'fulfilled',findingRefs:null}]}}),
  '$.finalAssessment.requirements[0].findingRefs');
  field(decodeControllerIntent({finalAssessment:{overall:'complete',answer:'done'},
    additions:[{actionId:'a',kind:'delegate',profileId:'x',objective:'y',expectedResult:'z'}]}),
  '$.finalAssessment');
  field(decodeControllerIntent({additions:[{actionId:'a',kind:'delegate',profileId:'x',
    objective:'y',expectedResult:'z',retryBasis:'no_effect'}],
    nextController:{continue:true}}),'$.additions[0].retryOf');
});

test('C18.1 large fully valid model Assessment is not truncated in decoding/materialization', () => {
  const text = 'Δ🧩'.repeat(28_000);
  const result = materializeControllerIntent(simple(text),binding);
  assert.equal(result.kind,'accepted');
  assert.equal(result.value.finalAssessment.answer,text);
});

test('C22 F1 lists actual external fields without altering the stable cause or canonical normalization', () => {
  const root = decodeControllerIntent({...simple('x'),unknown:true});
  assert.equal(root.kind,'rejected');
  assert.equal(root.reason.expected,'a model-owned ControllerIntent field (Host-owned metadata must be omitted)');
  assert.deepEqual(root.reason.allowedFields,['additions','cancellations','acceptedActionIds','waitPolicy',
    'clarification','nextController','finalAssessment','findings']);
  const nested = {...simple('x'),finalAssessment:{...simple('x').finalAssessment,unknown:true}};
  const decoded = decodeControllerIntent(nested);
  assert.equal(decoded.kind,'rejected');
  assert.equal(decoded.reason.path,'$.finalAssessment.unknown');
  assert.equal(decoded.reason.expected,'a supported field');
  assert.deepEqual(decoded.reason.allowedFields,['overall','requirements','observationRefs','findingRefs','unresolvedQuestions','answer']);
  const valid = materializeControllerIntent(simple('x'),binding);
  assert.equal(valid.kind,'accepted');
  const legacy = decodeDecision({...valid.value,finalAssessment:{...valid.value.finalAssessment,unknown:true}});
  assert.equal(legacy.kind,'rejected');
  assert.deepEqual(legacy.reason.allowedFields,['author',...decoded.reason.allowedFields]);
  assert.equal(materializeControllerIntent(nested,binding).kind,'rejected');
  const requirement = decodeControllerIntent({finalAssessment:{overall:'partial',answer:'x',
    requirements:[{requirementId:'r',status:'unverified',name:'bad'}]}});
  assert.equal(requirement.kind,'rejected');
  assert.deepEqual(requirement.reason.allowedFields,['requirementId','status','observationRefs','findingRefs','reason']);
  const finding = decodeControllerIntent({nextController:{continue:true},
    findings:[{findingId:'f',claim:'x',subject:'y',unknown:true}]});
  assert.equal(finding.kind,'rejected');
  assert.deepEqual(finding.reason.allowedFields,['findingId','claim','subject','supports','uncertainties','supersedes']);
  const position = decodeControllerIntent({nextController:{continue:true,contextRequest:{refs:[{revision:1,index:0,unknown:1}]}}});
  assert.equal(position.kind,'rejected');
  assert.deepEqual(position.reason.allowedFields,['revision','index']);
  const wrongType = decodeControllerIntent({finalAssessment:{overall:'bad',answer:'x'}});
  assert.equal(wrongType.kind,'rejected');
  assert.equal(wrongType.reason.expected,'complete | partial | unresolved');
  assert.equal(wrongType.reason.allowedFields,undefined);
  assert.deepEqual(materializeControllerIntent(simple('x'),binding),valid);
});

test('C22-R context selections and cursors retain old primary causes and normalized forms in Intent and legacy Decision',()=>{
  const prefix='$.nextController.contextRequest';
  const intent=request=>({nextController:{continue:true,contextRequest:request}});
  const canonical=materializeControllerIntent(intent({refs:['existing']}),binding).value;
  const decoders=[
    request=>decodeControllerIntent(intent(request)),
    request=>decodeDecision({...canonical,...intent(request)}),
    request=>materializeControllerIntent(intent(request),binding),
  ];
  const pos={revision:10,index:2};
  const valid=[
    {refs:['ref']}, {refs:[pos]}, {refs:[{ref:'ref',offset:0}]},
    {refs:[{ref:pos,offset:3}]}, {cursor:0}, {cursor:17}, {cursor:pos},
    {workCursor:0}, {workCursor:17}, {workCursor:pos},
  ];
  for(const request of valid){
    const [external,legacy,bound]=decoders.map(decode=>decode(request));
    for(const decoded of [external,legacy,bound]){
      assert.equal(decoded.kind,'accepted');
      assert.deepEqual(JSON.parse(JSON.stringify(decoded.value.nextController.contextRequest)),request);
    }
    assert.deepEqual(bound.value.nextController,legacy.value.nextController);
  }
  const reference=/non-empty reference string or an object \{revision, index\}/;
  const selection=/\{ref, offset\}/;
  const cursor=/use 0.*\{revision, index\}.*legacy Decisions.*not valid retrieval cursors/;
  for(const decode of decoders){
    for(const invalid of [false,null,[],1,undefined]){
      const rejected=decode({refs:[invalid]});
      assert.equal(rejected.kind,'rejected');
      assert.equal(rejected.reason.path,prefix+'.refs[0]');
      assert.equal(rejected.reason.expected,'an object');
      assert.match(rejected.reason.hint,reference);
      assert.match(rejected.reason.hint,selection);
      const nested=decode({refs:[{ref:invalid,offset:0}]});
      assert.equal(nested.kind,'rejected');
      assert.equal(nested.reason.path,prefix+'.refs[0].ref');
      assert.equal(nested.reason.expected,'an object');
      assert.match(nested.reason.hint,reference);
      assert.doesNotMatch(nested.reason.hint,selection);
    }
    for(const key of ['cursor','workCursor']){
      for(const invalid of [false,null,[], '0']){
        const result=decode({[key]:invalid});
        assert.equal(result.kind,'rejected');
        assert.equal(result.reason.path,prefix+'.'+key);
        assert.equal(result.reason.expected,'an object');
        assert.match(result.reason.hint,cursor);
      }
      const negative=decode({[key]:-1});
      assert.deepEqual(negative.reason,{code:'INVALID_PROPOSAL',path:prefix+'.'+key,expected:'a non-negative safe integer'});
    }
    for(const [request,path,expected,allowedFields] of [
      [{refs:['']},'.refs[0]','a non-empty string'],
      [{refs:[{ref:'',offset:0}]},'.refs[0].ref','a non-empty string'],
      [{refs:[{revision:-1,index:0}]},'.refs[0].revision','a non-negative safe integer'],
      [{refs:[{ref:{revision:1,index:-1},offset:0}]},'.refs[0].ref.index','a non-negative safe integer'],
      [{refs:[{ref:'r',offset:-1}]},'.refs[0].offset','a non-negative safe integer'],
      [{refs:[{revision:1,index:0,bad:true}]},'.refs[0].bad','a supported field',['revision','index']],
      [{refs:[{ref:'r',offset:0,bad:true}]},'.refs[0].bad','a supported field',['ref','offset']],
      [{cursor:{revision:1,index:-1}},'.cursor.index','a non-negative safe integer'],
    ]){
      const result=decode(request);
      assert.equal(result.kind,'rejected');
      assert.deepEqual(result.reason,{code:'INVALID_PROPOSAL',path:prefix+path,expected,...(allowedFields&&{allowedFields})});
    }
  }
});
