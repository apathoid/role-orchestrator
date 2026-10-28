#!/usr/bin/env node
// Local-only inventory; does not write a manifest or transmit instruction text.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadInvocationContext } from '../src/context.mjs';
const repoRoot=resolve(process.argv[2] ?? process.cwd());
const ctx=await loadInvocationContext(repoRoot,{scopePaths:[repoRoot]});
const instructions=ctx.instructions.map(({scope,path,body})=>({
  scope,path,characters:body.length,sha256:createHash('sha256').update(body).digest('hex'),
}));
console.log(JSON.stringify({version:1,repoRoot,instructions,
  note:'SHA-256 hashes the normalized instruction body as loaded by Role Orchestrator (not raw file bytes). Do not automatically omit documents. Review routing/security rules and write a complete routingConstraints summary before enabling optimized mode.'},null,2));
