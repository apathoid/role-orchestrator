import { cleanPlanStep } from './implementation-stages.mjs';
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function roleLabel(event) {
  const target = event.profile && event.model ? `${event.profile} / ${event.model}` : event.profile ?? event.model ?? '';
  return target ? `${event.role} [${target}]` : event.role;
}

export function createCliReporter({ stream = process.stderr } = {}) {
  const write = (text) => stream.write(text.endsWith('\n') ? text : `${text}\n`);
  return async (event) => {
    if (event.type === 'workspace_start') write(`[${now()}] Source repository available read-only`);
    else if (event.type === 'workspace_ready') {
      write(`[${now()}] ✓ Source repository ready (read-only for model roles)`);
      if (event.reviewTarget) {
        write(`[${now()}] Review target resolved: ${event.reviewTarget.sourceCommit.slice(0, 12)}; commit and parent evidence are available read-only`);
      }
    } else if (event.type === 'context_loaded') {
      const pieces = [];
      if (event.projectInstructions.length) pieces.push(`instructions: ${event.projectInstructions.map((x) => x.path).join(', ')}`);
      if (event.skill) pieces.push(`skill: ${event.skill.name}`);
      if (pieces.length) write(`[${now()}] Context loaded — ${pieces.join('; ')}`);
    }
    else if (event.type === 'coding_workspace_ready') write(`[${now()}] ✓ workspaceWrite ready`);
    else if (event.type === 'preparation_done') {
      const ok = event.disposition === 'PASS';
      write(`[${now()}] ${ok ? '✓' : '⚠'} Preparation ${ok ? 'complete' : 'incomplete — tooling/environment unverified'}`);
    }
    else if (event.type === 'implementation_reconciliation_proposed') write(`[${now()}] ↻ Implementation reconciliation requires review; awaiting confirmation`);
    else if (event.type === 'implementation_reconciliation_approved') write(`[${now()}] ✓ Implementation reconciliation accepted for this checkout (${event.automatic ? 'automatic' : 'confirmed'})`);
    else if (event.type === 'implementation_stage_start') write(`[${now()}] ▶ Implementation ${event.index}/${event.total}: ${event.steps.map((step) => step.id).join(', ')}`);
    else if (event.type === 'implementation_stage_done') write(`[${now()}] ✓ Implementation ${event.index}/${event.total} checkpoint: ${event.completedSteps} step(s)`);
    else if (event.type === 'invocation_retry_scheduled') write(`[${now()}] ↻ ${event.role}: retry ${event.attempt}/${event.attempts} after ${event.reason}`);
    else if (event.type === 'invocation_recovery_cancelled') write(`[${now()}] ⚠ ${event.role}: recovery cancelled by outer request`);
    else if (event.type === 'invocation_recovered') write(`[${now()}] ✓ ${event.role}: recovered after ${event.attempt} attempts`);
    else if (event.type === 'invocation_retry_skipped' || event.type === 'invocation_recovery_exhausted') write(`[${now()}] ⚠ ${event.role}: recovery ${event.type === 'invocation_retry_skipped' ? 'suppressed' : 'exhausted'} (${event.reason})`);
    else if (event.type === 'review_provider_retry') write(`[${now()}] ↻ ${event.role}: provider cancelled; read-only retry ${event.attempt}/2`);
    else if (event.type === 'review_interrupted') write(`[${now()}] ⚠ review interrupted: ${event.reason}; ${event.attempts} attempt(s)`);
    else if (event.type === 'implementation_stage_interrupted') write(`[${now()}] ⚠ Implementation ${event.stage} incomplete: ${event.reason}`);
    else if (event.type === 'implementation_checkpoint_resumed') write(`[${now()}] ↪ Implementation checkpoint resumed ${event.completed}/${event.total}`);
    else if (event.type === 'review_operation_resumed') write(`[${now()}] ↪ Review Operation ${event.operationId}: ${event.reusedUnits} units reused`);
    else if (event.type === 'review_scope_reconciled') write(`[${now()}] ↪ Git review scope reconciled: ${event.reusedUnits} reused, ${event.invalidatedUnits} invalidated`);
    else if (event.type === 'review_plan_created') write(`[${now()}] Review plan: ${event.total} units, Git manifest ${event.manifestAvailable ? 'available' : 'unavailable'}`);
    else if (event.type === 'review_continuation_ready') write(`[${now()}] ↪ Review continuation: ${event.verified} verified, ${event.pending} pending, durable=${event.durable}`);
    else if (event.type === 'review_checkpoint_persisted') write(`[${now()}] ✓ Review unit checkpoint: ${event.verified}/${event.total}`);
    else if (event.type === 'review_batch_start') write(`[${now()}] ▶ Review batch ${event.batch} (limit ${event.maxBatchesPerRun ?? event.total}): ${event.ids.join(', ')} (previous groups=${event.previousBatches})`);
    else if (event.type === 'review_batch_done') write(`[${now()}] ✓ Review batch ${event.batch} (limit ${event.maxBatchesPerRun ?? event.total}): ${event.checked}/${event.assigned} checked; gaps=${event.incomplete}`);
    else if (event.type === 'review_scope_resolution_required') write(`[${now()}] ⚠ Git review scope ${event.status}: ${event.reason} (${event.unresolved ?? '?'} unresolved change sets)`);
    else if (event.type === 'review_batch_interrupted') write(`[${now()}] ⚠ Review batch ${event.batch} interrupted (${event.code}); recovery exhausted or unavailable`);
    else if (event.type === 'review_checkpoint_resumed') write(`[${now()}] ↪ Review checkpoint: resumed ${event.completed}/${event.total} units`);
    else if (event.type === 'review_checkpoint_rejected') write(`[${now()}] ↪ Review checkpoint invalidated: ${event.reason}`);
    else if (event.type === 'review_checkpoint_error') write(`[${now()}] ⚠ Review checkpoint persistence failed: ${event.message}`);
    else if (event.type === 'role_start') write(`[${now()}] ▶ ${roleLabel(event)} — ${event.purpose}`);
    else if (event.type === 'role_thought_chunk') {
      for (const line of String(event.text).split('\n')) write(`[${now()}]   💭 ${line}`);
    }
    else if (event.type === 'role_commentary_chunk') {
      for (const line of String(event.text).split('\n')) write(`[${now()}]   ${line}`);
    }
    else if (event.type === 'role_usage') {
      if (event.contextWindow) write(`[${now()}]   context ${event.usage.totalTokens.toLocaleString('en-US')} / ${event.contextWindow.toLocaleString('en-US')} tokens`);
    }
    else if (event.type === 'role_done') write(`[${now()}] ✓ ${roleLabel(event)} — ${seconds(event.elapsedMs)}`);
    else if (event.type === 'role_cancelled') write(`[${now()}] ⊘ ${event.role} — ${event.message}`);
    else if (event.type === 'role_error') write(`[${now()}] ✗ ${event.role} — ${event.message}`);
    else if (event.type === 'route') {
      write(`\nPreliminary execution route (${event.policy.mode}, ${event.policy.tier}):`);
      event.preview.forEach((step, index) => {
        const model = step.profile ? ` [${step.profile}${step.model ? ` / ${step.model}` : ''}]` : '';
        const conditional = step.conditional ? ` — conditional${step.note ? `: ${step.note}` : ''}` : '';
        write(`  ${index + 1}. ${step.role}${model}: ${step.purpose}${conditional}`);
      });
      write('');
    } else if (event.type === 'plan') {
      write('Execution plan before write/review phase:');
      event.plan.steps.forEach((step, index) => write(`  ${index + 1}. ${step}`));
      if (event.plan.expectedFiles?.length) write(`  Expected/relevant files: ${event.plan.expectedFiles.join(', ')}`);
      if (event.plan.risks?.length) write(`  Risks/unknowns: ${event.plan.risks.join('; ')}`);
      write('');
    } else if (event.type === 'git_metadata_drift') {
      const interval = event.command ? ` after ${event.command}` : '';
      const fields = event.fields?.join(', ') || '(unknown)';
      const refs = [...(event.refs?.added ?? []), ...(event.refs?.updated ?? []), ...(event.refs?.removed ?? [])];
      write(`[${now()}] ⚠ Git metadata drift observed during ${event.stage}${interval}: ${fields}${refs.length ? ` [refs: ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ', …' : ''}]` : ''}. Changes preserved; attribution unknown.`);
    } else if (event.type === 'workspace_drift') {
      const details = [];
      if (event.changedPaths?.length) details.push(`paths=${event.changedPaths.join(', ')}`);
      if (event.gitFields?.length) details.push(`git=${event.gitFields.join(', ')}`);
      write(`[${now()}] ↻ ${event.role} workspace reconciliation${details.length ? ` — ${details.join('; ')}` : ''}`);
    } else if (event.type === 'workspace_drift_ignored') {
      const fields = event.gitFields?.join(', ') || '(unknown)';
      write(`[${now()}] · ${event.role} ignored non-semantic Git metadata drift for reconciliation: ${fields}`);
    } else if (event.type === 'workspace_drift_reconciled') {
      write(`[${now()}] ✓ ${event.role} reconciled against stable current workspace`);
    } else if (event.type === 'verification_start') write(`[${now()}] ▶ verification — run configured checks`);
    else if (event.type === 'verification_done') {
      const label = event.disposition === 'UNVERIFIED' ? 'unverified (environment/tooling)' : event.ok ? 'passed' : 'code failure';
      const icon = event.disposition === 'UNVERIFIED' ? '⚠' : event.ok ? '✓' : '✗';
      write(`[${now()}] ${icon} verification — ${label}`);
    }
    else if (event.type === 'fix_round') write(`[${now()}] ↻ fix round ${event.round}/${event.maxRounds}`);
    else if (event.type === 'fix_resolution') write(`[${now()}] ⚠ fix resolution: ${event.decision} (${event.reason}); workspace preserved`);
  };
}

export function formatResultMarkdown(result) {
  if (typeof result.responseText === 'string' && result.responseText.trim()) return result.responseText.trim();

  if (result.status === 'review_passed' || result.status === 'review_findings' || result.status === 'review_unresolved' || result.status === 'review_incomplete') {
    const review = result.review;
    const title = result.status === 'review_passed'
      ? 'no blocking findings'
      : result.status === 'review_findings'
        ? 'findings reported'
        : result.status === 'review_incomplete' ? 'scope not fully verified' : 'machine decision unresolved';
    const lines = [`## Review result: ${title}`, ''];
    if (result.reviewTarget) {
      lines.push(`Review target: source commit \`${result.reviewTarget.sourceCommit}\`. The requested commit and relevant repository evidence were reviewed read-only.`, '');
    }
    if (review?.summary) lines.push(review.summary);
    if (review?.issues?.length) {
      lines.push('', '### Findings');
      for (const issue of review.issues) {
        const location = issue.path ? ` — \`${issue.path}\`` : '';
        lines.push(`- **${issue.severity}**${location}: ${issue.message}${issue.suggestedFix ? ` Suggested fix: ${issue.suggestedFix}` : ''}`);
      }
    }
    if (result.finalValidation) {
      lines.push('', '### Escalation validation', result.finalValidation.summary);
      for (const issue of result.finalValidation.issues ?? []) {
        const location = issue.path ? ` — \`${issue.path}\`` : '';
        lines.push(`- **${issue.severity}**${location}: ${issue.message}`);
      }
    }
    if (result.status === 'review_incomplete') {
      lines.push('', `**Coverage incomplete:** ${result.reviewCoverage?.checked ?? 0}/${result.reviewCoverage?.total ?? 'unknown'} checklist items checked.`);
      for (const gap of result.reviewCoverage?.gaps?.slice(0, 12) ?? []) lines.push(`- ${gap}`);
      lines.push('', 'No production-readiness claim is justified by this partial review.');
    }
    if (result.status === 'review_unresolved') {
      lines.push('', '_The review text was preserved, but no reliable machine-readable pass/fix decision could be obtained._');
    }
    lines.push('', '_Review-only mode: no repository changes were applied._');
    return lines.join('\n');
  }

  if (result.status === 'planned') {
    return result.plannerOutput?.text?.trim() || (result.plan?.steps?.length
      ? ['## Plan', '', result.plan.goal ?? '', ...result.plan.steps.map((step, i) => `${i + 1}. ${cleanPlanStep(step)}`), '', '_Planning only — no repository changes were applied._'].join('\n')
      : 'Planning completed without repository edits.');
  }

  if (result.status === 'investigated') {
    const investigation = result.investigation;
    if (investigation?.format === 'text' && investigation.text) return investigation.text;
    if (result.exploration?.format === 'text' && result.exploration.text) return result.exploration.text;
    if (result.exploration?.summary) return result.exploration.summary;
    return 'Investigation completed without repository edits.';
  }

  const title = result.status === 'needs_user_decision'
    ? 'changes preserved; user decision required'
    : result.status === 'implementation_blocked'
      ? 'changes preserved; implementation blocked'
      : result.status === 'completed_with_findings'
        ? 'changes preserved; known findings remain'
        : result.status === 'applied'
    ? 'changes applied'
    : result.status === 'completed_with_unresolved_review'
      ? 'changes preserved; review decision unresolved'
      : result.status === 'completed_with_unverified_checks'
        ? 'changes preserved; some checks unverified'
        : 'no changes required';
  const lines = [`## Result: ${title}`, ''];
  if (result.review?.summary) lines.push(`Review: ${result.review.summary}`);
  if (result.finalValidation?.summary) lines.push(`Final validation: ${result.finalValidation.summary}`);
  if (result.gitMetadataDrift?.length) {
    const intervals = result.gitMetadataDrift.map((event) =>
      `${event.stage}${event.command ? ` (${event.command})` : ''}: ${event.fields.join(', ')}`,
    );
    lines.push(`⚠ Git metadata changed during this workflow (${intervals.join('; ')}). These changes were preserved and their source was not determined. Review current Git state before further Git operations.`);
  }
  if (result.verification?.length) {
    const passed = result.verification.filter((x) => x.status === 'PASS' || x.ok).length;
    lines.push(`Verification: ${passed}/${result.verification.length} checks passed${result.verificationDisposition === 'UNVERIFIED' ? '; remaining checks could not be verified because of tooling/environment/infra.' : '.'}`);
  }
  if (result.status === 'completed_with_unresolved_review') {
    lines.push('The workspace changes were preserved, but the reviewer/final validator did not return a reliable machine-readable pass/fix decision.');
  }
  return lines.join('\n');
}
