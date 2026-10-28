import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runVerificationCommand,verificationWatchPreflight} from '../src/repo.mjs';
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
  console.log('execution-verification-completion: PASS');
} finally {await rm(root,{recursive:true,force:true});}
