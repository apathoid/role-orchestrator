// Read-only task-owned quality projections, usable by ACP or another host.
// Never mutate the workspace, call a provider, or change a checkpoint.
import { sanitizeQualityText } from './quality-privacy.mjs';
import { activeQuality, evidenceMatrix, assessRecovery, applicableRiskAcceptance } from './quality-state.mjs';

const limit = (value, n = 240) => sanitizeQualityText(value, n).replace(/[\r\n]+/g, ' ');
const item = (id, value) => `- **${limit(id, 45)}** ${limit(value, 500)}`;

export async function qualityView(session, kind) {
  const current = activeQuality(session);
  if (!current) return 'No active saved implementation task. Use `/plans` to inspect available tasks.';
  const { task, state } = current;
  const prefix = [`### ${kind[0].toUpperCase() + kind.slice(1)} · task ${task.taskId.slice(0, 8)}`, ''];
  if (kind === 'evidence') {
    const rows = await evidenceMatrix(task, session.repoRoot);
    return [...prefix, ...(rows.length ? rows.flatMap((row) => [
      item(row.id, `${row.criterion} — ${row.state}${row.proofMethod ? ` (${row.proofMethod})` : ''}`),
      ...row.evidence.slice(-8).map((e) => `  - ${e.assessment}/${e.outcome}/${e.freshness} · ${limit(e.source.kind)} · ${limit(e.source.checkId ? `check:${e.source.checkId.slice(0, 12)}` : e.claim, 280)}`),
      ...(row.nextAction ? [`  - Next: ${row.nextAction}`] : []),
    ]) : ['No acceptance criteria in the active task.']), '',
      `Recorded evidence: ${state.evidence.length} (model claims are not executed checks).`].join('\n');
  }
  if (kind === 'findings') {
    const acknowledged = new Set(await applicableRiskAcceptance(task, session.repoRoot));
    return [...prefix, ...(state.findings.length ? state.findings.map((f) =>
      item(f.severity, `${f.lifecycle}/${f.confidence} · ${f.title} · ${f.taskImpact} · authorization=${f.remediationAuthorization} · evidence=${f.evidenceIds.length}${acknowledged.has(f.identity) ? ' · risk-acknowledged (not fixed)' : ''}`))
      : ['No recorded findings for this task.']), '',
      'Findings are task-scoped and are not automatically removed by a reviewer PASS or user risk acknowledgement.'].join('\n');
  }
  if (kind === 'recovery') {
    const r = await assessRecovery(task, session.repoRoot);
    return [...prefix,
      `**Checkpoint:** ${r.checkpointStatus}; completed stages: ${r.completedStages.join(', ') || 'none'}; next: ${r.nextStage ?? 'none'}`,
      `**Read-only recovery assessment:** ${r.recoverable ? 'structurally eligible' : 'requires reconciliation or repair'}`,
      `**Checkout drift:** ${r.checkoutDrift === null ? 'unknown' : String(r.checkoutDrift)}`,
      `**Evidence:** ${r.reusableEvidenceIds.length} reusable; ${r.staleEvidenceIds.length} stale; ${r.unknownEvidenceIds.length} freshness unknown`,
      `**Open findings:** ${r.unresolvedFindings.length}; approval needed: ${r.requiresApproval}`,
      `**Changed paths:** ${limit(r.changedPaths.slice(0, 30).join(', ')) || 'none identified'}`,
      `**Required:** ${r.requiredActions.join(', ') || 'none'}`,
      `**Targeted revalidation suggestions:** ${r.revalidationTargets.slice(0, 12).map((x) =>
        `${x.subject.kind}:${limit(x.subject.id)} ${x.action}${x.command ? ` (${limit(x.command, 100)})` : ''}${x.paths.length ? ` [${limit(x.paths.join(', '))}]` : ''}`).join('; ') || 'none'}`,
      'This proposal is not authorization to change files. Continue only through saved Plan checks.',
    ].join('\n');
  }
  if (kind === 'decisions') return [...prefix, ...(state.decisions.length ? state.decisions.map((d) =>
    [item(d.status, `Gate ${d.id} · ${d.kind}: ${d.summary}`),
      `  - ${limit(d.rationale)}`,
      ...d.options.map((o) => `  - \`${o.id}\` — ${limit(o.description)}`),
      ...(d.selection ? [`  - Selected: ${d.selection}`] : []),
    ].join('\n')) : ['No decisions recorded for this task.']), '',
    'Choose an option with `/decide <option>` when exactly one gate is pending, or `/decide <gate-id> <option>`. Approval never bypasses tool permissions.'].join('\n');
  throw new Error(`Unknown read-only quality view: ${kind}`);
}
