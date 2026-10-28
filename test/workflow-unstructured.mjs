import assert from 'node:assert/strict';
import { createCancellationError, CANCELLATION_REASONS } from '../src/cancellation.mjs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';

function exec(program, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${program} failed (${code})\n${stderr}`)));
  });
}

async function initRepo() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-unstructured-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'greeting.txt'), 'hello\n');
  await writeFile(join(repo, '.gitignore'), '.env\n*.key\n');
  await exec('git', ['init', '-q'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-qm', 'initial'], { cwd: repo });
  await writeFile(join(repo, '.env'), 'ORIGINAL=1\n');
  return { root, repo };
}

function structured(data) {
  return { output: data, format: 'structured' };
}
function text(value) {
  return { output: value, format: 'text' };
}

function fakeRegistry(behavior = {}) {
  const calls = [];
  const requests = [];
  let coderCount = 0;
  let reviewerCount = 0;
  const resolvedFor = (role) => ({
    role,
    profileName: 'fake',
    providerName: 'fake',
    profile: { model: 'fake-model', contextWindow: 100_000 },
  });
  return {
    calls,
    requests,
    resolveRole: resolvedFor,
    async invokeRole(role, request) {
      calls.push(role);
      requests.push({ role, request });
      let response;
      if (role === 'router') {
        response = behavior.routerText
          ? text('The task should be handled safely, but I did not return routing JSON.')
          : structured({
              mode: behavior.mode ?? 'change',
              writeIntent: behavior.writeIntent ?? ((behavior.mode ?? 'change') === 'change' ? 'explicit' : 'not_requested'),
              complexity: behavior.high ? 'high' : 'low',
              risk: behavior.high ? 'architecture' : 'normal',
              reason: 'test route',
              task: {
                ...emptyTaskSpec(behavior.mode ?? 'change', behavior.writeIntent ?? ((behavior.mode ?? 'change') === 'change' ? 'explicit' : 'not_requested')),
                constraints: {
                  ...emptyTaskSpec().constraints,
                  ...(behavior.reviewChecks ? { reviewChecks: behavior.reviewChecks } : {}),
                  ...(behavior.expectedFileCount !== undefined ? { expectedFileCount: behavior.expectedFileCount } : {}),
                  ...(behavior.excludedPaths ? { excludedPaths: behavior.excludedPaths } : {}),
                },
                ...(behavior.gitSelector ? { target: { kind: 'git', selector: behavior.gitSelector } } : {}),
                ...(behavior.continuation ? { continuation: behavior.continuation } : {}),
              },
            });
      } else if (role === 'explorer') {
        let explorerMutation = false;
        if (behavior.mutateDuringExplorer) {
          await writeFile(join(request.cwd, 'external.txt'), 'editor drift\n');
          explorerMutation = true;
        }
        if (behavior.refOnlyDuringExplorer) {
          await exec('git', ['branch', 'background-ref-update'], { cwd: request.cwd });
          explorerMutation = true;
        }
        if (behavior.configOnlyDuringExplorer) {
          await exec('git', ['config', '--local', 'audit.background', 'changed'], { cwd: request.cwd });
          explorerMutation = true;
        }
        if (behavior.indexOnlyDuringExplorer) {
          await exec('git', ['update-index', '--chmod=+x', 'greeting.txt'], { cwd: request.cwd });
          explorerMutation = true;
        }
        let transientCleanup = null;
        if (behavior.transientDuringExplorer) {
          const transientPath = join(request.cwd, 'transient-editor-state.txt');
          await writeFile(transientPath, 'temporary\n');
          transientCleanup = new Promise((resolve, reject) => {
            setTimeout(() => rm(transientPath, { force: true }).then(resolve, reject), 25);
          });
          explorerMutation = true;
        }
        if (explorerMutation) {
          const reconciliation = await request.reconcile?.();
          if (reconciliation?.prompt) requests.push({ role: 'explorer:reconcile', request: reconciliation });
          await transientCleanup;
        }
        response = behavior.explorerText
          ? text('greeting.txt contains the relevant implementation and is the only file needed for this task.')
          : structured({ summary: 'Greeting file.', relevantFiles: ['greeting.txt'], constraints: [], existingPatterns: [], likelyVerification: ['git diff --check'], unknowns: [] });
      } else if (role === 'planner') {
        response = behavior.plannerText
          ? text('Edit greeting.txt, verify the diff, then review the result.')
          : structured({ goal: 'Update greeting.', steps: behavior.longPlan
            ? ['1. Update data layer', '2. Add selectors', '3. Update view', '4. Test navigation', '5. Add integration cases']
            : ['Edit greeting.txt'], acceptanceCriteria: behavior.longPlan ? ['Greeting updated', 'No regression'] : ['Greeting updated'], risks: [], expectedFiles: ['greeting.txt'], engineeringFrame: { currentOwner: 'greeting.txt', existingAbstractions: [], generalMechanism: 'Store the greeting text.', specificPolicy: 'Use the requested greeting.', targetPlacement: ['greeting.txt'], stateOwnership: [], resourceOwnership: [], contractRisks: ['Preserve file semantics.'], avoid: ['Unrelated refactors.'], uncertainties: [] } });
      } else if (role === 'investigator' && request.schemaKind === 'implementationReconciliation') {
        if (behavior.requireVerifiedCheckpointContext) {
          const section = request.prompt.match(/VERIFIED CHECKPOINT CONTEXT \(DETERMINISTIC ORCHESTRATOR RESULT\):\n([\s\S]*?)\n\nREPOSITORY DELTA FROM CHECKPOINT:/);
          assert.ok(section, 'investigator must receive the verified checkpoint contract');
          const facts = JSON.parse(section[1]);
          assert.equal(facts.structureValidation, 'passed');
          assert.equal(facts.validatedBy, 'orchestrator-core');
          assert.equal(facts.checkpointStatus, 'interrupted');
          assert.deepEqual(facts.completedStages, ['I1']);
          assert.equal(facts.nextStage, 'I2');
          assert.equal(facts.interruptedStage, 'I2');
          assert.deepEqual(facts.completedStepEvidence.map((row) => row.id), ['S1', 'S2', 'S3']);
          assert.ok(facts.priorStageReports.some((row) => row.stage === 'I1'));
          assert.match(request.prompt, /Lack of the raw checkpoint JSON in your context is NOT a reason to block/);
          assert.match(request.prompt, /Your ONLY decision is whether the observed checkout changes remain semantically compatible/);
        }
        response = behavior.reconciliationInvalid ? text('Unable to establish reconciliation') : structured({
          decision: behavior.reconciliationBlocked ? 'blocked' : 'reverify',
          summary: 'Reviewed current checkout changes against the saved implementation requirements and existing completed-stage reports.',
          risks: behavior.reconciliationSafe ? [] : ['Changed behavior must be checked again at the integration gate'],
          verification: ['Re-run related regression tests and independent acceptance review'],
          affectedStages: ['I1'],
        });
      } else if (role === 'investigator') {
        if (behavior.mutateDuringInvestigator) {
          await writeFile(join(request.cwd, 'external.txt'), 'editor change\n');
          const reconciliation = await request.reconcile?.();
          if (reconciliation?.prompt) requests.push({ role: 'investigator:reconcile', request: reconciliation });
        }
        response = text(behavior.investigatorText
          ? 'The greeting is implemented in greeting.txt; repository evidence confirms there is no second implementation.'
          : 'The greeting lives in `greeting.txt`.\n\n```ts\nconst greeting = "hello";\n```');
      } else if (role.startsWith('coder')) {
        coderCount++;
        if (request.schemaKind === 'stagedImplementation') {
          const assigned = request.prompt.match(/CURRENT STAGE ONLY:\n([\s\S]*?)\n\nCOMPLETED STAGES/)?.[1];
          const steps = JSON.parse(assigned);
          if (!(behavior.verificationOnlyLastStage && coderCount === 2))
            await writeFile(join(request.cwd, 'greeting.txt'), `hello stage ${coderCount}\n`);
          if (behavior.failStageAt === coderCount) {
            const error = new Error('Provider stopped after partial edit');
            error.code = 'PROVIDER_CANCELLED';
            throw error;
          }
          response = structured({ action: behavior.verificationOnlyLastStage && coderCount === 2 ? 'no_change' : 'changed',
            summary: `Implemented stage with ${steps.length} steps.`,
            changedFiles: behavior.verificationOnlyLastStage && coderCount === 2 ? [] : ['greeting.txt'], notes: [],
            stepResults: steps.map((step) => ({ id: step.id, status: 'implemented',
              proofKind: behavior.verificationOnlyLastStage && coderCount === 2 ? 'verification' : 'change',
              ...(behavior.verificationOnlyLastStage && coderCount === 2 ? { checks: [{ command: 'git diff --check',
                outcome: behavior.verificationCheckFailed ? 'failed' : 'passed',
                evidence: 'Command completed and its exit status was inspected.' }] } : {}),
              evidence: behavior.verificationOnlyLastStage && coderCount === 2
                ? `Ran stage verification commands for ${step.id} and inspected actual output.`
                : `Applied changes to greeting.txt, confirmed behavior for ${step.id}.` })) });
          return { output: response.output, meta: { elapsedMs: 1, structuredOutput: { format: 'structured' } }, resolved: resolvedFor(role) };
        }
        if (!(behavior.fixerNoChange && coderCount > 1)) await writeFile(join(request.cwd, 'greeting.txt'), 'hello world\n');
        if ((behavior.stageDuringCoder && coderCount === 1) || (behavior.stageDuringFixer && coderCount > 1)) await exec('git', ['add', 'greeting.txt'], { cwd: request.cwd });
        if (behavior.mutateSensitiveDuringCoder) {
          await writeFile(join(request.cwd, '.env'), 'CHANGED=1\n');
          await writeFile(join(request.cwd, 'new.key'), 'secret\n');
        }
        if (behavior.planTransitionsToDefault && coderCount === 1) {
          await request.onProgress?.({ type: 'provider_state', key: 'collaboration_mode', value: 'default' });
        }
        response = behavior.coderText
          ? text('Updated greeting.txt in the current workspace and left the change uncommitted.')
          : structured({ action: 'changed', summary: 'Updated greeting.', changedFiles: ['greeting.txt'], notes: [] });
      } else if (role.startsWith('reviewer')) {
        reviewerCount++;
        if (behavior.providerCancelReviewerAt === reviewerCount) {
          throw createCancellationError(CANCELLATION_REASONS.PROVIDER_CANCELLED, {
            source: 'provider', expected: false,
            message: 'Internal provider returned stopReason=cancelled while outer execution remained active.',
          });
        }
        if (behavior.providerCancelAllReviewers) {
          throw createCancellationError(CANCELLATION_REASONS.PROVIDER_CANCELLED, { source: 'provider', expected: false });
        }
        if (behavior.failReviewerAt === reviewerCount) {
          const error = new Error('Internal provider returned 429 (test fixture)');
          error.code = 'RATE_LIMIT';
          throw error;
        }
        if (behavior.mutateDuringReviewer && reviewerCount === 1) await writeFile(join(request.cwd, 'review-drift.txt'), 'Concurrent change\n');
        if (behavior.moveReviewBaseDuringReviewer && reviewerCount === 1) await exec('git', ['branch', '-f', 'base-review', 'HEAD'], { cwd: request.cwd });
        const scope = request.schemaKind === 'scopedReview';
        const requested = scope
          ? request.prompt.match(/REVIEW WORK (?:PLAN \d+\/\d+|BATCH \d+ \(limit \d+ batches per run\))\. Assigned UNITS:\n([\s\S]*?)\n\nReturn scopedReview/)?.[1] ?? ''
          : '';
        const assignedIds = [...requested.matchAll(/^(C[SA]\d+|F\d+): /gm)].map((match) => match[1]);
        const requestedPaths = new Map([...requested.matchAll(/^(C[SA]\d+|F\d+): [^\n]*\n(?:  [^\n]*\n)*?  requiredPaths=(\[[^\n]*\])/gm)]
          .map((match) => [match[1], JSON.parse(match[2])]));
        const omitCoverage = behavior.coverageBadAlways || (behavior.coverageBadOnce && reviewerCount === 1);
        const coverage = assignedIds.slice(0, omitCoverage ? 0 : undefined).map((id) => ({
          id,
          status: behavior.coverageNotChecked ? 'not_checked' : 'checked',
          evidence: behavior.coverageNotChecked ? 'Test environment unavailable' : 'Inspected greeting.txt and compared its current Git version with expected behavior.',
          reviewedPaths: behavior.omitFilePaths && id.startsWith('F') ? [] : requestedPaths.get(id) ?? [],
          fileEvidence: (behavior.omitFilePaths && id.startsWith('F') ? [] : requestedPaths.get(id) ?? [])
            .map((path) => ({ path, evidence: `Inspected ${path} and compared its actual modified API and regression effects.` })),
        }));
        const inventory = {
          changedFiles: behavior.inventoryFiles ?? 1,
          reviewedFiles: behavior.reviewedFiles ?? 1,
          source: 'git diff --name-only (test fixture)',
        };
        const verdict = behavior.reviewerOutsideScope || (behavior.reviewFixOnce && reviewerCount === 1) ? 'fix' : 'pass';
        const result = { verdict, summary: 'Independent review recorded relevant findings.', issues: verdict === 'fix' ? [
          behavior.reviewerOutsideScope ? {
            severity: 'major', path: 'greeting.txt', message: 'Previously existing defect discovered by this task.',
            suggestedFix: 'Repair in a separately authorized production task.',
            origin: 'preexisting', taskRelation: 'dependency', remediationScope: 'outside_scope',
            evidence: 'Existing committed behavior was compared against an independently confirmed failing regression.',
          } : { severity: 'major', path: 'greeting.txt', message: 'Apply a concrete fix.', suggestedFix: 'Update logic.',
              origin:'introduced',taskRelation:'requirement',remediationScope:'in_scope',
              evidence:'The changed greeting handler does not satisfy the required behavior and needs the fix.' },
        ] : [] };
        response = behavior.reviewerText
          ? text('The change looks reasonable, but this answer intentionally has no machine-readable verdict.')
          : structured(scope ? { ...result, coverage, inventory } : request.schemaKind === 'implementationReview'
            ? { ...result, acceptanceResults: (behavior.invalidAcceptance ? [] : (behavior.longPlan ? ['A1', 'A2'] : ['A1']))
                .map((id) => ({ id, status: 'verified', evidence: 'Verified repository diff and relevant behavior through tests.' })) }
            : result);
      } else if (role === 'finalValidator') {
        const defect = {
          severity: behavior.criticalScoped ? 'blocking' : 'major', path: 'greeting.txt',
          message: 'Existing production behavior is inconsistent with the new regression expectations.',
          suggestedFix: 'Fix the original production behavior in a separate authorized task.',
          origin: behavior.uncertainScoped ? 'unknown' : 'preexisting',
          taskRelation: 'dependency', remediationScope: 'outside_scope',
          evidence: 'A reproduced regression in unchanged production behavior requires follow-up, not a speculative guess.',
        };
        const inScopeDefect = { ...defect, message: 'Implementation introduced a real regression.',
          origin: 'introduced', taskRelation: 'requirement', remediationScope: 'in_scope' };
        if (behavior.finalOutOfScope || behavior.finalFixInScope || behavior.uncertainScoped || behavior.criticalScoped) {
          assert.match(request.prompt, /FINDING ASSESSMENT.*read-only/);
          response = structured({ verdict: 'fix', summary: 'A real defect was found.',
            issues: [behavior.finalFixInScope ? inScopeDefect : defect],
            assessment: { correctness: 'defect_confirmed', taskCompliance: 'verified',
              fixAuthorization: behavior.finalFixInScope ? 'in_scope' : 'requires_approval' } });
        } else response = behavior.finalText
          ? text('Final validation completed, but this answer intentionally has no machine-readable verdict.')
          : structured({ verdict: 'pass', summary: 'Validation passed.', issues: [] });
      } else if (role.startsWith('responder')) {
        response = text('Final response in natural Markdown.\n\n```diff\n- hello\n+ hello world\n```');
      } else {
        throw new Error(`Unexpected role ${role}`);
      }
      return {
        output: response.output,
        meta: {
          elapsedMs: 1,
          usage: null,
          finalAnswerPresented: request.presentToUser === true && response.format === 'text',
          structuredOutput: {
            format: response.format,
            source: response.format === 'structured' ? 'test' : null,
            parseError: response.format === 'text' ? 'test parse failure' : null,
            rawText: typeof response.output === 'string' ? response.output : JSON.stringify(response.output),
          },
        },
        resolved: resolvedFor(role),
      };
    },
  };
}

const config = await loadConfig();
// Preserve the legacy scheduler as a compatibility regression fixture.
config.policy.reviewEfficiency = { enabled: false };
config.policy.workflowEfficiency = { investigationDirect: false }; // Legacy route coverage

async function runScenario(behavior, options = {}) {
  const { root, repo } = await initRepo();
  const registry = fakeRegistry(behavior);
  const events = [];
  try {
    let providerState = { ...(options.providerOptions ?? {}) };
    const result = await runWorkflow({
      task: options.task ?? 'Update the greeting.',
      config: options.configOverride ?? config,
      registry,
      repoStart: repo,
      modeOverride: options.modeOverride ?? null,
      planOnly: options.planOnly ?? false,
      providerOptionsForRole: options.providerOptions ? (role) => ({
        ...providerState,
        collaborationMode: ['coderLow','coderMedium','coderHigh'].includes(role) ? (providerState.collaborationMode ?? 'default') : 'default',
      }) : null,
      onProviderStateChange: async ({ key, value }) => {
        if (key === 'collaboration_mode') providerState = { ...providerState, collaborationMode: value };
      },
      providerOptions: options.providerOptions ?? {},
      promptBlocks: options.promptBlocks ?? [],
      additionalDirectories: options.additionalDirectories ?? [],
      sessionContextText: options.sessionContextText ?? '',
      authoritativePlan: options.authoritativePlan ?? null,
      reporter: async (event) => events.push(event),
    });
    return { result, registry, events, repo, greeting: (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { result, registry, events } = await runScenario({ mode: 'investigate', explorerText: true, investigatorText: true });
  assert.equal(result.status, 'investigated');
  assert.equal(result.exploration.format, 'text');
  assert.match(result.exploration.text, /greeting\.txt/);
  assert.equal(result.investigation.format, 'text');
  assert.match(result.investigation.text, /implemented in greeting\.txt/);
  assert.equal(result.responseText, result.investigation.text);
  assert.equal(events.at(-2).type, 'routing_outcome');
  assert.equal(events.at(-2).status, 'investigated');
  assert.equal(events.at(-1).type, 'complete', 'investigate also ends with terminal complete');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  assert.equal(events.some((event) => event.type === 'plan'), false, 'investigate must not publish a synthetic native task plan');
}

{
  const { result, greeting, registry, events } = await runScenario({ coderText: true });
  assert.equal(result.status, 'applied');
  assert.equal(greeting, 'hello world');
  assert.equal(result.implementation.outputFormat, 'text');
  assert.equal(result.implementation.action, 'changed');
  assert.deepEqual(result.implementation.changedFiles, []);
  assert.ok(result.changedPaths.includes('greeting.txt'));
  assert.match(result.responseText, /```diff/);
  assert.equal(events.some((event) => event.type === 'plan'), false, 'low-tier fallback execution scaffold must not be exposed as a planner task plan');
  const responderRequest = registry.requests.find((entry) => entry.role.startsWith('responder'))?.request;
  assert.match(responderRequest?.prompt ?? '', /REPOSITORY EXPLORATION:/);
  assert.match(responderRequest?.prompt ?? '', /Greeting file\./);
}

{
  const { result, registry } = await runScenario({ reviewerText: true });
  assert.equal(result.status, 'applied');
  assert.equal(result.review.verdict, 'unknown');
  assert.equal(result.finalValidation.verdict, 'pass');
  assert.ok(registry.calls.includes('finalValidator'));
  assert.ok(registry.calls.some((role) => role.startsWith('responder')));
}

{
  const { result, greeting } = await runScenario({ reviewerText: true, finalText: true });
  assert.equal(result.status, 'completed_with_unresolved_review');
  assert.equal(greeting, 'hello world');
  assert.equal(result.review.verdict, 'unknown');
  assert.equal(result.finalValidation.verdict, 'unknown');
}


{
  const { result, registry, greeting } = await runScenario({ mode: 'review', reviewerText: true, finalText: true });
  assert.equal(result.status, 'review_incomplete');
  assert.equal(result.review.verdict, 'unknown');
  assert.equal(result.finalValidation, null, 'missing coverage must not trigger an unrelated validation loop');
  assert.equal(result.planCompleted, false);
  assert.match(result.responseText, /Ревью не завершено/);
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

{
  const { result, registry, greeting } = await runScenario({ routerText: true });
  assert.equal(result.status, 'intent_unresolved', 'unstructured Router cannot complete a fresh natural-language task');
  assert.equal(result.errorCode, 'missing_task_spec');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

{
  const { result, greeting, registry } = await runScenario({ routerText: true }, { modeOverride: 'change' });
  assert.equal(result.status, 'intent_unresolved', 'host /change cannot manufacture an absent Router task');
  assert.equal(result.errorCode, 'missing_task_spec');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some(role => role.startsWith('coder')), false);
}

{
  const { result, events } = await runScenario({ high: true, plannerText: true });
  assert.equal(result.status, 'applied');
  assert.equal(result.plannerOutput.format, 'text');
  assert.match(result.plannerOutput.text, /Edit greeting\.txt/);
  assert.ok(Array.isArray(result.plan.steps) && result.plan.steps.length > 0);
  assert.equal(events.some((event) => event.type === 'plan'), false, 'unstructured planner fallback must remain internal');
}

{
  const { result, registry, events } = await runScenario({ high: true });
  assert.equal(result.status, 'applied');
  const planEvent = events.find((event) => event.type === 'plan');
  assert.deepEqual(planEvent?.plan?.steps, ['Edit greeting.txt']);
  assert.equal(planEvent?.plan?.engineeringFrame?.currentOwner, 'greeting.txt');

  const routerPrompt = registry.requests.find((entry) => entry.role === 'router')?.request.prompt ?? '';
  const plannerPrompt = registry.requests.find((entry) => entry.role === 'planner')?.request.prompt ?? '';
  const coderPrompt = registry.requests.find((entry) => entry.role.startsWith('coder'))?.request.prompt ?? '';
  const reviewerPrompt = registry.requests.find((entry) => entry.role.startsWith('reviewer'))?.request.prompt ?? '';
  const finalPrompt = registry.requests.find((entry) => entry.role === 'finalValidator')?.request.prompt ?? '';

  assert.doesNotMatch(routerPrompt, /ENGINEERING POLICY FOR THIS ROLE/);
  assert.match(plannerPrompt, /ENGINEERING POLICY FOR THIS ROLE/);
  assert.match(plannerPrompt, /semantic generality without speculative complexity/i);
  assert.match(plannerPrompt, /Engineering decision process/i);
  assert.match(coderPrompt, /semantic generality without speculative complexity/i);
  assert.match(coderPrompt, /ENGINEERING FRAME:[\s\S]*\"currentOwner\": \"greeting\.txt\"/);
  assert.equal((coderPrompt.match(/\"currentOwner\"/g) ?? []).length, 1, 'engineeringFrame must not be duplicated inside PLAN');
  assert.match(coderPrompt, /ENGINEERING CHECKPOINT/);
  assert.match(reviewerPrompt, /Engineering review rubric/i);
  assert.match(reviewerPrompt, /ENGINEERING FRAME:[\s\S]*\"generalMechanism\"/);
  assert.match(finalPrompt, /Engineering Hard Invariants/i);
  assert.doesNotMatch(finalPrompt, /semantic generality without speculative complexity/i);
}


{
  const { result, registry, greeting } = await runScenario(
    { mode: 'investigate', writeIntent: 'not_requested' },
    { task: 'Подскажи, как исправить проблему с greeting, но ничего не меняй.' },
  );
  assert.equal(result.status, 'investigated');
  assert.equal(result.route.classification.mode, 'investigate');
  assert.equal(result.route.classification.writeIntent, 'not_requested');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

// Defense in depth: even a host mistakenly providing an authoritativePlan
// cannot change a read-only question into a resumed implementation.
{
  const { result, registry, greeting } = await runScenario(
    { mode: 'investigate', writeIntent: 'not_requested' },
    { task: 'Как проверить реализацию плана?',
      authoritativePlan: { version: 1, repoRoot: '/deliberately-not-this-repo', planId: 'invalid', plan: {} } },
  );
  assert.equal(result.status, 'investigated');
  assert.equal(result.route.classification.mode, 'investigate');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

// A question about a saved plan must be semantically classified read-only.
// Schema validity alone cannot prove that an LLM classification is true.
{
  const { result, registry, greeting } = await runScenario(
    { mode: 'investigate', writeIntent: 'not_requested' },
    { task: 'Что делает этот метод?' },
  );
  assert.equal(result.status, 'investigated');
  assert.equal(result.route.classification.mode, 'investigate');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

// Correct Router classification of a question about continuation remains read-only.
{
  const { result, registry, greeting } = await runScenario(
    { mode: 'investigate', writeIntent: 'not_requested' },
    { task: 'Можешь объяснить, как продолжить реализацию плана?' },
  );
  assert.equal(result.status, 'investigated');
  assert.equal(result.route.classification.mode, 'investigate');
  assert.equal(result.route.classification.writeIntent, 'not_requested');
  assert.equal(greeting, 'hello');
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}

{
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  const { result, registry } = await runScenario({ mode: 'investigate' }, { promptBlocks: [image] });
  assert.equal(result.status, 'investigated');
  const explorerRequest = registry.requests.find((entry) => entry.role === 'explorer')?.request;
  assert.deepEqual(explorerRequest.promptBlocks, [image]);
}

{
  const { result, registry } = await runScenario({ mode: 'investigate', mutateDuringInvestigator: true });
  assert.equal(result.status, 'investigated');
  assert.ok(registry.requests.some((entry) => entry.role === 'investigator:reconcile'));
}


// Background Git bookkeeping must remain observable without consuming a
// reconciliation turn. A fetch/ref refresh or local config update does not
// invalidate conclusions about the current checkout by itself.
{
  const { result, registry, events } = await runScenario({ mode: 'investigate', refOnlyDuringExplorer: true });
  assert.equal(result.status, 'investigated');
  assert.equal(registry.requests.some((entry) => entry.role === 'explorer:reconcile'), false);
  assert.ok(events.some((event) => event.type === 'workspace_drift_ignored' && event.gitFields.includes('refs')));
}

{
  const { result, registry, events } = await runScenario({ mode: 'investigate', configOnlyDuringExplorer: true });
  assert.equal(result.status, 'investigated');
  assert.equal(registry.requests.some((entry) => entry.role === 'explorer:reconcile'), false);
  assert.ok(events.some((event) => event.type === 'workspace_drift_ignored' && event.gitFields.includes('localConfig')));
}

// Index changes can alter merge-conflict/staging semantics even when the file
// bytes are unchanged, so they still require reconciliation.
{
  const { result, registry } = await runScenario({ mode: 'investigate', indexOnlyDuringExplorer: true });
  assert.equal(result.status, 'investigated');
  const reconcile = registry.requests.find((entry) => entry.role === 'explorer:reconcile')?.request;
  assert.ok(reconcile?.prompt);
  assert.match(reconcile.prompt, /Semantic Git state changed: index/);
  assert.match(reconcile.diagnostic, /git=index/);
}

// A short-lived editor/index transition that settles back before the bounded
// confirmation snapshot must not spend another model turn.
{
  const previous = process.env.AGENT_RECONCILIATION_STABILITY_MS;
  process.env.AGENT_RECONCILIATION_STABILITY_MS = '75';
  try {
    const { result, registry } = await runScenario({ mode: 'investigate', transientDuringExplorer: true });
    assert.equal(result.status, 'investigated');
    assert.equal(registry.requests.some((entry) => entry.role === 'explorer:reconcile'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RECONCILIATION_STABILITY_MS;
    else process.env.AGENT_RECONCILIATION_STABILITY_MS = previous;
  }
}


{
  const priorContext = `OUTER CONVERSATION — RECENT TURNS VERBATIM:\nTurn 1:\nUser:\nПопробуй решение X.\n\nAssistant:\nРешение X уже проверено и ломает hover; повторно его не предлагать.`;
  const { registry } = await runScenario(
    { mode: 'investigate' },
    { sessionContextText: priorContext, task: 'Найди другой вариант.' },
  );
  for (const entry of registry.requests.filter((item) => !item.role.includes(':reconcile'))) {
    assert.match(entry.request.prompt, /Решение X уже проверено и ломает hover/,
      `${entry.role} must receive prior outer-conversation constraints`);
  }
  const investigatorPrompt = registry.requests.find((entry) => entry.role === 'investigator')?.request.prompt ?? '';
  assert.doesNotMatch(investigatorPrompt, /Use Git history as needed|git log|git show|git blame/i,
    'generic investigation must not prescribe Git-history tools');
}


{
  const { result, registry, greeting, events } = await runScenario(
    { mode: 'change', writeIntent: 'explicit', planTransitionsToDefault: true, reviewFixOnce: true },
    { task: 'Реализуй изменение.', providerOptions: { agentMode: 'agent-full-access', collaborationMode: 'plan' } },
  );
  assert.equal(result.route.classification.mode, 'change');
  assert.equal(result.route.classification.writeIntent, 'explicit');
  assert.equal(greeting, 'hello world');
  const routerRequest = registry.requests.find((entry) => entry.role === 'router')?.request;
  const coderRequests = registry.requests.filter((entry) => entry.role.startsWith('coder')).map((entry) => entry.request);
  const responderRequest = registry.requests.find((entry) => entry.role.startsWith('responder'))?.request;
  assert.equal(routerRequest?.providerOptions?.collaborationMode, 'default', 'machine control roles stay on default collaboration mode');
  assert.equal(coderRequests.length, 2, 'review fix should schedule a second coder invocation');
  assert.equal(coderRequests[0]?.providerOptions?.collaborationMode, 'plan', 'native Plan is delegated to the task-executing coder');
  assert.equal(coderRequests[0]?.providerOptions?.agentMode, 'agent-full-access', 'opaque provider state is transported without core interpretation');
  assert.equal(coderRequests[1]?.providerOptions?.collaborationMode, 'default', 'inner Plan → Default transition must affect later fix turns');
  assert.equal(result.status,'implementation_blocked','an evidenced unresolved in-scope defect is not a successful change');
  assert.equal(responderRequest,undefined,'a blocked in-scope fix must not receive a misleading final responder');
  assert.ok(events.some((event) => event.type === 'provider_state' && event.key === 'collaboration_mode' && event.value === 'default'));
}


// The validator must report real pre-existing defects without automatically
// broadening a tests-only task or disguising its limitations as a pass.
{
  const { result, registry, events } = await runScenario({ high: true, finalOutOfScope: true });
  assert.equal(result.status, 'completed_with_findings');
  assert.equal(result.planCompleted, false, 'unresolved findings are never full approval');
  assert.equal(result.fixDisposition.action, 'report_only');
  assert.equal(result.unresolvedFindings.length, 1);
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1, 'do not auto-fix an unauthorized production defect');
  assert.equal(registry.calls.some((role) => role.startsWith('responder')), false, 'use a deterministic truthful summary');
  assert.match(result.responseText, /pre-existing|preexisting|outside|scope|defect/i);
  assert.doesNotMatch(result.responseText, /\"verdict\":\s*\"fix\"/);
  assert.ok(events.some((event) => event.type === 'fix_resolution'));
}

// Even low-risk tasks must consult a validator when a reviewer discovers a
// credible out-of-scope defect, without turning it into an unauthorized edit.
{
  const { result, registry } = await runScenario({ reviewerOutsideScope: true, finalOutOfScope: true });
  assert.equal(result.status, 'completed_with_findings');
  assert.equal(result.fixDisposition.action, 'report_only');
  assert.equal(registry.calls.filter((role) => role === 'finalValidator').length, 1);
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1);
}

// Staged task coverage remains explicit and not falsely marked finished.
{
  const { result, registry } = await runScenario({ high: true, longPlan: true, finalOutOfScope: true });
  assert.equal(result.status, 'completed_with_findings');
  assert.equal(result.planCompleted, false);
  assert.equal(result.implementationCoverage.complete, true);
  assert.ok(result.acceptanceCoverage);
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, result.implementationCoverage.totalStages);
}

// Validator confidence never overrides machine-checked missing acceptance evidence.
{
  const { result } = await runScenario({ high: true, longPlan: true, finalOutOfScope: true, invalidAcceptance: true });
  assert.equal(result.status, 'implementation_blocked');
  assert.equal(result.planCompleted, false);
  assert.equal(result.acceptanceCoverage.complete, false);
  assert.match(result.responseText, /Acceptance criteria/i);
}

// Unknown origin is not evidence of a safe out-of-scope disposition or
// authorization to edit production code. Preserve the finding, ask the user.
{
  const { result, registry } = await runScenario({ high: true, uncertainScoped: true });
  assert.equal(result.status, 'needs_user_decision');
  assert.equal(result.fixDisposition.reason, 'scope_or_origin_unconfirmed');
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1);
}


{
  const { result, registry } = await runScenario({ high: true, finalFixInScope: true, fixerNoChange: true });
  assert.equal(result.status, 'implementation_blocked');
  assert.equal(result.fixDisposition.reason, 'coder_declined_required_fix');
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 2);
}

{
  const { result, registry } = await runScenario({ high: true, finalFixInScope: true }, {
    configOverride: { ...config, policy: { ...config.policy, maxFixRounds: 0 } },
  });
  assert.equal(result.status, 'implementation_blocked');
  assert.equal(result.fixDisposition.action, 'fix_round_limit');
  assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1, 'limit 0 must prohibit fix rounds');
}

// A failing check remains a failing check even when remediation needs approval.
{
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([[process.execPath, '-e', 'process.exit(2)']]);
  try {
    const { result, registry } = await runScenario({ high: true, finalOutOfScope: true });
    assert.equal(result.status, 'needs_user_decision');
    assert.equal(result.verificationDisposition, 'CODE_FAILURE');
    assert.equal(result.fixDisposition.action, 'approval_required');
    assert.equal(result.planCompleted, false);
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1);
    assert.match(result.responseText, /CODE_FAILURE/);
    assert.match(result.responseText, /needs|decision|approval|scope/i);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
    else process.env.AGENT_VERIFY_COMMANDS = previous;
  }
}

// Severity alone is a model assertion, not scope expansion or proof that an independent task is blocked.
{
  const { result } = await runScenario({ high: true, criticalScoped: true });
  assert.equal(result.status, 'completed_with_findings');
  assert.equal(result.fixDisposition.reason, 'confirmed_out_of_scope_defect');
  assert.equal(result.planCompleted,false);
}

{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit', mutateSensitiveDuringCoder: true });
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Update.', config, registry, repoStart: repo }),
      /Coder attempted to modify security-denied path\(s\): .*\.env.*new\.key/i,
    );
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'ORIGINAL=1\n');
    await assert.rejects(() => readFile(join(repo, 'new.key'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(repo, 'greeting.txt'), 'utf8'), 'hello world\n', 'unrelated coder edit must be preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const previous = process.env.AGENT_PREPARE_COMMANDS;
  process.env.AGENT_PREPARE_COMMANDS = JSON.stringify([[process.execPath, '-e', "require('fs').writeFileSync('.env','PREP_CHANGED=1\\n')"]]);
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Update.', config, registry, repoStart: repo }),
      /Project preparation modified security-denied path\(s\): .*\.env/i,
    );
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'ORIGINAL=1\n');
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_PREPARE_COMMANDS; else process.env.AGENT_PREPARE_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'review', writeIntent: 'not_requested' });
  const reviewConfig = structuredClone(config);
  reviewConfig.policy.reviewVerification = true;
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([[process.execPath, '-e', "require('fs').writeFileSync('.env','VERIFY_CHANGED=1\\n')"]]);
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Review.', config: reviewConfig, registry, repoStart: repo, modeOverride: 'review' }),
      /Verification modified security-denied path\(s\): .*\.env/i,
    );
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'ORIGINAL=1\n');
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}



{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'review', writeIntent: 'not_requested' });
  const reviewConfig = structuredClone(config);
  reviewConfig.policy.reviewVerification = true;
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([[process.execPath, '-e', "require('fs').writeFileSync('greeting.txt','VERIFY_CHANGED\\n')"]]);
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Review.', config: reviewConfig, registry, repoStart: repo, modeOverride: 'review' }),
      /Read-only review verification observed workspace mutations: paths=greeting\.txt.*preserved/i,
    );
    assert.equal(await readFile(join(repo, 'greeting.txt'), 'utf8'), 'VERIFY_CHANGED\n', 'review verification must not erase concurrent changes');
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// Review-only verification rejects Git drift, but never rewrites user refs/index.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'review', writeIntent: 'not_requested' });
  const reviewConfig = structuredClone(config);
  reviewConfig.policy.reviewVerification = true;
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['git', 'branch', 'review-verification-branch']]);
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Review.', config: reviewConfig, registry, repoStart: repo, modeOverride: 'review' }),
      /Read-only review verification observed workspace mutations:.*Git metadata=refs.*preserved/i,
    );
    await exec('git', ['show-ref', '--verify', 'refs/heads/review-verification-branch'], { cwd: repo });
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { result, registry } = await runScenario(
    { mode: 'change', writeIntent: 'explicit' },
    { additionalDirectories: ['/tmp/external-writable-root'] },
  );
  assert.equal(result.status, 'applied');
  const explorerRequest = registry.requests.find((entry) => entry.role === 'explorer')?.request;
  const coderRequest = registry.requests.find((entry) => entry.role.startsWith('coder'))?.request;
  assert.deepEqual(explorerRequest?.additionalDirectories, ['/tmp/external-writable-root'], 'read-only roles may inspect client-supplied additional directories');
  assert.deepEqual(coderRequest?.additionalDirectories, [], 'writable roles must not receive unmonitored additional writable roots');
}

{
  const { result } = await runScenario({ mode: 'change', writeIntent: 'explicit', mutateDuringExplorer: true });
  assert.deepEqual(result.changedPaths, ['greeting.txt'], 'read-only concurrent/editor drift before the coder must become execution baseline, not coder delta');
}


{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit', stageDuringCoder: true, mutateSensitiveDuringCoder: true });
  try {
    await assert.rejects(
      () => runWorkflow({ task: 'Update.', config, registry, repoStart: repo }),
      /Coder attempted to modify security-denied path\(s\): .*\.env.*new\.key/i,
    );
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'ORIGINAL=1\n');
    await assert.rejects(() => readFile(join(repo, 'new.key'), 'utf8'), /ENOENT/);
    const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: repo });
    assert.equal(staged.stdout.trim(), 'greeting.txt', 'security-path rollback must not undo potentially external staging');
    assert.equal(await readFile(join(repo, 'greeting.txt'), 'utf8'), 'hello world\n', 'allowed worktree edit must remain preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit', stageDuringCoder: true });
  try {
    const events = [];
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo, reporter: (event) => events.push(event) });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.gitMetadataDrift.map((event) => event.stage), ['coder']);
    assert.deepEqual(result.gitMetadataDrift[0].fields, ['index']);
    const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: repo });
    assert.equal(staged.stdout.trim(), 'greeting.txt', 'staged user/agent changes must never be reverted automatically');
    const reviewerPrompt = registry.requests.find((entry) => entry.role.startsWith('reviewer'))?.request.prompt ?? '';
    assert.match(reviewerPrompt, /GIT METADATA CHANGE OBSERVATIONS:[\s\S]*"stage": "coder"/);
    assert.ok(events.some((event) => event.type === 'git_metadata_drift' && event.action === 'preserved'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Git metadata changes from verification are preserved. We know only the
// command interval in which they appeared, not which process authored them.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([
    ['git', 'add', 'greeting.txt'],
    ['git', 'branch', 'verification-created-branch'],
    ['git', 'config', '--local', 'audit.verify', 'present'],
  ]);
  try {
    const events = [];
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo, reporter: (event) => events.push(event) });
    assert.equal(result.status, 'applied');
    const verifications = result.gitMetadataDrift.filter((event) => event.stage === 'verification');
    assert.deepEqual(verifications.map((event) => [event.command, event.fields]), [
      ['git add greeting.txt', ['index']],
      ['git branch verification-created-branch', ['refs']],
      ['git config --local audit.verify present', ['localConfig']],
    ]);
    assert.deepEqual(verifications[1].refs.added, ['refs/heads/verification-created-branch']);
    const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: repo });
    assert.equal(staged.stdout.trim(), 'greeting.txt');
    assert.equal((await exec('git', ['config', '--get', 'audit.verify'], { cwd: repo })).stdout.trim(), 'present');
    await exec('git', ['show-ref', '--verify', 'refs/heads/verification-created-branch'], { cwd: repo });
    const reviewerPrompt = registry.requests.find((entry) => entry.role.startsWith('reviewer'))?.request.prompt ?? '';
    assert.match(reviewerPrompt, /git add greeting.txt/);
    assert.match(reviewerPrompt, /attribution/i);
    assert.ok(events.some((event) => event.type === 'verification_done' && event.ok));
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// Simulate an independent editor/Git process writing mid-verification. A
// detected interval must never be treated as proof the command caused it.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const marker = join(root, 'verification-started');
  const command = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(() => process.exit(0), 650)`;
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([[process.execPath, '-e', command]]);
  try {
    const editor = (async () => {
      for (let i = 0; i < 150; i++) {
        try { await access(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      await access(marker); // fail the test rather than silently skipping the race
      await writeFile(join(repo, 'concurrent-editor.txt'), 'external user edit\n');
      await exec('git', ['branch', 'external-editor-branch'], { cwd: repo });
    })();
    const resultPromise = runWorkflow({ task: 'Update.', config, registry, repoStart: repo });
    const [result] = await Promise.all([resultPromise, editor]);
    assert.equal(result.status, 'applied');
    assert.ok(result.changedPaths.includes('concurrent-editor.txt'));
    assert.equal(await readFile(join(repo, 'concurrent-editor.txt'), 'utf8'), 'external user edit\n');
    await exec('git', ['show-ref', '--verify', 'refs/heads/external-editor-branch'], { cwd: repo });
    const drift = result.gitMetadataDrift.find((event) => event.stage === 'verification' && event.fields.includes('refs'));
    assert.equal(drift?.command, `${process.execPath} -e ${command}`);
    const reviewRequest = registry.requests.find((entry) => entry.role.startsWith('reviewer'))?.request;
    assert.match(reviewRequest.prompt, /concurrent-editor.txt/);
    assert.match(reviewRequest.prompt, /external-editor-branch/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// A HEAD change during verification must not rewrite refs or move HEAD back.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const initial = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const previous = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['git', 'commit', '-am', 'verification-test-commit']]);
  try {
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo });
    const current = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    assert.notEqual(current, initial);
    assert.ok(result.gitMetadataDrift.some((event) => event.stage === 'verification' && event.fields.includes('HEAD')));
    assert.ok(result.gitMetadataDrift.some((event) => event.fields.includes('refs')));
    assert.equal((await readFile(join(repo, 'greeting.txt'), 'utf8')), 'hello world\n');
  } finally {
    if (previous === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// Preparation drift is advisory too: the coder sees the up-to-date checkout.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const previous = process.env.AGENT_PREPARE_COMMANDS;
  process.env.AGENT_PREPARE_COMMANDS = JSON.stringify([['git', 'config', '--local', 'audit.prepare', 'set']]);
  try {
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo });
    assert.equal(result.status, 'applied');
    assert.ok(result.gitMetadataDrift.some((event) => event.stage === 'preparation' && event.fields.includes('localConfig')));
    assert.equal((await exec('git', ['config', '--get', 'audit.prepare'], { cwd: repo })).stdout.trim(), 'set');
  } finally {
    if (previous === undefined) delete process.env.AGENT_PREPARE_COMMANDS; else process.env.AGENT_PREPARE_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// Fixer drift should likewise be passed onward, without reverting staging.
{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit', reviewFixOnce: true, stageDuringFixer: true });
  try {
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo });
    assert.equal(result.status, 'implementation_blocked', 'staging alone cannot resolve an evidenced in-scope finding');
    assert.equal(result.fixDisposition?.reason,'coder_declined_required_fix');
    assert.ok(result.gitMetadataDrift.some((event) => event.stage === 'fixer' && event.fields.includes('index')));
    assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout.trim(), 'greeting.txt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'change', writeIntent: 'explicit' });
  const previous = process.env.AGENT_PREPARE_COMMANDS;
  process.env.AGENT_PREPARE_COMMANDS = JSON.stringify([['role-orchestrator-tool-that-does-not-exist']]);
  try {
    const result = await runWorkflow({ task: 'Update.', config, registry, repoStart: repo });
    assert.equal(result.status, 'completed_with_unverified_checks');
    assert.equal(result.planCompleted, false, 'a task plan must not be marked complete when preparation prevented implementation');
    assert.equal(result.verification[0].status, 'TOOL_UNAVAILABLE');
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_PREPARE_COMMANDS; else process.env.AGENT_PREPARE_COMMANDS = previous;
    await rm(root, { recursive: true, force: true });
  }
}


{
  const { root, repo } = await initRepo();
  const registry = fakeRegistry({ mode: 'review', writeIntent: 'not_requested' });
  try {
    await writeFile(join(repo, 'greeting.txt'), 'second\n');
    await exec('git', ['add', 'greeting.txt'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'second'], { cwd: repo });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const sourceCommit = stdout.trim();
    await writeFile(join(repo, 'greeting.txt'), 'third\n');
    await exec('git', ['add', 'greeting.txt'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'third'], { cwd: repo });

    const result = await runWorkflow({
      task: 'Review this historical commit.', config, registry, repoStart: repo,
      modeOverride: 'review', reviewTarget: { type: 'commit', revision: sourceCommit },
    });
    assert.equal(result.status, 'review_passed');
    assert.equal(result.reviewTarget?.sourceCommit, sourceCommit);
    assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
    const explorerPrompt = registry.requests.find((entry) => entry.role === 'explorer')?.request.prompt ?? '';
    const reviewerPrompt = registry.requests.find((entry) => entry.role.startsWith('reviewer'))?.request.prompt ?? '';
    assert.match(explorerPrompt, new RegExp(sourceCommit));
    assert.match(reviewerPrompt, /Review Git commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Zed Plan mode must force a read-only explorer -> planner flow, independent
// of router intent, tier and even an explicit /change slash-mode override.
{
  const { result, registry, events, greeting } = await runScenario(
    { mode: 'change', writeIntent: 'explicit' },
    { planOnly: true, modeOverride: 'change' },
  );
  assert.equal(result.status, 'planned');
  assert.equal(result.route.policy.mode, 'plan');
  assert.equal(result.route.policy.plan, true);
  assert.equal(result.route.policy.coder, null);
  assert.equal(result.route.policy.runVerification, false);
  assert.equal(greeting, 'hello');
  assert.deepEqual(registry.calls, ['router', 'explorer', 'planner']);
  assert.match(result.responseText, /## Plan/);
  assert.match(result.responseText, /### Steps/);
  assert.match(result.responseText, /Acceptance criteria/);
  assert.match(result.responseText, /no repository changes were applied/);
  assert.equal(events.filter((event) => event.type === 'plan').length, 1);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-2).type, 'routing_outcome', 'diagnostics must precede the terminal event');
  assert.equal(events.at(-2).status, 'planned');
  assert.equal(events.filter((event) => event.type === 'routing_outcome').length, 1);
  assert.ok(registry.requests.every(({ request }) => request.sandboxMode === 'read-only'));
}
{
  const { result, registry, events, greeting } = await runScenario(
    { mode: 'investigate', plannerText: true },
    { planOnly: true },
  );
  assert.equal(result.status, 'planned');
  assert.deepEqual(registry.calls, ['router', 'explorer', 'planner']);
  assert.equal(greeting, 'hello');
  assert.match(result.responseText, /^Edit greeting.txt/);
  assert.equal(events.some((event) => event.type === 'plan'), false, 'text fallback is not a machine-readable plan widget');
}
{
  const { result, registry, events } = await runScenario(
    { routerText: true, mode: 'change' },
    { planOnly: true },
  );
  assert.equal(result.status, 'intent_unresolved', 'Plan mode cannot silently succeed without a typed Router task');
  assert.equal(result.errorCode, 'missing_task_spec');
  assert.deepEqual(registry.calls, ['router']);
  assert.equal(events.some(event => event.type === 'route'), false);
}
{
  const { result, registry } = await runScenario({ mode: 'investigate' });
  assert.equal(result.status, 'investigated', 'Default mode must keep the original investigation route');
  assert.deepEqual(registry.calls, ['router', 'explorer', 'investigator']);
}

{
  const priorPlan = `### Steps\n1. Check signals in the whole module.\n2. Check regression tests.\n### Acceptance criteria\n- Confirm the result for all changed files.\nPrevious review had 337 changed files.`;
  const { result, registry } = await runScenario(
    { mode: 'review', inventoryFiles: 337, reviewedFiles: 11,
      reviewChecks: [{kind:'step',description:'Check signals in the whole module.'},
        {kind:'step',description:'Check regression tests.'},
        {kind:'acceptance',description:'Confirm the result for all changed files.'}],
      expectedFileCount: 337 },
    { task: 'Выполни ревью по предыдущему плану', sessionContextText: priorPlan, modeOverride: 'review' },
  );
  assert.equal(result.reviewCoverage.source, 'user');
  assert.equal(result.reviewCoverage.total, 3);
  assert.equal(result.status, 'review_incomplete');
  assert.match(registry.requests.find(({ role }) => role.startsWith('reviewer')).request.prompt, /Check signals in the whole module/);
}

const completeReviewChecks = [
  ...Array.from({length:16}, (_,i)=>({kind:'step',description:`Inspect functional scenario ${i+1}`})),
  ...Array.from({length:12}, (_,i)=>({kind:'acceptance',description:`Acceptance criterion ${i+1} is verified against the whole change.`})),
];
// The review skill's long, authoritative plan cannot be replaced by an
// incidental SHA from the Git history or the planner's smaller generic plan.
const completeReviewPlan = `Review the entire NWOF-6494 feature, not a single commit.
### Steps
${Array.from({ length: 16 }, (_, i) => `${i + 1}. ${i + 1}. Inspect functional scenario ${i + 1}; historical commit 5b731f8d14 is only context.`).join('\n')}
### Acceptance criteria
${Array.from({ length: 12 }, (_, i) => `- Acceptance criterion ${i + 1} is verified against the whole change.`).join('\n')}
### Relevant files
- src/modeling/sample.ts
The task requires reviewing 337 changed files.`;
{
  const { result, registry } = await runScenario(
    { mode: 'review', inventoryFiles: 337, reviewedFiles: 11, high: true, reviewChecks:completeReviewChecks, expectedFileCount:337 },
    { task: completeReviewPlan, modeOverride: 'review' },
  );
  assert.equal(result.reviewTarget, null, 'incidental commit reference cannot override the requested scope');
  assert.equal(result.status, 'review_incomplete', '11/337 files cannot be marked review_passed');
  assert.equal(result.planCompleted, false);
  assert.equal(result.reviewCoverage.checked, 16);
  assert.equal(result.reviewCoverage.total, 28);
  assert.equal(result.reviewCoverage.complete, false);
  assert.match(result.responseText, /Ревью не завершено/);
  assert.ok(result.reviewCoverage.gaps.some((gap) => gap.includes("Git scope not established")));
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 8);
  const followup = registry.requests.filter(({ role }) => role.startsWith('reviewer'))[1].request.prompt;
  assert.match(followup, /PRIOR REVIEW EVIDENCE/);
  assert.match(followup, /completedBatches\":1/);
  assert.match(followup, /CS1/);
  assert.ok(registry.requests.filter(({ role }) => role.startsWith('reviewer')).every(({ request }) => request.taskPlan === null), 'one reviewer batch must not complete the whole Zed plan');
  assert.equal(registry.calls.includes('finalValidator'), false);
  assert.equal(result.reviewLimits.repairAttemptsUsed, 0);
  const prompt = registry.requests.find(({ role }) => role.startsWith('reviewer')).request.prompt;
  assert.match(prompt, /CS1: Inspect functional scenario 1/);
  assert.doesNotMatch(prompt, /Review Git commit 5b731f8d14/);
  assert.equal(registry.calls.some((role) => role.startsWith('coder')), false);
}
{
  const { result, registry } = await runScenario(
    { mode: 'review', inventoryFiles: 337, reviewedFiles: 337, reviewChecks:completeReviewChecks, expectedFileCount:337 },
    { task: completeReviewPlan, modeOverride: 'review' },
  );
  assert.equal(result.status, 'review_incomplete', 'model-reported inventory alone cannot verify an unspecified Git scope');
  assert.equal(result.reviewCoverage.complete, false);
  assert.equal(result.planCompleted, false);
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 8);
}
{
  const { result, registry } = await runScenario(
    { mode: 'review', coverageBadOnce: true, reviewChecks:[{kind:'step',description:'Inspect greeting changes.'}] },
    { modeOverride: 'review', task: '### Steps\n1. Inspect greeting changes.' },
  );
  assert.equal(result.status, 'review_incomplete', 'malformed output must not trigger another expensive review');
  assert.equal(result.reviewLimits.repairAttemptsUsed, 0);
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 1);
}
{
  const { result, registry } = await runScenario(
    { mode: 'review', coverageBadAlways: true, reviewChecks:[{kind:'step',description:'Inspect greeting changes.'}] },
    { modeOverride: 'review', task: '### Steps\n1. Inspect greeting changes.\n2. Verify cleanup.' },
  );
  assert.equal(result.status, 'review_incomplete');
  assert.equal(result.reviewLimits.repairAttemptsUsed, 0);
  assert.equal(result.planCompleted, false);
  assert.ok(result.reviewCoverage.gaps.some((gap) => gap.includes('CS1')));
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 1, 'never re-run full review for JSON repair');
}
{
  const { result, registry } = await runScenario(
    { mode: 'review', coverageNotChecked: true, reviewChecks:[{kind:'step',description:'Inspect code without tests.'}] },
    { modeOverride: 'review', task: '### Steps\n1. Inspect the code without executing tests.' },
  );
  assert.equal(result.status, 'review_incomplete');
  assert.equal(result.reviewLimits.repairAttemptsUsed, 0, 'legitimate blocked coverage is not a formatting error');
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 1);
}
{
  const task = `### Steps\n${Array.from({ length: 45 }, (_, i) => `${i + 1}. Check scenario ${i + 1}`).join('\n')}`;
  const { result, registry } = await runScenario({ mode: 'review',
    reviewChecks:Array.from({length:45},(_,i)=>({kind:'step',description:`Check scenario ${i+1}`}))
  }, { modeOverride: 'review', task });
  assert.equal(result.status, 'review_incomplete', 'hard batch cap must not silently discard extra checklist items');
  assert.equal(result.reviewCoverage.total, 45);
  assert.equal(result.reviewCoverage.truncated, true);
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 8);
  assert.equal(result.planCompleted, false);
}

{
  const { result, registry } = await runScenario(
    { mode: 'review', mutateDuringReviewer: true, reviewChecks:[{kind:'step',description:'Inspect greeting.'}] },
    { modeOverride: 'review', task: '### Steps\n1. Inspect greeting.' },
  );
  assert.equal(result.status, 'review_incomplete', 'concurrent worktree drift invalidates an aggregated review pass');
  assert.ok(result.reviewCoverage.gaps.some((gap) => gap.includes('Repository changed')));
  assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 1, 'do not loop on live drift');
}


// Review groups are checkpoints, not retries. A failed later group must leave
// earlier evidence available for an identical-scope continuation, but a changed
// repository, inconsistent ledger or unrelated task must not reuse it.
{
  const { root, repo } = await initRepo();
  try {
    const task = `### Steps\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. Inspect feature component ${i + 1}.`).join('\n')}`;
    let checkpoint = null;
    const updates = [];
    const review10 = Array.from({length:10},(_,i)=>({kind:'step',description:`Inspect feature component ${i+1}`}));
    const firstRegistry = fakeRegistry({ mode: 'review', failReviewerAt: 2, reviewChecks: review10 });
    const initial = await runWorkflow({ task, config, registry: firstRegistry, repoStart: repo, modeOverride: 'review',
      onReviewCheckpoint: async (state) => { checkpoint = structuredClone(state); updates.push(state); } });
    assert.equal(initial.status, 'review_incomplete', 'provider failure must not claim completion');
    assert.equal(initial.reviewInterruption.code, 'RATE_LIMIT');
    assert.equal(initial.reviewCoverage.checked, 2);
    assert.equal(firstRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 2);
    assert.equal(checkpoint.status, 'in_progress');
    assert.equal(checkpoint.version, 3);
    assert.deepEqual(checkpoint.records.map((r) => r.id), ['CS1','CS2']);
    const nextRegistry = fakeRegistry({ mode: 'review', continuation: { mode: 'current_review' } });
    const events = [];
    const continued = await runWorkflow({ task: 'Продолжи ревью', config, registry: nextRegistry, repoStart: repo,
      reviewCheckpoint: checkpoint, onReviewCheckpoint: async (state) => { checkpoint = structuredClone(state); },
      reporter: async (event) => events.push(event) });
    assert.equal(continued.status, 'review_passed');
    assert.equal(continued.reviewCoverage.checked, 10);
    assert.equal(nextRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 4, 'completed units must not be re-run');
    assert.equal(nextRegistry.calls.filter(role=>role==='router').length,1,'fresh natural-language continuation requires one Router interpretation');
    assert.ok(!nextRegistry.calls.includes('explorer') && !nextRegistry.calls.includes('planner'), 'typed continuation must restore saved work plan without rebuilding it');
    assert.ok(events.some((event) => event.type === 'review_checkpoint_resumed'));
    assert.equal(checkpoint.status, 'finished');
    const forged = structuredClone(updates[0]);
    forged.records.push({ ...forged.records[0] });
    const corrupted = await runWorkflow({ task, config, registry: fakeRegistry({ mode: 'review', reviewChecks: review10 }), repoStart: repo,
      modeOverride: 'review', reviewCheckpoint: forged });
    assert.equal(corrupted.status, 'review_passed');
    assert.equal(corrupted.reviewLimits.completedBatches, 5, 'invalid checkpoint must force full review');
    const stale = structuredClone(updates[0]);
    await writeFile(join(repo, 'greeting.txt'), 'changed externally\n');
    const staleRegistry = fakeRegistry({ mode: 'review', reviewChecks: review10 });
    const staleResult = await runWorkflow({ task, config, registry: staleRegistry, repoStart: repo,
      modeOverride: 'review', reviewCheckpoint: stale });
    assert.equal(staleResult.reviewLimits.completedBatches, 5);
    assert.equal(staleRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 5,
      'changed checkout must invalidate previous evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
}


// Operation-level continuation across a full batch budget: 28 criterion Units,
// first run commits 16, second run invokes only the remaining 12. The router,
// explorer and planner must not run again, even after a different user turn.
{
  const { root, repo } = await initRepo();
  try {
    const task = `### Steps\n${Array.from({ length: 28 }, (_, i) => `${i + 1}. Inspect independent feature contract ${i + 1}.`).join('\n')}`;
    let checkpoint = null;
    const firstRegistry = fakeRegistry({ mode: 'review', reviewChecks: Array.from({length:28},(_,i)=>({kind:'step',description:`Inspect independent feature contract ${i+1}`})) });
    const first = await runWorkflow({ task, config, registry: firstRegistry, repoStart: repo, modeOverride: 'review',
      onReviewCheckpoint: async (value) => { checkpoint = structuredClone(value); } });
    assert.equal(first.status, 'review_incomplete');
    assert.equal(first.reviewCoverage.units.verified, 16);
    assert.equal(first.reviewCoverage.units.pending, 12);
    assert.equal(firstRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 8);
    assert.equal(checkpoint.version, 3);
    assert.equal(checkpoint.records.length, 16);
    const operationId = checkpoint.operation.id;
    const nextRegistry = fakeRegistry({ mode: 'review', continuation: { mode: 'current_review' } });
    const second = await runWorkflow({ task: 'Продолжи ревью', config, registry: nextRegistry, repoStart: repo,
      reviewCheckpoint: checkpoint, onReviewCheckpoint: async (value) => { checkpoint = structuredClone(value); } });
    assert.equal(second.status, 'review_passed');
    assert.equal(second.reviewOperationId, operationId);
    assert.equal(second.reviewCoverage.units.verified, 28);
    assert.equal(second.reviewCoverage.units.pending, 0);
    assert.equal(nextRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 6);
    assert.deepEqual(nextRegistry.calls.filter((role) => ['router','explorer','planner'].includes(role)), ['router'], 'new natural-language continuation uses Router once but reuses stored work plan');
    assert.equal(checkpoint.status, 'finished');
    assert.equal(checkpoint.records.length, 28);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A persistent Plan is applied without a second planner. Stage checkpoints
// never mark a partially written stage complete and never retry autonomously.
{
  const { root, repo } = await initRepo();
  try {
    const planned = await runWorkflow({ task: 'Plan the change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true });
    assert.equal(planned.status, 'planned');
    assert.equal(planned.planArtifact.plan.steps[0], 'Update data layer');
    assert.match(planned.responseText, /1\. Update data layer\n2\. Add selectors/);
    let checkpoint = null;
    const failRegistry = fakeRegistry({ longPlan: true, failStageAt: 2, continuation: { mode: 'current_implementation' } });
    const first = await runWorkflow({ task: 'Реализуй предыдущий план', config, registry: failRegistry, repoStart: repo,
      authoritativePlan: planned.planArtifact,
      onImplementationCheckpoint: async (value) => { checkpoint = structuredClone(value); } });
    assert.equal(first.status, 'implementation_incomplete');
    assert.equal(first.planCompleted, false);
    assert.equal(checkpoint.status, 'interrupted');
    assert.deepEqual(checkpoint.completedStages, ['I1']);
    assert.equal(failRegistry.calls.filter((role) => role === 'planner').length, 0, 'saved Plan must be authoritative');
    assert.equal(failRegistry.calls.filter((role) => role.startsWith('coder')).length, 2, 'no automatic retry on partial edits');
    const events = [];
    const resumedRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const resumed = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: resumedRegistry,
      repoStart: repo, authoritativePlan: planned.planArtifact, implementationCheckpoint: checkpoint,
      onImplementationCheckpoint: async (value) => { checkpoint = structuredClone(value); },
      reporter: async (event) => events.push(event) });
    assert.equal(resumed.status, 'applied');
    assert.equal(resumed.planCompleted, true);
    assert.equal(resumedRegistry.calls.filter((role) => role.startsWith('coder')).length, 1, 'must resume only incomplete stage');
    assert.ok(events.some((event) => event.type === 'implementation_checkpoint_resumed'));
    assert.equal(checkpoint.status, 'finished');
    assert.equal(resumed.acceptanceCoverage.results.length, 2);
    await writeFile(join(repo, 'greeting.txt'), 'external update\n');
    const staleRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const stale = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: staleRegistry,
      repoStart: repo, authoritativePlan: planned.planArtifact, implementationCheckpoint: checkpoint });
    assert.equal(stale.status, 'implementation_incomplete');
    assert.equal(staleRegistry.calls.filter((role) => role.startsWith('coder')).length, 0, 'stale checkpoint must never write');
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const { root, repo } = await initRepo();
  try {
    const planned = await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true });
    const registry = fakeRegistry({ longPlan: true, invalidAcceptance: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Реализуй план', config, registry, repoStart: repo, authoritativePlan: planned.planArtifact });
    assert.equal(result.status, 'implementation_incomplete', 'incomplete acceptance evidence must not claim success');
    assert.equal(result.planCompleted, false);
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Out-of-band drift after the initial plan check must never erase the
// completed-stage prefix or restart coding from stage I1.
{
  const { root, repo } = await initRepo();
  try {
    const planned = await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true });
    const registry = fakeRegistry({ longPlan: true, mutateDuringExplorer: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Реализуй предыдущий план', config, registry, repoStart: repo,
      authoritativePlan: planned.planArtifact });
    assert.equal(result.status, 'implementation_incomplete');
    assert.ok(['pre_write_checkout_drift', 'stale_plan_or_checkpoint'].includes(result.implementationCoverage.reason));
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A well-understood one-line edit auto-reconciles in the same request.
{
  const { root, repo } = await initRepo();
  try {
    let plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    let checkpoint = null;
    let pending = null;
    const saveCheckpoint = async (value) => { checkpoint = structuredClone(value); };
    const saveReconciliation = async ({ plan: nextPlan, checkpoint: nextCheckpoint, proposal }) => {
      plan = structuredClone(nextPlan); checkpoint = nextCheckpoint ? structuredClone(nextCheckpoint) : null; pending = proposal;
    };
    await runWorkflow({ task: 'Реализуй предыдущий план', config, registry: fakeRegistry({ longPlan: true, failStageAt: 2, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: plan, onImplementationCheckpoint: saveCheckpoint });
    assert.deepEqual(checkpoint.completedStages, ['I1']);
    // The previous stage already dirtied greeting.txt, so a manual edit can be
    // compared against its exact saved digest.
    await writeFile(join(repo, 'greeting.txt'), 'hello stage 2\nmanual hotfix\n');
    // A genuinely incompatible change can still be blocked by investigator;
    // core validation is NOT evidence of semantic compatibility.
    const incompatibleRegistry = fakeRegistry({ longPlan: true, reconciliationBlocked: true, requireVerifiedCheckpointContext: true, continuation: { mode: 'current_implementation' } });
    const incompatible = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: incompatibleRegistry, repoStart: repo,
      authoritativePlan: plan, implementationCheckpoint: checkpoint, onImplementationReconciliation: saveReconciliation });
    assert.equal(incompatible.implementationCoverage.reason, 'reconciliation_blocked');
    assert.equal(incompatibleRegistry.calls.filter((role) => role.startsWith('coder')).length, 0);
    assert.deepEqual(checkpoint.completedStages, ['I1'], 'semantic rejection preserves checkpoint');
    const registry = fakeRegistry({ longPlan: true, reconciliationSafe: true, requireVerifiedCheckpointContext: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry, repoStart: repo,
      authoritativePlan: plan, implementationCheckpoint: checkpoint, onImplementationCheckpoint: saveCheckpoint,
      onImplementationReconciliation: saveReconciliation });
    assert.equal(result.status, 'applied');
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 1);
    assert.equal(registry.calls.filter((role) => role === 'investigator').length, 1);
    assert.equal(checkpoint.reconciliationHistory.length, 1);
    assert.equal(checkpoint.reconciliationHistory[0].automatic, true);
    assert.equal(pending, null);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A newly modified but previously clean tracked file is also eligible for
// automatic reconciliation. An untracked file is not.
{
  const { root, repo } = await initRepo();
  try {
    const plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    await writeFile(join(repo, 'greeting.txt'), 'manual one-line fix\n');
    let saved = null;
    let proposalSaved = null;
    const registry = fakeRegistry({ longPlan: true, reconciliationSafe: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Реализуй предыдущий план', config, registry, repoStart: repo,
      authoritativePlan: plan, onImplementationCheckpoint: async (value) => { saved = value; },
      onImplementationReconciliation: async (value) => { proposalSaved = value; } });
    assert.equal(result.status, 'applied');
    assert.ok(saved?.completedStages.length > 0);
    assert.equal(proposalSaved?.proposal, null);
    assert.equal(registry.calls.filter((role) => role === 'investigator').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
}
// Legacy plans lack an exact dirty-file snapshot and can never auto-consent.
{
  const { root, repo } = await initRepo();
  try {
    let plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    let pending = null;
    let checkpoint = null;
    const save = async ({ plan: value, checkpoint: cp, proposal }) => { plan = value; checkpoint = cp; pending = proposal; };
    await writeFile(join(repo, 'greeting.txt'), 'manual edit\n');
    const offered = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: fakeRegistry({ longPlan: true, reconciliationSafe: true, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: { ...plan, repoSnapshot: undefined }, onImplementationReconciliation: save });
    assert.equal(offered.implementationCoverage.reason, 'reconciliation_confirmation_required');
    assert.equal(pending.changes.exact, false);
    const resumed = await runWorkflow({ task: 'Подтверждаю, продолжай', config, registry: fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: plan, implementationReconciliation: pending,
      onImplementationReconciliation: save, onReconciliationDecision: async () => 'accept_checkout',
      onImplementationCheckpoint: async (value) => { checkpoint = value; } });
    assert.equal(resumed.status, 'applied');
    assert.equal(pending, null);
  } finally { await rm(root, { recursive: true, force: true }); }
}
// A changed index requires confirmation even with a safe model verdict.
{
  const { root, repo } = await initRepo();
  try {
    const plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    await exec('git', ['update-index', '--chmod=+x', 'greeting.txt'], { cwd: repo });
    const registry = fakeRegistry({ longPlan: true, reconciliationSafe: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry,
      repoStart: repo, authoritativePlan: plan, onImplementationReconciliation: async () => {} });
    assert.equal(result.implementationCoverage.reason, 'reconciliation_confirmation_required');
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Risky reconciliation still requires an independent user confirmation.
// It is session-scoped, bound to the exact checkout, and resumes only missing stages.
{
  const { root, repo } = await initRepo();
  try {
    let plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    let checkpoint = null;
    let pending = null;
    const onImplementationCheckpoint = async (value) => { checkpoint = structuredClone(value); };
    const onImplementationReconciliation = async ({ plan: updatedPlan, checkpoint: updatedCheckpoint, proposal }) => {
      plan = structuredClone(updatedPlan);
      checkpoint = updatedCheckpoint ? structuredClone(updatedCheckpoint) : null;
      pending = proposal ? structuredClone(proposal) : null;
    };
    await runWorkflow({ task: 'Реализуй предыдущий план', config, registry: fakeRegistry({ longPlan: true, failStageAt: 2, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: plan, onImplementationCheckpoint });
    assert.deepEqual(checkpoint.completedStages, ['I1']);
    assert.ok(checkpoint.repoSnapshot?.workspaceHashes, 'new checkpoints include file hashes');
    await writeFile(join(repo, 'greeting.txt'), 'hello stage 2\nmanual production hotfix\n');
    const reconcileRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const offered = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: reconcileRegistry,
      repoStart: repo, authoritativePlan: plan, implementationCheckpoint: checkpoint,
      onImplementationReconciliation });
    assert.equal(offered.status, 'implementation_incomplete');
    assert.equal(offered.implementationCoverage.reason, 'reconciliation_confirmation_required');
    assert.match(offered.responseText, /Подтверждаю согласование и продолжи реализацию плана/);
    assert.doesNotMatch(offered.responseText, /[a-f0-9]{12} и продолжи/);
    assert.deepEqual(reconcileRegistry.calls, ['router', 'investigator']);
    assert.ok(pending && pending.changes.changedPaths.includes('greeting.txt'));
    const againRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const again = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: againRegistry,
      repoStart: repo, authoritativePlan: plan, implementationCheckpoint: checkpoint,
      implementationReconciliation: pending, onImplementationReconciliation });
    assert.equal(again.implementationCoverage.reason, 'reconciliation_confirmation_required');
    assert.deepEqual(againRegistry.calls, ['router'], 'fresh request routes once but must not repeat reconciliation analysis');
    const wrongRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const wrong = await runWorkflow({ task: 'Подтверждаю согласование 000000000000 и продолжи реализацию плана', config, registry: wrongRegistry,
      repoStart: repo, authoritativePlan: plan, implementationCheckpoint: checkpoint,
      implementationReconciliation: pending, onImplementationReconciliation });
    assert.equal(wrong.implementationCoverage.reason, 'reconciliation_confirmation_required', 'user text cannot grant host approval');
    assert.deepEqual(wrongRegistry.calls, ['router']);
    const acceptedRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const accepted = await runWorkflow({ task: 'Подтверждаю согласование и продолжи реализацию плана', config, registry: acceptedRegistry,
      repoStart: repo, authoritativePlan: plan, implementationCheckpoint: checkpoint,
      implementationReconciliation: pending, onImplementationReconciliation,
      onReconciliationDecision: async () => 'accept_checkout', onImplementationCheckpoint });
    assert.equal(accepted.status, 'applied');
    assert.equal(acceptedRegistry.calls.filter((role) => role.startsWith('coder')).length, 1, 'first completed stage must not run again');
    assert.equal(pending, null);
    assert.equal(checkpoint.reconciliationHistory.length, 1);
    assert.equal(checkpoint.reconciliationHistory[0].revalidationRequired, true);
    assert.equal(checkpoint.status, 'finished');
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const { root, repo } = await initRepo();
  try {
    const plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    await writeFile(join(repo, 'greeting.txt'), 'manual change\n');
    let pending = null;
    const save = async ({ proposal }) => { pending = proposal; };
    const offered = await runWorkflow({ task: 'Реализуй предыдущий план', config, registry: fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: plan, onImplementationReconciliation: save });
    assert.equal(offered.implementationCoverage.reason, 'reconciliation_confirmation_required');
    const original = pending;
    await writeFile(join(repo, 'greeting.txt'), 'another manual change\n');
    const plainRegistry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const stalePlain = await runWorkflow({ task: 'Подтверждаю согласование и продолжи реализацию плана',
      config, registry: plainRegistry, repoStart: repo, authoritativePlan: plan,
      implementationReconciliation: original, onImplementationReconciliation: save,
      onReconciliationDecision: async () => 'accept_checkout' });
    assert.equal(stalePlain.implementationCoverage.reason, 'invalid_reconciliation_confirmation');
    assert.deepEqual(plainRegistry.calls, ['router']);
    const registry = fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } });
    const declined = await runWorkflow({ task: `Подтверждаю согласование ${original.token} и продолжи реализацию плана`,
      config, registry, repoStart: repo, authoritativePlan: plan,
      implementationReconciliation: original, onImplementationReconciliation: save,
      onReconciliationDecision: async () => 'accept_checkout' });
    assert.equal(declined.implementationCoverage.reason, 'invalid_reconciliation_confirmation');
    assert.deepEqual(registry.calls, ['router'], 'new text is routed once, but stale token cannot invoke coder');
    await exec('git', ['commit', '--allow-empty', '-m', 'unexpected HEAD movement'], { cwd: repo });
    const blocked = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry: fakeRegistry({ longPlan: true, continuation: { mode: 'current_implementation' } }),
      repoStart: repo, authoritativePlan: plan, onImplementationReconciliation: save });
    assert.equal(blocked.implementationCoverage.reason, 'reconciliation_unsafe_scope');
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const { root, repo } = await initRepo();
  try {
    const plan = (await runWorkflow({ task: 'Plan change', config, registry: fakeRegistry({ longPlan: true }), repoStart: repo, planOnly: true })).planArtifact;
    await writeFile(join(repo, 'greeting.txt'), 'manual change\n');
    const registry = fakeRegistry({ longPlan: true, reconciliationInvalid: true, continuation: { mode: 'current_implementation' } });
    const result = await runWorkflow({ task: 'Продолжи реализацию плана', config, registry, repoStart: repo,
      authoritativePlan: plan, onImplementationReconciliation: async () => { throw new Error('unexpected checkpoint save'); } });
    assert.equal(result.implementationCoverage.reason, 'reconciliation_blocked');
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}
// Verification-only stages are allowed to complete without a second diff,
// but a failed check must not be converted to an accepted checkpoint.
{
  const success = await runScenario({ high: true, longPlan: true, verificationOnlyLastStage: true });
  assert.equal(success.result.status, 'applied');
  assert.ok(success.events.some((event) => event.type === 'implementation_stage_done' && event.stage === 'I2'));
  const failure = await runScenario({ high: true, longPlan: true, verificationOnlyLastStage: true, verificationCheckFailed: true });
  assert.equal(failure.result.status, 'implementation_incomplete');
  assert.ok(failure.result.implementationCoverage.gaps.some((gap) => gap.includes('verification_failed')));
  assert.equal(failure.result.implementationCoverage.reason, 'verification_failed');
}
// An interrupted first batch must not produce a synthetic PASS verdict.
{
  const { result } = await runScenario({ mode: 'review', failReviewerAt: 1 },
    { modeOverride: 'review', task: 'Review changed source' });
  assert.equal(result.status, 'review_incomplete');
  assert.equal(result.review.verdict, 'unknown');
  assert.equal(result.reviewCoverage.checked, 0);
}
// A skill-driven review and an ordinary review workflow share the same
// invocation recovery policy. The user-facing command name is irrelevant.
{
  const { result, registry, events } = await runScenario({ mode: 'review', providerCancelReviewerAt: 1 },
    { modeOverride: 'review', task: 'Review branch changes for regressions' });
  assert.equal(result.status, 'review_passed', 'a scope-free read-only review may complete after recovered cancellation');
  assert.equal(registry.calls.filter(role => role.startsWith('reviewer')).length, 3);
  assert.equal(events.filter(event => event.type === 'invocation_retry_scheduled').length, 1);
  assert.equal(events.filter(event => event.type === 'invocation_recovered').length, 1);
}
// Exactly one fresh read-only reviewer invocation is retried on an unexpected
// provider cancellation. No coder, implementation stage or verification is
// rerun in that process.
{
  const recovered = await runScenario({ high: true, longPlan: true, providerCancelReviewerAt: 1 });
  assert.equal(recovered.result.status, 'applied');
  assert.equal(recovered.registry.calls.filter((role) => role.startsWith('reviewer')).length, 2);
  assert.equal(recovered.registry.calls.filter((role) => role.startsWith('coder')).length, 2);
  assert.deepEqual(recovered.events.filter((event) => event.type === 'invocation_retry_scheduled').map((event) => event.attempt), [2]);
  assert.equal(new Set(recovered.events.filter((event) => event.type === 'role_start' && event.role.startsWith('reviewer')).map((event) => event.invocationId)).size, 2,
    'fresh role invocation identity is required after provider cancellation');
}
{
  const { root, repo } = await initRepo();
  try {
    let checkpoint = null;
    let savedPlan = null;
    const registry = fakeRegistry({ high: true, longPlan: true, providerCancelAllReviewers: true });
    const events = [];
    const result = await runWorkflow({ task: 'Implement the change', config, registry, repoStart: repo,
      onImplementationPlan: async (value) => { savedPlan = structuredClone(value); },
      onImplementationCheckpoint: async (value) => { checkpoint = structuredClone(value); },
      reporter: async (event) => events.push(event) });
    assert.equal(result.status, 'review_interrupted');
    assert.equal(result.planCompleted, false);
    assert.equal(checkpoint.status, 'review_interrupted');
    assert.deepEqual(checkpoint.completedStages, ['I1', 'I2']);
    assert.equal(checkpoint.interruption.reason, 'review_provider_cancelled');
    assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 2);
    assert.equal(registry.calls.filter((role) => role.startsWith('coder')).length, 2);
    assert.ok(events.some((event) => event.type === 'review_interrupted'));
    assert.match(result.responseText, /final acceptance is NOT complete/);
    const restored = await runWorkflow({ task: 'Continue saved plan', config, registry: fakeRegistry({ longPlan: true }),
      repoStart: repo, authoritativePlan: savedPlan, implementationCheckpoint: checkpoint,
      onImplementationCheckpoint: async (value) => { checkpoint = structuredClone(value); } });
    assert.notEqual(restored.implementationCoverage?.reason, 'checkpoint_not_reusable');
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Git-grounded file Units are independently resumable across runs. Limits cap
// invocations per run, not the authoritative scope of the review.
{
  const { root, repo } = await initRepo();
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const base = stdout.trim();
    for (let i = 0; i < 65; i++) await writeFile(join(repo, `part-${String(i).padStart(3, '0')}.ts`), `export const value${i} = ${i};\n`);
    await exec('git', ['add', '.'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Add multiple independent source units'], { cwd: repo });
    const task = `Review the entire diff ${base}...HEAD\n### Steps\n1. Check functional changes and regressions.`;
    let checkpoint;
    const typedFileReview = { mode:'review', gitSelector:{type:'range',left:base,right:'HEAD',notation:'...'},
      reviewChecks:[{kind:'step',description:'Check functional changes and regressions.'}] };
    const firstRegistry = fakeRegistry(typedFileReview);
    const initial = await runWorkflow({ task, config, registry: firstRegistry, repoStart: repo, modeOverride: 'review',
      onReviewCheckpoint: async (value) => { checkpoint = structuredClone(value); } });
    assert.equal(initial.status, 'review_incomplete');
    assert.equal(initial.reviewCoverage.files.total, 65);
    assert.equal(initial.reviewCoverage.units.total, 18, '1 criterion + 17 file groups');
    assert.equal(initial.reviewCoverage.units.verified, 16);
    assert.equal(initial.reviewCoverage.files.verified, 64);
    assert.equal(checkpoint.records.length, 16);
    assert.equal(checkpoint.version, 3);
    const secondRegistry = fakeRegistry({ mode:'review', continuation:{mode:'current_review'} });
    const resumedEvents = [];
    const resumed = await runWorkflow({ task, config, registry: secondRegistry, repoStart: repo, modeOverride: 'review',
      reviewCheckpoint: checkpoint, onReviewCheckpoint: async (value) => { checkpoint = structuredClone(value); },
      reporter: async (event) => resumedEvents.push(event) });
    assert.equal(resumed.status, 'review_passed');
    assert.equal(resumed.reviewCoverage.files.verified, 65);
    assert.equal(resumed.reviewCoverage.units.verified, 18);
    assert.equal(secondRegistry.calls.filter((role) => role.startsWith('reviewer')).length, 2);
    assert.ok(resumedEvents.some((event) => event.type === 'review_checkpoint_resumed'));
    assert.equal(checkpoint.status, 'finished');

    // Replaying the same logical unit with a different batch size must not
    // erase independent verified evidence.
    const safetyRegistry = fakeRegistry({ ...typedFileReview, omitFilePaths:true });
    const unverified = await runWorkflow({ task, config, registry: safetyRegistry, repoStart: repo, modeOverride: 'review' });
    assert.equal(unverified.status, 'review_incomplete');
    assert.equal(unverified.reviewCoverage.files.verified, 0, 'missing explicit file-path proof must not count');
    assert.equal(unverified.reviewCoverage.checked, 0, 'criteria wait for source Units when the per-run budget is exhausted');
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A changed referenced baseline must invalidate a checkpoint even if the
// checked-out files and HEAD remain unchanged.
{
  const { root, repo } = await initRepo();
  try {
    await exec('git', ['branch', 'base-review'], { cwd: repo });
    for (let i = 0; i < 35; i++) await writeFile(join(repo, `part-${i}.ts`), `export const value = ${i};\n`);
    await exec('git', ['add', '.'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Large feature'], { cwd: repo });
    const task = 'Review base-review...HEAD\n### Steps\n1. Inspect regression risks.';
    let checkpoint;
    const initial = await runWorkflow({ task, config, registry: fakeRegistry({ mode:'review', gitSelector:{type:'range',left:'base-review',right:'HEAD',notation:'...'} }), repoStart: repo,
      modeOverride: 'review', onReviewCheckpoint: async (value) => { checkpoint = structuredClone(value); },
      config: { ...config, policy: { ...config.policy, reviewWork: { maxBatchesPerRun: 1 } } } });
    assert.equal(initial.status, 'review_incomplete');
    const baselineSaved = checkpoint;
    const continuedEvents = [];
    const regroup = await runWorkflow({ task, config: { ...config, policy: { ...config.policy,
      reviewWork: { maxBatchesPerRun: 2, maxUnitsPerBatch: 1 } } }, registry: fakeRegistry({ mode:'review', continuation:{mode:'current_review'} }),
      repoStart: repo, modeOverride: 'review', reviewCheckpoint: baselineSaved,
      reporter: async (event) => continuedEvents.push(event) });
    assert.ok(continuedEvents.some((event) => event.type === 'review_checkpoint_resumed'), 'batch layout should not invalidate stable units');
    await exec('git', ['branch', '-f', 'base-review', 'HEAD'], { cwd: repo });
    const invalidatedEvents = [];
    await runWorkflow({ task, config, registry: fakeRegistry({ mode:'review', continuation:{mode:'current_review'} }), repoStart: repo, modeOverride: 'review',
      reviewCheckpoint: baselineSaved, reporter: async (event) => invalidatedEvents.push(event) });
    assert.ok(invalidatedEvents.some((event) => event.type === 'review_checkpoint_rejected'));
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const { root, repo } = await initRepo();
  try {
    await exec('git', ['branch', 'base-review'], { cwd: repo });
    await writeFile(join(repo, 'feature.ts'), 'export const feature = true;\n');
    await exec('git', ['add', '.'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Feature change'], { cwd: repo });
    const events = [];
    const result = await runWorkflow({ task: 'Review base-review...HEAD', config,
      registry: fakeRegistry({ mode:'review', moveReviewBaseDuringReviewer:true,
        gitSelector:{type:'range',left:'base-review',right:'HEAD',notation:'...'} }),
      repoStart: repo, modeOverride: 'review', reporter: async (event) => events.push(event) });
    assert.equal(result.status, 'review_incomplete', 'moving review base during a provider turn must invalidate the result');
    assert.equal(result.reviewCoverage.files.verified, 0);
    assert.ok(events.some((event) => event.type === 'review_scope_invalidated'));
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A rename whose old side is denied must not appear in assigned work or
// silently count toward complete coverage, even if its new side is public.
{
  const { root, repo } = await initRepo();
  try {
    await mkdir(join(repo, 'secret'), { recursive: true });
    await writeFile(join(repo, 'secret', 'tokens.ts'), 'export const sensitive = true;\n');
    await exec('git', ['add', 'secret/tokens.ts'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Old private location'], { cwd: repo });
    const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await mkdir(join(repo, 'public'), { recursive: true });
    await exec('git', ['mv', 'secret/tokens.ts', 'public/tokens.ts'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Move formerly private content'], { cwd: repo });
    const secureConfig = { ...config, security: { ...config.security, denyGlobs: ['secret/**'] } };
    const registry = fakeRegistry({mode:'review',gitSelector:{type:'range',left:base,right:'HEAD',notation:'...'}});
    const result = await runWorkflow({ task: `Review ${base}...HEAD`, config: secureConfig,
      registry, repoStart: repo, modeOverride: 'review' });
    assert.equal(result.status, 'review_incomplete');
    assert.equal(result.reviewCoverage.files.total, 1);
    assert.equal(result.reviewCoverage.files.verified, 0);
    assert.ok(result.reviewCoverage.gaps.some((gap) => gap.includes('inaccessible')));
    for (const request of registry.requests.filter((entry) => entry.role.startsWith('reviewer'))) {
      assert.doesNotMatch(request.request.prompt, /secret\/tokens\.ts|public\/tokens\.ts/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

// An unverified prerequisite must prevent downstream units from starting.
{
  const { root, repo } = await initRepo();
  try {
    await mkdir(join(repo, 'src/modules/auth'), { recursive: true });
    await mkdir(join(repo, 'src/modules/checkout'), { recursive: true });
    const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await writeFile(join(repo, 'src/modules/auth/core.ts'), 'export const auth = true;\n');
    await writeFile(join(repo, 'src/modules/checkout/payment.ts'), "import { auth } from '../auth/core';\n");
    await exec('git', ['add', '.'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'Add related modules'], { cwd: repo });
    const registry = fakeRegistry({mode:'review',omitFilePaths:true,gitSelector:{type:'range',left:base,right:'HEAD',notation:'...'}});
    const results = await runWorkflow({ task: `Review ${base}...HEAD`, config, registry,
      repoStart: repo, modeOverride: 'review' });
    assert.equal(results.status, 'review_incomplete');
    assert.equal(results.reviewCoverage.units.verified, 0);
    assert.equal(registry.calls.filter((role) => role.startsWith('reviewer')).length, 1,
      'importer and acceptance checks remain blocked by unverified imported source');
  } finally { await rm(root, { recursive: true, force: true }); }
}

console.log('workflow-unstructured: passed');
