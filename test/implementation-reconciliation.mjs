import assert from 'node:assert/strict';
import { snapshotImplementationRepo, implementationReconciliationChanges,
  reconciliationApproval, canAutoReconcile, reconciliationOnlyRequest,
  newReconciliationProposal, reconciliationProposalMatches,
  assessReconciliationAnalysis, validatedCheckpointContext } from '../src/implementation-reconciliation.mjs';
import { repositoryFingerprint } from '../src/implementation-stages.mjs';
const oldState = { head: 'old', gitMetadata: { headRef: 'refs/heads/main', stagedHash: 'index' },
  workspaceHashes: { 'a.ts': 'old-digest', 'untouched.ts': 'same' } };
const current = { head: 'old', gitMetadata: { headRef: 'refs/heads/main', stagedHash: 'index' },
  workspaceHashes: { 'a.ts': 'changed', 'untouched.ts': 'same', 'new.ts': 'hash' } };
const snapshot = snapshotImplementationRepo(oldState);
const changes = implementationReconciliationChanges(snapshot, current);
assert.equal(changes.exact, true);
assert.deepEqual(changes.changedPaths, ['a.ts', 'new.ts']);
assert.equal(changes.headChanged, false);
assert.equal(changes.indexChanged, false);
const unknown = implementationReconciliationChanges(null, current);
assert.equal(unknown.exact, false);
assert.equal(unknown.headChanged, null);
assert.ok(unknown.changedPaths.length >= 2);
assert.equal(reconciliationApproval('Подтверждаю согласование'),null,'free text is not a trusted confirmation');
assert.deepEqual(reconciliationApproval('accept_checkout'),{explicit:true,gate:true});
assert.equal(reconciliationOnlyRequest({operation:'investigate',continuation:{mode:'reconcile'}}),true);
assert.equal(reconciliationOnlyRequest({operation:'change',continuation:{mode:'reconcile'}}),false);
const accepted = { decision: 'reverify', summary: 'Examined the changed files and all relevant implementation invariants.',
  risks: ['Review contract'], verification: ['Re-run regression checks'], affectedStages: ['I1'] };
assert.deepEqual(assessReconciliationAnalysis(accepted, 'structured', [{ id: 'I1' }]), accepted);
assert.equal(assessReconciliationAnalysis({ ...accepted, affectedStages: ['I5'] }, 'structured', [{ id: 'I1' }]), null);
assert.equal(assessReconciliationAnalysis(accepted, 'text', [{ id: 'I1' }]), null);
const key = repositoryFingerprint(current);
const proposal = newReconciliationProposal({ planId: 'plan1', baseKey: 'oldkey', currentState: current, changes,
  analysis: accepted, completedStages: ['I1'] });
assert.ok(reconciliationProposalMatches(proposal, { planId: 'plan1', baseKey: 'oldkey', repoKey: key, completedStages: ['I1'] }));
assert.equal(reconciliationProposalMatches(proposal, { planId: 'plan1', baseKey: 'oldkey', repoKey: 'stale', completedStages: ['I1'] }), false);
assert.equal(reconciliationProposalMatches(proposal, { planId: 'plan1', baseKey: 'oldkey', repoKey: key, completedStages: [] }), false);
assert.equal(canAutoReconcile(proposal, { snapshot, currentState: current }), false, 'newly dirty paths need confirmation');
const plainCurrent = { ...current, workspaceHashes: { 'a.ts': 'changed', 'untouched.ts': 'same' } };
const eligible = { ...proposal, changes: { ...changes, changedPaths: ['a.ts'] }, analysis: { ...proposal.analysis, risks: [] } };
assert.equal(canAutoReconcile(eligible, { snapshot, currentState: plainCurrent }), true);
const trackedCleanFile = { ...eligible, changes: { ...eligible.changes, changedPaths: ['new.ts'] } };
assert.equal(canAutoReconcile(trackedCleanFile, { snapshot, currentState: current }), false);
assert.equal(canAutoReconcile(trackedCleanFile, { snapshot, currentState: current, baselineCleanTrackedPaths: ['new.ts'] }), true);
assert.equal(canAutoReconcile({ ...eligible, changes: { ...eligible.changes, indexChanged: true } }, { snapshot, currentState: plainCurrent }), false);
assert.equal(canAutoReconcile({ ...eligible, analysis: { ...eligible.analysis, verification: [] } }, { snapshot, currentState: plainCurrent }), false);
assert.equal(canAutoReconcile(eligible, { snapshot: null, currentState: plainCurrent }), false);
// The context is derived from an already validated checkpoint, never from
// model assertion. Its state is informative; integrity is checked by the core.
const checkpointFacts = validatedCheckpointContext({
  status: 'interrupted', completedStages: ['I1'], interruptedStage: 'I2',
  records: [{ id: 'S1', status: 'implemented', evidence: 'Implementation verified in changed module.' }],
  reports: [{ stage: 'I1', summary: 'Updated the shared adapter.', changedPaths: ['src/adapter.ts'] }],
}, [{ id: 'I1' }, { id: 'I2' }]);
assert.equal(checkpointFacts.structureValidation, 'passed');
assert.equal(checkpointFacts.validatedBy, 'orchestrator-core');
assert.equal(checkpointFacts.checkpointStatus, 'interrupted');
assert.deepEqual(checkpointFacts.completedStages, ['I1']);
assert.equal(checkpointFacts.nextStage, 'I2');
assert.equal(checkpointFacts.interruptedStage, 'I2');
assert.equal(checkpointFacts.completedStepEvidence[0].id, 'S1');
assert.deepEqual(checkpointFacts.priorStageReports[0].changedPaths, ['src/adapter.ts']);
const initialFacts = validatedCheckpointContext(null, [{ id: 'I1' }]);
assert.equal(initialFacts.checkpointStatus, 'not_started');
assert.equal(initialFacts.nextStage, 'I1');
assert.deepEqual(initialFacts.completedStages, []);
console.log('implementation-reconciliation: passed');
