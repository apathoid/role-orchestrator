#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeReviewCoverage } from './fake-review-coverage.mjs';
import { fakeRouterResult } from './fake-router-fixture.mjs';
import readline from 'node:readline';
import crypto from 'node:crypto';

const sessions = new Map();
const log = process.env.FAKE_CODEX_LOG;
let supportsSessionFailure = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }); }
function update(sessionId, update) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }); }

function roleForPrompt(prompt) {
  const explicit = prompt.match(/ORCHESTRATOR ROLE: ([A-Za-z]+)/)?.[1];
  if (explicit) return explicit.replace(/(?:Low|Medium|High)$/, '');
  if (prompt.includes('Classify the software-engineering task')) return 'router';
  if (prompt.includes('Inspect the repository only enough')) return 'explorer';
  if (prompt.includes('Produce the smallest grounded execution plan')) return 'planner';
  if (prompt.includes('Synthesize a read-only investigation')) return 'investigator';
  if (prompt.includes('Implement the requested change directly')) return 'coder';
  if (prompt.includes('Review independently')) return 'reviewer';
  if (prompt.includes('Perform a risk-focused final validation')) return 'finalValidator';
  if (prompt.includes('Produce the final user-facing answer after the orchestration workflow has completed')) return 'responder';
  return 'unknown';
}

// Fake findings must satisfy the same evidence and task-scope contract as real
// reviewer results. They describe observed test-workspace state, not authority
// to expand the user's write scope.
async function groundedPunctuationFinding(cwd, message, suggestedFix) {
  const observed = (await readFile(join(cwd, 'greeting.txt'), 'utf8')).trim();
  if (observed !== 'hello world') {
    throw new Error(`Punctuation fixture expected an unfixed greeting, observed ${JSON.stringify(observed)}`);
  }
  return {
    severity: 'major', path: 'greeting.txt', message, suggestedFix,
    origin: 'introduced', taskRelation: 'requirement', remediationScope: 'in_scope',
    evidence: `The smoke-task punctuation requirement is "hello world!"; greeting.txt currently contains ${JSON.stringify(observed)} after the initial coder change.`,
  };
}

async function produceOutput(session, prompt) {
  const detectedRole = roleForPrompt(prompt);
  const role = detectedRole === 'unknown' ? session.lastRole ?? 'unknown' : detectedRole;
  if (role !== 'unknown') session.lastRole = role;
  if (log) await appendFile(log, JSON.stringify({ cwd: session.cwd, sandboxMode: session.mode === 'agent' ? 'workspace-write' : 'read-only', role, model: session.config.model, effort: session.config.reasoning_effort, modelProvider: process.env.MODEL_PROVIDER ?? null, codexConfig: process.env.CODEX_CONFIG ?? null }) + '\n');

  // These are valid inner-session metadata/echo updates, but the outer
  // orchestrator must not forward them into Zed because they describe the
  // ephemeral role session and may contain the private orchestration prompt.
  update(session.id, { sessionUpdate: 'session_info_update', title: `ORCHESTRATOR ROLE BOUNDARY: ${role} internal prompt` });
  update(session.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `PRIVATE INNER PROMPT FOR ${role}` } });

  // Deliberately fragment streaming text so tests catch clients that trim or
  // append newlines to ACP chunks instead of concatenating them verbatim.
  update(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting ' }, _meta: { codex: { phase: 'commentary' } } });
  update(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${role} evidence` }, _meta: { codex: { phase: 'commentary' } } });
  update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `I am checking the relevant ${role} evidence ` }, _meta: { codex: { phase: 'commentary' } } });
  update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'in more detail before returning the structured result.' }, _meta: { codex: { phase: 'commentary' } } });

  if (prompt.includes('ACTIVITY_EXTENDS_IDLE_TEST')) {
    for (let i = 0; i < 4; i += 1) {
      await sleep(35);
      update(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ` progress-${i}` }, _meta: { codex: { phase: 'commentary' } } });
    }
  }
  if (prompt.includes('IDLE_TIMEOUT_TEST')) {
    await sleep(120);
  }
  if (prompt.includes('TURN_DEADLINE_TEST')) {
    for (let i = 0; i < 8; i += 1) {
      await sleep(25);
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: 'timing-progress', status: 'in_progress', title: `Timing progress ${i}` });
    }
  }

  if (prompt.includes('UNPHASED_PRELUDE_TEST')) {
    // An adapter without phase metadata may emit a preliminary message before
    // its explicitly-marked final. The preliminary must never reach Zed.
    update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect this first.' } });
  }

  if (process.env.FAKE_TOOL_EVENTS === '1') {
    update(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      title: 'Analyze architecture and docs',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'npm run analyze' },
    });
    update(session.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '# very verbose generated report\n...lots of output...' } }],
      rawOutput: { stdout: '# very verbose generated report\n...lots of output...', exitCode: 0 },
    });
    update(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit greeting.txt',
      kind: 'edit',
      status: 'in_progress',
    });
    update(session.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      content: [{ type: 'diff', path: join(session.cwd, 'greeting.txt'), oldText: 'hello\n', newText: 'hello world\n' }],
    });
  }
  if (prompt.includes('TASK PLAN PROGRESS CONTRACT:')) {
    const expectedCount = Number(prompt.match(/grounded task plan already exists with exactly (\d+) ordered steps/i)?.[1] ?? 0);
    for (const expected of [
      `Keep exactly ${expectedCount} items in the same order`,
      'do not wait until the final answer to report progress',
      'first unfinished step in_progress',
    ]) {
      if (!prompt.includes(expected)) throw new Error(`Missing strict task-plan progress contract fragment: ${expected}`);
    }
    const labels = Array.from({ length: expectedCount }, (_, i) => i === 0 ? 'Inspect evidence' : i === 1 ? 'Complete task' : `Complete task ${i}`);
    const frame = (active, completedThrough = -1) => labels.map((content, index) => ({
      content,
      priority: 'medium',
      status: index <= completedThrough ? 'completed' : index === active ? 'in_progress' : 'pending',
    }));
    if (expectedCount > 0) update(session.id, { sessionUpdate: 'plan', entries: frame(0) });
    if (expectedCount > 1) update(session.id, { sessionUpdate: 'plan', entries: frame(1, 0) });
    if (expectedCount > 0) update(session.id, { sessionUpdate: 'plan', entries: labels.map((content) => ({ content, priority: 'medium', status: 'completed' })) });
  } else {
    update(session.id, { sessionUpdate: 'plan', entries: [
      { content: 'Inspect evidence', priority: 'medium', status: 'completed' },
      { content: 'Complete task', priority: 'medium', status: 'in_progress' },
    ] });
  }
  update(session.id, { sessionUpdate: 'usage_update', used: 1300, size: 1050000 });

  if (process.env.FAKE_EXPECT_COMMIT_REVIEW === '1') {
    const sourceCommit = process.env.FAKE_SOURCE_COMMIT;
    const resolved = spawnSync('git', ['rev-parse', '--verify', `${sourceCommit}^{commit}`], { cwd: session.cwd, encoding: 'utf8' });
    if (resolved.status !== 0) throw new Error(`Requested source commit is not reachable: ${sourceCommit}`);
    const show = spawnSync('git', ['show', '--format=', '--no-ext-diff', sourceCommit, '--', 'greeting.txt'], { cwd: session.cwd, encoding: 'utf8' });
    if (show.status !== 0 || !show.stdout.includes('+hello target')) throw new Error('Real commit review diff is unavailable.');
    if (!prompt.includes(sourceCommit)) throw new Error('Requested source commit ID was not provided to the review role.');
  }

  const high = prompt.includes('HIGH_RISK');
  const reviewOnly = prompt.includes('TASK MODE OVERRIDE: review') || /USER TASK:\n(?:REVIEW_ONLY|REVIEW_FINDING|Review\b)/i.test(prompt);
  const investigateOnly = prompt.includes('TASK MODE OVERRIDE: investigate') || prompt.includes('INVESTIGATE_ONLY');
  const needsFix = prompt.includes('NEEDS_FIX') || prompt.includes('ESCALATE');
  const escalate = prompt.includes('ESCALATE');
  let output;

  if (role === 'router') {
    output = fakeRouterResult({ prompt, high, reviewOnly, investigateOnly });
  } else if (role === 'explorer') {
    output = { summary: 'Greeting is stored in greeting.txt.', relevantFiles: ['greeting.txt'], constraints: [], existingPatterns: ['Single-line text file'], likelyVerification: ['git diff --check'], unknowns: [] };
  } else if (role === 'planner') {
    output = { goal: 'Update the greeting.', steps: ['Update greeting.txt'], acceptanceCriteria: ['Greeting contains requested text'], risks: [], expectedFiles: ['greeting.txt'], engineeringFrame: { currentOwner: 'greeting.txt', existingAbstractions: [], generalMechanism: 'Store the greeting text.', specificPolicy: 'Use the requested greeting.', targetPlacement: ['greeting.txt'], stateOwnership: [], resourceOwnership: [], contractRisks: ['Preserve file semantics.'], avoid: ['Unrelated refactors.'], uncertainties: [] } };
  } else if (role === 'investigator') {
    output = 'The greeting is implemented in `greeting.txt`.\n\n```ts\nconst greeting = "hello";\n```\n\nNo repository edits were made.';
  } else if (role === 'coder') {
    if (!['agent', 'agent-full-access', 'read-only'].includes(session.mode)) throw new Error(`Coder received unknown native mode ${session.mode}`);
    if (process.env.FAKE_EXPECT_CODER_HISTORY === '1') {
      const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: session.cwd, encoding: 'utf8' });
      if (count.status !== 0 || Number(count.stdout.trim()) < 2) throw new Error('Coder does not have full Git history.');
    }
    const greetingPath = join(session.cwd, 'greeting.txt');
    const current = (await readFile(greetingPath, 'utf8')).trim();
    if (prompt.includes('DENIED_PATCH')) {
      await mkdir(join(session.cwd, 'config'), { recursive: true });
      await writeFile(join(session.cwd, 'config/development.json'), 'should-not-be-written\n');
      output = { action: 'changed', summary: 'Attempt a policy-denied change.', changedFiles: ['config/development.json'], notes: [] };
    } else if (prompt.includes('GENERATED_REPORT')) {
      await writeFile(greetingPath, 'hello world\n');
      await mkdir(join(session.cwd, 'report'), { recursive: true });
      await writeFile(join(session.cwd, 'report/index.json'), '{"generated":true}\n');
      output = { action: 'changed', summary: 'Update greeting and run report generator.', changedFiles: ['greeting.txt'], notes: [] };
    } else if (current === 'hello') {
      await writeFile(greetingPath, 'hello world\n');
      output = { action: 'changed', summary: 'Update greeting.', changedFiles: ['greeting.txt'], notes: [] };
    } else if (current === 'hello world' && needsFix) {
      await writeFile(greetingPath, 'hello world!\n');
      output = { action: 'changed', summary: 'Apply requested review fix.', changedFiles: ['greeting.txt'], notes: [] };
    } else {
      output = { action: 'no_change', summary: 'No further change.', changedFiles: [], notes: [] };
    }
  } else if (role === 'reviewer') {
    if (session.mode !== 'read-only') throw new Error(`Reviewer expected read-only mode, got ${session.mode}`);
    const fixed = prompt.includes('+hello world!');
    const reviewFinding = prompt.includes('REVIEW_FINDING');
    output = reviewFinding
      ? { verdict: 'fix', summary: 'Review-only smoke finding.', issues: [{ severity: 'major', path: 'greeting.txt', message: 'Example review finding.', suggestedFix: 'Consider changing the greeting.' }] }
      : escalate && !fixed
        ? { verdict: 'escalate', summary: 'Smoke-test requests stronger validation.', issues: [{ severity: 'major', path: 'greeting.txt', message: 'Escalated decision.', suggestedFix: 'Decide whether punctuation is required.' }] }
        : needsFix && !fixed
          ? { verdict: 'fix', summary: 'Smoke-test requests one fix.', issues: [await groundedPunctuationFinding(session.cwd, 'Missing exclamation mark.', 'Append !.')] }
          : { verdict: 'pass', summary: 'No blocking issues.', issues: [] };
    const scopedFixture = fakeReviewCoverage(prompt);
    if (scopedFixture) output = { ...output, ...scopedFixture };
  } else if (role === 'finalValidator') {
    const fixed = prompt.includes('+hello world!');
    const reviewFinding = prompt.includes('REVIEW_FINDING');
    output = reviewFinding
      ? { verdict: 'fix', summary: 'Review-only smoke finding.', issues: [{ severity: 'major', path: 'greeting.txt', message: 'Example review finding.', suggestedFix: 'Consider changing the greeting.' }] }
      : escalate && !fixed
        ? { verdict: 'fix', summary: 'Escalation resolved: punctuation is required.', issues: [await groundedPunctuationFinding(session.cwd, 'Add required punctuation.', 'Append !.')] }
        : { verdict: 'pass', summary: 'High-risk smoke validation passed.', issues: [] };
  } else if (role === 'responder') {
    if (prompt.includes('ACTIVE SKILL') && prompt.includes('REVIEW_FINDING')) {
      output = '# Skill review format\n\n## Evidence\nThere is one concrete issue in `greeting.txt`.\n\n```diff\n- hello\n+ hello world\n```';
    } else if (prompt.includes('REVIEW_FINDING')) {
      output = '# Review\n\nThere is one concrete issue in `greeting.txt`.\n\n```diff\n- hello\n+ hello world\n```';
    } else if (prompt.includes('FINAL WORKFLOW STATUS')) {
      output = 'Implemented the requested change and reviewed the resulting workspace.\n\n```diff\n- hello\n+ hello world\n```';
    } else {
      output = 'The workflow completed. The repository state was preserved and the relevant evidence is available above.';
    }
  } else {
    throw new Error('Fake codex-acp could not determine role from prompt.');
  }

  session.lastOutput = output;
  let finalText = typeof output === 'string' ? output : JSON.stringify(output);
  if (prompt.includes('MALFORMED_FINAL') && role === 'explorer') {
    finalText = `I inspected the repository and found the relevant files. Please use this result: ${output.summary}`;
  } else if (prompt.includes('MALFORMED_PLANNER') && role === 'planner') {
    finalText = 'Update greeting.txt, then run the configured verification and review the resulting diff.';
  } else if (prompt.includes('MALFORMED_INVESTIGATOR') && role === 'investigator') {
    finalText = 'The greeting is implemented in greeting.txt; Git history confirms this is the relevant source of truth.';
  } else if (prompt.includes('MALFORMED_CODER') && role === 'coder') {
    finalText = `I updated the project workspace directly. Current action: ${output.action}.`;
  } else if (prompt.includes('MALFORMED_REVIEWER') && role === 'reviewer') {
    finalText = 'The change looks reasonable, but this response intentionally has no machine-readable verdict.';
  } else if (prompt.includes('MALFORMED_FINAL_VALIDATOR') && role === 'finalValidator') {
    finalText = 'I could not express the final validation as the requested machine-readable verdict.';
  } else if (prompt.includes('MALFORMED_ROUTER') && role === 'router') {
    finalText = 'This task needs repository work, but this response intentionally omits the routing JSON.';
  } else if (prompt.includes('FENCED_FINAL') && role === 'explorer') {
    finalText = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;
  }
  if (prompt.includes('UNPHASED_ONLY_TEST')) {
    const midpoint = Math.floor(finalText.length / 2);
    update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finalText.slice(0, midpoint) } });
    update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finalText.slice(midpoint) } });
  } else {
    update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finalText }, _meta: { codex: { phase: 'final_answer' } } });
  }
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    const air = params.clientCapabilities?._meta?.jetbrains?.air;
    supportsSessionFailure = Number.isInteger(air?.version)
      && air.version >= 1
      && Array.isArray(air.capabilities)
      && air.capabilities.includes('sessionFailure');
    return reply(id, {
      protocolVersion: params.protocolVersion,
      agentInfo: { name: '@agentclientprotocol/codex-acp', version: '1.12.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true } },
      authMethods: [],
    });
  }
  if (method === 'session/new') {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { id: sessionId, cwd: params.cwd, mode: 'agent', config: {}, mcpServers: params.mcpServers ?? [], additionalDirectories: params.additionalDirectories ?? [] });
    return reply(id, { sessionId, configOptions: [] });
  }
  if (method === 'session/set_mode') {
    const session = sessions.get(params.sessionId); if (!session) return fail(id, -32602, 'Unknown session');
    session.mode = params.modeId;
    return reply(id, {});
  }
  if (method === 'session/set_config_option') {
    const session = sessions.get(params.sessionId); if (!session) return fail(id, -32602, 'Unknown session');
    session.config[params.configId] = params.value;
    return reply(id, { configOptions: [] });
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId); if (!session) return fail(id, -32602, 'Unknown session');
    const blocks = params.prompt ?? [];
    const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (prompt.includes('NATIVE_FULL_ACCESS_TEST') && session.mode !== 'agent-full-access') {
      return fail(id, -32602, `Expected native agent-full-access mode, got ${session.mode}.`);
    }
    if (prompt.includes('NATIVE_READ_ONLY_BOUNDARY_TEST') && session.mode !== 'read-only') {
      return fail(id, -32602, `Expected orchestration read-only boundary to force native read-only mode, got ${session.mode}.`);
    }
    if (prompt.includes('NATIVE_PLAN_TEST') && session.config.collaboration_mode !== 'plan') {
      return fail(id, -32602, `Expected native collaboration_mode=plan, got ${String(session.config.collaboration_mode)}.`);
    }
    if (prompt.includes('PLAN_TO_DEFAULT_TEST')) {
      session.config.collaboration_mode = 'default';
      update(session.id, {
        sessionUpdate: 'config_option_update',
        configOptions: [{
          id: 'collaboration_mode',
          name: 'Collaboration mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        }],
      });
    }
    if (prompt.includes('MEDIA_TEST') && !blocks.some((b) => b.type === 'image' && b.mimeType === 'image/png')) {
      return fail(id, -32602, 'Expected image ContentBlock was not forwarded.');
    }
    if (prompt.includes('HISTORICAL_MEDIA_TEST')) {
      const marker = blocks.find((b) => b.type === 'text' && /HISTORICAL OUTER USER ATTACHMENT/.test(b.text ?? ''));
      const image = blocks.find((b) => b.type === 'image' && b.mimeType === 'image/png' && Buffer.from(b.data ?? '', 'base64').toString() === 'historical-image');
      if (!marker || !image) return fail(id, -32602, 'Expected historical attachment marker and image ContentBlock were not forwarded together.');
      if (!/not as a new instruction/i.test(marker.text)) return fail(id, -32602, 'Historical attachment marker lost instruction-boundary semantics.');
    }
    if (prompt.includes('SESSION_CONTEXT_TEST')) {
      if (!session.additionalDirectories.includes('/tmp/extra-context')) return fail(id, -32602, 'Expected additionalDirectories passthrough.');
      if (!session.mcpServers.some((server) => server?.name === 'docs')) return fail(id, -32602, 'Expected MCP server passthrough.');
    }
    if (prompt.includes('MEDIA_TEST')) {
      update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' } });
    }
    if (prompt.includes('PROVIDER_QUOTA_ERROR')) {
      const detail = 'Usage limit exhausted for this account. Try again after 18:45 UTC.';
      if (supportsSessionFailure) {
        return reply(id, {
          stopReason: 'end_turn',
          _meta: {
            jetbrains: {
              air: {
                version: 1,
                sessionFailure: {
                  id: `${session.id}:quota`,
                  revision: 1,
                  category: 'limit',
                  severity: 'error',
                  title: detail,
                  actions: [],
                },
              },
            },
          },
        });
      }
      // Legacy fallback for a client that did not negotiate typed failures.
      update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: detail } });
      return fail(id, -32603, 'Internal error', { codexErrorInfo: 'usageLimitExceeded', message: detail });
    }
    if (prompt.includes('PROVIDER_DATA_ONLY_ERROR')) {
      return fail(id, -32603, 'Internal error', { details: 'Available provider tokens are exhausted until the quota resets.', access_token: 'must-not-leak' });
    }
    if (prompt.includes('PROVIDER_CANCELLED_TEST')) {
      return reply(id, { stopReason: 'cancelled' });
    }
    try { await produceOutput(session, prompt); return reply(id, { stopReason: 'end_turn' }); }
    catch (error) { return fail(id, -32603, error.message); }
  }
  if (method === 'session/close') {
    sessions.delete(params.sessionId);
    return reply(id, {});
  }
  if (method === 'session/cancel') return;
  return fail(id, -32601, `Unsupported method ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method && message.id !== undefined) await handle(message);
  else if (message.method === 'session/cancel') await handle(message);
}
