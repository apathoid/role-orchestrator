import assert from 'node:assert/strict';
import {execFileSafe,boundedVerificationOutput} from '../src/repo.mjs';
const r=await execFileSafe(process.execPath,['-e','process.stdout.write("START\\n"+"x".repeat(200000)+"\\nEND_MARKER\\n")'],
  {allowFailure:true,maxCaptureChars:1000,maxResultChars:1000});
assert.equal(r.truncated,true);
assert(r.outputCharacters.stdout>200000);
assert(r.outputTail.stdout.endsWith('END_MARKER\n'));
const snippet=boundedVerificationOutput(r,800);
assert(snippet.startsWith('START'));
assert(snippet.includes('END_MARKER'));
assert(snippet.includes('characters omitted'));
console.log('execution-bounded-output: PASS');
