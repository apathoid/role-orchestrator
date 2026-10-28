// Safe inventory for operator-authored review-context.json. No source bodies
// or raw prompts are printed; no policy changes are made automatically.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadInstructionContext } from '../src/context.mjs';
const root=resolve(process.argv[2] ?? '.');
const documents=await loadInstructionContext(root);
const inventory=documents.filter(row=>/^(project|nested)(?:-reference)+$/.test(row.scope)).map(row=>({
  scope:row.scope,path:row.path,sha256:createHash('sha256').update(row.body).digest('hex'),characters:row.body.length,
  eligibleForExplicitDeferral:true,
}));
process.stdout.write(JSON.stringify({version:1,reviewed:false,inventory,
  manifestExample:{version:1,reviewed:false,defer:[]},
  warning:'Manually audit each document and declare allowed roles before setting reviewed:true; do not defer mandatory instructions.'},null,2)+'\n');
