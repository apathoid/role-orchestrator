import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fakeUrl = new URL('./mock-acp-sdk.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@agentclientprotocol/sdk') return { url: fakeUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { harness } = await import('./mock-acp-sdk.mjs');
const { GenericAcpProvider } = await import('../src/providers/acp/generic-acp.mjs');
const { CodexAcpProvider } = await import('../src/providers/codex-acp.mjs');
const cwd = await mkdtemp(join(tmpdir(), 'role-orchestrator-acp-lifecycle-'));
const processCommand = process.execPath;
const processArgs = ['-e', 'process.stdin.resume()'];
const request = { profile: { model: 'test', preflightTimeoutMs: 100, cleanupTimeoutMs: 20 },
  profileName: 'test', role: 'investigator', prompt: 'Hello', cwd, sandboxMode: 'read-only' };
function provider(type) {
  if (type === 'generic') return new GenericAcpProvider('mock', { command: processCommand,
    args: processArgs, workspaceModes: { readOnly: 'read-only', write: 'agent' } });
  const instance = new CodexAcpProvider('mock', {});
  instance.resolveCommand = () => ({ command: processCommand, args: processArgs });
  return instance;
}
try {
  for (const type of ['generic', 'codex']) {
    harness.reset();
    let release;
    harness.initializeGate = new Promise(resolve => { release = resolve; });
    const p = provider(type);
    try {
      const preparing = p.prepare?.() ?? p.ensureStarted();
      const invoking = p.invoke(request);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(harness.events.filter(x => x === 'initialize').length, 1, `${type}: one initialize`);
      assert.equal(harness.events.includes('session.new'), false, `${type}: no session before initialize`);
      release();
      await Promise.all([preparing, invoking]);
      assert.equal(harness.events.includes('session.new'), true);
    } finally { await p.close(); }
  }
  for (const type of ['generic', 'codex']) {
    harness.reset();
    let release;
    harness.initializeGate = new Promise(resolve => { release = resolve; });
    const p = provider(type);
    try {
      const invocations = Array.from({ length: 10 }, () => p.invoke(request));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(harness.events.filter(x => x === 'initialize').length, 1,
        `${type}: concurrent invocations must share one handshake`);
      assert.equal(harness.events.filter(x => x === 'session.new').length, 0);
      release();
      await Promise.all(invocations);
      assert.equal(harness.events.filter(x => x === 'session.new').length, 10);
    } finally { await p.close(); }
  }
  for (const type of ['generic','codex']) {
    harness.reset();
    const p = provider(type);
    try {
      harness.initializeRejectOnce = true;
      await assert.rejects(() => p.ensureStarted(), /initialize|rejected/);
      await p.ensureStarted();
      assert.equal(harness.events.filter(x => x === 'initialize').length, 2, `${type}: second handshake`);
    } finally { await p.close(); }
  }
  for (const type of ['generic','codex']) {
    harness.reset();
    // Delay mocked initialize so the actual ChildProcess error/exit wins.
    harness.initializeGate = new Promise(() => {});
    const p = provider(type);
    if (type === 'generic') p.config.command = '/nonexistent-role-orchestrator-agent';
    else p.resolveCommand = () => ({ command: '/nonexistent-role-orchestrator-agent', args: [] });
    try {
      await assert.rejects(() => p.ensureStarted(), /initialize|ENOENT|spawn/i);
      assert.equal(p.connection, null, `${type}: no ready connection after spawn failure`);
    } finally { await p.close(); }
  }
  for (const type of ['generic','codex']) {
    harness.reset();
    harness.holdSessionNew = true;
    const p = provider(type);
    const controller = new AbortController();
    try {
      const promise = p.invoke({ ...request, signal: controller.signal });
      await new Promise(resolve => setTimeout(resolve, 30));
      controller.abort();
      await assert.rejects(promise, /cancel|abort/i);
    } finally { await p.close(); }
  }
  for (const type of ['generic', 'codex']) {
    harness.reset();
    harness.holdSessionNew = true;
    const p = provider(type);
    try {
      const error = await p.invoke({ ...request,
        profile: { ...request.profile, preflightTimeoutMs: 25 } }).then(
          () => null, error => error);
      assert.ok(error, `${type}: a stuck session.new must not succeed`);
      assert.equal(error.timeoutKind, 'preflight');
    } finally { await p.close(); }
  }
  for (const type of ['generic','codex']) {
    harness.reset();
    harness.holdClose = true;
    const p = provider(type);
    try {
      const started = Date.now();
      await p.invoke(request);
      assert.ok(Date.now() - started < 1_000, `${type}: close must not hang`);
    } finally { await p.close(); }
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
console.log('acp-lifecycle-hardening: passed');
