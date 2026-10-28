#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeReviewCoverage } from './fake-review-coverage.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';

const args = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;

if (args[0] === '--version') {
  console.log('codex-cli 0.153.1');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}

const execIndex = args.indexOf('exec');
const approvalIndex = args.indexOf('--ask-for-approval');
if (execIndex >= 0 && approvalIndex > execIndex) {
  console.error("error: unexpected argument '--ask-for-approval' found");
  process.exit(2);
}
if (execIndex < 0) {
  console.error(`Unsupported fake codex invocation: ${args.join(' ')}`);
  process.exit(2);
}

const sandboxIndex = args.indexOf('--sandbox');
const sandboxMode = sandboxIndex >= 0 ? args[sandboxIndex + 1] : null;
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) process.exit(3);
const outputPath = args[outputIndex + 1];
if (!args.includes('--json')) { console.error('Expected --json streaming mode.'); process.exit(35); }

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();

let role = 'unknown';
if (prompt.includes('Classify the software-engineering task')) role = 'router';
else if (prompt.includes('Inspect the repository only enough')) role = 'explorer';
else if (prompt.includes('Produce the smallest grounded execution plan')) role = 'planner';
else if (prompt.includes('Synthesize a read-only investigation')) role = 'investigator';
else if (prompt.includes('Implement the requested change directly')) role = 'coder';
else if (prompt.includes('Review independently')) role = 'reviewer';
else if (prompt.includes('Perform a risk-focused final validation')) role = 'finalValidator';
else if (prompt.includes('Produce the final user-facing answer after the orchestration workflow has completed')) role = 'responder';

if (log) await appendFile(log, JSON.stringify({ cwd: process.cwd(), args, sandboxMode, role }) + '\n');

console.log(JSON.stringify({ type: 'item.updated', item: { id: `reasoning-${role}`, type: 'reasoning', text: `Inspecting ${role} evidence` } }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: `reasoning-${role}`, type: 'reasoning', text: `Inspecting ${role} evidence before producing the structured result.` } }));
if (args.includes('tools.update_plan.enabled=true')) {
  console.log(JSON.stringify({ type: 'item.updated', item: { id: `todo-${role}`, type: 'todo_list', items: [
    { text: 'Inspect evidence', completed: true },
    { text: 'Complete task', completed: false },
  ] } }));
}
console.log(JSON.stringify({ type: 'item.completed', item: { id: `commentary-${role}`, type: 'agent_message', text: `I am checking the relevant ${role} evidence in more detail before returning the structured result.` } }));
console.log(JSON.stringify({ type: 'item.started', item: { id: `tool-${role}`, type: 'command_execution', command: 'git status --short', aggregated_output: '', status: 'in_progress' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: `tool-${role}`, type: 'command_execution', command: 'git status --short', aggregated_output: '', exit_code: 0, status: 'completed' } }));

if (process.env.FAKE_EXPECT_COMMIT_REVIEW === '1') {
  const sourceCommit = process.env.FAKE_SOURCE_COMMIT;
  if (!sourceCommit) { console.error('Missing FAKE_SOURCE_COMMIT.'); process.exit(31); }
  const resolved = spawnSync('git', ['rev-parse', '--verify', `${sourceCommit}^{commit}`], { cwd: process.cwd(), encoding: 'utf8' });
  if (resolved.status !== 0) {
    console.error(`Requested source commit is not reachable in model cwd: ${sourceCommit}`);
    process.exit(32);
  }
  const show = spawnSync('git', ['show', '--format=', '--no-ext-diff', sourceCommit, '--', 'greeting.txt'], { cwd: process.cwd(), encoding: 'utf8' });
  if (show.status !== 0 || !show.stdout.includes('+hello target')) {
    console.error(`Real commit review diff is unavailable:\n${show.stdout}\n${show.stderr}`);
    process.exit(33);
  }
  if (!prompt.includes(sourceCommit)) {
    console.error('Requested source commit ID was not provided to the review role.');
    process.exit(34);
  }
}

const high = prompt.includes('HIGH_RISK');
const reviewOnly = prompt.includes('TASK MODE OVERRIDE: review') || /USER TASK:\n(?:REVIEW_ONLY|REVIEW_FINDING|Review\b)/i.test(prompt);
const investigateOnly = prompt.includes('TASK MODE OVERRIDE: investigate') || prompt.includes('INVESTIGATE_ONLY');
const needsFix = prompt.includes('NEEDS_FIX') || prompt.includes('ESCALATE');
const escalate = prompt.includes('ESCALATE');
let output;

if (role === 'router') {
  // The protocol fixture models the Router's typed output. Classifying these
  // fixed test inputs here is only a deterministic fake-provider response.
  const planOnly = prompt.includes('PLAN-ONLY MODE:');
  const continuation = /USER TASK:\nImplement saved plan(?:\n|$)/.test(prompt);
  const operation = planOnly ? 'plan' : reviewOnly ? 'review' : investigateOnly ? 'investigate' : 'change';
  const task = emptyTaskSpec(operation, operation === 'change' ? 'explicit' : 'not_requested');
  if (continuation) task.continuation = {mode:'current_implementation'};
  output = {mode:operation==='plan'?'investigate':operation,
    writeIntent:operation==='change'?'explicit':'not_requested',
    complexity:high?'high':'low',risk:high?'security_or_data':'normal',
    reason:'typed fake-provider route',task};
} else if (role === 'explorer') {
  output = {
    summary: 'Greeting is stored in greeting.txt.',
    relevantFiles: ['greeting.txt'],
    constraints: [],
    existingPatterns: ['Single-line text file'],
    likelyVerification: ['git diff --check'],
    unknowns: [],
  };
} else if (role === 'planner') {
  output = {
    goal: 'Update the greeting.',
    steps: ['Update greeting.txt'],
    acceptanceCriteria: ['Greeting contains requested text'],
    risks: [],
    expectedFiles: ['greeting.txt'],
    engineeringFrame: { currentOwner: 'greeting.txt', existingAbstractions: [], generalMechanism: 'Store the greeting text.', specificPolicy: 'Use the requested greeting.', targetPlacement: ['greeting.txt'], stateOwnership: [], resourceOwnership: [], contractRisks: ['Preserve file semantics.'], avoid: ['Unrelated refactors.'], uncertainties: [] },
  };
} else if (role === 'investigator') {
  output = 'The greeting is implemented in `greeting.txt`.\n\n```ts\nconst greeting = "hello";\n```';
} else if (role === 'coder') {
  if (sandboxMode !== 'workspace-write') {
    console.error(`Coder expected workspace-write sandbox, got ${sandboxMode}`);
    process.exit(40);
  }
  if (process.env.FAKE_EXPECT_CODER_HISTORY === '1') {
    const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
    if (count.status !== 0 || Number(count.stdout.trim()) < 2) {
      console.error(`Coder does not have full Git history in the real workspace: ${count.stdout} ${count.stderr}`);
      process.exit(42);
    }
  }
  const current = (await readFile('greeting.txt', 'utf8')).trim();
  if (prompt.includes('DENIED_PATCH')) {
    await mkdir('config', { recursive: true });
    await writeFile('config/development.json', 'should-not-be-written\n');
    output = { action: 'changed', summary: 'Attempt a policy-denied change.', changedFiles: ['config/development.json'], notes: [] };
  } else if (current === 'hello') {
    await writeFile('greeting.txt', 'hello world\n');
    output = { action: 'changed', summary: 'Update greeting.', changedFiles: ['greeting.txt'], notes: [] };
  } else if (current === 'hello world' && needsFix) {
    await writeFile('greeting.txt', 'hello world!\n');
    output = { action: 'changed', summary: 'Apply requested review fix.', changedFiles: ['greeting.txt'], notes: [] };
  } else {
    output = { action: 'no_change', summary: 'No further change.', changedFiles: [], notes: [] };
  }
} else if (role === 'reviewer') {
  if (sandboxMode !== 'read-only') {
    console.error(`Reviewer expected read-only sandbox, got ${sandboxMode}`);
    process.exit(41);
  }
  const fixed = prompt.includes('+hello world!');
  const reviewFinding = prompt.includes('REVIEW_FINDING');
  output = reviewFinding
    ? {
        verdict: 'fix',
        summary: 'Review-only smoke finding.',
        issues: [{ severity: 'major', path: 'greeting.txt', message: 'Example review finding.', suggestedFix: 'Consider changing the greeting.' }],
      }
    : escalate && !fixed
      ? {
          verdict: 'escalate',
          summary: 'Smoke-test requests stronger validation.',
          issues: [{ severity: 'major', path: 'greeting.txt', message: 'Escalated decision.', suggestedFix: 'Decide whether punctuation is required.' }],
          }
      : needsFix && !fixed
        ? {
            verdict: 'fix',
            summary: 'Smoke-test requests one fix.',
            issues: [{ severity: 'major', path: 'greeting.txt', message: 'Missing exclamation mark.', suggestedFix: 'Append !.' }],
              }
        : { verdict: 'pass', summary: 'No blocking issues.', issues: [] };
  const scopedFixture = fakeReviewCoverage(prompt);
  if (scopedFixture) output = { ...output, ...scopedFixture };
  } else if (role === 'finalValidator') {
  const fixed = prompt.includes('+hello world!');
  const reviewFinding = prompt.includes('REVIEW_FINDING');
  output = reviewFinding
    ? {
        verdict: 'fix',
        summary: 'Review-only smoke finding.',
        issues: [{ severity: 'major', path: 'greeting.txt', message: 'Example review finding.', suggestedFix: 'Consider changing the greeting.' }],
      }
    : escalate && !fixed
      ? {
          verdict: 'fix',
          summary: 'Escalation resolved: punctuation is required.',
          issues: [{ severity: 'major', path: 'greeting.txt', message: 'Add required punctuation.', suggestedFix: 'Append !.' }],
        }
      : { verdict: 'pass', summary: 'High-risk smoke validation passed.', issues: [] };
} else if (role === 'responder') {
  output = prompt.includes('ACTIVE SKILL') && prompt.includes('REVIEW_FINDING')
    ? '# Skill review format\n\n## Evidence\nThere is one concrete issue in `greeting.txt`.\n\n```diff\n- hello\n+ hello world\n```'
    : prompt.includes('REVIEW_FINDING')
      ? '# Review\n\nThere is one concrete issue in `greeting.txt`.\n\n```diff\n- hello\n+ hello world\n```'
      : 'Implemented the requested change.\n\n```diff\n- hello\n+ hello world\n```';
} else {
  console.error('Fake codex could not determine role from prompt.');
  process.exit(4);
}

console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 50, output_tokens: 100, reasoning_output_tokens: 25 } }));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, typeof output === 'string' ? output : JSON.stringify(output));
