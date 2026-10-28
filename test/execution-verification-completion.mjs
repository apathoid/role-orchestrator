import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSafe,runVerificationCommand,verificationWatchPreflight} from '../src/repo.mjs';
const root=await mkdtemp(path.join(tmpdir(),'ro-verification-'));
try {
  await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'vitest',safe:'vitest run',nested:'npm run test'},dependencies:{'@agentclientprotocol/sdk':'2.1.0'}}));
  assert.equal((await verificationWatchPreflight(root,['npm','run','test'])).reason,'vitest_default_watch');
  assert.equal(await verificationWatchPreflight(root,['npm','run','safe']),null);
  assert.equal((await verificationWatchPreflight(root,['npm','run','nested'])).script,'test');
  assert.equal((await verificationWatchPreflight(root,['vitest','--watch'])).reason,'watch_option');
  let status=await runVerificationCommand(root,['npm','run','test']);
  assert.equal(status.status,'ENVIRONMENT_ERROR');
  assert.equal(status.reasonCode,'INTERACTIVE_VERIFICATION');
  const check=async (code, expected)=>{
    const result=await runVerificationCommand(root,[process.execPath,'-e',code],{timeoutMs:3000});
    assert.equal(result.status,expected);return result;
  };
  assert.equal((await check('process.exit(0)','PASS')).ok,true);
  assert.equal((await check('process.exit(2)','TEST_FAILED')).reasonCode,'NONZERO_EXIT');
  await mkdir(path.join(root,'node_modules'));
  status=await runVerificationCommand(root,[process.execPath,'-e',
    'console.error("Cannot find package \'@agentclientprotocol/sdk\' imported from test");process.exit(1)'],{timeoutMs:3000});
  assert.equal(status.status,'ENVIRONMENT_ERROR','partial dependency directory does not mean a declared package is installed');
  status=await runVerificationCommand(root,['missing-executable-ro-test-7791'],{timeoutMs:3000});
  assert.equal(status.status,'TOOL_UNAVAILABLE');
  status=await runVerificationCommand(root,[process.execPath,'-e','setInterval(()=>{},1000)'],{timeoutMs:180});
  assert.equal(status.status,'INFRA_FAILURE');
  assert.equal(status.reasonCode,'VERIFICATION_TIMEOUT');
  assert.equal(status.diagnostics.timedOut,true);
  // A wrapper can exit(0) while its child inherits the verifier's stdio.
  // Waiting for 'close' then hangs unless we kill the entire POSIX group even
  // though the original leader has already exited.
  if (process.platform !== 'win32') {
    const wrapper = `const {spawn}=require('node:child_process');
const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
console.log('grandchild started');grandchild.unref();`;
    const start = Date.now();
    const orphaned = await runVerificationCommand(root, [process.execPath, '-e',wrapper], {
      timeoutMs:300, policies:{},
    });
    assert.equal(orphaned.status,'INFRA_FAILURE');
    assert.equal(orphaned.diagnostics.timedOut,true, 'timeout still applies after wrapper exits');
    assert.ok(Date.now()-start < 3000, 'orphaned pipe holder must not stall completion');
    const ignoring = `const {spawn}=require('node:child_process');
const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
console.log('grandchild started');grandchild.unref();`;
    const escalatedAt = Date.now();
    const escalated = await execFileSafe(process.execPath, ['-e',ignoring], {
      cwd:root, timeoutMs:300, allowFailure:true, killProcessGroup:true,
    });
    assert.equal(escalated.timedOut,true);
    assert.ok(Date.now()-escalatedAt < 4500, 'SIGKILL must terminate group members ignoring SIGTERM');
    const controller = new AbortController();
    const cancelAt = Date.now();
    const cancelTimer = setTimeout(() => controller.abort(), 300);
    try {
      await assert.rejects(execFileSafe(process.execPath, ['-e',wrapper], {
        cwd:root, timeoutMs:5000, allowFailure:true, killProcessGroup:true,
        signal:controller.signal,
      }), error => error?.name === 'AbortError' && error?.code === 'CANCELLED');
      assert.ok(Date.now()-cancelAt < 3000, 'cancellation must finish after wrapper has exited');
    } finally { clearTimeout(cancelTimer); }
  }
  console.log('execution-verification-completion: PASS');
} finally {await rm(root,{recursive:true,force:true});}
