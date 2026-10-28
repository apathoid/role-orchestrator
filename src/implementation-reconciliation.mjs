import { randomBytes } from 'node:crypto';
import { changedPathsBetweenStates } from './repo.mjs';
import { repositoryFingerprint } from './implementation-stages.mjs';

/**
 * Facts already validated by the host-neutral workflow, not a new model-level
 * checkpoint validator. Call only after validateImplementationCheckpoint succeeds.
 * The investigator owns semantic compatibility, never checkpoint integrity.
 * Keep the evidence bounded: the complete durable records remain in the session.
 */
export function validatedCheckpointContext(checkpoint, stages) {
  const completedStages = checkpoint?.completedStages ?? [];
  const nextStage = stages[completedStages.length]?.id ?? null;
  return {
    structureValidation: 'passed',
    validatedBy: 'orchestrator-core',
    validatedInvariants: [
      'planId and scopeKey match the saved plan (the checkpoint repoKey has not been compared to the current checkout)',
      'completed stage IDs form an ordered prefix of the current implementation stages',
      'completed step records correspond to that prefix and have status implemented',
    ],
    // These are observations, not independently verified implementation claims.
    checkpointStatus: checkpoint?.status ?? 'not_started',
    completedStages: [...completedStages],
    nextStage,
    interruptedStage: checkpoint?.interruptedStage ?? null,
    completedStepCount: checkpoint?.records?.length ?? 0,
    completedStepEvidence: (checkpoint?.records ?? []).map((record) => ({
      id: record.id, status: record.status,
      evidence: String(record.evidence ?? '').slice(0, 400),
      evidenceTruncated: String(record.evidence ?? '').length > 400,
    })),
    priorStageReports: (checkpoint?.reports ?? []).map((report) => ({
      stage: report.stage,
      summary: String(report.summary ?? '').slice(0, 600),
      summaryTruncated: String(report.summary ?? '').length > 600,
      changedPaths: Array.isArray(report.changedPaths) ? report.changedPaths.slice(0, 40) : [],
      pathsTruncated: Array.isArray(report.changedPaths) && report.changedPaths.length > 40,
    })),
    // Explicitly distinguish structural validation from real-world correctness.
    limitations: [
      'Structural validation does not prove that previous code changes, step evidence or tests are correct.',
      'The current checkout may differ from the checkpoint; evaluate that delta separately.',
      'Prior stage reports and the checkpoint status are observations, not independently validated facts about implementation quality.',
      'Evidence excerpts may be truncated; inspect the checkout if further evidence is needed.',
      'An interrupted stage may contain partial edits and is not marked completed.',
    ],
  };
}

// Only hashes and Git identity are persisted; no source code, diffs or secrets.
export function snapshotImplementationRepo(state) {
  return {
    head: state.head,
    headRef: state.gitMetadata?.headRef ?? null,
    index: state.gitMetadata?.stagedHash ?? null,
    workspaceHashes: { ...state.workspaceHashes },
  };
}

export function implementationReconciliationChanges(snapshot, current) {
  const exact = Boolean(snapshot && typeof snapshot.head === 'string' && snapshot.workspaceHashes && typeof snapshot.workspaceHashes === 'object');
  const changedPaths = exact
    ? changedPathsBetweenStates(snapshot, current)
    : Object.keys(current.workspaceHashes ?? {}).sort();
  return {
    exact,
    changedPaths,
    headChanged: exact ? snapshot.head !== current.head : null,
    branchChanged: exact ? snapshot.headRef !== (current.gitMetadata?.headRef ?? null) : null,
    indexChanged: exact ? snapshot.index !== (current.gitMetadata?.stagedHash ?? null) : null,
  };
}

// New user language is classified once by the Router; approval is ONLY a
// previously recorded, session-scoped trusted decision gate, never model text.
export function reconciliationOnlyRequest(taskSpec) {
  return taskSpec?.continuation?.mode === 'reconcile' && taskSpec?.operation === 'investigate';
}
export function reconciliationApproval(hostDecision) {
  return hostDecision === 'accept_checkout' ? {explicit:true,gate:true} : null;
}

// This is a deterministic eligibility gate, NOT a substitute for the read-only
// investigation. Only a small, exact, unchanged-index file edit can be accepted
// automatically, and only with a coherent, risk-free structured analysis.
export function canAutoReconcile(proposal, { snapshot, currentState, baselineCleanTrackedPaths = [] }) {
  const changes = proposal?.changes;
  const analysis = proposal?.analysis;
  if (!changes?.exact || !snapshot?.workspaceHashes || !currentState?.workspaceHashes
    || changes.headChanged !== false || changes.branchChanged !== false || changes.indexChanged !== false
    || !Array.isArray(changes.changedPaths) || changes.changedPaths.length === 0
    || changes.changedPaths.length > 20
    || !['compatible', 'reverify'].includes(analysis?.decision)
    || !Array.isArray(analysis.risks) || analysis.risks.length !== 0
    || !Array.isArray(analysis.verification) || !Array.isArray(analysis.affectedStages)) return false;
  // A tracked file absent from the old dirty-file snapshot was clean at that
  // time. With identical HEAD/index, it can be considered without guessing.
  // Truly new/untracked files and paths that disappeared still need consent.
  const baselineClean = new Set(baselineCleanTrackedPaths);
  if (changes.changedPaths.some((path) => !Object.hasOwn(currentState.workspaceHashes, path)
    || (!Object.hasOwn(snapshot.workspaceHashes, path) && !baselineClean.has(path)))) return false;
  // If previously completed stages are affected, we must have specific tests
  // or a revalidation plan; compatibility is not proof of correctness.
  if (analysis.affectedStages.length > 0 && analysis.verification.length === 0) return false;
  return true;
}

export function newReconciliationProposal({ planId, baseKey, currentState, changes, analysis, completedStages }) {
  return {
    version: 1,
    token: randomBytes(6).toString('hex'),
    planId,
    baseKey,
    repoKey: repositoryFingerprint(currentState),
    changes,
    analysis: {
      decision: analysis.decision,
      summary: analysis.summary.slice(0, 2500),
      risks: analysis.risks.slice(0, 20).map((s) => s.slice(0, 500)),
      verification: analysis.verification.slice(0, 20).map((s) => s.slice(0, 500)),
      affectedStages: analysis.affectedStages,
    },
    completedStages: [...completedStages],
  };
}

export function reconciliationProposalMatches(proposal, { planId, baseKey, repoKey, completedStages }) {
  return proposal?.version === 1 && /^[a-f0-9]{12}$/.test(proposal.token ?? '')
    && proposal.planId === planId && proposal.baseKey === baseKey && proposal.repoKey === repoKey
    && JSON.stringify(proposal.completedStages) === JSON.stringify(completedStages)
    && ['compatible', 'reverify'].includes(proposal.analysis?.decision);
}

export function assessReconciliationAnalysis(output, format, stages) {
  const validIds = new Set(stages.map((stage) => stage.id));
  if (format !== 'structured' || !['compatible', 'reverify', 'blocked'].includes(output?.decision)
    || typeof output.summary !== 'string' || output.summary.trim().length < 16
    || !Array.isArray(output.risks) || output.risks.some((v) => typeof v !== 'string')
    || !Array.isArray(output.verification) || output.verification.some((v) => typeof v !== 'string')
    || !Array.isArray(output.affectedStages) || output.affectedStages.some((id) => !validIds.has(id))) return null;
  return output;
}

export function reconciliationPrompt(proposal) {
  const { changes, analysis } = proposal;
  const paths = changes.changedPaths.slice(0, 30).map((path) => `- \`${path.replaceAll('`', '')}\``).join('\n') || '- No identifiable path delta';
  return `### Implementation reconciliation — review required\n\n${analysis.summary}\n\n` +
    `Baseline comparison: **${changes.exact ? 'exact hash comparison' : 'legacy checkpoint; prior per-file hashes unavailable'}**.\n` +
    `Git HEAD changed: ${String(changes.headChanged)}; branch changed: ${String(changes.branchChanged)}; index changed: ${String(changes.indexChanged)}.\n\n` +
    `Potentially affected files (${changes.changedPaths.length}):\n${paths}${changes.changedPaths.length > 30 ? '\n- …additional paths omitted' : ''}\n\n` +
    `Affected implementation stages: ${analysis.affectedStages.join(', ') || 'none identified'}; completed stage evidence will still require integration revalidation.\n\n` +
    `Risks: ${analysis.risks.join('; ') || '(none reported)'}\n\n` +
    `Verification required: ${analysis.verification.join('; ') || 'Full existing integration verification'}\n\n` +
    `**No implementation was started.** This change needs an explicit decision before the saved baseline can be updated. To accept the inspected checkout and resume, send:\n\n` +
    `\`Подтверждаю согласование и продолжи реализацию плана\`\n\n` +
    `No confirmation code is required. Any further checkout change invalidates this proposal. Do not confirm if the changes are unfamiliar.`;
}
