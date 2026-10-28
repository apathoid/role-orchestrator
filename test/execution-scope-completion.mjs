import assert from 'node:assert/strict';
import { assessFixDecision, classifyFixFinding, fixInterruptionReport } from '../src/fix-decision.mjs';
const ext = { severity:'major',path:'src/production.ts',message:'Existing handler is broken',
  origin:'pre_existing',taskRelation:'independent',remediationScope:'outside_scope',
  evidence:'Commit before test task demonstrates broken production callback.',reproductionKey:'old',contractId:'callback' };
const testGap = { severity:'major',path:'test/production.test.ts',message:'Missing negative case',
  origin:'pre_existing',taskRelation:'requirement',remediationScope:'in_scope',
  evidence:'Required negative case has no assertion in existing test file.',reproductionKey:'missing',contractId:'tests' };
const introduced = { ...testGap,path:'src/new.ts',origin:'introduced',reproductionKey:'new',message:'New failure' };
const final = issues=>({verdict:'fix',issues,assessment:{taskCompliance:'verified',fixAuthorization:'requires_approval',correctness:'defect_confirmed'}});
const review = issues=>({verdict:'fix',issues});
const decision = (issues, disposition='PASS', reviewer={verdict:'pass',issues:[]})=>assessFixDecision({
  review:reviewer,finalValidation:final(issues),verificationDisposition:disposition});
assert.equal(classifyFixFinding(ext).classification,'pre_existing_out_of_scope');

assert.equal(classifyFixFinding({...ext,origin:'introduced'}).classification,'insufficient_evidence',
  'an introduced bug cannot simultaneously authorize an outside-scope repair');

assert.equal(decision([ext]).action,'report_only','an independent preexisting defect must not block a valid test task');
assert.equal(decision([ext],'PASS',review([ext])).action,'report_only');
assert.equal(decision([ext],'CODE_FAILURE').action,'approval_required','failing verification is not success');
assert.equal(decision([testGap]).action,'fix');
assert.equal(decision([introduced]).action,'fix');
assert.deepEqual(decision([ext,testGap]).findings,[testGap],'fixer must never see outside-scope repairs as authorized');
assert.equal(decision([ext,testGap]).outOfScopeFindings.length,1);
const mixed = decision([ext,testGap]);
assert.match(fixInterruptionReport({status:'implementation_blocked',decision:mixed,review:review([testGap]),
  verificationDisposition:'PASS',changedPaths:[],verification:[]}),/Non-blocking out-of-scope findings/);
assert.equal(decision([ext,{...ext}]).findings.length,1,'identical issue evidence deduplicated');
assert.equal(decision([ext,{...ext,reproductionKey:'different'}]).findings.length,2,'different reproductions retained');
assert.equal(decision([{...ext,origin:'unknown'}]).action,'approval_required');
assert.equal(decision([{...ext,evidence:'unverified'}]).action,'approval_required');
assert.equal(decision([ext],'PASS', {verdict:'fix',issues:[ext]}).action,'report_only');
assert.equal(assessFixDecision({review:review([ext]),finalValidation:{verdict:'pass',issues:[]},verificationDisposition:'PASS'}).action,'report_only');
assert.equal(assessFixDecision({review:review([testGap]),finalValidation:{verdict:'pass',issues:[]},verificationDisposition:'PASS'}).action,'fix');
console.log('execution-scope-completion: PASS');
