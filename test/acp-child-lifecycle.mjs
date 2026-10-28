import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateAcpChild } from '../src/providers/acp/child-lifecycle.mjs';

for (const gracefulMs of [0, 40]) {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    const begin = Date.now();
    await terminateAcpChild(child, { gracefulMs, termMs: 75 });
    assert.ok(Date.now() - begin < 1_500, 'teardown must remain bounded');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'child must exit even if it ignores SIGTERM');
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
}
console.log('acp-child-lifecycle: passed');
