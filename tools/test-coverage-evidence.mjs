#!/usr/bin/env node
import { buildTestCoverageEvidence } from '../src/testing/coverage-evidence.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';
// Developer utility. Natural-language intent is resolved by the Router in the
// orchestrator; this CLI accepts only explicit, typed Git arguments.
const n=Number(process.argv[2]);
if (!Number.isSafeInteger(n)||n<1||n>128) {
  console.error('Usage: node tools/test-coverage-evidence.mjs <recent-commit-count> [repo-root]');
  process.exitCode=2;
} else {
  const task={...emptyTaskSpec('change','explicit'),qualityGoals:['test_inventory','scenario_assessment'],
    target:{kind:'git',selector:{type:'union',selectors:[{type:'recent_commits',count:n},{type:'worktree'}]}}};
  const result=await buildTestCoverageEvidence(process.argv[3]??process.cwd(),task);
  console.log(JSON.stringify(result,null,2));
  if (result.status==='UNVERIFIED') process.exitCode=3;
}
