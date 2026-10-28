import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWorkflow } from '../src/workflow.mjs';
import { loadConfig } from '../src/config.mjs';
import { emptyTaskSpec, validateTaskSpec } from '../src/routing/task-spec.mjs';
import { captureRepoState } from '../src/repo.mjs';
import { planDigest, repositoryFingerprint } from '../src/implementation-stages.mjs';
import { newReconciliationProposal, implementationReconciliationChanges, snapshotImplementationRepo } from '../src/implementation-reconciliation.mjs';

const root = await mkdtemp(join(tmpdir(), 'reconcile-lifecycle-'));
const git = (...args) => { const p=spawnSync('git',args,{cwd:root,encoding:'utf8'}); assert.equal(p.status,0,p.stderr); };
class RouteReached extends Error {}
try {
  git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@invalid.local');
  await writeFile(join(root,'a.js'),'export default 1;\n'); git('add','.');git('commit','-qm','initial');
  const baseline = await captureRepoState(root);
  await writeFile(join(root,'a.js'),'export default 2;\n');
  const current = await captureRepoState(root);
  const plan={goal:'Update tests',steps:['Add tests for the implementation'],acceptanceCriteria:['Tests pass'],risks:[],expectedFiles:['a.test.js']};
  const artifact={version:1,repoRoot:root,planId:planDigest(plan),repoKey:repositoryFingerprint(baseline),repoSnapshot:snapshotImplementationRepo(baseline),plan};
  const proposal=newReconciliationProposal({planId:artifact.planId,baseKey:artifact.repoKey,currentState:current,
    changes:implementationReconciliationChanges(artifact.repoSnapshot,current),completedStages:[],
    analysis:{decision:'reverify',summary:'The currently changed source remains compatible with the saved test plan.',
      risks:['Verify updated behavior'],verification:['Re-run tests'],affectedStages:['I1']}});
  const config=await loadConfig({repoRoot:root,home:join(root,'unconfigured-home'),env:{}});
  const routing=(mode,decision)=>({mode:mode==='reconcile'?'investigate':'change',writeIntent:mode==='reconcile'?'not_requested':'explicit',
    complexity:'medium',risk:'architecture',reason:'explicit checkout decision',
    task:{...emptyTaskSpec(mode==='reconcile'?'investigate':'change',mode==='reconcile'?'not_requested':'explicit'),
      continuation:{mode,...(decision?{decision}:{})}}});
  async function scenario({mode='reconcile',decision='accept_checkout',gate='resolved',stored=null,expectedStatus='investigated'}) {
    let calls=0, updates=0, decisions=0, routeSeen=false;
    let decisionValue=stored;
    const registry={resolveRole:role=>({role,profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32768}}),
      invokeRole:async role=>{calls++;assert.equal(role,'router','unchanged proposal must not invoke investigator');return {output:routing(mode,decision),outputFormat:'structured',meta:{elapsedMs:1,structuredOutput:{format:'structured'}},resolved:{profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32768}}};}};
    let result;
    try {
      result=await runWorkflow({task:'Подтверждаю согласование и продолжи реализацию плана',config,registry,repoStart:root,
        savedOperationMetadata:[{operationId:'saved0001',planId:artifact.planId,pendingReconciliation:true}],
        onSelectSavedImplementation:async()=>({plan:artifact,reconciliation:proposal}),
        onResolveReconciliationIntent:async selection=>{decisions++;assert.equal(selection,decision);if(gate==='resolved')decisionValue=selection;return {status:gate,selection:gate==='resolved'?selection:null};},
        onReconciliationDecision:async()=>decisionValue,
        onImplementationReconciliation:async state=>{updates++;assert.equal(state.proposal,null);assert.equal(state.plan.reconciledRepoKey,repositoryFingerprint(current));return null;},
        reporter:async ev=>{if(ev.type==='route'){routeSeen=true;throw new RouteReached();}},
      });
    } catch(e) {if(!(e instanceof RouteReached))throw e;}
    assert.equal(calls,1);
    assert.equal(decisions,decision?1:0);
    if(expectedStatus==='route') { assert.equal(routeSeen,true); assert.equal(updates,1); }
    else {assert.equal(result.status,expectedStatus);assert.equal(updates,(gate==='resolved'&&decision==='accept_checkout'||stored==='accept_checkout')?1:0);}
    return result;
  }
  await scenario({});
  await scenario({mode:'current_implementation',expectedStatus:'route'});
  const invalid=await scenario({gate:'invalidated',expectedStatus:'implementation_incomplete'});
  assert.equal(invalid.implementationCoverage.reason,'reconciliation_decision_not_applicable');
  const declined=await scenario({decision:'decline',expectedStatus:'implementation_incomplete'});
  assert.equal(declined.implementationCoverage.reason,'reconciliation_declined');
  const alreadyAccepted=await scenario({decision:null,stored:'accept_checkout'});
  assert.equal(alreadyAccepted.status,'investigated');
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec(),continuation:{mode:'new',decision:'accept_checkout'}}),/reconciliation_decision/);
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec('change','explicit'),continuation:{mode:'reconcile',decision:'accept_checkout'}}),/invalid_reconcile/);
  assert.equal(validateTaskSpec({...emptyTaskSpec(),continuation:{mode:'reconcile',decision:'decline'}}).continuation.decision,'decline');
} finally { await rm(root,{recursive:true,force:true}); }
console.log('reconciliation-lifecycle: PASS');
