import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { discoverAgentSkills,selectAgentSkill } from '../../src/adapters/configuration/agent-skills.js';
test('C24 Agent Skills discovery reads real bounded YAML metadata with project precedence',()=>withOwnedRun('C24-skills',async root=>{
  const home=join(root,'home'),cwd=join(root,'workspace');
  async function skill(base,dir,metadata) {
    const path=join(base,'.agents','skills',dir,'SKILL.md');
    await mkdir(join(path,'..'),{recursive:true});
    await writeFile(path,metadata);
    return path;
  }
  const global=await skill(home,'shared','---\nname: shared\ndescription: Global skill\n---\nreal instructions');
  const local=await skill(cwd,'shared','---\nname: shared\ndescription: >-\n  project\n  skill\n---\nreal instructions');
  await skill(cwd,'broken','---\nname: broken\nname: duplicate\ndescription: invalid\n---');
  await skill(cwd,'oversize','---\nname: oversized\ndescription: '+ 'a'.repeat(32768)+'\n---');
  const result=await discoverAgentSkills(cwd,home);
  assert.deepEqual(result.commands,[{name:'shared',description:'project skill',path:local,source:'project'}]);
  assert.equal((await selectAgentSkill(cwd,global,home)).source,'global');
  assert.equal(await selectAgentSkill(cwd,'missing',home),undefined);
  await writeFile(local,'---\nname: shared\ndescription: changed\n---\nnew instructions');
  assert.equal((await selectAgentSkill(cwd,'shared',home)).description,'changed');
}));
