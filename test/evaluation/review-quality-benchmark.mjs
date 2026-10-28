import assert from 'node:assert/strict';
import { evaluateBenchmarkSuite } from '../../src/evaluation/benchmark-suite.mjs';
// Fixture labels are explicitly independent of reviewer observations.
const independent={expectedFindings:['race','detached_window'],blockerMajorIds:['race','detached_window'],mandatoryObligations:['file_scope','lifecycle']};
const run=(findings,invocations)=>({reportedFindings:findings,verifiedObligations:['file_scope','lifecycle'],
  measurements:{invocations,inputTokens:null,outputTokens:null,quotaPercentage:null,elapsedMs:null}});
const result=evaluateBenchmarkSuite({minRuns:2,scenarios:[{id:'risk-coverage',adjudication:independent,
  baselineRuns:[run(['race'],2),run(['race'],2)],
  candidateRuns:[run(['race','detached_window'],2),run(['race','detached_window'],2)]}]});
assert.equal(result.scenarios[0].reductions.tokens,null,'missing usage must remain unknown');
assert.equal(result.scenarios[0].qualityStatus,'accepted');
const invalid=evaluateBenchmarkSuite({minRuns:2,scenarios:[{id:'missing',adjudication:independent,
  baselineRuns:[run(['race','detached_window'],2),run(['race','detached_window'],2)],
  candidateRuns:[run(['race'],2),run(['race'],2)]}]});
assert.equal(invalid.status,'rejected','lost confirmed major must block release');
console.log('review-quality-benchmark: PASS');
