#!/usr/bin/env node
// Explicit real-provider A/B only. Never launches Explorer/Coder/verification.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createModelRegistry } from '../src/models.mjs';
import { validateRouterFixture,evaluateRouterFixture } from '../src/routing/evaluation.mjs';
const [,,repoArg,fixtureArg,flag]=process.argv;
if(!repoArg||!fixtureArg||flag!=='--run'||process.argv.length!==5) {
  console.error('Usage: node tools/router-evaluate.mjs /repo/path /path/to/fixtures.json --run');
  console.error('Calls the configured Router model TWICE per fixture (legacy and optimized). No other roles or edits.');
  process.exit(2);
}
try {
  const repoRoot=resolve(repoArg);
  const parsed=JSON.parse(await readFile(resolve(fixtureArg),'utf8'));
  if(!Array.isArray(parsed)||!parsed.length||parsed.length>100) throw new TypeError('Fixture file must contain 1..100 fixtures');
  const fixtures=parsed.map(validateRouterFixture);
  if(fixtures.some(f=>!f.expected||['mode','writeIntent','complexity','risk'].some(key=>f.expected[key]===undefined)))
    throw new TypeError('Every fixture needs independent expected mode/writeIntent/complexity/risk');
  if(new Set(fixtures.map(f=>f.id)).size!==fixtures.length) throw new TypeError('Duplicate fixture IDs');
  const config=await loadConfig({repoRoot});
  const results=[];
  for(const fixture of fixtures) {
    try {results.push(await evaluateRouterFixture({fixture,repoRoot,config,registryFactory:()=>createModelRegistry(config)}));}
    catch {results.push({id:fixture.id,pass:false,error:'router_evaluation_failed'});}
  }
  // No task text, raw prompts, paths, provider exceptions or reasoning in export.
  console.log(JSON.stringify({version:1,scope:'router_ab_evaluation',total:results.length,
    passing:results.filter(x=>x.pass).length,results},null,2));
  if(results.some(x=>!x.pass)) process.exitCode=1;
} catch {
  console.error('Invalid corpus or environment; no results exported.');process.exitCode=2;
}
